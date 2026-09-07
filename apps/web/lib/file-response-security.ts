const SVG_CONTENT_TYPE = "image/svg+xml";

export function getFileResponseSecurityHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
  };

  if (contentType === SVG_CONTENT_TYPE) {
    // Project SVG files are untrusted. Keep inline image previews working, but
    // make a direct navigation a sandboxed, scriptless document with no access
    // to the app's same-origin APIs or external resources.
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
    headers["Referrer-Policy"] = "no-referrer";
  }

  return headers;
}
