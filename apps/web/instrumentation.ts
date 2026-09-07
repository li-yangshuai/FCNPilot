export async function register(): Promise<void> {
  // Keep the import inside a positive runtime branch: webpack can remove this
  // dependency from the Edge instrumentation graph before resolving Node APIs.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
    configureHttpDispatcher();
  }
}
