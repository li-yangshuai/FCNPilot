#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function isCompatibleNode(version) {
  const [major, minor] = parseNodeVersion(version);
  return major > 22 || (major === 22 && minor >= 19);
}

function compareVersions(a, b) {
  const av = parseNodeVersion(a);
  const bv = parseNodeVersion(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

function resolveRuntimeNode() {
  if (isCompatibleNode(process.version)) return process.execPath;

  const nvmVersionsDir = path.join(
    process.env.NVM_DIR || path.join(process.env.HOME || "", ".nvm"),
    "versions",
    "node",
  );
  try {
    const compatible = fs.readdirSync(nvmVersionsDir)
      .filter(isCompatibleNode)
      .sort(compareVersions)
      .reverse();
    if (compatible.length > 0) {
      const nodePath = path.join(nvmVersionsDir, compatible[0], "bin", "node");
      if (fs.existsSync(nodePath)) {
        process.stderr.write(
          `[pi-web-sync] Current ${process.version} is unsupported; using ${compatible[0]}.\n`,
        );
        return nodePath;
      }
    }
  } catch {
    // Fall through to the actionable error below.
  }

  process.stderr.write(
    `[pi-web-sync] Pi requires Node >=22.19 (current: ${process.version}). ` +
    "Run `nvm install 22 && nvm use 22`, then retry.\n",
  );
  process.exit(1);
}

function extractPiWebArgs(argv) {
  const passThrough = [];
  let webUser = process.env.PI_WEB_USER || "";
  let webUid = process.env.PI_WEB_UID || "";
  let bridgeToken = process.env.PI_WEB_BRIDGE_TOKEN || "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--web-user" || arg === "--account") {
      webUser = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--web-user=")) {
      webUser = arg.slice("--web-user=".length);
      continue;
    }
    if (arg.startsWith("--account=")) {
      webUser = arg.slice("--account=".length);
      continue;
    }
    if (arg === "--web-uid") {
      webUid = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--web-uid=")) {
      webUid = arg.slice("--web-uid=".length);
      continue;
    }
    if (arg === "--bridge-token") {
      bridgeToken = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--bridge-token=")) {
      bridgeToken = arg.slice("--bridge-token=".length);
      continue;
    }
    passThrough.push(arg);
  }

  return { passThrough, webUser: webUser.trim(), webUid: webUid.trim(), bridgeToken: bridgeToken.trim() };
}

function noProxyForWeb(webUrl) {
  const entries = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  try {
    const hostname = new URL(webUrl).hostname;
    entries.push(hostname);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      entries.push("localhost", "127.0.0.1", "::1", "[::1]");
    }
  } catch {
    // URL validation and the actionable connection error are handled by the
    // sync extension. Preserve any existing proxy exclusions here.
  }
  return [...new Set(entries)].join(",");
}

const extensionPath = path.join(__dirname, "pi-web-sync-extension.ts");
const runtimeNode = resolveRuntimeNode();
const defaultWebUrl = `http://127.0.0.1:${process.env.PI_WEB_PORT || 30211}`;
const webUrl = process.env.PI_WEB_URL || defaultWebUrl;
const noProxy = noProxyForWeb(webUrl);
const { passThrough, webUser, webUid, bridgeToken } = extractPiWebArgs(process.argv.slice(2));
const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (webUid && !UID_RE.test(webUid)) {
  process.stderr.write("[pi-web-sync] Invalid Web account UID.\n");
  process.exit(1);
}
const requestedCwd = (process.env.PI_WEB_CWD || process.env.INIT_CWD || process.cwd()).trim();
const cliCwd = path.resolve(requestedCwd);
try {
  if (!fs.statSync(cliCwd).isDirectory()) {
    throw new Error("not a directory");
  }
} catch {
  process.stderr.write(`[pi-web-sync] Workspace does not exist or is not a directory: ${cliCwd}\n`);
  process.exit(1);
}
let piBin;
try {
  piBin = require.resolve("@earendil-works/pi-coding-agent/dist/cli.js", {
    paths: [path.join(__dirname, "..")],
  });
} catch {
  piBin = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
}

const child = spawn(
  runtimeNode,
  [piBin, "--extension", extensionPath, ...passThrough],
  {
    // npm --prefix runs package scripts from the package directory. Keep the
    // Pi CLI in the workspace where the user launched sync instead.
    cwd: cliCwd,
    stdio: "inherit",
    env: {
      ...process.env,
      PI_WEB_SYNC_ACTIVE: "1",
      PI_WEB_URL: webUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...(webUser ? { PI_WEB_USER: webUser } : {}),
      ...(webUid ? { PI_WEB_UID: webUid } : {}),
      ...(bridgeToken ? { PI_WEB_BRIDGE_TOKEN: bridgeToken } : {}),
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
