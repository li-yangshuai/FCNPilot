import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface ClangdCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value?: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  textEdit?: {
    newText?: string;
    range?: LspRange;
    insert?: LspRange;
    replace?: LspRange;
  };
  additionalTextEdits?: Array<{ newText: string; range: LspRange }>;
}

export interface ClangdDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

declare global {
  var __piClangdManagers: Map<string, ClangdManager> | undefined;
}

function findClangd(): string | null {
  const candidates = [
    process.env.CLANGD_PATH,
    path.join(homedir(), ".local", "bin", "clangd"),
    path.join(homedir(), ".local", "share", "pi-web", "clangd-venv", "bin", "clangd"),
    "/usr/bin/clangd",
    "/usr/local/bin/clangd",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync("which", ["clangd"], { encoding: "utf8" }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch { /* not available on PATH */ }
  return null;
}

function languageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".c") return "c";
  if (extension === ".m") return "objective-c";
  if (extension === ".mm") return "objective-cpp";
  return "cpp";
}

export class ClangdManager {
  private process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private versions = new Map<string, number>();
  private diagnostics = new Map<string, ClangdDiagnostic[]>();
  private initialized: Promise<void>;
  private alive = true;

  constructor(readonly root: string, executable: string) {
    this.process = spawn(executable, [
      "--background-index",
      "--clang-tidy",
      "--completion-style=detailed",
      "--header-insertion=iwyu",
      "--query-driver=/usr/bin/g++,/usr/bin/gcc,/usr/local/bin/g++,/usr/local/bin/gcc",
    ], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on("data", () => { /* clangd logs are intentionally quiet */ });
    this.process.on("error", () => {
      this.alive = false;
    });
    this.process.on("exit", (code) => {
      this.alive = false;
      const error = new Error(`clangd exited${code == null ? "" : ` with code ${code}`}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
    });
    this.initialized = this.initialize();
  }

  isAlive(): boolean {
    return this.alive && !this.process.killed;
  }

  private send(message: JsonRpcMessage): void {
    const json = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`clangd request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
            contextSupport: true,
          },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: true },
      },
    });
    this.notify("initialized", {});
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + bodyLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed server output and continue parsing subsequent frames.
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "clangd request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: ClangdDiagnostic[] } | undefined;
      if (params?.uri && Array.isArray(params.diagnostics)) {
        this.diagnostics.set(params.uri, params.diagnostics);
      }
    }
  }

  async sync(filePath: string, content: string): Promise<string> {
    await this.initialized;
    const uri = pathToFileURL(filePath).href;
    const previousVersion = this.versions.get(uri);
    const version = (previousVersion ?? 0) + 1;
    this.versions.set(uri, version);
    if (previousVersion === undefined) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(filePath), version, text: content },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    return uri;
  }

  async complete(
    filePath: string,
    content: string,
    position: LspPosition,
    triggerKind?: number,
    triggerCharacter?: string,
  ): Promise<ClangdCompletionItem[]> {
    const uri = await this.sync(filePath, content);
    const result = await this.request("textDocument/completion", {
      textDocument: { uri },
      position,
      context: {
        triggerKind: triggerKind ?? 1,
        ...(triggerCharacter ? { triggerCharacter } : {}),
      },
    }) as ClangdCompletionItem[] | { items?: ClangdCompletionItem[] } | null;
    if (Array.isArray(result)) return result;
    return result?.items ?? [];
  }

  getDiagnostics(filePath: string): ClangdDiagnostic[] {
    return this.diagnostics.get(pathToFileURL(filePath).href) ?? [];
  }
}

export function getClangdManager(root: string): ClangdManager {
  const executable = findClangd();
  if (!executable) {
    throw new Error("clangd is not installed. Set CLANGD_PATH or install clangd to enable C/C++ IntelliSense.");
  }
  if (!globalThis.__piClangdManagers) globalThis.__piClangdManagers = new Map();
  const normalizedRoot = path.resolve(root);
  const existing = globalThis.__piClangdManagers.get(normalizedRoot);
  if (existing?.isAlive()) return existing;
  const manager = new ClangdManager(normalizedRoot, executable);
  globalThis.__piClangdManagers.set(normalizedRoot, manager);
  return manager;
}
