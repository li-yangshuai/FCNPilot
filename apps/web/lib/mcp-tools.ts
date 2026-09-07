import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig, McpServerEntry } from "./mcp-config";
import { loadMcpServers } from "./mcp-config";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse<T = unknown> = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpListToolsResult = {
  tools?: McpTool[];
  nextCursor?: string;
};

type McpToolResultContent =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

type McpCallToolResult = {
  content?: McpToolResultContent[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
};

type McpClientSession = {
  sessionId?: string;
  initialized: boolean;
};

export type McpDiscoveryStatus = {
  name: string;
  url: string;
  source: McpServerEntry["source"];
  ok: boolean;
  tools: Array<{ name: string; piToolName: string; description?: string }>;
  error?: string;
};

const MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
const MAX_TOOL_TEXT_CHARS = 64 * 1024;

const sessions = new Map<string, McpClientSession>();

function discoveryTimeoutMs(config: McpServerConfig): number {
  const env = Number.parseInt(process.env.PI_WEB_MCP_DISCOVERY_TIMEOUT_MS || "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  if (typeof config.connectTimeoutMs === "number" && config.connectTimeoutMs > 0) {
    return config.connectTimeoutMs;
  }
  return DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function toolTimeoutMs(config: McpServerConfig): number {
  if (typeof config.toolTimeoutMs === "number" && config.toolTimeoutMs > 0) {
    return config.toolTimeoutMs;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function parseSsePayload(text: string): unknown {
  const events = text.split(/\n\n+/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      return JSON.parse(data);
    } catch {
      // Keep scanning: some SSE streams include non-JSON events before the
      // JSON-RPC message.
    }
  }
  throw new Error("MCP server returned SSE without a JSON-RPC message");
}

async function parseMcpResponse<T>(response: Response): Promise<JsonRpcResponse<T> | null> {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  const contentType = response.headers.get("content-type") || "";
  const parsed = contentType.includes("text/event-stream")
    ? parseSsePayload(text)
    : JSON.parse(text);
  return parsed as JsonRpcResponse<T>;
}

function headersFor(server: McpServerEntry, session?: McpClientSession): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  for (const [key, value] of Object.entries(server.config.headers || {})) {
    headers.set(key, value);
  }
  if (session?.sessionId) headers.set("mcp-session-id", session.sessionId);
  return headers;
}

async function mcpRequest<T>(
  server: McpServerEntry,
  session: McpClientSession,
  request: JsonRpcRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const response = await fetch(server.config.url, {
    method: "POST",
    headers: headersFor(server, session),
    body: JSON.stringify(request),
    signal: combineSignals(signal, timeoutMs),
  });

  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) session.sessionId = sessionId;

  const payload = await parseMcpResponse<T>(response);
  if (!response.ok) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`MCP ${server.name} ${request.method} failed: ${message}`);
  }
  if (payload?.error) {
    throw new Error(`MCP ${server.name} ${request.method} failed: ${payload.error.message || "JSON-RPC error"}`);
  }
  return payload?.result;
}

async function initialize(server: McpServerEntry, timeoutMs: number, signal?: AbortSignal): Promise<McpClientSession> {
  const key = `${server.name}\0${server.config.url}`;
  const existing = sessions.get(key);
  if (existing?.initialized && server.config.lifecycle === "keep-alive") return existing;

  const session: McpClientSession = existing ?? { initialized: false };
  await mcpRequest(server, session, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fcnpilot-web", version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0" },
    },
  }, timeoutMs, signal);

  await mcpRequest(server, session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, timeoutMs, signal).catch(() => undefined);

  session.initialized = true;
  sessions.set(key, session);
  return session;
}

function sanitizeToolNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "tool";
}

function piToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeToolNamePart(serverName)}_${sanitizeToolNamePart(toolName)}`.slice(0, 96);
}

function ensureObjectSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return schema as Record<string, unknown>;
}

function stringifyMcpContent(result: McpCallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content || []) {
    if (item.type === "text") {
      parts.push(typeof item.text === "string" ? item.text : "");
    } else if (item.type === "image") {
      const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/*";
      const dataLength = typeof item.data === "string" ? item.data.length : 0;
      parts.push(`[image: ${mimeType}, ${dataLength} base64 chars]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.filter(Boolean).join("\n\n") || JSON.stringify(result, null, 2);
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n\n[Truncated MCP tool output at ${MAX_TOOL_TEXT_CHARS} chars]`;
}

function toPiContent(result: McpCallToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const converted: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const item of result.content || []) {
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      converted.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  converted.unshift({ type: "text", text: stringifyMcpContent(result) });
  return converted;
}

function createToolDefinition(server: McpServerEntry, tool: McpTool, session: McpClientSession): ToolDefinition {
  const name = piToolName(server.name, tool.name);
  return {
    name,
    label: `${server.name}: ${tool.name}`,
    description: tool.description
      ? `[MCP ${server.name}] ${tool.description}`
      : `Call MCP tool "${tool.name}" on server "${server.name}".`,
    promptSnippet: `Call MCP ${server.name}/${tool.name}`,
    promptGuidelines: [
      `Use ${name} when the task needs the company MCP server "${server.name}" tool "${tool.name}".`,
    ],
    parameters: ensureObjectSchema(tool.inputSchema) as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await mcpRequest<McpCallToolResult>(server, session, {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: tool.name,
          arguments: params ?? {},
        },
      }, toolTimeoutMs(server.config), signal);

      const safeResult = result ?? { content: [{ type: "text", text: "MCP tool returned no result" }] };
      if (safeResult.isError) {
        throw new Error(stringifyMcpContent(safeResult));
      }
      return {
        content: toPiContent(safeResult),
        details: {
          server: server.name,
          url: server.config.url,
          tool: tool.name,
          piToolName: name,
        },
      };
    },
  };
}

export async function discoverMcpToolsForServer(server: McpServerEntry): Promise<{
  session: McpClientSession;
  tools: McpTool[];
}> {
  const timeout = discoveryTimeoutMs(server.config);
  const session = await initialize(server, timeout);
  const allTools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await mcpRequest<McpListToolsResult>(server, session, {
      jsonrpc: "2.0",
      id: `tools-list-${cursor || "first"}`,
      method: "tools/list",
      params: cursor ? { cursor } : {},
    }, timeout);
    allTools.push(...(result?.tools || []));
    cursor = result?.nextCursor;
  } while (cursor);
  return { session, tools: allTools };
}

export async function createMcpCustomTools(
  cwd: string,
  agentDir: string,
  accountUid: string,
  enabledNames?: ReadonlySet<string>,
): Promise<ToolDefinition[]> {
  const servers = loadMcpServers(cwd, agentDir, accountUid, enabledNames);
  if (servers.length === 0) return [];

  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();
  for (const server of servers) {
    try {
      const discovered = await discoverMcpToolsForServer(server);
      for (const tool of discovered.tools) {
        if (!tool.name) continue;
        const definition = createToolDefinition(server, tool, discovered.session);
        if (usedNames.has(definition.name)) continue;
        usedNames.add(definition.name);
        tools.push(definition);
      }
      console.log(`[pi-web] MCP ${server.name}: registered ${discovered.tools.length} tools from ${server.config.url}`);
    } catch (error) {
      console.warn(`[pi-web] MCP ${server.name}: skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return tools;
}

export async function inspectMcpServers(cwd: string, agentDir: string, accountUid: string): Promise<McpDiscoveryStatus[]> {
  const servers = loadMcpServers(cwd, agentDir, accountUid);
  // Discovery requests are independent. Run them concurrently so one slow or
  // offline MCP server does not delay the status and tool list of every other
  // configured server.
  return Promise.all(servers.map(async (server): Promise<McpDiscoveryStatus> => {
    try {
      const discovered = await discoverMcpToolsForServer(server);
      return {
        name: server.name,
        url: server.config.url,
        source: server.source,
        ok: true,
        tools: discovered.tools.map((tool) => ({
          name: tool.name,
          piToolName: piToolName(server.name, tool.name),
          description: tool.description,
        })),
      };
    } catch (error) {
      return {
        name: server.name,
        url: server.config.url,
        source: server.source,
        ok: false,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
