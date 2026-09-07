#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");
const wasmEntry = require.resolve("@next/swc-wasm-nodejs");
const projectRoot = process.cwd();
const distDirName = process.env.PI_WEB_NEXT_DIST_DIR || ".next";
const distDir = path.resolve(projectRoot, distDirName);
const relativeDistDir = path.relative(projectRoot, distDir);

if (
  !relativeDistDir
  || relativeDistDir.startsWith(`..${path.sep}`)
  || path.isAbsolute(relativeDistDir)
) {
  throw new Error(`Refusing to clean an unsafe Next distDir: ${distDir}`);
}

// Next preserves unreferenced assets across incremental production builds.
// Remove only deployable output so obsolete chunks and font formats cannot be
// shipped, while retaining .next/cache and .next/dev for fast rebuilds/dev.
for (const directory of ["server", "static", "standalone"]) {
  rmSync(path.join(distDir, directory), { recursive: true, force: true });
}

// Next normally prefers native SWC. When an older glibc cannot load it, point
// the fallback loader at the version-pinned local package so it never needs a
// build-time registry download. Modern systems continue to use native SWC.
const result = spawnSync(
  process.execPath,
  [nextCli, "build", "--webpack", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TEST_WASM_DIR: path.dirname(wasmEntry),
    },
  },
);

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
