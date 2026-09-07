import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "@/lib/file-access";
import { accountOwnsSession, getCurrentAccountUid } from "@/lib/accounts";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime as getImageMimeFromExtension,
} from "@/lib/file-types";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { getFileResponseSecurityHeaders } from "@/lib/file-response-security";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  validateUploadFileNames,
} from "@/lib/file-upload";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { samePath } from "@/lib/paths";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const TEXT_EDIT_MAX_BYTES = 512 * 1024;
const execFileAsync = promisify(execFile);
const FILE_SEARCH_RESULT_LIMIT = 200;
const FILE_SEARCH_VISIT_LIMIT = 30_000;
type CreateKind = "file" | "directory";

// Prefer the file signature for images while retaining the centralized suffix
// table for formats without a distinctive header.
function getImageMime(filePath: string): string | null {
  const extensionMime = getImageMimeFromExtension(filePath);
  if (!extensionMime) return null;

  // A surprising number of project assets have a .png suffix while their
  // actual bytes are JPEG. Browsers differ in how aggressively they sniff an
  // image served with a mismatched Content-Type, so prefer the file signature.
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.allocUnsafe(512);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      const bytes = header.subarray(0, bytesRead);

      if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
      }
      if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
      }
      if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) {
        return "image/gif";
      }
      if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
      }
      if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") {
        return "image/bmp";
      }
      if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
        return "image/x-icon";
      }
      if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
        const brands = bytes.subarray(8, 32).toString("ascii");
        if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
      }
      const textHeader = bytes.toString("utf8").replace(/^\uFEFF/, "").trimStart();
      if (/<svg(?:\s|>)/i.test(textHeader.slice(0, 480))) {
        return "image/svg+xml";
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Fall back to the suffix when the header cannot be read. The normal file
    // access path will still return the appropriate read/not-found error.
  }
  return extensionMime;
}

const FILE_REQUEST_TYPES = [
  "list", "search", "read", "origin", "timeline", "revision",
  "download", "meta", "preview", "watch",
] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", pyw: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "shell", gitignore: "shell", ps1: "powershell", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

async function readGitOrigin(filePath: string): Promise<{
  available: boolean;
  tracked: boolean;
  content: string;
  ref: string;
}> {
  const commonOptions = {
    cwd: path.dirname(filePath),
    encoding: "utf8" as const,
    timeout: 3_000,
    maxBuffer: TEXT_EDIT_MAX_BYTES * 2,
  };
  let repoRoot: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], commonOptions);
    repoRoot = result.stdout.trim();
  } catch {
    return { available: false, tracked: false, content: "", ref: "open snapshot" };
  }
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    return { available: false, tracked: false, content: "", ref: "open snapshot" };
  }
  try {
    const result = await execFileAsync("git", ["show", `HEAD:${relativePath}`], {
      ...commonOptions,
      cwd: repoRoot,
    });
    return { available: true, tracked: true, content: result.stdout, ref: "HEAD" };
  } catch {
    // A repository file that does not exist in HEAD is untracked/new. Its Git
    // origin is an empty file, so Diff naturally renders every line as added.
    return { available: true, tracked: false, content: "", ref: "untracked" };
  }
}

interface GitTimelineEntry {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: string;
  message: string;
  path?: string;
}

async function readGitTimeline(filePath: string, isDirectory: boolean): Promise<{
  available: boolean;
  isDirectory: boolean;
  relativePath: string;
  workingTreeChanges: number;
  entries: GitTimelineEntry[];
}> {
  const options = {
    cwd: path.dirname(filePath),
    encoding: "utf8" as const,
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  };
  let repoRoot: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], options);
    repoRoot = result.stdout.trim();
  } catch {
    return { available: false, isDirectory, relativePath: "", workingTreeChanges: 0, entries: [] };
  }

  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    return { available: false, isDirectory, relativePath: "", workingTreeChanges: 0, entries: [] };
  }

  const gitOptions = { ...options, cwd: repoRoot };
  const logArgs = [
    "log",
    ...(!isDirectory ? ["--follow"] : []),
    "--max-count=100",
    "--date=iso-strict",
    "--name-only",
    "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s",
    "--",
    relativePath,
  ];
  const [statusResult, logResult] = await Promise.allSettled([
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", relativePath], gitOptions),
    execFileAsync("git", logArgs, gitOptions),
  ]);

  const workingTreeChanges = statusResult.status === "fulfilled"
    ? statusResult.value.stdout.split(/\r?\n/).filter(Boolean).length
    : 0;
  const entries = logResult.status === "fulfilled"
    ? logResult.value.stdout
        .split("\x1e")
        .map((record) => record.trim())
        .filter(Boolean)
        .flatMap((record): GitTimelineEntry[] => {
          const [header, ...changedPaths] = record.split(/\r?\n/).filter(Boolean);
          const [hash, shortHash, author, timestamp, ...messageParts] = header.split("\x1f");
          if (!hash || !shortHash || !timestamp) return [];
          return [{
            hash,
            shortHash,
            author: author || "Unknown",
            timestamp,
            message: messageParts.join("\x1f") || shortHash,
            ...(!isDirectory && changedPaths.length > 0 ? { path: changedPaths[changedPaths.length - 1] } : {}),
          }];
        })
    : [];

  return { available: true, isDirectory, relativePath, workingTreeChanges, entries };
}

async function readGitRevision(filePath: string, ref: string): Promise<{
  content: string;
  language: string;
  ref: string;
}> {
  if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("Invalid Git revision");
  const timeline = await readGitTimeline(filePath, false);
  const entry = timeline.entries.find((candidate) => candidate.hash.toLowerCase() === ref.toLowerCase());
  if (!timeline.available || !entry?.path) throw new Error("Revision is not available for this file");

  const options = {
    cwd: path.dirname(filePath),
    encoding: "utf8" as const,
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  };
  const rootResult = await execFileAsync("git", ["rev-parse", "--show-toplevel"], options);
  const repoRoot = rootResult.stdout.trim();
  const candidates = [...new Set([entry.path, timeline.relativePath].filter(Boolean))];
  for (const historicalPath of candidates) {
    try {
      const result = await execFileAsync("git", ["show", `${entry.hash}:${historicalPath}`], {
        ...options,
        cwd: repoRoot,
      });
      return {
        content: result.stdout,
        language: getLanguage(historicalPath),
        ref: entry.shortHash,
      };
    } catch {
      // Rename commits can report either side of the rename. Try the current
      // repository path as a fallback before declaring the revision missing.
    }
  }
  throw new Error("File content is not available in this revision");
}

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function safeRelativeSegments(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeSlashes(value.trim());
  if (!normalized || normalized.startsWith("/") || isWindowsAbsolutePath(normalized)) return null;
  if (/[\u0000-\u001F\u007F]/u.test(normalized)) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments;
}

function existingParentFor(targetPath: string): string {
  let current = path.dirname(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

async function searchWorkspaceEntries(rootPath: string, query: string, allowedRoots: Set<string>) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const results: Array<{ name: string; fullPath: string; relativePath: string; isDir: boolean; size: number }> = [];
  const queue = [rootPath];
  let visited = 0;

  while (queue.length > 0 && results.length < FILE_SEARCH_RESULT_LIMIT && visited < FILE_SEARCH_VISIT_LIMIT) {
    const batch = queue.splice(0, 8);
    const listings = await Promise.all(batch.map(async (directory) => {
      try {
        return {
          directory,
          entries: await fs.promises.readdir(directory, { withFileTypes: true }),
        };
      } catch {
        return { directory, entries: [] as fs.Dirent[] };
      }
    }));

    for (const { directory, entries } of listings) {
      for (const entry of entries) {
        visited += 1;
        if (visited >= FILE_SEARCH_VISIT_LIMIT) break;
        if (IGNORED_NAMES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;

        const fullPath = path.join(directory, entry.name);
        if (!isFilePathAllowed(fullPath, allowedRoots)) continue;
        const relativePath = path.relative(rootPath, fullPath).split(path.sep).join("/");
        if (entry.isDirectory()) queue.push(fullPath);
        if (!relativePath.toLocaleLowerCase().includes(normalizedQuery)) continue;

        results.push({
          name: entry.name,
          fullPath,
          relativePath,
          isDir: entry.isDirectory(),
          size: 0,
        });
        if (results.length >= FILE_SEARCH_RESULT_LIMIT) break;
      }
    }
  }

  return results.sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function realAllowedRoots(allowedRoots: Set<string>): Set<string> {
  const roots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      roots.add(fs.realpathSync(root));
    } catch {
      // stale session root
    }
  }
  return roots;
}

function isAllowedRootItself(filePath: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    try {
      if (fs.realpathSync(filePath) === fs.realpathSync(root)) return true;
    } catch {
      if (path.resolve(filePath) === path.resolve(root)) return true;
    }
  }
  return false;
}

function assertCreateTargetAllowed(targetPath: string, allowedRoots: Set<string>): string | null {
  if (!isFilePathAllowed(targetPath, allowedRoots)) {
    return "Access denied";
  }

  const existingParent = existingParentFor(targetPath);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(existingParent);
  } catch {
    return "Parent directory not found";
  }
  if (!parentStat.isDirectory()) return "Parent path is not a directory";

  const realParent = fs.realpathSync(existingParent);
  const realTarget = path.join(realParent, path.relative(existingParent, targetPath));
  if (!isFilePathAllowed(realTarget, realAllowedRoots(allowedRoots))) {
    return "Resolved path is outside the project";
  }
  return null;
}

function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

async function getUploadDirectory(segments: string[], accountUid: string): Promise<
  { directory: string } | { response: NextResponse }
> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots(accountUid, directory);
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Upload target is not a directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides before writes
  // so a symlink inside an allowed root cannot redirect uploads outside it.
  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale session roots that no longer exist.
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

async function handleUploadPost(
  request: NextRequest,
  segments: string[],
  accountUid: string,
): Promise<NextResponse> {
  try {
    const uploadDirectory = await getUploadDirectory(segments, accountUid);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    const type = request.nextUrl.searchParams.get("type") ?? "upload";

    if (type === "upload-check") {
      const body = await request.json().catch(() => null) as { fileNames?: unknown } | null;
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(inspectUploadTargets(directory, fileNames));
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const inspection = inspectUploadTargets(directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      const destination = path.join(directory, file.name);
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (conflictSet.has(file.name)) {
        try {
          fs.unlinkSync(destination);
        } catch (error) {
          errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }

      try {
        fs.writeFileSync(destination, bytes, { flag: "wx" });
        uploaded.push(file.name);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function createFileBodyStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath, range);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(filePath: string, asDownload = false): string {
  const disposition = asDownload ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function streamFile(filePath: string, stat: fs.Stats, contentType: string, requestHeaders: Headers, asDownload = false): Response {
  const rangeHeader = requestHeaders.get("range");
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "private, no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, asDownload),
    "ETag": etag,
    "Last-Modified": lastModified,
    ...getFileResponseSecurityHeaders(contentType),
  };

  // The PDF viewer may recreate its request after a real content refresh or a
  // tab restore. Validators let it reuse the cached bytes instead of streaming
  // the whole document again. Range responses still carry the same validators.
  if (!rangeHeader) {
    const ifNoneMatch = requestHeaders.get("if-none-match");
    const ifModifiedSince = requestHeaders.get("if-modified-since");
    const notModifiedByTag = ifNoneMatch?.split(",").some((value) => value.trim() === etag || value.trim() === "*") ?? false;
    const modifiedSinceMs = ifModifiedSince ? Date.parse(ifModifiedSince) : NaN;
    const notModifiedByDate = !ifNoneMatch
      && Number.isFinite(modifiedSinceMs)
      && Math.trunc(stat.mtimeMs / 1000) * 1000 <= modifiedSinceMs;
    if (notModifiedByTag || notModifiedByDate) {
      return new Response(null, { status: 304, headers });
    }
  }

  if (!rangeHeader) {
    return new Response(createFileBodyStream(filePath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(filePath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const rawType = request.nextUrl.searchParams.get("type") ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return NextResponse.json({ error: "Invalid file request type" }, { status: 400 });
    }
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots(accountUid, filePath);
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
    const allowedBySessionReference =
      !allowedByRoot &&
      sessionId !== null &&
      accountOwnsSession(accountUid, sessionId) &&
      type !== "list" &&
      await isFilePathReferencedBySession(filePath, sessionId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (type !== "watch") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }

    const existingAuthorizationPath = stat ? filePath : path.dirname(filePath);
    if (
      !allowedBySessionReference
      && !isExistingFilePathAllowed(existingAuthorizationPath, allowedRoots)
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (type === "search") {
      if (!stat?.isDirectory()) {
        return NextResponse.json({ error: "Not a directory" }, { status: 400 });
      }
      const query = request.nextUrl.searchParams.get("q") ?? "";
      return NextResponse.json({ entries: await searchWorkspaceEntries(filePath, query, allowedRoots) });
    }

    if (type === "read") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Image too large for preview (>10MB)" }, { status: 413 });
        }
        return streamFile(filePath, stat, imageMime, request.headers);
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        return streamFile(filePath, stat, audioMime, request.headers);
      }
      const documentMime = getDocumentMime(filePath);
      if (documentMime) {
        return streamFile(filePath, stat, documentMime, request.headers);
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const language = getLanguage(filePath);
      return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs });
    }

    if (type === "origin") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath)) {
        return NextResponse.json({ error: "Origin view is only available for text files" }, { status: 415 });
      }
      if (stat.size > TEXT_EDIT_MAX_BYTES) {
        return NextResponse.json({ error: "File too large for Origin view (>512KB)" }, { status: 413 });
      }
      return NextResponse.json(await readGitOrigin(filePath));
    }

    if (type === "timeline") {
      return NextResponse.json(await readGitTimeline(filePath, stat?.isDirectory() ?? false));
    }

    if (type === "revision") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Git revisions are only available for files" }, { status: 400 });
      }
      const ref = request.nextUrl.searchParams.get("ref") ?? "";
      try {
        return NextResponse.json(await readGitRevision(filePath, ref));
      } catch (error) {
        return NextResponse.json({
          error: error instanceof Error ? error.message : "Unable to read Git revision",
        }, { status: 404 });
      }
    }

    if (type === "download") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
      return streamFile(filePath, stat, mime, request.headers, true);
    }

    if (type === "meta") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return NextResponse.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
      }

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { path: filePath },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (stat && !stat.isFile() && !stat.isDirectory()) {
        return NextResponse.json({ error: "Not a file or directory" }, { status: 400 });
      }
      let watcher: fs.FSWatcher | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let abortHandler: (() => void) | null = null;
      const isDirectory = stat?.isDirectory() ?? false;
      let lastMtimeMs = stat?.mtimeMs ?? 0;
      let lastCtimeMs = stat?.ctimeMs ?? 0;
      let lastIno = stat?.ino ?? 0;
      let lastSize = stat?.size ?? 0;
      let lastExists = stat !== undefined;
      const stopWatching = () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            stopWatching();
            try { controller.close(); } catch { /* already closed */ }
          };
          const send = (eventName: string, data: Record<string, unknown>) => {
            if (closed) return;
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            try {
              controller.enqueue(encoder.encode(payload));
            } catch {
              close();
            }
          };
          try {
            if (isDirectory) {
              const watchHandler = (eventType: string, changedName: string | Buffer | null) => {
                const relativePath = changedName ? normalizeSlashes(String(changedName)) : "";
                if (
                  relativePath
                  && relativePath.split("/").some((segment) => (
                    IGNORED_NAMES.has(segment)
                    || IGNORED_SUFFIXES.some((suffix) => segment.endsWith(suffix))
                  ))
                ) return;
                try {
                  const current = fs.statSync(filePath);
                  send("change", {
                    eventType,
                    path: relativePath,
                    mtime: current.mtime.toISOString(),
                    size: current.size,
                    isDirectory: true,
                  });
                } catch {
                  send("change", {
                    eventType,
                    path: relativePath,
                    mtime: new Date().toISOString(),
                    size: 0,
                    isDirectory: true,
                  });
                }
              };
              try {
                watcher = fs.watch(filePath, { recursive: true }, watchHandler);
              } catch {
                // Older runtimes/filesystems may not support recursive watching.
                watcher = fs.watch(filePath, watchHandler);
              }
            } else {
              const watchedDirectory = path.dirname(filePath);
              watcher = fs.watch(watchedDirectory, (_eventType, changedName) => {
                if (
                  changedName != null
                  && !samePath(path.join(watchedDirectory, changedName.toString()), filePath)
                ) return;
                try {
                  const s = fs.statSync(filePath);
                  // Ignore read/attribute notifications that did not change the file.
                  if (
                    lastExists
                    && s.mtimeMs === lastMtimeMs
                    && s.ctimeMs === lastCtimeMs
                    && s.ino === lastIno
                    && s.size === lastSize
                  ) return;
                  lastExists = true;
                  lastMtimeMs = s.mtimeMs;
                  lastCtimeMs = s.ctimeMs;
                  lastIno = s.ino;
                  lastSize = s.size;
                  send("change", { mtime: s.mtime.toISOString(), size: s.size, isDirectory: false });
                } catch {
                  if (!lastExists) return;
                  lastExists = false;
                  send("change", { mtime: new Date().toISOString(), size: 0, isDirectory: false });
                }
              });
            }
            watcher.on("error", () => {
              close();
            });
            // Publish the snapshot only after the watcher is installed.
            send("connected", { filePath, isDirectory });
            heartbeat = setInterval(() => send("ping", { timestamp: Date.now() }), 25_000);
            abortHandler = close;
            if (request.signal.aborted) close();
            else request.signal.addEventListener("abort", close, { once: true });
          } catch {
            send("error", { message: "Failed to watch file" });
            close();
          }
        },
        cancel() {
          stopWatching();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // type === "list"
    if (!stat?.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    // Avoid per-entry stat calls for normal files and directories. Symlinks and
    // filesystems without directory type information use the stat fallback.
    const dirents = fs.readdirSync(filePath, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(filePath, d.name));
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: 0, modified: "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: filePath });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const allowedRoots = await getAllowedFileRoots(accountUid, filePath);
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let fileStat: fs.Stats;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink()) {
        return NextResponse.json({ error: "Editing symbolic links is not allowed" }, { status: 403 });
      }
      fileStat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    if (getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath)) {
      return NextResponse.json({ error: "This file type is not editable" }, { status: 415 });
    }

    // Resolve the existing file before writing so a path inside an allowed
    // project cannot escape through a symlinked parent directory.
    const realFilePath = fs.realpathSync(filePath);
    const realRoots = new Set<string>();
    for (const root of allowedRoots) {
      try { realRoots.add(fs.realpathSync(root)); } catch { /* stale session root */ }
    }
    if (!isFilePathAllowed(realFilePath, realRoots)) {
      return NextResponse.json({ error: "Resolved file path is outside the project" }, { status: 403 });
    }

    const body = await request.json() as { content?: unknown; expectedMtimeMs?: unknown };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    const byteLength = Buffer.byteLength(body.content, "utf8");
    if (byteLength > TEXT_EDIT_MAX_BYTES) {
      return NextResponse.json({ error: "File is too large to edit (>512KB)" }, { status: 413 });
    }

    if (
      typeof body.expectedMtimeMs === "number"
      && Math.abs(fileStat.mtimeMs - body.expectedMtimeMs) > 0.001
    ) {
      return NextResponse.json({
        error: "File changed on disk since it was opened",
        conflict: true,
        currentContent: fs.readFileSync(filePath, "utf8"),
        currentMtimeMs: fileStat.mtimeMs,
      }, { status: 409 });
    }

    fs.writeFileSync(filePath, body.content, { encoding: "utf8", mode: fileStat.mode });
    const savedStat = fs.statSync(filePath);
    return NextResponse.json({
      ok: true,
      size: savedStat.size,
      mtimeMs: savedStat.mtimeMs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { path: segments } = await params;
    const sourcePath = filePathFromSegments(segments);
    const allowedRoots = await getAllowedFileRoots(accountUid);
    if (!isFilePathAllowed(sourcePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (isAllowedRootItself(sourcePath, allowedRoots)) {
      return NextResponse.json({ error: "Moving the project root is not allowed" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({})) as {
      destinationDirectory?: unknown;
      newName?: unknown;
      overwrite?: unknown;
    };
    if (typeof body.destinationDirectory !== "string" || !body.destinationDirectory.trim()) {
      return NextResponse.json({ error: "destinationDirectory is required" }, { status: 400 });
    }
    const destinationDirectory = path.resolve(normalizeSlashes(body.destinationDirectory.trim()));
    if (!isFilePathAllowed(destinationDirectory, allowedRoots)) {
      return NextResponse.json({ error: "Destination is outside the allowed project roots" }, { status: 403 });
    }

    let sourceStat: fs.Stats;
    let destinationStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(sourcePath);
    } catch {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
      return NextResponse.json({ error: "Only regular files and directories can be moved" }, { status: 400 });
    }
    try {
      destinationStat = fs.lstatSync(destinationDirectory);
    } catch {
      return NextResponse.json({ error: "Destination directory not found" }, { status: 404 });
    }
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
      return NextResponse.json({ error: "Destination is not a regular directory" }, { status: 400 });
    }

    const realRoots = realAllowedRoots(allowedRoots);
    const realSource = fs.realpathSync(sourcePath);
    const realDestination = fs.realpathSync(destinationDirectory);
    if (!isFilePathAllowed(realSource, realRoots) || !isFilePathAllowed(realDestination, realRoots)) {
      return NextResponse.json({ error: "Resolved path is outside the project" }, { status: 403 });
    }
    if (sourceStat.isDirectory()) {
      const relativeDestination = path.relative(realSource, realDestination);
      if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
        return NextResponse.json({ error: "A folder cannot be moved into itself or one of its subfolders" }, { status: 400 });
      }
    }

    let targetName = path.basename(sourcePath);
    if (body.newName !== undefined) {
      const nameSegments = safeRelativeSegments(body.newName);
      if (!nameSegments || nameSegments.length !== 1) {
        return NextResponse.json({ error: "Invalid file or folder name" }, { status: 400 });
      }
      targetName = nameSegments[0];
    }
    const targetPath = path.join(destinationDirectory, targetName);
    if (path.resolve(targetPath) === path.resolve(sourcePath)) {
      return NextResponse.json({ ok: true, path: sourcePath, previousPath: sourcePath, isDir: sourceStat.isDirectory(), unchanged: true });
    }
    const targetError = assertCreateTargetAllowed(targetPath, allowedRoots);
    if (targetError) return NextResponse.json({ error: targetError }, { status: 403 });

    let replacingExistingFile = false;
    if (fs.existsSync(targetPath)) {
      const targetStat = fs.lstatSync(targetPath);
      if (targetStat.isSymbolicLink()) {
        return NextResponse.json({ error: "Replacing symbolic links is not allowed" }, { status: 403 });
      }
      if (body.overwrite !== true) {
        return NextResponse.json({
          error: `"${path.basename(targetPath)}" already exists in the destination`,
          conflict: true,
          canOverwrite: sourceStat.isFile() && targetStat.isFile(),
          targetPath,
        }, { status: 409 });
      }
      if (!sourceStat.isFile() || !targetStat.isFile()) {
        return NextResponse.json({ error: "Folders cannot replace or merge with an existing item" }, { status: 409 });
      }
      replacingExistingFile = true;
    }

    try {
      fs.renameSync(sourcePath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (replacingExistingFile && (code === "EEXIST" || code === "EPERM")) {
        // Windows does not replace an existing file with rename(). The target
        // is removed only after the source rename has been attempted normally.
        fs.unlinkSync(targetPath);
        fs.renameSync(sourcePath, targetPath);
        return NextResponse.json({ ok: true, path: targetPath, previousPath: sourcePath, isDir: false, unchanged: false });
      }
      if (code !== "EXDEV") throw error;
      fs.cpSync(sourcePath, targetPath, {
        recursive: sourceStat.isDirectory(),
        errorOnExist: !replacingExistingFile,
        force: replacingExistingFile,
      });
      fs.rmSync(sourcePath, { recursive: sourceStat.isDirectory(), force: false });
    }

    return NextResponse.json({
      ok: true,
      path: targetPath,
      previousPath: sourcePath,
      isDir: sourceStat.isDirectory(),
      unchanged: false,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { path: segments } = await params;
    const postType = request.nextUrl.searchParams.get("type");
    const isMultipart = request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data") ?? false;
    if (postType === "upload" || postType === "upload-check" || (postType === null && isMultipart)) {
      return handleUploadPost(request, segments, accountUid);
    }
    if (postType !== null) {
      return NextResponse.json({ error: "Invalid file request type" }, { status: 400 });
    }
    const parentPath = filePathFromSegments(segments);
    const allowedRoots = await getAllowedFileRoots(accountUid, parentPath);
    if (!isFilePathAllowed(parentPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let parentStat: fs.Stats;
    try {
      parentStat = fs.statSync(parentPath);
    } catch {
      return NextResponse.json({ error: "Parent directory not found" }, { status: 404 });
    }
    if (!parentStat.isDirectory()) {
      return NextResponse.json({ error: "Parent path is not a directory" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({})) as { name?: unknown; kind?: unknown; content?: unknown };
    const kind: CreateKind = body.kind === "directory" ? "directory" : "file";
    const childSegments = safeRelativeSegments(body.name);
    if (!childSegments) {
      return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    }

    const targetPath = path.resolve(parentPath, ...childSegments);
    const allowedError = assertCreateTargetAllowed(targetPath, allowedRoots);
    if (allowedError) {
      return NextResponse.json({ error: allowedError }, { status: 403 });
    }
    if (fs.existsSync(targetPath)) {
      return NextResponse.json({ error: "File or directory already exists" }, { status: 409 });
    }

    if (kind === "directory") {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      const content = typeof body.content === "string" ? body.content : "";
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > TEXT_EDIT_MAX_BYTES) {
        return NextResponse.json({ error: "File is too large to create (>512KB)" }, { status: 413 });
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    }

    const stat = fs.statSync(targetPath);
    return NextResponse.json({
      ok: true,
      path: targetPath,
      name: path.basename(targetPath),
      isDir: stat.isDirectory(),
      size: stat.isFile() ? stat.size : 0,
      modified: stat.mtime.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const allowedRoots = await getAllowedFileRoots(accountUid, filePath);
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (isAllowedRootItself(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Deleting the project root is not allowed" }, { status: 400 });
    }

    let linkStat: fs.Stats;
    try {
      linkStat = fs.lstatSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (linkStat.isSymbolicLink()) {
      return NextResponse.json({ error: "Deleting symbolic links is not allowed" }, { status: 403 });
    }

    const realFilePath = fs.realpathSync(filePath);
    if (!isFilePathAllowed(realFilePath, realAllowedRoots(allowedRoots))) {
      return NextResponse.json({ error: "Resolved path is outside the project" }, { status: 403 });
    }

    if (linkStat.isDirectory()) {
      const recursive = request.nextUrl.searchParams.get("recursive") === "true";
      const entries = fs.readdirSync(filePath);
      if (entries.length > 0 && !recursive) {
        return NextResponse.json({ error: "Directory is not empty", needsRecursive: true }, { status: 409 });
      }
      fs.rmSync(filePath, { recursive, force: false });
      return NextResponse.json({ ok: true, path: filePath, isDir: true });
    }

    if (!linkStat.isFile()) {
      return NextResponse.json({ error: "Only files and directories can be deleted" }, { status: 400 });
    }

    fs.unlinkSync(filePath);
    return NextResponse.json({ ok: true, path: filePath, isDir: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
