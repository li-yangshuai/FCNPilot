import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { readIfcnWorkspaceConfiguration } from "./ifcn-workspace";
import { getProjectTrustStatus } from "./project-trust";
import type { IfcnRunArtifact, IfcnRunDetail, IfcnRunSummary } from "./ifcn-results-types";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const RUN_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class IfcnResultsError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "IfcnResultsError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function relativeSegments(value: unknown): string[] {
  if (typeof value !== "string" || !value || /[\\:\u0000-\u001f\u007f]/u.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new IfcnResultsError("电路结果文件路径无效", 400);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new IfcnResultsError("电路结果文件路径无效", 400);
  }
  return segments;
}

function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new IfcnResultsError("电路运行编号无效", 400);
}

/** Every path component is checked, including output/, the run, and manifest. */
function resolveResultPath(engineRoot: string, segments: string[]): string {
  const root = path.resolve(engineRoot);
  let current = root;
  for (const [index, segment] of ["", ...segments].entries()) {
    if (segment) current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new IfcnResultsError("电路结果文件不存在", 404);
    }
    if (stat.isSymbolicLink() || (index <= segments.length - 1 && !stat.isDirectory())) {
      throw new IfcnResultsError("电路结果不能通过符号链接或其他文件跳转访问", 403);
    }
  }
  if (realpathSync(current) !== current) throw new IfcnResultsError("电路结果路径已发生变化", 403);
  return current;
}

function readBoundedFile(filename: string, maximumBytes: number): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new IfcnResultsError("无法读取电路结果文件", 404);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new IfcnResultsError("电路结果不是普通文件", 403);
    if (stat.size > maximumBytes) throw new IfcnResultsError("电路结果文件超过预览和下载大小限制", 413);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (offset !== stat.size || readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new IfcnResultsError("电路结果正在更新，请稍后重试", 409);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readManifest(engineRoot: string, id: string): Record<string, unknown> {
  assertRunId(id);
  const filename = resolveResultPath(engineRoot, ["output", "pi-runs", id, "manifest.json"]);
  let value;
  try {
    value = JSON.parse(readBoundedFile(filename, MAX_MANIFEST_BYTES).toString("utf8"));
  } catch (error) {
    if (error instanceof IfcnResultsError) throw error;
    throw new IfcnResultsError("电路运行清单无效或正在更新", 409);
  }
  const manifest = record(value);
  if (manifest.schema !== "ifcn.pi.run.v1" || manifest.run_id !== id) {
    throw new IfcnResultsError("电路运行清单与编号不一致", 409);
  }
  return manifest;
}

function artifactEntry(value: unknown): { path: string; bytes: number; sha256: string } {
  const item = record(value);
  relativeSegments(item.path);
  if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0
    || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) {
    throw new IfcnResultsError("电路结果清单缺少有效的长度或校验值", 409);
  }
  return { path: item.path as string, bytes: item.bytes as number, sha256: item.sha256 };
}

function artifactMetadata(id: string, name: string, value: unknown): IfcnRunArtifact {
  relativeSegments(name);
  const item = artifactEntry(value);
  const extension = path.posix.extname(item.path).toLowerCase();
  const preview = extension === ".svg" ? "svg" : extension === ".qca" ? "qca" : extension === ".ifcn" ? "ifcn" : null;
  const mediaType = extension === ".svg" ? "image/svg+xml"
    : extension === ".json" ? "application/json"
      : [".qca", ".ifcn", ".v", ".dot", ".tex", ".txt", ".rst", ".csv"].includes(extension)
        ? "text/plain; charset=utf-8" : "application/octet-stream";
  const downloadUrl = `/api/ifcn/runs/${id}/artifacts?name=${encodeURIComponent(name)}`;
  return { name, bytes: item.bytes, sha256: item.sha256, mediaType, preview, downloadUrl,
    previewUrl: preview ? `${downloadUrl}&preview=1` : null };
}

function artifactsFromManifest(id: string, manifest: Record<string, unknown>): IfcnRunArtifact[] {
  return Object.entries(record(manifest.artifacts)).flatMap(([name, item]) => {
    try { return [artifactMetadata(id, name, item)]; } catch { return []; }
  });
}

function runSummary(id: string, manifest: Record<string, unknown>): IfcnRunSummary {
  const frontend = record(manifest.frontend);
  const selection = record(record(manifest.metrics).algorithm_selection);
  const source = text(manifest.source) ?? "";
  const optimizationPolicy = text(record(manifest.optimization).policy);
  return {
    id,
    module: text(frontend.module) ?? (path.posix.basename(source).replace(/\.v$/i, "") || id.slice(0, 8)),
    sourceName: path.posix.basename(source),
    designType: manifest.design_type === "combinational" || manifest.design_type === "sequential" ? manifest.design_type : null,
    status: text(manifest.status) ?? "unknown",
    currentStage: text(manifest.current_stage),
    createdAt: text(manifest.created_at),
    updatedAt: text(manifest.updated_at),
    algorithm: text(selection.selected_algorithm) ?? text(record(manifest.parameters).algorithm),
    optimizationPolicy: optimizationPolicy && ["llm", "noop", "random", "heuristic"].includes(optimizationPolicy) ? optimizationPolicy as IfcnRunSummary["optimizationPolicy"] : null,
    clockScheme: text(record(record(manifest.metrics).pnr).clock_scheme),
    artifactCount: artifactsFromManifest(id, manifest).length,
  };
}

/** Reads only this server's configured and trusted engine; never runs engine code. */
export async function authorizeIfcnResults(accountUid: string): Promise<string> {
  if (!accountUid) throw new IfcnResultsError("请先登录", 401);
  const configuration = readIfcnWorkspaceConfiguration();
  if (!configuration.valid || !configuration.cwd) {
    throw new IfcnResultsError(configuration.message ?? "FCN 电路设计工程尚未配置", 503);
  }
  const root = configuration.cwd;
  allowFileRoot(accountUid, root);
  if (!isExistingFilePathAllowed(root, await getAllowedFileRoots(accountUid, root))) {
    throw new IfcnResultsError("当前账户无权访问 FCN 电路结果", 403);
  }
  if (!getProjectTrustStatus(root, getAgentDir()).trusted) {
    throw new IfcnResultsError("请先确认信任 FCN 电路设计工程", 403);
  }
  return root;
}

export function listIfcnRuns(engineRoot: string, limit = 100): { runs: IfcnRunSummary[]; total: number } {
  let directory: string;
  try {
    directory = resolveResultPath(engineRoot, ["output", "pi-runs"]);
  } catch (error) {
    if (error instanceof IfcnResultsError && error.status === 404) return { runs: [], total: 0 };
    throw error;
  }
  const runs = readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) return [];
    try { return [runSummary(entry.name, readManifest(engineRoot, entry.name))]; } catch { return []; }
  });
  runs.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return { runs: runs.slice(0, Math.min(100, Math.max(1, limit))), total: runs.length };
}

export function readIfcnRun(engineRoot: string, id: string): IfcnRunDetail {
  const manifest = readManifest(engineRoot, id);
  return {
    ...runSummary(id, manifest),
    stages: Object.entries(record(manifest.stages)).map(([stageId, value]) => {
      const stage = record(value);
      return { id: stageId, status: text(stage.status) ?? "unknown",
        attempt: typeof stage.attempt === "number" ? stage.attempt : 0,
        ...(text(stage.started_at) ? { startedAt: stage.started_at as string } : {}),
        ...(text(stage.completed_at) ? { completedAt: stage.completed_at as string } : {}),
      };
    }),
    metrics: record(manifest.metrics),
    validation: record(manifest.validation),
    requestedUntil: text(manifest.requested_until),
    error: text(manifest.error),
    artifacts: artifactsFromManifest(id, manifest),
  };
}

export function readIfcnArtifact(engineRoot: string, id: string, name: string): {
  bytes: Buffer; artifact: IfcnRunArtifact;
} {
  relativeSegments(name);
  const manifest = readManifest(engineRoot, id);
  const artifacts = record(manifest.artifacts);
  if (!Object.hasOwn(artifacts, name)) throw new IfcnResultsError("文件未列入此电路运行的结果清单", 404);
  const item = artifactEntry(artifacts[name]);
  const segments = ["output", "pi-runs", id, ...relativeSegments(item.path)];
  const filename = resolveResultPath(engineRoot, segments);
  const bytes = readBoundedFile(filename, MAX_ARTIFACT_BYTES);
  // Recheck all components after opening; hashes are verified over these exact
  // response bytes, never a separate read or a manifest-supplied absolute path.
  if (resolveResultPath(engineRoot, segments) !== filename
    || bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
    throw new IfcnResultsError("电路结果校验失败，文件已变化；请重新运行或刷新结果", 409);
  }
  return { bytes, artifact: artifactMetadata(id, name, artifacts[name]) };
}

export function ifcnArtifactHeaders(artifact: IfcnRunArtifact, preview: boolean): Record<string, string> {
  const inline = preview && artifact.preview !== null;
  const filename = path.posix.basename(artifact.name);
  const fallback = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return {
    "Content-Type": artifact.mediaType,
    "Content-Length": String(artifact.bytes),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  };
}
