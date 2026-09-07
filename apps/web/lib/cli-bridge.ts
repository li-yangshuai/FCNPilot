import { randomUUID } from "crypto";
import { realpathSync } from "fs";
import path from "path";
import type { AccountIdentity } from "./accounts";

export interface CliBridgeRegistration {
  clientId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  accountUid?: string;
  username?: string;
  pairingToken?: string;
  sessionName?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  model?: { id: string; provider: string } | null;
  thinkingLevel?: string;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  activeTools?: string[];
}

export interface CliBridgeCommand {
  id: string;
  command: Record<string, unknown>;
}

type EventListener = (event: Record<string, unknown>) => void;
type RunningListener = (runningIds: string[], connectedIds: string[]) => void;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CommandWaiter {
  resolve: (commands: CliBridgeCommand[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CliBridgeRecord {
  registration: CliBridgeRegistration;
  connectedAt: number;
  lastSeen: number;
  listeners: Set<EventListener>;
  commandQueue: CliBridgeCommand[];
  commandWaiters: Set<CommandWaiter>;
  pendingCommands: Map<string, PendingCommand>;
}

declare global {
  var __piCliBridges: Map<string, CliBridgeRecord> | undefined;
  var __piCliRunningListeners: Set<RunningListener> | undefined;
  var __piCliPairings: Map<string, CliBridgePairing> | undefined;
}

const BRIDGE_STALE_MS = 45_000;
const COMMAND_TIMEOUT_MS = 35_000;
const COMMAND_POLL_MS = 20_000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface CliBridgePairing extends AccountIdentity {
  cwd: string;
  createdAt: number;
  expiresAt: number;
  clientId?: string;
}

export interface CliBridgePairingClaim extends AccountIdentity {
  cwd: string;
  createdAt: number;
}

function canonicalWorkspacePath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function getPairings(): Map<string, CliBridgePairing> {
  if (!(globalThis.__piCliPairings instanceof Map)) globalThis.__piCliPairings = new Map();
  const now = Date.now();
  for (const [token, pairing] of globalThis.__piCliPairings) {
    if (pairing.expiresAt <= now) globalThis.__piCliPairings.delete(token);
  }
  return globalThis.__piCliPairings;
}

export function createCliBridgePairing(account: AccountIdentity, cwd: string): string {
  const token = randomUUID();
  const now = Date.now();
  getPairings().set(token, {
    ...account,
    cwd: canonicalWorkspacePath(cwd),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  });
  return token;
}

export function claimCliBridgePairing(token: string, clientId: string, cwd: string): CliBridgePairingClaim | null {
  if (!token || !clientId) return null;
  const pairings = getPairings();
  const pairing = pairings.get(token);
  if (!pairing || pairing.cwd !== canonicalWorkspacePath(cwd)) return null;
  if (pairing.clientId && pairing.clientId !== clientId) {
    // A CLI process can die after claiming a token but before completing its
    // registration. Permit that same secret to be reused while it is valid,
    // but never let it replace a live bridge.
    const tokenHasLiveBridge = Array.from(getRegistry().values()).some(
      (record) => record.registration.pairingToken === token,
    );
    if (tokenHasLiveBridge) return null;
  }
  pairing.clientId = clientId;
  pairing.expiresAt = Date.now() + PAIRING_TTL_MS;
  return {
    uid: pairing.uid,
    username: pairing.username,
    cwd: pairing.cwd,
    createdAt: pairing.createdAt,
  };
}

export function getCliBridgeToken(req: Request): string {
  return req.headers.get("x-pi-web-bridge-token")?.trim() ?? "";
}

function getRegistry(): Map<string, CliBridgeRecord> {
  if (!globalThis.__piCliBridges) globalThis.__piCliBridges = new Map();
  return globalThis.__piCliBridges;
}

function getRunningListeners(): Set<RunningListener> {
  if (!globalThis.__piCliRunningListeners) globalThis.__piCliRunningListeners = new Set();
  return globalThis.__piCliRunningListeners;
}

function rejectPending(record: CliBridgeRecord, reason: string): void {
  for (const pending of record.pendingCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  record.pendingCommands.clear();
  for (const waiter of record.commandWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve([]);
  }
  record.commandWaiters.clear();
}

function pruneStaleBridges(): void {
  const now = Date.now();
  let changed = false;
  for (const [sessionId, record] of getRegistry()) {
    if (now - record.lastSeen <= BRIDGE_STALE_MS) continue;
    rejectPending(record, "CLI bridge disconnected");
    getRegistry().delete(sessionId);
    for (const listener of [...record.listeners]) {
      listener({ type: "cli_bridge_disconnected", sessionId, reason: "CLI bridge timed out" });
    }
    record.listeners.clear();
    changed = true;
  }
  if (changed) notifyCliRunningChange();
}

function findBridge(sessionId: string, clientId?: string, pairingToken?: string): CliBridgeRecord | undefined {
  pruneStaleBridges();
  const record = getRegistry().get(sessionId);
  if (!record) return undefined;
  if (clientId && record.registration.clientId !== clientId) return undefined;
  if (pairingToken !== undefined && record.registration.pairingToken !== pairingToken) return undefined;
  if (clientId && pairingToken) {
    const pairing = getPairings().get(pairingToken);
    if (pairing?.clientId === clientId) pairing.expiresAt = Date.now() + PAIRING_TTL_MS;
  }
  return record;
}

function wakeCommandWaiters(record: CliBridgeRecord): void {
  if (record.commandQueue.length === 0) return;
  const commands = record.commandQueue.splice(0);
  for (const waiter of record.commandWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(commands);
    break;
  }
  record.commandWaiters.clear();
}

export function registerCliBridge(registration: CliBridgeRegistration): void {
  const registry = getRegistry();
  const existing = registry.get(registration.sessionId);
  if (existing && existing.registration.clientId !== registration.clientId) {
    removeCliBridge(registration.sessionId, existing, "CLI bridge was replaced by another client");
  }

  const record = existing?.registration.clientId === registration.clientId
    ? existing
    : {
        registration,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        listeners: new Set<EventListener>(),
        commandQueue: [],
        commandWaiters: new Set<CommandWaiter>(),
        pendingCommands: new Map<string, PendingCommand>(),
      };

  record.registration = {
    ...record.registration,
    ...registration,
  };
  record.lastSeen = Date.now();
  registry.set(registration.sessionId, record);
  notifyCliRunningChange();
}

export function touchCliBridge(
  sessionId: string,
  clientId: string,
  pairingToken: string,
  state?: Partial<CliBridgeRegistration>,
): boolean {
  const record = findBridge(sessionId, clientId, pairingToken);
  if (!record) return false;
  record.lastSeen = Date.now();
  if (state) {
    const {
      sessionName,
      isStreaming,
      isCompacting,
      model,
      thinkingLevel,
      contextUsage,
      systemPrompt,
      activeTools,
    } = state;
    record.registration = {
      ...record.registration,
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(isStreaming !== undefined ? { isStreaming } : {}),
      ...(isCompacting !== undefined ? { isCompacting } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(activeTools !== undefined ? { activeTools } : {}),
    };
  }
  notifyCliRunningChange();
  return true;
}

export function unregisterCliBridge(sessionId: string, clientId: string, pairingToken: string): void {
  const record = findBridge(sessionId, clientId, pairingToken);
  if (!record) return;
  removeCliBridge(sessionId, record, "CLI bridge disconnected");
}

function removeCliBridge(sessionId: string, record: CliBridgeRecord, reason: string): void {
  rejectPending(record, reason);
  getRegistry().delete(sessionId);
  for (const listener of record.listeners) {
    listener({ type: "cli_bridge_disconnected", sessionId, reason });
  }
  record.listeners.clear();
  notifyCliRunningChange();
}

export function revokeCliBridgesForAccount(accountUid: string): void {
  const pairings = getPairings();
  for (const [token, pairing] of pairings) {
    if (pairing.uid === accountUid) pairings.delete(token);
  }
  for (const [sessionId, record] of getRegistry()) {
    if (record.registration.accountUid === accountUid) {
      removeCliBridge(sessionId, record, "Account access was revoked");
    }
  }
}

export function getCliBridgeState(sessionId: string): CliBridgeRegistration | null {
  return findBridge(sessionId)?.registration ?? null;
}

export function getCliBridgeAgentState(sessionId: string): Record<string, unknown> | null {
  const bridge = getCliBridgeState(sessionId);
  if (!bridge) return null;
  return {
    sessionId: bridge.sessionId,
    sessionFile: bridge.sessionFile,
    isStreaming: bridge.isStreaming ?? false,
    isPromptRunning: bridge.isStreaming ?? false,
    isCompacting: bridge.isCompacting ?? false,
    model: bridge.model ?? undefined,
    contextUsage: bridge.contextUsage ?? null,
    systemPrompt: bridge.systemPrompt ?? "",
    thinkingLevel: bridge.thinkingLevel ?? "off",
    transport: "cli",
    cliConnected: true,
  };
}

export function publishCliEvents(
  sessionId: string,
  clientId: string,
  pairingToken: string,
  events: Record<string, unknown>[],
): boolean {
  const record = findBridge(sessionId, clientId, pairingToken);
  if (!record) return false;
  record.lastSeen = Date.now();

  for (const event of events) {
    if (event.type === "agent_start") record.registration.isStreaming = true;
    if (event.type === "agent_end") record.registration.isStreaming = false;
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      record.registration.isCompacting = true;
    }
    if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      record.registration.isCompacting = false;
    }
    if (event.type === "model_select") {
      const model = event.model as { id?: unknown; provider?: unknown } | undefined;
      if (typeof model?.id === "string" && typeof model.provider === "string") {
        record.registration.model = { id: model.id, provider: model.provider };
      }
    }
    if (event.type === "thinking_level_select" && typeof event.level === "string") {
      record.registration.thinkingLevel = event.level;
    }
    for (const listener of record.listeners) listener(event);
  }

  notifyCliRunningChange();
  return true;
}

export function subscribeCliEvents(sessionId: string, listener: EventListener): (() => void) | null {
  const record = findBridge(sessionId);
  if (!record) return null;
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

export function sendCliCommand(sessionId: string, command: Record<string, unknown>): Promise<unknown> {
  const record = findBridge(sessionId);
  if (!record) return Promise.reject(new Error("CLI bridge is not connected"));

  const id = randomUUID();
  record.commandQueue.push({ id, command });
  wakeCommandWaiters(record);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.pendingCommands.delete(id);
      reject(new Error(`CLI command timed out: ${String(command.type ?? "unknown")}`));
    }, COMMAND_TIMEOUT_MS);
    record.pendingCommands.set(id, { resolve, reject, timer });
  });
}

export async function waitForCliCommands(
  sessionId: string,
  clientId: string,
  pairingToken: string,
): Promise<CliBridgeCommand[] | null> {
  const record = findBridge(sessionId, clientId, pairingToken);
  if (!record) return null;
  record.lastSeen = Date.now();
  if (record.commandQueue.length > 0) return record.commandQueue.splice(0);

  return new Promise((resolve) => {
    const waiter: CommandWaiter = {
      resolve,
      timer: setTimeout(() => {
        record.commandWaiters.delete(waiter);
        resolve([]);
      }, COMMAND_POLL_MS),
    };
    record.commandWaiters.add(waiter);
  });
}

export function resolveCliCommand(
  sessionId: string,
  clientId: string,
  pairingToken: string,
  commandId: string,
  response: { success: boolean; data?: unknown; error?: string },
): boolean {
  const record = findBridge(sessionId, clientId, pairingToken);
  if (!record) return false;
  record.lastSeen = Date.now();
  const pending = record.pendingCommands.get(commandId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  record.pendingCommands.delete(commandId);
  if (response.success) pending.resolve(response.data);
  else pending.reject(new Error(response.error ?? "CLI command failed"));
  return true;
}

export function getRunningCliSessionIds(): string[] {
  pruneStaleBridges();
  const ids: string[] = [];
  for (const [sessionId, record] of getRegistry()) {
    if (record.registration.isStreaming || record.registration.isCompacting) ids.push(sessionId);
  }
  return ids;
}

export function subscribeCliRunningSessions(listener: RunningListener): () => void {
  getRunningListeners().add(listener);
  return () => getRunningListeners().delete(listener);
}

function notifyCliRunningChange(): void {
  const runningIds = getRunningCliSessionIds();
  const connectedIds = getConnectedCliSessionIds();
  for (const listener of getRunningListeners()) {
    try {
      listener(runningIds, connectedIds);
    } catch {
      // Ignore listener failures.
    }
  }
}

export function getConnectedCliSessionIds(): string[] {
  pruneStaleBridges();
  return [...getRegistry().keys()];
}
