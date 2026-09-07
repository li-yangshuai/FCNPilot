"use client";

import { useMemo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import {
  openDocument,
  parseDocumentHref,
  parseDocumentPageAnchor,
  type AttachedDocument,
  type DocumentOpenDetail,
} from "@/lib/docqa";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  docQaDocuments?: AttachedDocument[];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function basename(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() || filePath;
}

function inferDocumentForAnchor(documents: AttachedDocument[] | undefined, label: string): AttachedDocument | null {
  const pdfDocuments = documents?.filter((document) => document.kind.toLowerCase() === "pdf") ?? [];
  if (pdfDocuments.length === 0) return null;
  if (pdfDocuments.length === 1) return pdfDocuments[0];

  const normalizedLabel = label.toLowerCase();
  return pdfDocuments.find((document) => {
    const names = [document.name, basename(document.path)].filter(Boolean).map((name) => name.toLowerCase());
    return names.some((name) => normalizedLabel.includes(name));
  }) ?? null;
}

function renderDocumentLink(document: DocumentOpenDetail, children: ReactNode) {
  return (
    <button
      type="button"
      title={`Open cited source${document.location ? ` at ${document.location}` : ""}`}
      onClick={() => openDocument(document)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        margin: "0 2px", padding: "1px 6px",
        border: "1px solid rgba(59,130,246,0.28)", borderRadius: 5,
        background: "rgba(59,130,246,0.08)", color: "var(--accent)",
        cursor: "pointer", font: "inherit", fontSize: "0.88em",
        textDecoration: "none", verticalAlign: "baseline",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      {children}
    </button>
  );
}

export function MarkdownBody({ children, className, isStreaming, docQaDocuments, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;

      const linkedDocument = href ? parseDocumentHref(href) : null;
      if (linkedDocument) return renderDocumentLink(linkedDocument, children);

      if (href) {
        const location = parseDocumentPageAnchor(href);
        const inferredDocument = location
          ? inferDocumentForAnchor(docQaDocuments, nodeText(children))
          : null;
        if (inferredDocument && location) {
          return renderDocumentLink({ path: inferredDocument.path, location }, children);
        }
      }

      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, docQaDocuments, isStreaming, onOpenFile]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
