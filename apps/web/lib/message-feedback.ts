import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assertAccountUid, getPiWebUserDir, migrateLegacyFile } from "./pi-web-paths";
import {
  FEEDBACK_REASONS,
  type MessageFeedback,
  type MessageFeedbackInput,
} from "./message-feedback-types";

export type {
  FeedbackRating,
  FeedbackReason,
  MessageFeedback,
  MessageFeedbackInput,
} from "./message-feedback-types";

const STORE_VERSION = 1 as const;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
interface FeedbackStore {
  version: typeof STORE_VERSION;
  items: Record<string, MessageFeedback>;
}

function assertId(value: string, label: string): string {
  if (!ID_RE.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function shortText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function storePath(uid: string): string {
  const canonicalUid = assertAccountUid(uid);
  const nextPath = join(getPiWebUserDir(canonicalUid), "feedback.json");
  migrateLegacyFile(join(getAgentDir(), "pi-web-users", canonicalUid, "feedback.json"), nextPath);
  return nextPath;
}

function itemKey(sessionId: string, entryId: string): string {
  return `${assertId(sessionId, "session ID")}:${assertId(entryId, "entry ID")}`;
}

function emptyStore(): FeedbackStore {
  return { version: STORE_VERSION, items: {} };
}

function readStore(uid: string): FeedbackStore {
  const filePath = storePath(uid);
  if (!existsSync(filePath)) return emptyStore();
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<FeedbackStore>;
  if (parsed.version !== STORE_VERSION || !parsed.items || typeof parsed.items !== "object" || Array.isArray(parsed.items)) {
    throw new Error("Invalid message feedback store");
  }
  return { version: STORE_VERSION, items: parsed.items };
}

function writeStore(uid: string, store: FeedbackStore): void {
  const filePath = storePath(uid);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function listMessageFeedback(uid: string, sessionId: string): MessageFeedback[] {
  assertId(sessionId, "session ID");
  return Object.values(readStore(uid).items).filter((item) => item.sessionId === sessionId);
}

export function saveMessageFeedback(
  uid: string,
  sessionId: string,
  entryId: string,
  input: MessageFeedbackInput,
): MessageFeedback {
  if (input.rating !== "up" && input.rating !== "down") throw new Error("Invalid feedback rating");
  const reasons = [...new Set(input.reasons ?? [])];
  if (reasons.some((reason) => !FEEDBACK_REASONS.includes(reason))) throw new Error("Invalid feedback reason");
  const key = itemKey(sessionId, entryId);
  const store = readStore(uid);
  const existing = store.items[key];
  const now = new Date().toISOString();
  const feedback: MessageFeedback = {
    sessionId,
    entryId,
    rating: input.rating,
    reasons: input.rating === "down" ? reasons.slice(0, FEEDBACK_REASONS.length) : [],
    ...(shortText(input.comment, 1000) ? { comment: shortText(input.comment, 1000) } : {}),
    ...(shortText(input.provider, 200) ? { provider: shortText(input.provider, 200) } : {}),
    ...(shortText(input.model, 200) ? { model: shortText(input.model, 200) } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.items[key] = feedback;
  writeStore(uid, store);
  return feedback;
}

export function deleteMessageFeedback(uid: string, sessionId: string, entryId: string): void {
  const key = itemKey(sessionId, entryId);
  const store = readStore(uid);
  if (!(key in store.items)) return;
  delete store.items[key];
  writeStore(uid, store);
}
