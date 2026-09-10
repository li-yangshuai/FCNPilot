import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("historical context lookup uses shared models without bypassing trust", async () => {
  const source = await readFile(new URL("./historical-context-usage.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /modelRegistry/);
  assert.match(source, /ModelRuntime\.create\(/);
  assert.match(source, /services\.modelRuntime\.getModel\(/);
  assert.match(source, /services\.modelRuntime\.getModels\(\)/);
  assert.match(source, /getAgentDir\(\)/);
  assert.match(source, /projectTrustReloadOptions\(cwd, sharedAgentDir\)/);
});
