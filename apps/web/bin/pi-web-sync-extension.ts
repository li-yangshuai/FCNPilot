import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type BridgeCommand = {
  id: string;
  command: Record<string, unknown>;
};

type BridgeSession = {
  clientId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  accountUid?: string;
  username?: string;
};

type PendingContextCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_WEB_URL = `http://127.0.0.1:${process.env.PI_WEB_PORT || "30141"}`;
const EVENT_BATCH_MS = 24;
const HEARTBEAT_MS = 8_000;

export default function piWebSyncExtension(pi: ExtensionAPI) {
  const webUrl = (process.env.PI_WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "");
  const webUser = (process.env.PI_WEB_USER || "").trim();
  const webUid = (process.env.PI_WEB_UID || "").trim();
  const pairingToken = (process.env.PI_WEB_BRIDGE_TOKEN || "").trim();
  const webPassword = process.env.PI_WEB_PASSWORD || "";
  const basicAuthorization = webPassword
    ? `Basic ${Buffer.from(`pi:${webPassword}`, "utf8").toString("base64")}`
    : "";
  const clientId = randomUUID();
  let bridge: BridgeSession | null = null;
  let currentContext: ExtensionContext | null = null;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  let eventQueue: Record<string, unknown>[] = [];
  let sendChain = Promise.resolve();
  let syncAttempt: Promise<void> | null = null;
  let commandLoopRunning = false;
  let lastSyncError = "";
  const contextCommands = new Map<string, PendingContextCommand>();

  const syncErrorText = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const detail = cause && cause !== message ? `${message}: ${cause}` : message;
    return detail.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
  };

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${webUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(basicAuthorization ? { Authorization: basicAuthorization } : {}),
        ...(pairingToken ? { "X-Pi-Web-Bridge-Token": pairingToken } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const stateFromContext = (ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage();
    return {
      sessionName: pi.getSessionName(),
      isStreaming: !ctx.isIdle(),
      isCompacting: false,
      model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : null,
      thinkingLevel: pi.getThinkingLevel(),
      contextUsage: usage
        ? {
            percent: usage.percent,
            contextWindow: usage.contextWindow,
            tokens: usage.tokens,
          }
        : null,
      systemPrompt: ctx.getSystemPrompt(),
      activeTools: pi.getActiveTools(),
    };
  };

  const materializeSession = (ctx: ExtensionContext): string | null => {
    let sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return null;
    if (!existsSync(sessionFile)) {
      const header = ctx.sessionManager.getHeader();
      if (!header) return null;
      mkdirSync(dirname(sessionFile), { recursive: true });
      const entries = [header, ...ctx.sessionManager.getEntries()];
      try {
        writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Pi normally delays its first write until an assistant message exists.
      // Reopening the now-materialized file marks it flushed, preserving the
      // current entries and preventing the later `wx` persistence path from
      // failing because the bridge-created file already exists.
      const writableManager = ctx.sessionManager as typeof ctx.sessionManager & {
        setSessionFile: (filePath: string) => void;
      };
      writableManager.setSessionFile(sessionFile);
      sessionFile = ctx.sessionManager.getSessionFile();
    }
    return sessionFile ?? null;
  };

  const register = async (ctx: ExtensionContext) => {
    const sessionFile = materializeSession(ctx);
    if (!sessionFile) return false;
    bridge = {
      clientId,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      cwd: ctx.cwd,
      ...(webUid ? { accountUid: webUid } : {}),
      ...(webUser ? { username: webUser } : {}),
    };
    await request("/api/cli-bridge/register", {
      method: "POST",
      body: JSON.stringify({
        ...bridge,
        ...stateFromContext(ctx),
      }),
    });
    return true;
  };

  const startCommandLoop = () => {
    if (commandLoopRunning) return;
    commandLoopRunning = true;
    void commandLoop().finally(() => {
      commandLoopRunning = false;
    });
  };

  const syncWithWeb = (ctx: ExtensionContext): Promise<void> => {
    const targetSessionId = ctx.sessionManager.getSessionId();
    if (syncAttempt) {
      return syncAttempt.then(() => {
        if (bridge?.sessionId === targetSessionId) return;
        return syncWithWeb(ctx);
      });
    }
    syncAttempt = (async () => {
      try {
        // /new and /resume can replace the active Pi Session without restarting
        // the CLI process. Detach the previous registration before attaching
        // the new Session, otherwise heartbeats keep updating the old ID.
        if (bridge && bridge.sessionId !== targetSessionId) {
          const previousBridge = bridge;
          bridge = null;
          try {
            await request("/api/cli-bridge/disconnect", {
              method: "POST",
              body: JSON.stringify({
                clientId,
                sessionId: previousBridge.sessionId,
              }),
            });
          } catch {
            // The server also expires stale registrations automatically.
          }
        }
        if (!bridge) {
          if (!await register(ctx)) throw new Error("CLI session file is not ready");
        } else {
          const result = await request<{ registered?: boolean }>("/api/cli-bridge/heartbeat", {
            method: "POST",
            body: JSON.stringify({
              clientId,
              sessionId: bridge.sessionId,
              state: stateFromContext(ctx),
            }),
          });
          if (!result.registered && !await register(ctx)) {
            throw new Error("CLI session file is not ready");
          }
        }
        lastSyncError = "";
        ctx.ui.setStatus("pi-web-sync", "WEB sync");
        startCommandLoop();
      } catch (error) {
        const message = syncErrorText(error);
        ctx.ui.setStatus("pi-web-sync", `WEB sync offline: ${message}`);
        if (message !== lastSyncError) {
          console.error(`[pi-web-sync] ${message}`);
          lastSyncError = message;
        }
      }
    })().finally(() => {
      syncAttempt = null;
    });
    return syncAttempt;
  };

  const heartbeat = () => {
    if (!currentContext || stopped) return;
    void syncWithWeb(currentContext);
  };

  const flushEvents = () => {
    eventTimer = null;
    if (!bridge || eventQueue.length === 0) return;
    const events = eventQueue;
    eventQueue = [];
    const activeBridge = bridge;
    sendChain = sendChain.then(async () => {
      try {
        const result = await request<{ registered?: boolean }>("/api/cli-bridge/events", {
          method: "POST",
          body: JSON.stringify({
            clientId,
            sessionId: activeBridge.sessionId,
            events,
          }),
        });
        if (!result.registered && currentContext) await register(currentContext);
      } catch {
        // Do not block the CLI if the Web UI is unavailable.
      }
    });
  };

  const enqueueEvent = (event: Record<string, unknown>) => {
    if (!bridge || stopped) return;
    eventQueue.push(event);
    if (!eventTimer) eventTimer = setTimeout(flushEvents, EVENT_BATCH_MS);
  };

  const toUserContent = (command: Record<string, unknown>): string | (TextContent | ImageContent)[] => {
    const message = typeof command.message === "string" ? command.message : "";
    const images = Array.isArray(command.images)
      ? command.images as Array<{ data?: unknown; mimeType?: unknown }>
      : [];
    if (images.length === 0) return message;
    return [
      ...(message ? [{ type: "text" as const, text: message }] : []),
      ...images
        .filter((image) => typeof image.data === "string" && typeof image.mimeType === "string")
        .map((image) => ({
          type: "image" as const,
          data: image.data as string,
          mimeType: image.mimeType as string,
        })),
    ];
  };

  const invokeContextCommand = (
    type: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const token = randomUUID();
    const encoded = Buffer.from(JSON.stringify({ token, type, payload }), "utf8").toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        contextCommands.delete(token);
        reject(new Error(`CLI context command timed out: ${type}`));
      }, 20_000);
      contextCommands.set(token, { resolve, reject, timer });
      pi.sendUserMessage(`/__pi_web_bridge ${encoded}`);
    });
  };

  const executeCommand = async (command: Record<string, unknown>): Promise<unknown> => {
    const ctx = currentContext;
    if (!ctx) throw new Error("CLI session context is unavailable");
    const type = String(command.type ?? "");

    switch (type) {
      case "prompt": {
        const behavior = command.streamingBehavior;
        pi.sendUserMessage(toUserContent(command), {
          ...(!ctx.isIdle()
            ? { deliverAs: behavior === "steer" ? "steer" as const : "followUp" as const }
            : {}),
        });
        return null;
      }
      case "steer":
        pi.sendUserMessage(toUserContent(command), { deliverAs: "steer" });
        return null;
      case "follow_up":
        pi.sendUserMessage(toUserContent(command), { deliverAs: "followUp" });
        return null;
      case "abort":
      case "abort_compaction":
        ctx.abort();
        return null;
      case "set_model": {
        const provider = String(command.provider ?? "");
        const modelId = String(command.modelId ?? "");
        // models.json can be edited from the Web UI while this interactive CLI
        // remains open. Refresh before lookup so newly added providers/models
        // are selectable without restarting the CLI session.
        ctx.modelRegistry.refresh();
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        if (!await pi.setModel(model)) throw new Error(`No API key for: ${provider}/${modelId}`);
        return { id: model.id, provider: model.provider };
      }
      case "set_thinking_level":
        pi.setThinkingLevel(command.level as Parameters<typeof pi.setThinkingLevel>[0]);
        return null;
      case "set_tools":
        pi.setActiveTools(Array.isArray(command.toolNames) ? command.toolNames as string[] : []);
        return null;
      case "get_tools": {
        const active = new Set(pi.getActiveTools());
        return pi.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          active: active.has(tool.name),
        }));
      }
      case "get_commands":
        return {
          commands: pi.getCommands().filter((item) => item.name !== "__pi_web_bridge"),
        };
      case "set_session_name":
        pi.setSessionName(String(command.name ?? "").trim());
        return null;
      case "navigate_tree":
        return invokeContextCommand("navigate_tree", {
          targetId: String(command.targetId ?? ""),
        });
      case "compact":
        ctx.compact({
          customInstructions: typeof command.customInstructions === "string"
            ? command.customInstructions
            : undefined,
        });
        return { started: true };
      case "get_last_assistant_text": {
        const entries = ctx.sessionManager.getBranch();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i] as {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          const content = entry.message.content;
          const text = Array.isArray(content)
            ? content
                .filter((part): part is { type: string; text: string } =>
                  !!part && typeof part === "object" &&
                  (part as { type?: unknown }).type === "text" &&
                  typeof (part as { text?: unknown }).text === "string")
                .map((part) => part.text)
                .join("")
            : typeof content === "string" ? content : "";
          return { text };
        }
        return { text: "" };
      }
      case "get_session_stats": {
        const entries = ctx.sessionManager.getBranch();
        return {
          sessionFile: ctx.sessionManager.getSessionFile(),
          sessionId: ctx.sessionManager.getSessionId(),
          sessionName: pi.getSessionName(),
          totalMessages: entries.filter((entry) => entry.type === "message").length,
          contextUsage: ctx.getContextUsage(),
        };
      }
      case "get_state":
        return {
          ...stateFromContext(ctx),
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile(),
          transport: "cli",
          cliConnected: true,
        };
      case "fork":
      case "reload":
        throw new Error(`${type} is not available from Web while the interactive CLI owns the session`);
      default:
        throw new Error(`Unsupported CLI bridge command: ${type}`);
    }
  };

  const respond = async (
    activeBridge: BridgeSession,
    commandId: string,
    success: boolean,
    data?: unknown,
    error?: string,
  ) => {
    try {
      await request("/api/cli-bridge/respond", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          sessionId: activeBridge.sessionId,
          commandId,
          success,
          data,
          error,
        }),
      });
    } catch {
      // Response timeout is surfaced by the Web API caller.
    }
  };

  const commandLoop = async () => {
    while (!stopped && bridge) {
      const activeBridge = bridge;
      try {
        const result = await request<{ commands?: BridgeCommand[] }>(
          `/api/cli-bridge/commands?clientId=${encodeURIComponent(clientId)}&sessionId=${encodeURIComponent(activeBridge.sessionId)}`,
        );
        for (const item of result.commands ?? []) {
          try {
            const data = await executeCommand(item.command);
            await respond(activeBridge, item.id, true, data);
          } catch (error) {
            await respond(
              activeBridge,
              item.id,
              false,
              undefined,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } catch {
        if (currentContext) {
          try { await register(currentContext); } catch { /* retry below */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  };

  pi.registerCommand("__pi_web_bridge", {
    description: "Internal command used by Pi Web synchronization",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let decoded: { token: string; type: string; payload: Record<string, unknown> };
      try {
        decoded = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8")) as typeof decoded;
      } catch {
        return;
      }
      const pending = contextCommands.get(decoded.token);
      if (!pending) return;
      try {
        if (decoded.type === "navigate_tree") {
          const result = await ctx.navigateTree(String(decoded.payload.targetId ?? ""), {});
          pending.resolve({ cancelled: result.cancelled });
        } else {
          throw new Error(`Unsupported context command: ${decoded.type}`);
        }
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        clearTimeout(pending.timer);
        contextCommands.delete(decoded.token);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    stopped = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    await syncWithWeb(ctx);
  });

  pi.on("input", (event, ctx) => {
    currentContext = ctx;
    if (event.source === "interactive") {
      const content: string | (TextContent | ImageContent)[] = event.images?.length
        ? [
            ...(event.text ? [{ type: "text" as const, text: event.text }] : []),
            ...event.images,
          ]
        : event.text;
      enqueueEvent({
        type: "cli_input",
        message: {
          role: "user",
          content,
          timestamp: Date.now(),
        },
        streamingBehavior: event.streamingBehavior,
      });
    }
    return { action: "continue" };
  });

  const forward = (event: object, ctx: ExtensionContext) => {
    currentContext = ctx;
    enqueueEvent(event as Record<string, unknown>);
  };

  pi.on("agent_start", (event, ctx) => forward(event, ctx));
  pi.on("agent_end", (event, ctx) => forward(event, ctx));
  pi.on("turn_start", (event, ctx) => forward(event, ctx));
  pi.on("turn_end", (event, ctx) => forward(event, ctx));
  pi.on("message_start", (event, ctx) => forward(event, ctx));
  pi.on("message_update", (event, ctx) => forward(event, ctx));
  pi.on("message_end", (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_start", (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_update", (event, ctx) => forward(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => forward(event, ctx));
  pi.on("model_select", (event, ctx) => forward(event, ctx));
  pi.on("thinking_level_select", (event, ctx) => forward(event, ctx));
  pi.on("session_compact", (event, ctx) => forward(event, ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    currentContext = ctx;
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (eventTimer) clearTimeout(eventTimer);
    flushEvents();
    for (const pending of contextCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CLI session closed"));
    }
    contextCommands.clear();
    ctx.ui.setStatus("pi-web-sync", undefined);
    if (bridge) {
      const closingBridge = bridge;
      bridge = null;
      try {
        await request("/api/cli-bridge/disconnect", {
          method: "POST",
          body: JSON.stringify({
            clientId,
            sessionId: closingBridge.sessionId,
          }),
        });
      } catch {
        // Web server may already be gone.
      }
    }
  });
}
