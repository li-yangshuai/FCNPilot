import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  // Keep output tracing inside this package when the repository has another
  // lockfile above it. The desktop build uses a separate output directory so
  // it never replaces the development server's `.next/` state.
  outputFileTracingRoot: configDir,
  distDir: process.env.PI_WEB_NEXT_DIST_DIR || ".next",
  ...(process.env.PI_WEB_NEXT_DIST_DIR ? { output: "standalone" as const } : {}),
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "node-pty",
  ],
  allowedDevOrigins: ["localhost", "127.0.0.1", "10.*.*.*", "172.*.*.*", "192.168.*.*"],
  devIndicators: false,
  // The UI serves workspace images directly and does not use next/image. Keep
  // the runtime independent of Sharp so desktop/server bundles do not need its
  // glibc, musl, and WASM binaries.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
