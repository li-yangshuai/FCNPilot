import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { assertSafeNetworkBinding, isLoopbackHostname, resolveLaunchHostname } = require("../bin/network-binding.js");
const { buildNextArgs, readLaunchArgs } = require("../bin/pi-web-launch.js");

test("resolves one effective hostname without trusting the ambient system HOSTNAME", () => {
  assert.equal(resolveLaunchHostname(undefined, {}), "127.0.0.1");
  assert.equal(resolveLaunchHostname(undefined, { HOSTNAME: "container-id" }), "127.0.0.1");
  assert.equal(resolveLaunchHostname(undefined, { PI_WEB_HOSTNAME: " 0.0.0.0 " }), "0.0.0.0");
  assert.equal(resolveLaunchHostname(" ::1 ", { PI_WEB_HOSTNAME: "0.0.0.0" }), "::1");
  assert.equal(resolveLaunchHostname("", { PI_WEB_HOSTNAME: "0.0.0.0" }), "127.0.0.1");
});

test("the Next launcher always forwards the effective hostname", () => {
  const defaults = readLaunchArgs(["--webpack"]);
  const defaultHostname = resolveLaunchHostname(defaults.hostname, {});
  assert.deepEqual(
    buildNextArgs("next-bin", "dev", 30141, defaultHostname, defaults.forwarded),
    ["next-bin", "dev", "--webpack", "-p", "30141", "-H", "127.0.0.1"],
  );

  const explicit = readLaunchArgs(["-H0.0.0.0", "-p8080", "--turbo"]);
  assert.equal(explicit.hostname, "0.0.0.0");
  assert.equal(explicit.requestedPort, "8080");
  assert.deepEqual(explicit.forwarded, ["--turbo"]);
  assert.deepEqual(
    buildNextArgs("next-bin", "start", 8080, resolveLaunchHostname(explicit.hostname, {}), explicit.forwarded),
    ["next-bin", "start", "--turbo", "-p", "8080", "-H", "0.0.0.0"],
  );
});

test("recognizes loopback bind names", () => {
  for (const hostname of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
    assert.doesNotThrow(() => assertSafeNetworkBinding(hostname, {}));
  }
});

test("requires authentication for non-loopback listeners", () => {
  for (const hostname of ["0.0.0.0", "::", "192.168.1.20", "amedac.internal"]) {
    assert.throws(() => assertSafeNetworkBinding(hostname, {}), /Refusing to listen/);
    assert.doesNotThrow(() => assertSafeNetworkBinding(hostname, { PI_WEB_PASSWORD: "secret" }));
  }
});

test("supports an explicit insecure-LAN acknowledgement", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.doesNotThrow(() => assertSafeNetworkBinding("0.0.0.0", {
      PI_WEB_ALLOW_INSECURE_LAN: value,
    }));
  }
  assert.throws(() => assertSafeNetworkBinding("0.0.0.0", {
    PI_WEB_ALLOW_INSECURE_LAN: "false",
  }));
});
