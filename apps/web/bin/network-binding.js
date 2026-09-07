"use strict";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Pi Web exposes a full file browser and interactive shell. Refuse an
 * accidental network-wide bind without an authentication gate. An explicit
 * escape hatch remains for isolated development networks where another layer
 * provides access control.
 */
function assertSafeNetworkBinding(hostname, env = process.env) {
  if (isLoopbackHostname(hostname)) return;
  if (typeof env.PI_WEB_PASSWORD === "string" && env.PI_WEB_PASSWORD.length > 0) return;
  if (isEnabled(env.PI_WEB_ALLOW_INSECURE_LAN)) return;
  throw new Error(
    `Refusing to listen on ${hostname || "all interfaces"} without authentication. ` +
    "Set PI_WEB_PASSWORD, or explicitly acknowledge an isolated trusted network " +
    "with PI_WEB_ALLOW_INSECURE_LAN=1.",
  );
}

function resolveLaunchHostname(cliHostname, env = process.env) {
  const configured = cliHostname ?? env.PI_WEB_HOSTNAME;
  const hostname = typeof configured === "string" ? configured.trim() : "";
  return hostname || "127.0.0.1";
}

module.exports = { assertSafeNetworkBinding, isLoopbackHostname, resolveLaunchHostname };
