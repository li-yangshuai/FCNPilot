"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const AUTO_PORT_START = 30141;
const AUTO_PORT_SPAN = 10_000;
const AUTO_PORT_ATTEMPTS = 256;

function resolvedConfigPath(value, fallback) {
  return path.resolve((value || "").trim() || fallback);
}

function getPortIdentity(env = process.env) {
  const home = (env.HOME || os.homedir()).trim();
  const systemUser = typeof process.getuid === "function"
    ? `uid:${process.getuid()}`
    : `user:${env.USER || env.USERNAME || os.userInfo().username}`;
  const agentDir = resolvedConfigPath(
    env.PI_CODING_AGENT_DIR,
    path.join(home, ".pi", "agent"),
  );
  const webConfigDir = resolvedConfigPath(
    env.PI_WEB_CONFIG_DIR,
    path.join(home, ".pi", "pi-web"),
  );
  return `${systemUser}\0${agentDir}\0${webConfigDir}`;
}

function hashIdentity(value) {
  // FNV-1a gives a deterministic, well-distributed value without another
  // package. Math.imul keeps the operation in the unsigned 32-bit range.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getPreferredPort(env = process.env) {
  return AUTO_PORT_START + (hashIdentity(getPortIdentity(env)) % AUTO_PORT_SPAN);
}

function parsePort(value, source = "port") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
  return port;
}

function canListen(port, hostname) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: hostname || undefined, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function selectLaunchPort({
  requestedPort,
  hostname,
  env = process.env,
  isPortAvailable = canListen,
} = {}) {
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== "") {
    const port = parsePort(requestedPort, "Requested port");
    if (!(await isPortAvailable(port, hostname))) {
      throw new Error(
        `Port ${port} is already in use. Choose another with --port, PI_WEB_PORT, or PORT.`,
      );
    }
    return { port, preferredPort: port, automatic: false };
  }

  const preferredPort = getPreferredPort(env);
  for (let offset = 0; offset < AUTO_PORT_ATTEMPTS; offset += 1) {
    const port = AUTO_PORT_START
      + ((preferredPort - AUTO_PORT_START + offset) % AUTO_PORT_SPAN);
    if (await isPortAvailable(port, hostname)) {
      return { port, preferredPort, automatic: true };
    }
  }

  throw new Error(
    `No available FCNPilot port was found after ${AUTO_PORT_ATTEMPTS} attempts. ` +
    "Set one explicitly with --port, PI_WEB_PORT, or PORT.",
  );
}

module.exports = {
  AUTO_PORT_START,
  AUTO_PORT_SPAN,
  getPortIdentity,
  getPreferredPort,
  parsePort,
  selectLaunchPort,
};
