import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPiWebConfigDir, migrateLegacyFile } from "./pi-web-paths.ts";

test("an explicit FCNPilot config directory never imports legacy global preferences", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fcnpilot-config-"));
  const original = process.env.PI_WEB_CONFIG_DIR;
  t.after(() => {
    if (original === undefined) delete process.env.PI_WEB_CONFIG_DIR;
    else process.env.PI_WEB_CONFIG_DIR = original;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const legacy = path.join(root, "legacy.json");
  const isolated = path.join(root, "isolated");
  const destination = path.join(isolated, "preferences.json");
  fs.writeFileSync(legacy, "legacy preferences");
  process.env.PI_WEB_CONFIG_DIR = isolated;
  assert.equal(getPiWebConfigDir(), isolated);
  migrateLegacyFile(legacy, destination);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readFileSync(legacy, "utf8"), "legacy preferences");

  delete process.env.PI_WEB_CONFIG_DIR;
  migrateLegacyFile(legacy, destination);
  assert.equal(fs.readFileSync(destination, "utf8"), "legacy preferences");
});
