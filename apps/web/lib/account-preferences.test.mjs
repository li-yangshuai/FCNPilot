import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account preferences persist every UI tool preset, including read-only", async () => {
  const source = await readFile(new URL("./account-preferences.ts", import.meta.url), "utf8");

  assert.match(source, /new Set\(\["none", "read-only", "default", "full"\]\)/);
  assert.match(source, /AccountToolPreset = "none" \| "read-only" \| "default" \| "full"/);
});
