import { getCurrentAccountUid } from "@/lib/accounts";
import { getWebTerminal, subscribeWebTerminal } from "@/lib/web-terminal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { id } = await params;
  if (!getWebTerminal(accountUid, id)) return Response.json({ error: "Terminal not found" }, { status: 404 });
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* stream closed */ }
      };
      unsubscribe = subscribeWebTerminal(accountUid, id, send);
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* stream closed */ }
      }, 15_000);
      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
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
