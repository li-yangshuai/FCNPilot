import { existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  getMcpSettingsPaths,
  loadMcpServers,
  removeMcpServer,
  upsertMcpServer,
  type McpConfigScope,
  type McpServerConfig,
} from "@/lib/mcp-config";
import { inspectMcpServers } from "@/lib/mcp-tools";
import { getCurrentAccountUid } from "@/lib/accounts";
import { getAccountPreferences, updateAccountPreferences } from "@/lib/account-preferences";
import { getProjectTrustStatus } from "@/lib/project-trust";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireWorkspace(accountUid: string, cwd: unknown): Promise<string | Response> {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const workspace = cwd.trim();
  const roots = await getAllowedFileRoots(accountUid);
  if (!isFilePathAllowed(workspace, roots)) {
    return NextResponse.json({ error: "cwd is outside the allowed project roots" }, { status: 403 });
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return NextResponse.json({ error: "cwd is not a directory" }, { status: 400 });
  }
  return workspace;
}

function readServerConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== "string" || !raw.url.trim()) return null;
  const optionalNumbers = ["idleTimeout", "toolTimeoutMs", "connectTimeoutMs"] as const;
  if (optionalNumbers.some((key) => raw[key] !== undefined && (
    typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || (raw[key] as number) <= 0
  ))) return null;
  if (raw.directTools !== undefined && typeof raw.directTools !== "boolean") return null;
  if (raw.lifecycle !== undefined && raw.lifecycle !== "keep-alive" && raw.lifecycle !== "per-request") return null;
  if (raw.headers !== undefined && (
    !raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)
    || Object.values(raw.headers).some((header) => typeof header !== "string")
  )) return null;
  return {
    url: raw.url,
    ...(raw.directTools !== undefined ? { directTools: raw.directTools as boolean } : {}),
    ...(typeof raw.lifecycle === "string" ? { lifecycle: raw.lifecycle } : {}),
    ...(typeof raw.idleTimeout === "number" ? { idleTimeout: raw.idleTimeout } : {}),
    ...(typeof raw.toolTimeoutMs === "number" ? { toolTimeoutMs: raw.toolTimeoutMs } : {}),
    ...(typeof raw.connectTimeoutMs === "number" ? { connectTimeoutMs: raw.connectTimeoutMs } : {}),
    ...(raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
  };
}

export async function GET(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const requestUrl = new URL(request.url);
    const workspaceOrResponse = await requireWorkspace(accountUid, requestUrl.searchParams.get("cwd"));
    if (workspaceOrResponse instanceof Response) return workspaceOrResponse;
    const cwd = workspaceOrResponse;

    const agentDir = getAgentDir();
    const settingsPaths = getMcpSettingsPaths(cwd, agentDir, accountUid);
    const configured = loadMcpServers(cwd, agentDir, accountUid);
    // The chat toolbar only needs configured names and enabled state. Avoid
    // connecting to every MCP server on each chat mount when inspect=0.
    const servers = requestUrl.searchParams.get("inspect") === "0"
      ? []
      : await inspectMcpServers(cwd, agentDir, accountUid);
    const preferences = getAccountPreferences(accountUid);
    const enabledNames = preferences.enabledMcpServers === undefined
      ? undefined
      : new Set(preferences.enabledMcpServers);
    const isEnabled = (name: string) => enabledNames === undefined || enabledNames.has(name);
    return NextResponse.json({
      settingsPaths,
      enabledServers: preferences.enabledMcpServers ?? null,
      configured: configured.map((server) => ({
        name: server.name,
        url: server.config.url,
        source: server.source,
        directTools: server.config.directTools,
        lifecycle: server.config.lifecycle,
        enabled: isEnabled(server.name),
      })),
      servers: servers.map((server) => ({
        ...server,
        enabled: isEnabled(server.name),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as {
      cwd?: unknown;
      name?: unknown;
      scope?: unknown;
      config?: unknown;
    };
    const workspaceOrResponse = await requireWorkspace(accountUid, body.cwd);
    if (workspaceOrResponse instanceof Response) return workspaceOrResponse;
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (body.scope !== "global" && body.scope !== "project") {
      return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
    }
    if (body.scope === "project" && !getProjectTrustStatus(workspaceOrResponse, getAgentDir()).trusted) {
      return NextResponse.json({ error: "Trust this project before adding project MCP servers" }, { status: 403 });
    }
    const config = readServerConfig(body.config);
    if (!config) return NextResponse.json({ error: "Invalid MCP server configuration" }, { status: 400 });

    const entry = upsertMcpServer(
      workspaceOrResponse,
      getAgentDir(),
      accountUid,
      body.scope as McpConfigScope,
      body.name,
      config,
    );
    const preferences = getAccountPreferences(accountUid);
    if (preferences.enabledMcpServers !== undefined && !preferences.enabledMcpServers.includes(entry.name)) {
      updateAccountPreferences(accountUid, {
        enabledMcpServers: [...preferences.enabledMcpServers, entry.name],
      });
    }
    return NextResponse.json({ success: true, name: entry.name, source: entry.source });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    const body = await request.json() as { cwd?: unknown; name?: unknown; source?: unknown };
    const workspaceOrResponse = await requireWorkspace(accountUid, body.cwd);
    if (workspaceOrResponse instanceof Response) return workspaceOrResponse;
    if (typeof body.name !== "string" || (body.source !== "global" && body.source !== "project")) {
      return NextResponse.json({ error: "name and source are required" }, { status: 400 });
    }
    const removed = removeMcpServer(
      workspaceOrResponse,
      getAgentDir(),
      accountUid,
      body.name,
      body.source as McpConfigScope,
    );
    if (!removed) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    const preferences = getAccountPreferences(accountUid);
    if (preferences.enabledMcpServers?.includes(body.name)) {
      updateAccountPreferences(accountUid, {
        enabledMcpServers: preferences.enabledMcpServers.filter((name) => name !== body.name),
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const accountUid = await getCurrentAccountUid();
    if (!accountUid) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, "enabledServers")) {
      return NextResponse.json({ error: "enabledServers is required" }, { status: 400 });
    }

    const enabledServers = (body as { enabledServers?: unknown }).enabledServers;
    if (enabledServers !== null && (
      !Array.isArray(enabledServers)
      || enabledServers.some((name) => typeof name !== "string" || !name.trim())
    )) {
      return NextResponse.json(
        { error: "enabledServers must be an array of server names or null" },
        { status: 400 },
      );
    }

    const preferences = updateAccountPreferences(accountUid, {
      enabledMcpServers: enabledServers as string[] | null,
    });
    return NextResponse.json({
      success: true,
      enabledServers: preferences.enabledMcpServers ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
