import { createAgentEventStream } from "@/lib/agent-event-stream";
import { toClientAgentEvent } from "@/lib/agent-event-wire";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { getCliBridgeState, subscribeCliEvents } from "@/lib/cli-bridge";
import { accountOwnsSession, getCurrentAccountUid } from "@/lib/accounts";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return new Response("Not logged in", { status: 401 });
  if (!accountOwnsSession(accountUid, id)) return new Response("Session not found", { status: 404 });
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const cliBridge = getCliBridgeState(id);
  if (cliBridge) {
    return createCliEventResponse(req, id, accountUid);
  }

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    sessionPromise = startRpcSession(id, filePath, undefined, { accountUid })
      .then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return agentEventResponse(stream);
}

function agentEventResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function createCliEventResponse(req: Request, sessionId: string, accountUid: string): Response {
  let cancelStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const resources: {
        unsubscribe: (() => void) | null;
        heartbeat?: ReturnType<typeof setInterval>;
      } = { unsubscribe: null };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (resources.heartbeat) clearInterval(resources.heartbeat);
        resources.unsubscribe?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      cancelStream = cleanup;
      const encode = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      if (req.signal.aborted || !accountOwnsSession(accountUid, sessionId)) {
        cleanup();
        return;
      }

      const state = getCliBridgeState(sessionId);
      encode({
        type: "connected",
        sessionId,
        transport: "cli",
        isStreaming: state?.isStreaming ?? false,
      });
      if (closed) return;
      resources.unsubscribe = subscribeCliEvents(sessionId, (event) => {
        if (!accountOwnsSession(accountUid, sessionId)) {
          cleanup();
          return;
        }
        const eventType = event.type;
        if (typeof eventType !== "string") return;
        const clientEvent = toClientAgentEvent({ ...event, type: eventType });
        if (clientEvent) encode(clientEvent);
        if (eventType === "cli_bridge_disconnected") cleanup();
      });
      if (!resources.unsubscribe) {
        encode({ type: "cli_bridge_disconnected", sessionId });
        cleanup();
        return;
      }
      if (closed) {
        resources.unsubscribe();
        return;
      }

      resources.heartbeat = setInterval(() => {
        if (closed) return;
        if (!accountOwnsSession(accountUid, sessionId) || !getCliBridgeState(sessionId)) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) cleanup();
    },
    cancel() {
      cancelStream();
    },
  });

  return agentEventResponse(stream);
}
