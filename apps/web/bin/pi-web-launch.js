#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { selectLaunchPort } = require("./pi-web-port.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertSafeNetworkBinding, resolveLaunchHostname } = require("./network-binding.js");

const pkgDir = path.join(__dirname, "..");

function readLaunchArgs(argv) {
  const forwarded = [];
  let requestedPort;
  let hostname;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port" || arg === "-p") {
      requestedPort = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      requestedPort = arg.slice("--port=".length);
      continue;
    }
    if (arg.startsWith("-p=")) {
      requestedPort = arg.slice(3);
      continue;
    }
    if (/^-p\d+$/.test(arg)) {
      requestedPort = arg.slice(2);
      continue;
    }
    if (arg === "--hostname" || arg === "-H") {
      hostname = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--hostname=")) {
      hostname = arg.slice("--hostname=".length);
      continue;
    }
    if (arg.startsWith("-H") && arg.length > 2) {
      hostname = arg.slice(2).replace(/^=/, "");
      continue;
    }
    forwarded.push(arg);
  }

  return { forwarded, requestedPort, hostname };
}

function buildNextArgs(nextBin, mode, port, hostname, forwarded) {
  // Keep enforced network arguments last so a future unrecognized duplicate
  // can never override the hostname and port that were validated above.
  return [nextBin, mode, ...forwarded, "-p", String(port), "-H", hostname];
}

function displayHost(hostname) {
  if (!hostname || hostname === "0.0.0.0" || hostname === "::") return "localhost";
  return hostname;
}

function devWarmupHost(hostname) {
  if (!hostname || hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "::1";
  return hostname;
}

function warmDevServer(child, port, hostname) {
  const startedAt = Date.now();
  const timeoutAt = startedAt + 90_000;
  let stopped = false;
  let timer;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  child.once("exit", stop);

  const attempt = () => {
    if (stopped) return;
    const request = http.get({
      host: devWarmupHost(hostname),
      port,
      path: "/",
      agent: false,
      headers: { Connection: "close", "User-Agent": "fcnpilot-dev-warmup" },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (stopped) return;
        if ((response.statusCode ?? 500) >= 500) {
          scheduleRetry();
          return;
        }
        stop();
        process.stdout.write(`[FCNPilot] UI compiled and ready in ${Date.now() - startedAt}ms.\n`);
      });
    });
    request.setTimeout(5_000, () => request.destroy());
    request.once("error", scheduleRetry);
  };

  const scheduleRetry = () => {
    if (stopped) return;
    if (Date.now() >= timeoutAt) {
      stop();
      process.stderr.write("[FCNPilot] Development UI warmup timed out; open the URL to retry.\n");
      return;
    }
    timer = setTimeout(attempt, 100);
    timer.unref?.();
  };

  // Give Next's listener a brief head start. Issuing the request in the same
  // tick as spawn can leave it waiting for the socket timeout on some hosts.
  timer = setTimeout(attempt, 500);
  timer.unref?.();
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "dev" && mode !== "start") {
    throw new Error("Usage: pi-web-launch.js <dev|start> [Next.js options]");
  }

  const { forwarded, requestedPort: cliPort, hostname: cliHostname } = readLaunchArgs(process.argv.slice(3));
  const hostname = resolveLaunchHostname(cliHostname);
  assertSafeNetworkBinding(hostname);
  const requestedPort = cliPort ?? process.env.PI_WEB_PORT ?? process.env.PORT ?? "30211";
  const selected = await selectLaunchPort({ requestedPort, hostname });
  const nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });

  if (selected.automatic) {
    const suffix = selected.port === selected.preferredPort
      ? ""
      : ` (preferred ${selected.preferredPort} was unavailable)`;
    process.stdout.write(
      `[FCNPilot] Automatic port ${selected.port}${suffix}; ` +
      `identity: system user + Pi config paths.\n`,
    );
  }
  process.stdout.write(
    `[FCNPilot] Open http://${displayHost(hostname)}:${selected.port}\n`,
  );

  const child = spawn(
    process.execPath,
    buildNextArgs(nextBin, mode, selected.port, hostname, forwarded),
    {
      cwd: pkgDir,
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: String(selected.port),
        PI_WEB_PORT: String(selected.port),
        PI_WEB_HOSTNAME: hostname,
      },
    },
  );

  if (mode === "dev" && process.env.PI_WEB_DEV_WARMUP !== "0") {
    warmDevServer(child, selected.port, hostname);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[FCNPilot] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = { buildNextArgs, readLaunchArgs };
