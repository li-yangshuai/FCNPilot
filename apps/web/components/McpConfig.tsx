"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiLanguage } from "@/lib/i18n";
import { useAppDialog } from "./AppDialogProvider";

interface ConfiguredServer {
  name: string;
  url: string;
  source: "global" | "project";
  directTools?: boolean;
  lifecycle?: string;
  enabled: boolean;
}

interface McpResponse {
  configured?: ConfiguredServer[];
  servers?: DiscoveredServer[];
  enabledServers?: string[] | null;
  error?: string;
}

interface DiscoveredServer {
  name: string;
  source: "global" | "project";
  ok: boolean;
  enabled: boolean;
  tools: Array<{ name: string; piToolName: string; description?: string }>;
  error?: string;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  boxSizing: "border-box",
  outline: "none",
};

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 5, color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>{children}</label>;
}

export function McpConfig({
  cwd,
  uiLanguage,
  onClose,
}: {
  cwd: string;
  uiLanguage: UiLanguage;
  onClose: () => void;
}) {
  const dialog = useAppDialog();
  const zh = uiLanguage === "zh";
  const [servers, setServers] = useState<ConfiguredServer[]>([]);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [enabledServers, setEnabledServers] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<"project" | "global">("project");
  const [lifecycle, setLifecycle] = useState<"keep-alive" | "per-request">("keep-alive");
  const [directTools, setDirectTools] = useState(true);
  const [headersText, setHeadersText] = useState("");
  const [adding, setAdding] = useState(false);
  const refreshGenerationRef = useRef(0);

  const discoverTools = useCallback(async (generation: number) => {
    setDiscovering(true);
    try {
      const response = await fetch(`/api/mcp/tools?cwd=${encodeURIComponent(cwd)}&inspect=1`, { cache: "no-store" });
      const body = await response.json() as McpResponse;
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (refreshGenerationRef.current !== generation) return;
      setDiscoveredServers(body.servers ?? []);
    } catch (discoverError) {
      if (refreshGenerationRef.current !== generation) return;
      setDiscoveredServers([]);
      setError(discoverError instanceof Error ? discoverError.message : String(discoverError));
    } finally {
      if (refreshGenerationRef.current === generation) setDiscovering(false);
    }
  }, [cwd]);

  const load = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    setLoading(true);
    setDiscovering(false);
    setDiscoveredServers([]);
    setError(null);
    try {
      const response = await fetch(`/api/mcp/tools?cwd=${encodeURIComponent(cwd)}&inspect=0`, { cache: "no-store" });
      const body = await response.json() as McpResponse;
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setServers(body.configured ?? []);
      setEnabledServers(body.enabledServers ?? null);
      void discoverTools(generation);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [cwd, discoverTools]);

  useEffect(() => {
    void load();
    return () => {
      // Ignore a late discovery response after the dialog closes or cwd changes.
      refreshGenerationRef.current += 1;
    };
  }, [load]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const effectiveEnabled = useMemo(() => (
    enabledServers === null
      ? new Set(servers.map((server) => server.name))
      : new Set(enabledServers)
  ), [enabledServers, servers]);

  const toggleServer = useCallback(async (serverName: string) => {
    const next = new Set(effectiveEnabled);
    if (next.has(serverName)) next.delete(serverName);
    else next.add(serverName);
    setBusyName(serverName);
    setError(null);
    try {
      const response = await fetch("/api/mcp/tools", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledServers: [...next] }),
      });
      const body = await response.json() as { enabledServers?: string[] | null; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setEnabledServers(body.enabledServers ?? null);
      setServers((previous) => previous.map((server) => (
        server.name === serverName ? { ...server, enabled: next.has(serverName) } : server
      )));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusyName(null);
    }
  }, [effectiveEnabled]);

  const addServer = useCallback(async () => {
    if (!name.trim() || !url.trim() || adding) return;
    setAdding(true);
    setError(null);
    try {
      let headers: Record<string, string> | undefined;
      if (headersText.trim()) {
        const parsed = JSON.parse(headersText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || Object.values(parsed).some((value) => typeof value !== "string")) {
          throw new Error(zh ? "Headers 必须是字符串键值的 JSON 对象" : "Headers must be a JSON object with string values");
        }
        headers = parsed as Record<string, string>;
      }
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          name: name.trim(),
          scope,
          config: { url: url.trim(), directTools, lifecycle, ...(headers ? { headers } : {}) },
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setName("");
      setUrl("");
      setHeadersText("");
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setAdding(false);
    }
  }, [adding, cwd, directTools, headersText, lifecycle, load, name, scope, url, zh]);

  const deleteServer = useCallback(async (server: ConfiguredServer) => {
    const message = zh
      ? `删除 MCP “${server.name}”？对应的 ${server.name}.json 文件也会删除。`
      : `Delete MCP “${server.name}”? Its ${server.name}.json file will also be removed.`;
    const confirmed = await dialog.confirm({ title: zh ? "删除 MCP" : "Delete MCP", message, confirmLabel: zh ? "删除" : "Delete", cancelLabel: zh ? "取消" : "Cancel", danger: true });
    if (!confirmed) return;
    setBusyName(server.name);
    setError(null);
    try {
      const response = await fetch("/api/mcp/tools", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name: server.name, source: server.source }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusyName(null);
    }
  }, [cwd, dialog, load, zh]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={zh ? "MCP 管理" : "MCP manager"}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.45)" }}
    >
      <div style={{ width: "min(820px, 96vw)", maxHeight: "min(760px, 92vh)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)" }}>
        <div style={{ height: 48, padding: "0 16px", display: "flex", alignItems: "center", gap: 9, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
          </svg>
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{zh ? "MCP 管理" : "MCP Manager"}</div>
            <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{cwd}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"} style={{ width: 28, height: 28, border: "none", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ minHeight: 0, overflowY: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 16 }}>
          <section style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
              <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{zh ? "已配置服务" : "Configured servers"}</span>
              <button type="button" onClick={() => void load()} disabled={loading} style={{ border: "none", background: "none", color: "var(--accent)", cursor: loading ? "default" : "pointer", fontSize: 11 }}>{loading ? (zh ? "加载中…" : "Loading…") : discovering ? (zh ? "正在识别工具…" : "Discovering tools…") : (zh ? "刷新工具" : "Refresh tools")}</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {!loading && servers.length === 0 && (
                <div style={{ padding: 20, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>{zh ? "还没有 MCP 服务" : "No MCP servers configured"}</div>
              )}
              {servers.map((server) => {
                const enabled = effectiveEnabled.has(server.name);
                const busy = busyName === server.name;
                const discovery = discoveredServers.find((item) => (
                  item.name === server.name && item.source === server.source
                ));
                return (
                  <div key={`${server.source}:${server.name}`} style={{ padding: "10px 11px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: enabled ? "#22c55e" : "var(--text-dim)", flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{server.name}</span>
                      <span style={{ padding: "1px 5px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--text-dim)", fontSize: 9 }}>{server.source === "global" ? (zh ? "全局" : "global") : (zh ? "工程" : "project")}</span>
                    </div>
                    <div title={server.url} style={{ margin: "6px 0 9px 15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{server.url}</div>
                    <div style={{ margin: "0 0 9px 15px" }}>
                      {!discovery && discovering && (
                        <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{zh ? "正在连接并读取工具集…" : "Connecting and reading tool set…"}</div>
                      )}
                      {discovery?.ok && (
                        <div>
                          <div style={{ marginBottom: discovery.tools.length ? 6 : 0, color: "#16a34a", fontSize: 10, fontWeight: 650 }}>
                            {zh ? `已连接 · 识别到 ${discovery.tools.length} 个工具` : `Connected · ${discovery.tools.length} tools discovered`}
                          </div>
                          {discovery.tools.length > 0 && (
                            <div style={{ maxHeight: 132, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 3, scrollbarWidth: "thin" }}>
                              {discovery.tools.map((tool) => (
                                <div key={tool.piToolName} title={tool.description} style={{ padding: "5px 7px", border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)", borderRadius: 5, background: "var(--bg-panel)" }}>
                                  <div style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 650, overflowWrap: "anywhere" }}>{tool.name}</div>
                                  {tool.description && <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 9, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tool.description}</div>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {discovery && !discovery.ok && (
                        <div title={discovery.error} style={{ color: "#ef4444", fontSize: 10, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                          {zh ? `连接失败：${discovery.error || "未知错误"}` : `Connection failed: ${discovery.error || "Unknown error"}`}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
                      <button type="button" disabled={busy} onClick={() => void toggleServer(server.name)} style={{ height: 26, padding: "0 9px", border: `1px solid ${enabled ? "rgba(34,197,94,0.35)" : "var(--border)"}`, borderRadius: 6, background: enabled ? "rgba(34,197,94,0.10)" : "var(--bg-panel)", color: enabled ? "#16a34a" : "var(--text-muted)", cursor: busy ? "wait" : "pointer", fontSize: 10, fontWeight: 650 }}>{enabled ? (zh ? "已激活" : "Active") : (zh ? "未激活" : "Inactive")}</button>
                      <button type="button" disabled={busy} onClick={() => void deleteServer(server)} style={{ height: 26, padding: "0 8px", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 6, background: "none", color: "#ef4444", cursor: busy ? "wait" : "pointer", fontSize: 10 }}>{zh ? "删除" : "Delete"}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ minWidth: 0, padding: 13, alignSelf: "start", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg)" }}>
            <div style={{ marginBottom: 12, color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{zh ? "增加 MCP" : "Add MCP server"}</div>
            <div style={{ marginBottom: 10 }}><Label>{zh ? "名称" : "Name"}</Label><input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-mcp" style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} /></div>
            <div style={{ marginBottom: 10 }}><Label>URL</Label><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 10 }}>
              <div><Label>{zh ? "保存范围" : "Scope"}</Label><select value={scope} onChange={(event) => setScope(event.target.value as "project" | "global")} style={fieldStyle}><option value="project">{zh ? "当前工程" : "Current project"}</option><option value="global">{zh ? "全局" : "Global"}</option></select></div>
              <div><Label>{zh ? "连接方式" : "Lifecycle"}</Label><select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as "keep-alive" | "per-request")} style={fieldStyle}><option value="keep-alive">keep-alive</option><option value="per-request">per-request</option></select></div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <Label>{zh ? "Headers（可选 JSON）" : "Headers (optional JSON)"}</Label>
              <textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder={'{"Authorization":"Bearer ..."}'} rows={3} style={{ ...fieldStyle, height: 72, padding: 8, resize: "vertical", fontFamily: "var(--font-mono)" }} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}><input type="checkbox" checked={directTools} onChange={(event) => setDirectTools(event.target.checked)} />{zh ? "将工具直接加载到会话" : "Load tools directly into sessions"}</label>
            <button type="button" onClick={() => void addServer()} disabled={adding || !name.trim() || !url.trim()} style={{ width: "100%", height: 34, border: "none", borderRadius: 7, background: "var(--accent)", color: "#fff", cursor: adding || !name.trim() || !url.trim() ? "not-allowed" : "pointer", opacity: adding || !name.trim() || !url.trim() ? 0.55 : 1, fontSize: 12, fontWeight: 700 }}>{adding ? (zh ? "正在增加…" : "Adding…") : (zh ? "增加并激活" : "Add and activate")}</button>
          </section>
        </div>

        <div style={{ minHeight: 38, padding: "8px 16px", display: "flex", alignItems: "center", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ flex: 1, color: error ? "#ef4444" : "var(--text-dim)", fontSize: 11 }}>{error ?? (zh ? "配置保存在 ~/.pi/pi-web/MCP 并由所有账号共享；启用选择按账号保存，新会话生效。" : "Configs are shared from ~/.pi/pi-web/MCP; enabled selections remain account-scoped and apply to new sessions.")}</span>
          <button type="button" onClick={onClose} style={{ height: 28, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{zh ? "完成" : "Done"}</button>
        </div>
      </div>
    </div>
  );
}
