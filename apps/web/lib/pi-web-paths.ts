import { constants, copyFileSync, chmodSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertAccountUid(uid: string): string {
  if (!UID_RE.test(uid)) throw new Error("Invalid account UID");
  return uid.toLowerCase();
}

export function getPiWebConfigDir(): string {
  const configured = process.env.PI_WEB_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".pi", "pi-web");
}

export function getPiWebUserDir(uid: string): string {
  return join(getPiWebConfigDir(), "users", assertAccountUid(uid));
}

export function migrateLegacyFile(legacyPath: string, nextPath: string): void {
  // An explicit config directory is an isolated FCNPilot installation. Importing
  // global Pi Web files here would silently restore another application's state.
  if (process.env.PI_WEB_CONFIG_DIR?.trim()) return;
  if (existsSync(nextPath) || !existsSync(legacyPath)) return;
  mkdirSync(dirname(nextPath), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(legacyPath, nextPath, constants.COPYFILE_EXCL);
    chmodSync(nextPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
