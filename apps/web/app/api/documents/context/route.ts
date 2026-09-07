import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { getCurrentAccountUid } from "@/lib/accounts";
import {
  createDocumentHref,
  MAX_DOCQA_DOCUMENTS,
  type AttachedDocument,
  type PreparedDocument,
} from "@/lib/docqa";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DOCUMENT_MIB = 100;
const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MIB * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "rst", "csv", "tsv", "html", "htm", "xml",
  "json", "jsonl", "yaml", "yml", "toml", "log",
]);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, "pdf", "docx"]);

type ExtractedDocument =
  | { kind: "pdf"; pages: string[] }
  | { kind: "text" | "docx"; text: string };

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function truncateExtracted(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Extraction truncated at 5 MiB]`;
}

async function extractDocument(filePath: string, extension: string): Promise<ExtractedDocument> {
  if (extension === "pdf") {
    const bytes = await readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const result = await extractText(pdf, { mergePages: false });
      let remaining = MAX_EXTRACTED_CHARS;
      const pages = result.text.map((pageText) => {
        if (remaining <= 0) return "[Extraction omitted: document text exceeded 5 MiB]";
        const selected = pageText.slice(0, remaining);
        remaining -= selected.length;
        return selected;
      });
      return { kind: "pdf", pages };
    } finally {
      await pdf.loadingTask.destroy();
    }
  }

  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return { kind: "docx", text: truncateExtracted(result.value) };
  }

  return { kind: "text", text: truncateExtracted(await readFile(filePath, "utf8")) };
}

function formatLineDocument(document: AttachedDocument, text: string): { content: string; locations: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: string[] = [];
  const chunkSize = 40;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize);
    const location = `L${start + 1}-L${end}`;
    const href = createDocumentHref(document.path, location);
    sections.push(
      `--- ${location} | cite: [${document.name} · lines ${start + 1}-${end}](${href}) ---\n`
      + lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n"),
    );
  }
  return { content: sections.join("\n\n"), locations: sections.length };
}

function formatPdfDocument(document: AttachedDocument, pages: string[]): { content: string; locations: number } {
  const sections = pages.map((pageText, index) => {
    const page = index + 1;
    const href = createDocumentHref(document.path, `P${page}`);
    const pageLines = pageText
      .replace(/\r\n?/g, "\n")
      .split("\n")
      // Prefix every extracted line with the real PDF page. grep/read output
      // line numbers can be huge in long manuals; the P<number> marker is the
      // page number the UI can jump to.
      .map((line) => `P${page}: ${line}`)
      .join("\n");
    return `--- PAGE ${page} | cite: [${document.name} · page ${page}](${href}) ---\n${pageLines}`;
  });
  return { content: sections.join("\n\n"), locations: sections.length };
}

async function prepareDocument(document: AttachedDocument): Promise<PreparedDocument> {
  const extension = extensionOf(document.path);
  const fileStat = await stat(document.path);
  const cacheKey = createHash("sha256")
    .update(`${document.path}\0${fileStat.mtimeMs}\0${fileStat.size}`)
    .digest("hex")
    .slice(0, 24);
  const cacheDir = path.join(tmpdir(), "pi-web-docqa");
  const extractedPath = path.join(cacheDir, `${cacheKey}-${path.basename(document.path).replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`);

  const extracted = await extractDocument(document.path, extension);
  const formatted = extracted.kind === "pdf"
    ? formatPdfDocument(document, extracted.pages)
    : formatLineDocument(document, extracted.text);

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(extractedPath, formatted.content, { encoding: "utf8", mode: 0o600 });
  return {
    ...document,
    kind: extracted.kind,
    size: fileStat.size,
    extractedPath,
    locations: formatted.locations,
  };
}

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { documents?: AttachedDocument[] };
    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      return NextResponse.json({ error: "At least one document is required" }, { status: 400 });
    }
    if (body.documents.length > MAX_DOCQA_DOCUMENTS) {
      return NextResponse.json({ error: `A maximum of ${MAX_DOCQA_DOCUMENTS} documents is supported` }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots(accountUid);
    const validatedDocuments: AttachedDocument[] = [];
    for (const document of body.documents) {
      if (!document || typeof document.path !== "string" || !isFilePathAllowed(document.path, allowedRoots)) {
        return NextResponse.json({ error: "Document path is not allowed" }, { status: 403 });
      }
      const extension = extensionOf(document.path);
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        return NextResponse.json({ error: `Unsupported document type: .${extension || "(none)"}` }, { status: 415 });
      }
      const fileStat = await stat(document.path);
      if (!fileStat.isFile()) {
        return NextResponse.json({ error: "Document path is not a file" }, { status: 400 });
      }
      if (fileStat.size > MAX_DOCUMENT_BYTES) {
        return NextResponse.json({ error: `${document.name} is larger than ${MAX_DOCUMENT_MIB} MiB` }, { status: 413 });
      }
      validatedDocuments.push({
        path: document.path,
        name: path.basename(document.path),
        kind: extension,
        size: fileStat.size,
      });
    }

    const documents = await Promise.all(validatedDocuments.map(prepareDocument));
    return NextResponse.json({ documents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
