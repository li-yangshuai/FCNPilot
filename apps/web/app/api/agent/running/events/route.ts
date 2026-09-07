import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { getConnectedCliSessionIds, getRunningCliSessionIds, subscribeCliRunningSessions } from "@/lib/cli-bridge";
import { filterSessionIdsForAccount, getAccountByUid, getCurrentAccountUid } from "@/lib/accounts";
import { getSessionsDir } from "@/lib/session-reader";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream for running state and session-file
// changes. Ordinary Pi CLI sessions do not connect to the Web bridge, so their
// filesystem events keep the shared sidebar current without polling.
export async function GET(req: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return new Response("Not logged in", { status: 401 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const resources: {
        heartbeat?: ReturnType<typeof setInterval>;
        sessionNotifyTimer?: ReturnType<typeof setTimeout>;
        sessionRescanTimer?: ReturnType<typeof setTimeout>;
        sessionWatchers: Map<string, FSWatcher>;
        unsubscribeRpc: () => void;
        unsubscribeCli: () => void;
      } = {
        sessionWatchers: new Map(),
        unsubscribeRpc: () => {},
        unsubscribeCli: () => {},
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (resources.heartbeat) clearInterval(resources.heartbeat);
        if (resources.sessionNotifyTimer) clearTimeout(resources.sessionNotifyTimer);
        if (resources.sessionRescanTimer) clearTimeout(resources.sessionRescanTimer);
        resources.sessionWatchers.forEach((watcher) => watcher.close());
        resources.unsubscribeRpc();
        resources.unsubscribeCli();
        try { controller.close(); } catch { /* already closed */ }
      };
      const encode = (data: unknown) => {
        if (closed) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const sessionsDir = getSessionsDir();

      function scheduleSessionChange() {
        if (resources.sessionNotifyTimer) clearTimeout(resources.sessionNotifyTimer);
        resources.sessionNotifyTimer = setTimeout(() => {
          resources.sessionNotifyTimer = undefined;
          encode({ type: "sessions-changed" });
        }, 120);
      }

      function scheduleSessionWatcherRescan() {
        if (resources.sessionRescanTimer) clearTimeout(resources.sessionRescanTimer);
        resources.sessionRescanTimer = setTimeout(() => {
          resources.sessionRescanTimer = undefined;
          reconcileSessionWatchers();
        }, 120);
      }

      function watchSessionDirectory(directory: string) {
        if (resources.sessionWatchers.has(directory)) return;
        try {
          const watcher = watch(directory, { persistent: false }, () => {
            scheduleSessionChange();
            if (directory === sessionsDir) scheduleSessionWatcherRescan();
          });
          watcher.on("error", () => {
            if (resources.sessionWatchers.get(directory) === watcher) {
              resources.sessionWatchers.delete(directory);
            }
            try { watcher.close(); } catch { /* already closed */ }
            scheduleSessionWatcherRescan();
          });
          resources.sessionWatchers.set(directory, watcher);
        } catch {
          // The directory may disappear between the scan and fs.watch.
        }
      }

      function reconcileSessionWatchers() {
        const wanted = new Set<string>();
        if (existsSync(sessionsDir)) {
          wanted.add(sessionsDir);
          try {
            for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
              if (entry.isDirectory()) wanted.add(`${sessionsDir}/${entry.name}`);
            }
          } catch {
            // A concurrent rename/removal is handled by the next root event.
          }
        }

        wanted.forEach(watchSessionDirectory);
        for (const [directory, watcher] of resources.sessionWatchers) {
          if (wanted.has(directory)) continue;
          try { watcher.close(); } catch { /* already closed */ }
          resources.sessionWatchers.delete(directory);
        }
      }

      reconcileSessionWatchers();

      if (req.signal.aborted) {
        cleanup();
        return;
      }

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      let rpcIds = getRunningRpcSessionIds();
      let cliIds = getRunningCliSessionIds();
      let connectedCliIds = getConnectedCliSessionIds();
      const emitRunning = () => {
        if (!getAccountByUid(accountUid)) {
          cleanup();
          return;
        }
        encode({
          type: "running",
          runningSessionIds: filterSessionIdsForAccount([...new Set([...rpcIds, ...cliIds])], accountUid),
          cliSessionIds: filterSessionIdsForAccount(connectedCliIds, accountUid),
        });
      };
      resources.unsubscribeRpc = subscribeRunningSessions((ids) => {
        rpcIds = ids;
        emitRunning();
      });
      resources.unsubscribeCli = subscribeCliRunningSessions((ids, connectedIds) => {
        cliIds = ids;
        connectedCliIds = connectedIds;
        emitRunning();
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      emitRunning();
      if (closed) return;

      // Heartbeat to keep the connection alive through proxies/timeouts.
      resources.heartbeat = setInterval(() => {
        if (!getAccountByUid(accountUid)) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
