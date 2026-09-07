import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";

export type WebTerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

interface WebTerminalSession {
  id: string;
  ownerUid: string;
  cwd: string;
  process: pty.IPty;
  /** Kept optional so hot-reloaded development sessions can migrate in place. */
  history?: string;
  historyChunks: string[];
  historyChars: number;
  eventHistory: WebTerminalEvent[];
  listeners: Set<(event: WebTerminalEvent) => void>;
  lastActivityAt: number;
  exited: boolean;
}

declare global {
  var __piWebTerminals: Map<string, WebTerminalSession> | undefined;
  var __piWebTerminalCleanup: ReturnType<typeof setInterval> | undefined;
}

const MAX_TERMINALS_PER_ACCOUNT = 8;
const MAX_HISTORY_CHARS = 250_000;
const MAX_HISTORY_CHUNKS = 256;
const IDLE_TIMEOUT_MS = 30 * 60_000;

function registry(): Map<string, WebTerminalSession> {
  if (!(globalThis.__piWebTerminals instanceof Map)) globalThis.__piWebTerminals = new Map();
  if (!globalThis.__piWebTerminalCleanup) {
    globalThis.__piWebTerminalCleanup = setInterval(() => {
      const cutoff = Date.now() - IDLE_TIMEOUT_MS;
      for (const session of registry().values()) {
        if (session.lastActivityAt < cutoff) closeWebTerminal(session.ownerUid, session.id);
      }
    }, 60_000);
    globalThis.__piWebTerminalCleanup.unref?.();
  }
  return globalThis.__piWebTerminals;
}

async function sandboxCommand(accountUid: string, cwd: string): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const roots = await getAllowedFileRoots(accountUid);
  if (!isFilePathAllowed(cwd, roots)) throw new Error("Terminal cwd is outside the allowed project roots");
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) throw new Error("Terminal cwd is not a directory");
  const configuredShell = process.env.SHELL;
  const command = configuredShell && path.isAbsolute(configuredShell) && fs.existsSync(configuredShell)
    ? configuredShell
    : "/bin/bash";
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    command,
    args: ["-i"],
    env: {
      ...env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  };
}

function ensureHistoryBuffer(session: WebTerminalSession): void {
  if (Array.isArray(session.historyChunks) && Number.isFinite(session.historyChars)) return;
  const legacyHistory = typeof session.history === "string"
    ? session.history.slice(-MAX_HISTORY_CHARS)
    : "";
  session.historyChunks = legacyHistory ? [legacyHistory] : [];
  session.historyChars = legacyHistory.length;
  delete session.history;
}

function appendHistory(session: WebTerminalSession, data: string): void {
  if (!data) return;
  ensureHistoryBuffer(session);
  session.historyChunks.push(data);
  session.historyChars += data.length;

  // Compact periodically instead of copying the entire retained history for
  // every PTY chunk. This keeps long-running terminals from causing GC stalls.
  if (session.historyChars > MAX_HISTORY_CHARS || session.historyChunks.length >= MAX_HISTORY_CHUNKS) {
    const compacted = session.historyChunks.join("").slice(-MAX_HISTORY_CHARS);
    session.historyChunks = compacted ? [compacted] : [];
    session.historyChars = compacted.length;
  }
}

function publish(session: WebTerminalSession, event: WebTerminalEvent): void {
  session.lastActivityAt = Date.now();
  if (event.type === "output") {
    appendHistory(session, event.data);
  } else if (event.type === "exit") {
    session.eventHistory.push(event);
    session.eventHistory = session.eventHistory.slice(-4);
  }
  session.listeners.forEach((listener) => listener(event));
}

export async function createWebTerminal(accountUid: string, cwd: string, cols = 100, rows = 24) {
  const activeCount = [...registry().values()].filter((session) => session.ownerUid === accountUid && !session.exited).length;
  if (activeCount >= MAX_TERMINALS_PER_ACCOUNT) throw new Error(`At most ${MAX_TERMINALS_PER_ACCOUNT} terminals may be open`);
  const launch = await sandboxCommand(accountUid, cwd);
  const id = randomUUID();
  const child = pty.spawn(launch.command, launch.args, {
    name: "xterm-256color",
    cols: Math.max(20, Math.min(400, Math.floor(cols))),
    rows: Math.max(5, Math.min(160, Math.floor(rows))),
    cwd,
    env: launch.env,
  });
  const session: WebTerminalSession = {
    id,
    ownerUid: accountUid,
    cwd,
    process: child,
    historyChunks: [],
    historyChars: 0,
    eventHistory: [],
    listeners: new Set(),
    lastActivityAt: Date.now(),
    exited: false,
  };
  registry().set(id, session);
  child.onData((data) => publish(session, { type: "output", data }));
  child.onExit(({ exitCode, signal }) => {
    session.exited = true;
    publish(session, { type: "exit", exitCode, signal });
  });
  return { id, cwd };
}

export function getWebTerminal(accountUid: string, id: string): WebTerminalSession | null {
  const session = registry().get(id);
  return session?.ownerUid === accountUid ? session : null;
}

export function writeWebTerminal(accountUid: string, id: string, data: string): void {
  const session = getWebTerminal(accountUid, id);
  if (!session || session.exited) throw new Error("Terminal not found or already exited");
  session.lastActivityAt = Date.now();
  session.process.write(data);
}

export function resizeWebTerminal(accountUid: string, id: string, cols: number, rows: number): void {
  const session = getWebTerminal(accountUid, id);
  if (!session || session.exited) return;
  session.process.resize(
    Math.max(20, Math.min(400, Math.floor(cols))),
    Math.max(5, Math.min(160, Math.floor(rows))),
  );
}

export function subscribeWebTerminal(accountUid: string, id: string, listener: (event: WebTerminalEvent) => void): (() => void) | null {
  const session = getWebTerminal(accountUid, id);
  if (!session) return null;
  ensureHistoryBuffer(session);
  if (session.historyChars > 0) listener({ type: "output", data: session.historyChunks.join("") });
  session.eventHistory.forEach(listener);
  session.listeners.add(listener);
  session.lastActivityAt = Date.now();
  return () => session.listeners.delete(listener);
}

export function closeWebTerminal(accountUid: string, id: string): boolean {
  const session = getWebTerminal(accountUid, id);
  if (!session) return false;
  registry().delete(id);
  if (!session.exited) {
    try { session.process.kill(); } catch { /* already exited */ }
  }
  session.listeners.clear();
  return true;
}
