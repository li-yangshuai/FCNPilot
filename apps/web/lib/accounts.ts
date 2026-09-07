import {
  createHash,
  randomBytes,
  randomUUID,
} from "crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { cookies } from "next/headers";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "./types";
import { getPiWebConfigDir, migrateLegacyFile } from "./pi-web-paths";
import {
  SHARED_ACCOUNT_IDENTITY,
  SHARED_ACCOUNT_UID,
  SHARED_ACCOUNT_USERNAME,
} from "./shared-workspace";

export const ACCOUNT_COOKIE_NAME = "pi-web-user";
const ACCOUNT_STORE_VERSION = 3 as const;
const ACCOUNT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_LENGTH = 16;
const LOGIN_TOKEN_LENGTH = 32;
const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface StoredAccount {
  uid: string;
  username: string;
  createdAt: string;
  lastLoginAt: string;
}

interface PasswordCredential {
  algorithm: "scrypt";
  salt: string;
  hash: string;
}

interface AccountRecord extends StoredAccount {
  /** null only for accounts safely migrated from the passwordless v1/v2 store. */
  password: PasswordCredential | null;
}

interface LoginTokenRecord {
  tokenHash: string;
  accountUid: string;
  expiresAt: string;
}

interface AccountStore {
  version: typeof ACCOUNT_STORE_VERSION;
  accounts: AccountRecord[];
  /** session id -> immutable account uid */
  sessionOwners: Record<string, string>;
  /** Only a SHA-256 digest is persisted; the opaque token exists in the cookie. */
  loginTokens: LoginTokenRecord[];
}

export interface AccountSummary extends StoredAccount {
  sessionCount: number;
}

export type AccountIdentity = Pick<StoredAccount, "uid" | "username">;

function sharedStoredAccount(): StoredAccount {
  return {
    ...SHARED_ACCOUNT_IDENTITY,
    createdAt: "1970-01-01T00:00:00.000Z",
    lastLoginAt: "1970-01-01T00:00:00.000Z",
  };
}

export type AuthenticationResult =
  | { status: "success"; account: AccountSummary }
  | { status: "invalid_credentials" }
  | { status: "password_reset_required" };

export type DeleteAccountResult =
  | { status: "deleted"; uid: string; sessionIds: string[] }
  | { status: "invalid_credentials" }
  | { status: "password_reset_required" };

type CookieResponse = {
  cookies: {
    set: (name: string, value: string, options?: Record<string, unknown>) => void;
    delete: (name: string) => void;
  };
};

function getAccountStorePath(): string {
  const nextPath = join(getPiWebConfigDir(), "accounts.json");
  migrateLegacyFile(join(getAgentDir(), "pi-web-accounts.json"), nextPath);
  return nextPath;
}

function emptyStore(): AccountStore {
  return {
    version: ACCOUNT_STORE_VERSION,
    accounts: [],
    sessionOwners: {},
    loginTokens: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUid(value: unknown): value is string {
  return typeof value === "string" && UID_RE.test(value);
}

function normalizeUid(value: string): string {
  return value.toLowerCase();
}

function decodeCanonicalBase64(value: unknown, length: number): Buffer | null {
  if (typeof value !== "string" || !BASE64_RE.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== length || decoded.toString("base64") !== value) return null;
  return decoded;
}

function normalizePasswordCredential(value: unknown): PasswordCredential {
  if (!isRecord(value) || value.algorithm !== "scrypt") {
    throw new Error("Invalid password credential");
  }
  if (
    !decodeCanonicalBase64(value.salt, PASSWORD_SALT_LENGTH)
    || !decodeCanonicalBase64(value.hash, PASSWORD_KEY_LENGTH)
  ) {
    throw new Error("Invalid password credential encoding");
  }
  return {
    algorithm: "scrypt",
    salt: value.salt as string,
    hash: value.hash as string,
  };
}

function normalizeStore(parsed: unknown): {
  store: AccountStore;
  migrated: boolean;
  sourceVersion: 1 | 2 | 3;
} {
  if (!isRecord(parsed)) throw new Error("Invalid account store format");
  if (
    parsed.version === undefined
    && Array.isArray(parsed.accounts)
    && parsed.accounts.some((account) => isRecord(account) && "uid" in account)
  ) {
    throw new Error("Account store contains UIDs but has no version; refusing an unsafe legacy migration");
  }

  const sourceVersion = (parsed.version ?? 1) as number;
  if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== ACCOUNT_STORE_VERSION) {
    throw new Error(`Unsupported account store version: ${parsed.version}`);
  }
  if (!Array.isArray(parsed.accounts) || !isRecord(parsed.sessionOwners)) {
    throw new Error("Invalid account store structure");
  }

  let migrated = sourceVersion !== ACCOUNT_STORE_VERSION;
  const accounts: AccountRecord[] = [];
  const usernames = new Set<string>();
  const uids = new Set<string>();
  const usernameToUid = new Map<string, string>();

  for (const value of parsed.accounts) {
    if (!isRecord(value)) throw new Error("Invalid account record");
    const username = normalizeUsername(value.username);
    if (
      !username
      || usernames.has(username)
      || typeof value.createdAt !== "string"
      || typeof value.lastLoginAt !== "string"
    ) {
      throw new Error("Invalid or duplicate account record");
    }

    const storedUid = typeof value.uid === "string" ? normalizeUid(value.uid) : "";
    if (sourceVersion >= 2 && (!isUid(storedUid) || uids.has(storedUid))) {
      throw new Error("Invalid or duplicate account UID");
    }
    let uid = sourceVersion >= 2 ? storedUid : randomUUID();
    if (sourceVersion >= 2 && uid !== value.uid) migrated = true;
    while (uids.has(uid)) uid = randomUUID();

    const password = sourceVersion === ACCOUNT_STORE_VERSION
      ? value.password === null
        ? null
        : normalizePasswordCredential(value.password)
      : null;

    accounts.push({
      uid,
      username,
      createdAt: value.createdAt,
      lastLoginAt: value.lastLoginAt,
      password,
    });
    usernames.add(username);
    uids.add(uid);
    usernameToUid.set(username, uid);
  }

  const sessionOwners: Record<string, string> = {};
  for (const [sessionId, owner] of Object.entries(parsed.sessionOwners)) {
    if (!sessionId || typeof owner !== "string") {
      if (sourceVersion >= 2) throw new Error(`Invalid v${sourceVersion} session ownership record`);
      migrated = true;
      continue;
    }
    const canonicalOwner = isUid(owner) ? normalizeUid(owner) : owner;
    const ownerUid = uids.has(canonicalOwner) ? canonicalOwner : usernameToUid.get(owner);
    if (!ownerUid) {
      if (sourceVersion >= 2) {
        throw new Error(`Unknown account UID in v${sourceVersion} session ownership: ${sessionId}`);
      }
      migrated = true;
      continue;
    }
    sessionOwners[sessionId] = ownerUid;
    if (ownerUid !== owner) migrated = true;
  }

  const loginTokens: LoginTokenRecord[] = [];
  if (sourceVersion === ACCOUNT_STORE_VERSION) {
    if (!Array.isArray(parsed.loginTokens)) throw new Error("Invalid login token store");
    const tokenHashes = new Set<string>();
    const now = Date.now();
    for (const value of parsed.loginTokens) {
      if (
        !isRecord(value)
        || typeof value.tokenHash !== "string"
        || !SHA256_RE.test(value.tokenHash)
        || tokenHashes.has(value.tokenHash)
        || !isUid(value.accountUid)
        || !uids.has(normalizeUid(value.accountUid))
        || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.expiresAt))
      ) {
        throw new Error("Invalid login token record");
      }
      tokenHashes.add(value.tokenHash);
      if (Date.parse(value.expiresAt) <= now) {
        migrated = true;
        continue;
      }
      loginTokens.push({
        tokenHash: value.tokenHash,
        accountUid: normalizeUid(value.accountUid),
        expiresAt: value.expiresAt,
      });
    }
  }

  return {
    store: { version: ACCOUNT_STORE_VERSION, accounts, sessionOwners, loginTokens },
    migrated,
    sourceVersion,
  };
}

function readStore(): AccountStore {
  const storePath = getAccountStorePath();
  if (!existsSync(storePath)) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read account store without data loss: ${String(error)}`);
  }
  const normalized = normalizeStore(parsed);
  if (normalized.migrated) {
    if (normalized.sourceVersion < ACCOUNT_STORE_VERSION) {
      const backupPath = `${storePath}.v${normalized.sourceVersion}.backup`;
      if (!existsSync(backupPath)) {
        copyFileSync(storePath, backupPath);
        chmodSync(backupPath, 0o600);
      }
    }
    writeStore(normalized.store);
  }
  return normalized.store;
}

function writeStore(store: AccountStore): void {
  const storePath = getAccountStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, storePath);
    chmodSync(storePath, 0o600);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function hashLoginToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeUsername(username: unknown): string {
  return typeof username === "string" ? username.trim() : "";
}

export function validateUsername(username: string): string | null {
  if (!username) return "用户名不能为空";
  if (username.length > 40) return "用户名不能超过 40 个字符";
  if (/[\u0000-\u001F\u007F]/u.test(username)) return "用户名不能包含控制字符";
  if (/[\\/]/u.test(username)) return "用户名不能包含 / 或 \\";
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "密码不能为空";
  if (password.length === 0) return "密码不能为空";
  if (password.length > 1024) return "密码不能超过 1024 个字符";
  return null;
}

export function assertValidUsername(username: string): void {
  const error = validateUsername(username);
  if (error) throw new Error(error);
}

export function getAccountByUid(uid: string): StoredAccount | null {
  return normalizeUid(uid) === SHARED_ACCOUNT_UID ? sharedStoredAccount() : null;
}

export function getAccountByUsername(username: string): StoredAccount | null {
  return normalizeUsername(username) === SHARED_ACCOUNT_USERNAME ? sharedStoredAccount() : null;
}

export function accountExists(username: string): boolean {
  return normalizeUsername(username) === SHARED_ACCOUNT_USERNAME;
}

export function registerAccount(username: string, password: string): AccountSummary | null {
  void username;
  void password;
  return null;
}

export function authenticateAccount(username: string, password: unknown): AuthenticationResult {
  void username;
  void password;
  return { status: "invalid_credentials" };
}

export function deleteAccountWithPassword(
  uid: string,
  password: unknown,
): DeleteAccountResult {
  void uid;
  void password;
  return { status: "invalid_credentials" };
}

export function listAccounts(): AccountSummary[] {
  return [{ ...sharedStoredAccount(), sessionCount: 0 }];
}

export function getAccountSummary(uid: string): AccountSummary | null {
  return normalizeUid(uid) === SHARED_ACCOUNT_UID
    ? { ...sharedStoredAccount(), sessionCount: 0 }
    : null;
}

export function bindSessionToAccount(sessionId: string, accountUid: string): void {
  void sessionId;
  if (accountUid !== SHARED_ACCOUNT_UID) throw new Error("Invalid shared workspace UID");
}

export function unbindSession(sessionId: string): void {
  void sessionId;
}

export function getSessionOwnerUid(sessionId: string): string | null {
  return sessionId ? SHARED_ACCOUNT_UID : null;
}

export function accountOwnsSession(accountUid: string, sessionId: string): boolean {
  return accountUid === SHARED_ACCOUNT_UID && Boolean(sessionId);
}

export function filterSessionsForAccount(sessions: SessionInfo[], accountUid: string): SessionInfo[] {
  return accountUid === SHARED_ACCOUNT_UID ? sessions : [];
}

export function filterSessionIdsForAccount(sessionIds: string[], accountUid: string): string[] {
  return accountUid === SHARED_ACCOUNT_UID ? sessionIds : [];
}

export function getSessionIdsForAccount(accountUid: string): string[] {
  void accountUid;
  return [];
}

function appendLoginToken(store: AccountStore, accountUid: string): string {
  let token: string;
  let tokenHash: string;
  const existingHashes = new Set(store.loginTokens.map((record) => record.tokenHash));
  do {
    token = randomBytes(LOGIN_TOKEN_LENGTH).toString("base64url");
    tokenHash = hashLoginToken(token);
  } while (existingHashes.has(tokenHash));

  store.loginTokens.push({
    tokenHash,
    accountUid,
    expiresAt: new Date(Date.now() + ACCOUNT_COOKIE_MAX_AGE * 1000).toISOString(),
  });
  return token;
}

export function createLoginSession(accountUid: string): string {
  if (!isUid(accountUid)) throw new Error("Account not found");
  accountUid = normalizeUid(accountUid);
  const store = readStore();
  if (!store.accounts.some((account) => account.uid === accountUid)) {
    throw new Error("Account not found");
  }

  const token = appendLoginToken(store, accountUid);
  writeStore(store);
  return token;
}

export function encodeAccountCookie(token: string): string {
  return encodeURIComponent(token);
}

export function decodeAccountCookie(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const token = decodeURIComponent(value).trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function getCurrentLoginToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return decodeAccountCookie(cookieStore.get(ACCOUNT_COOKIE_NAME)?.value);
}

/**
 * Replaces the request's current login token and creates the target token in a
 * single account-store write. If the write fails, the old token remains valid.
 */
export async function replaceCurrentLoginSession(accountUid: string): Promise<string> {
  if (!isUid(accountUid)) throw new Error("Account not found");
  accountUid = normalizeUid(accountUid);
  const currentToken = await getCurrentLoginToken();
  const store = readStore();
  if (!store.accounts.some((account) => account.uid === accountUid)) {
    throw new Error("Account not found");
  }

  if (currentToken) {
    const currentTokenHash = hashLoginToken(currentToken);
    store.loginTokens = store.loginTokens.filter((record) => record.tokenHash !== currentTokenHash);
  }
  const token = appendLoginToken(store, accountUid);
  writeStore(store);
  return token;
}

export async function getCurrentAccount(): Promise<StoredAccount | null> {
  return sharedStoredAccount();
}

export async function getCurrentAccountUid(): Promise<string | null> {
  return SHARED_ACCOUNT_UID;
}

export async function getCurrentAccountUsername(): Promise<string | null> {
  return SHARED_ACCOUNT_USERNAME;
}

export function revokeLoginToken(token: string): void {
  if (!TOKEN_RE.test(token)) return;
  const store = readStore();
  const tokenHash = hashLoginToken(token);
  const before = store.loginTokens.length;
  store.loginTokens = store.loginTokens.filter((record) => record.tokenHash !== tokenHash);
  if (store.loginTokens.length !== before) writeStore(store);
}

export async function revokeCurrentLoginSession(): Promise<void> {
  const token = await getCurrentLoginToken();
  if (token) revokeLoginToken(token);
}

function requestUsesSecureCookies(request?: Request): boolean {
  const configured = process.env.PI_WEB_SECURE_COOKIES?.trim().toLowerCase();
  if (configured === "true" || configured === "1") return true;
  if (configured === "false" || configured === "0") return false;

  if (request) {
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      ?.trim()
      .toLowerCase();
    if (forwardedProtocol) return forwardedProtocol === "https";
    try {
      return new URL(request.url).protocol === "https:";
    } catch {
      return false;
    }
  }

  return process.env.NODE_ENV === "production";
}

export function setAccountCookie(response: CookieResponse, token: string, request?: Request): void {
  if (!TOKEN_RE.test(token)) throw new Error("Invalid login token");
  response.cookies.set(ACCOUNT_COOKIE_NAME, encodeAccountCookie(token), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: requestUsesSecureCookies(request),
    maxAge: ACCOUNT_COOKIE_MAX_AGE,
  });
}

export function clearAccountCookie(response: CookieResponse): void {
  response.cookies.delete(ACCOUNT_COOKIE_NAME);
}
