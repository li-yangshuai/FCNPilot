import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { getFileResponseSecurityHeaders } = await loadSubject("./file-response-security.ts");

test("sandboxes inline SVG responses without allowing scripts", () => {
  const headers = getFileResponseSecurityHeaders("image/svg+xml");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.match(headers["Content-Security-Policy"], /(?:^|;)\s*sandbox(?:;|$)/);
  assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
  assert.doesNotMatch(headers["Content-Security-Policy"], /allow-scripts/);
});

test("adds nosniff without document-only CSP to ordinary binary responses", () => {
  assert.deepEqual(getFileResponseSecurityHeaders("image/png"), {
    "X-Content-Type-Options": "nosniff",
  });
});
