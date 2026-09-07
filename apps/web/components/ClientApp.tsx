"use client";

import dynamic from "next/dynamic";
import { AppDialogProvider } from "./AppDialogProvider";

function AppLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading FCNPilot"
      style={{
        width: "100%",
        height: "100dvh",
        background: "var(--bg)",
      }}
    />
  );
}

const AppShell = dynamic(
  () => import("./AppShell").then((module) => module.AppShell),
  { ssr: false, loading: AppLoading },
);

/**
 * The application shell is a browser workspace: its initial state depends on
 * localStorage, viewport media queries, restored drafts, and async workspace
 * discovery. Rendering that state on the server creates an HTML snapshot that
 * cannot reliably match a different browser's first render.
 *
 * Keep SSR useful as a stable app-sized placeholder. The dynamic client-only
 * boundary starts loading as soon as hydration begins, without waiting for an
 * extra mounted-state render.
 */
export function ClientApp({ defaultCwd = null }: { defaultCwd?: string | null }) {
  return (
    <AppDialogProvider>
      <AppShell defaultCwd={defaultCwd} />
    </AppDialogProvider>
  );
}
