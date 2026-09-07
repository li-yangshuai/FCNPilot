import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (name) => new URL(`../${name}`, import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(projectFile(name), "utf8"));
}

test("pins the local SWC WASM fallback to the Next.js version", async () => {
  const [manifest, lockfile] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);
  const nextVersion = manifest.dependencies.next;

  assert.equal(manifest.devDependencies["@next/swc-wasm-nodejs"], nextVersion);
  assert.equal(
    lockfile.packages[""].devDependencies["@next/swc-wasm-nodejs"],
    nextVersion,
  );

  const lockedFallback = lockfile.packages["node_modules/@next/swc-wasm-nodejs"];
  assert.equal(lockedFallback.version, nextVersion);
  assert.equal(lockedFallback.dev, true);
});

test("does not use build-time remote Google fonts", async () => {
  const layout = await readFile(projectFile("app/layout.tsx"), "utf8");

  assert.doesNotMatch(layout, /next\/font\/google/);
});

test("points the Next build at the installed fallback package", async () => {
  const buildScript = await readFile(projectFile("scripts/build-next.mjs"), "utf8");

  assert.match(buildScript, /require\.resolve\("@next\/swc-wasm-nodejs"\)/);
  assert.match(buildScript, /NEXT_TEST_WASM_DIR: path\.dirname\(wasmEntry\)/);
});
