import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AI code routes use the Pi 0.84 model runtime and project trust gate", async () => {
  const routes = await Promise.all([
    readFile(new URL("../app/api/code-intelligence/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/code-intelligence/review/route.ts", import.meta.url), "utf8"),
  ]);

  for (const source of routes) {
    assert.doesNotMatch(source, /modelRegistry|getApiKeyAndHeaders|pi-ai\/compat/);
    assert.match(source, /ModelRuntime\.create\(/);
    assert.match(source, /getAvailableSnapshot\(\)/);
    assert.match(source, /modelRuntime\.completeSimple\(/);
    assert.match(source, /projectTrustReloadOptions\(body\.cwd, sharedAgentDir\)/);
    assert.match(source, /getActiveAgentDir\(accountUid\)/);
  }
});

test("historical context lookup uses the account suite without bypassing trust", async () => {
  const source = await readFile(new URL("./historical-context-usage.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /modelRegistry/);
  assert.match(source, /ModelRuntime\.create\(/);
  assert.match(source, /services\.modelRuntime\.getModel\(/);
  assert.match(source, /services\.modelRuntime\.getModels\(\)/);
  assert.match(source, /getActiveAgentDir\(accountUid\)/);
  assert.match(source, /projectTrustReloadOptions\(cwd, sharedAgentDir\)/);
});
