import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler"); bare
// `import("./path-security.ts")` only works while that file has no imports.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./path-security.ts");
}

async function loadFileAccessSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-access.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("never exposes the Pi Web config directory through a broad root", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-private-config-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, "pi-web-config");
  const alias = path.join(base, "config-alias");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "accounts.json"), "secret");
  fs.symlinkSync(configDir, alias, process.platform === "win32" ? "junction" : "dir");

  const previousConfigDir = process.env.PI_WEB_CONFIG_DIR;
  process.env.PI_WEB_CONFIG_DIR = configDir;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.PI_WEB_CONFIG_DIR;
    else process.env.PI_WEB_CONFIG_DIR = previousConfigDir;
  });

  const { isFilePathAllowed } = await loadFileAccessSubject();
  const broadRoots = new Set([base]);
  assert.equal(isFilePathAllowed(configDir, broadRoots), false);
  assert.equal(isFilePathAllowed(path.join(configDir, "accounts.json"), broadRoots), false);
  assert.equal(isFilePathAllowed(path.join(configDir, "future.json"), broadRoots), false);
  assert.equal(isFilePathAllowed(path.join(alias, "accounts.json"), broadRoots), false);
  assert.equal(isFilePathAllowed(path.join(alias, "future.json"), broadRoots), false);
});
