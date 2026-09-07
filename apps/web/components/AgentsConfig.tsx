"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomAgent, CustomAgentScope } from "@/lib/custom-agents";
import { useAppDialog } from "./AppDialogProvider";

interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  sourceInfo?: { scope?: string; source?: string };
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface McpToolInfo {
  name: string;
  piToolName: string;
  description?: string;
}

interface McpServerInfo {
  name: string;
  ok: boolean;
  enabled: boolean;
  error?: string;
  tools: McpToolInfo[];
}

interface AgentSuiteInfo {
  path: string;
  isDefault: boolean;
  requiresTrust: boolean;
  trusted: boolean;
  agents: number;
  skills: number;
  extensions: number;
  hasSettings: boolean;
}

interface Props {
  cwd: string;
  onClose: () => void;
  onOpenFile: (filePath: string, fileName: string) => void;
}

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_SUBAGENT_CONTROLS = [
  { id: "general-purpose", label: "Agent" },
  { id: "Explore", label: "Explore" },
  { id: "Plan", label: "Plan" },
] as const;
type BuiltinSubagentId = typeof BUILTIN_SUBAGENT_CONTROLS[number]["id"];

function blankAgent(): CustomAgent {
  return {
    id: "",
    name: "",
    description: "",
    scope: "project",
    filePath: "",
    systemPrompt: "You are a specialized coding agent.\n\nDescribe your role, constraints, workflow, and expected output.",
    tools: ["read", "bash", "edit", "write"],
    skills: [],
    allSkills: true,
  };
}

function fieldLabel(text: string, children: React.ReactNode) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{text}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 9px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

export function AgentsConfig({ cwd, onClose, onOpenFile }: Props) {
  const dialog = useAppDialog();
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [draft, setDraft] = useState<CustomAgent>(blankAgent);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hiddenBuiltinSubagentIds, setHiddenBuiltinSubagentIds] = useState<BuiltinSubagentId[]>(() => (
    BUILTIN_SUBAGENT_CONTROLS.map((item) => item.id)
  ));
  const [subagentExtensionAvailable, setSubagentExtensionAvailable] = useState(false);
  const [subagentVisibilitySaving, setSubagentVisibilitySaving] = useState<BuiltinSubagentId | null>(null);
  const [suite, setSuite] = useState<AgentSuiteInfo | null>(null);
  const [suitePath, setSuitePath] = useState("");
  const [suiteEditorOpen, setSuiteEditorOpen] = useState(false);
  const [suiteSaving, setSuiteSaving] = useState(false);
  const [activeMainAgentId, setActiveMainAgentId] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(true);
  const [mcpToolsError, setMcpToolsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsResponse, skillsResponse, modelsResponse, preferencesResponse, suiteResponse, subagentsResponse] = await Promise.all([
        fetch(`/api/agents?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`),
        fetch("/api/accounts/preferences", { cache: "no-store" }),
        fetch("/api/agent-suite", { cache: "no-store" }),
        fetch(`/api/subagents?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" }),
      ]);
      const agentsBody = await agentsResponse.json() as { agents?: CustomAgent[]; error?: string };
      const skillsBody = await skillsResponse.json() as { skills?: SkillInfo[]; error?: string };
      const modelsBody = await modelsResponse.json() as { modelList?: ModelInfo[]; error?: string };
      const preferencesBody = await preferencesResponse.json() as {
        preferences?: { hiddenBuiltinSubagentIds?: BuiltinSubagentId[]; selectedAgentId?: string | null };
        error?: string;
      };
      const suiteBody = await suiteResponse.json() as { suite?: AgentSuiteInfo; error?: string };
      const subagentsBody = await subagentsResponse.json() as { extensionAvailable?: boolean; error?: string };
      if (!agentsResponse.ok) throw new Error(agentsBody.error || "Failed to load Agents");
      if (!skillsResponse.ok) throw new Error(skillsBody.error || "Failed to load Skills");
      if (!preferencesResponse.ok) throw new Error(preferencesBody.error || "Failed to load preferences");
      if (!suiteResponse.ok) throw new Error(suiteBody.error || "Failed to load Agent suite");
      if (!subagentsResponse.ok) throw new Error(subagentsBody.error || "Failed to load subagents");
      setAgents(agentsBody.agents ?? []);
      setSkills(skillsBody.skills ?? []);
      setModels(modelsBody.modelList ?? []);
      setSuite(suiteBody.suite ?? null);
      setSuitePath(suiteBody.suite?.path ?? "");
      setActiveMainAgentId(preferencesBody.preferences?.selectedAgentId ?? null);
      setSubagentExtensionAvailable(Boolean(subagentsBody.extensionAvailable));
      setHiddenBuiltinSubagentIds(
        (preferencesBody.preferences?.hiddenBuiltinSubagentIds ?? BUILTIN_SUBAGENT_CONTROLS.map((item) => item.id))
          .filter((id): id is BuiltinSubagentId => BUILTIN_SUBAGENT_CONTROLS.some((item) => item.id === id)),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const loadMcpTools = useCallback(async () => {
    setMcpToolsLoading(true);
    setMcpToolsError(null);
    try {
      const response = await fetch(`/api/mcp/tools?cwd=${encodeURIComponent(cwd)}&inspect=1`, { cache: "no-store" });
      const body = await response.json() as { servers?: McpServerInfo[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Failed to discover MCP tools");
      setMcpServers(body.servers ?? []);
    } catch (loadError) {
      setMcpServers([]);
      setMcpToolsError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setMcpToolsLoading(false);
    }
  }, [cwd]);

  const activateSuite = async (reset = false) => {
    if (suiteSaving) return;
    setSuiteSaving(true);
    setError(null);
    try {
      let response = await fetch("/api/agent-suite", {
        method: reset ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        ...(reset ? {} : { body: JSON.stringify({ path: suitePath }) }),
      });
      let body = await response.json() as {
        suite?: AgentSuiteInfo;
        error?: string;
        requiresTrust?: boolean;
      };
      if (!reset && response.status === 409 && body.requiresTrust && body.suite) {
        setSuite(body.suite);
        const confirmed = await dialog.confirm({
          title: "Trust Agent Suite?",
          message: `The suite at ${body.suite.path} can load settings, skills, and executable extensions with your local user permissions. Only continue if you trust its contents.`,
          confirmLabel: "Trust and use",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!confirmed) return;
        response = await fetch("/api/agent-suite", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: body.suite.path, trust: true }),
        });
        body = await response.json() as { suite?: AgentSuiteInfo; error?: string };
      }
      if (!response.ok || !body.suite) throw new Error(body.error || `HTTP ${response.status}`);
      setSuite(body.suite);
      setSuitePath(body.suite.path);
      setSelectedId("new");
      setDraft(blankAgent());
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSuiteSaving(false);
    }
  };

  const selectMainAgent = async (agentId: string | null) => {
    const previous = activeMainAgentId;
    setActiveMainAgentId(agentId);
    setError(null);
    try {
      const response = await fetch("/api/accounts/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedAgentId: agentId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    } catch (saveError) {
      setActiveMainAgentId(previous);
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  useEffect(() => {
    void load();
    void loadMcpTools();
  }, [load, loadMcpTools]);

  const toggleBuiltinSubagentVisibility = async (id: BuiltinSubagentId) => {
    if (subagentVisibilitySaving) return;
    const previous = hiddenBuiltinSubagentIds;
    const next = previous.includes(id)
      ? previous.filter((item) => item !== id)
      : [...previous, id];
    setHiddenBuiltinSubagentIds(next);
    setSubagentVisibilitySaving(id);
    setError(null);
    try {
      const response = await fetch("/api/accounts/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiddenBuiltinSubagentIds: next }),
      });
      const body = await response.json() as {
        preferences?: { hiddenBuiltinSubagentIds?: BuiltinSubagentId[] };
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setHiddenBuiltinSubagentIds(
        body.preferences?.hiddenBuiltinSubagentIds ?? BUILTIN_SUBAGENT_CONTROLS.map((item) => item.id),
      );
    } catch (saveError) {
      setHiddenBuiltinSubagentIds(previous);
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSubagentVisibilitySaving(null);
    }
  };

  const selectAgent = (id: string) => {
    setSelectedId(id);
    setError(null);
    const selected = agents.find((agent) => agent.id === id);
    setDraft(selected ? { ...selected, tools: [...(selected.tools ?? [])], skills: [...(selected.skills ?? [])] } : blankAgent());
  };

  const selectedOriginal = agents.find((agent) => agent.id === selectedId);
  const selectedModelValue = draft.provider && draft.modelId ? `${draft.provider}\0${draft.modelId}` : "";
  const uniqueSkills = useMemo(() => {
    const byName = new Map<string, SkillInfo>();
    for (const skill of skills) byName.set(skill.name, skill);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [skills]);

  const saveAgent = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/agents", {
        method: selectedOriginal ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          agent: draft,
          ...(selectedOriginal ? {
            original: {
              name: selectedOriginal.name,
              scope: selectedOriginal.scope,
              mtimeMs: selectedOriginal.mtimeMs,
            },
          } : {}),
        }),
      });
      const body = await response.json() as { agent?: CustomAgent; error?: string };
      if (!response.ok || !body.agent) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      setSelectedId(body.agent.id);
      setDraft(body.agent);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const deleteAgent = async () => {
    if (!selectedOriginal || !await dialog.confirm({ title: "Delete Agent", message: `Delete Agent “${selectedOriginal.name}”?`, confirmLabel: "Delete", cancelLabel: "Cancel", danger: true })) return;
    setSaving(true);
    try {
      const response = await fetch("/api/agents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name: selectedOriginal.name, scope: selectedOriginal.scope }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      selectAgent("new");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 800,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, background: "rgba(0,0,0,0.45)",
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{
        width: "min(1040px, 96vw)", height: "min(760px, 92vh)",
        display: "grid", gridTemplateColumns: "250px minmax(0, 1fr)",
        overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12,
        background: "var(--bg)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)",
      }}>
        <aside style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)", background: "var(--bg-panel)", minHeight: 0 }}>
          <div style={{ padding: "15px 14px 10px", fontSize: 15, fontWeight: 700 }}>Custom Agents</div>
          <div style={{ margin: "0 10px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => setSuiteEditorOpen((open) => !open)}
              style={{
                width: "100%", minHeight: 38, padding: "7px 9px",
                display: "flex", alignItems: "center", gap: 7,
                border: "none", background: "transparent", color: "var(--text)",
                cursor: "pointer", textAlign: "left",
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 15 }}>⌘</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 11, fontWeight: 700 }}>Agent Suite</span>
                <span title={suite?.path} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 9, color: "var(--text-dim)" }}>
                  {suite?.isDefault ? "Default Pi Agent" : (suite?.path.split(/[\\/]/).pop() || suite?.path || "Select directory")}
                </span>
              </span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{suiteEditorOpen ? "−" : "+"}</span>
            </button>
            {suiteEditorOpen && (
              <div style={{ padding: "0 9px 9px", borderTop: "1px solid var(--border)" }}>
                <input
                  value={suitePath}
                  onChange={(event) => setSuitePath(event.target.value)}
                  placeholder="~/.pi/my-agent"
                  spellCheck={false}
                  style={{ ...inputStyle, marginTop: 8, fontSize: 10, fontFamily: "var(--font-mono)" }}
                />
                {suite && (
                  <div style={{ marginTop: 6, fontSize: 9, lineHeight: 1.45, color: "var(--text-dim)" }}>
                    {suite.agents} agents · {suite.skills} skills · {suite.extensions} extensions
                    {suite.hasSettings ? " · settings" : ""}
                    {!suite.trusted ? " · trust required" : ""}
                  </div>
                )}
                <label style={{ display: "block", marginTop: 7 }}>
                  <span style={{ display: "block", marginBottom: 4, fontSize: 9, color: "var(--text-dim)" }}>Main Agent for new sessions</span>
                  <select
                    value={activeMainAgentId ?? ""}
                    onChange={(event) => void selectMainAgent(event.target.value || null)}
                    style={{ ...inputStyle, padding: "5px 7px", fontSize: 10 }}
                  >
                    <option value="">Pi default</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name} · {agent.scope}</option>
                    ))}
                  </select>
                </label>
                <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
                  <button type="button" disabled={suiteSaving || !suitePath.trim()} onClick={() => void activateSuite(false)} style={{ ...inputStyle, flex: 1, padding: "5px 7px", cursor: "pointer", color: "var(--accent)" }}>
                    {suiteSaving ? "Loading…" : "Use suite"}
                  </button>
                  {!suite?.isDefault && (
                    <button type="button" disabled={suiteSaving} onClick={() => void activateSuite(true)} title="Restore the default Pi Agent directory" style={{ ...inputStyle, width: "auto", padding: "5px 7px", cursor: "pointer" }}>
                      Reset
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 6, fontSize: 9, lineHeight: 1.35, color: "var(--text-dim)" }}>
                  New sessions load this main Agent and the suite&apos;s subagents. Models, MCP and session storage remain shared.
                </div>
              </div>
            )}
          </div>
          {subagentExtensionAvailable && <div style={{ margin: "0 10px 10px", padding: 9, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
            <div style={{ marginBottom: 7, display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Subagent delegation</span>
              <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-dim)" }}>shown above input</span>
            </div>
            <div style={{ marginBottom: 7, fontSize: 9, lineHeight: 1.4, color: "var(--text-dim)" }}>
              Optional per-message shortcuts. Selecting one asks the main Agent to delegate that message; selecting several runs them in parallel.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 5 }}>
              {BUILTIN_SUBAGENT_CONTROLS.map((item) => {
                const visible = !hiddenBuiltinSubagentIds.includes(item.id);
                const busy = subagentVisibilitySaving === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={visible}
                    disabled={Boolean(subagentVisibilitySaving)}
                    title={`${visible ? "Hide" : "Show"} ${item.label} above the chat input`}
                    onClick={() => void toggleBuiltinSubagentVisibility(item.id)}
                    style={{
                      minWidth: 0,
                      height: 30,
                      padding: "0 6px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      border: `1px solid ${visible ? "color-mix(in srgb, var(--accent) 30%, var(--border))" : "var(--border)"}`,
                      borderRadius: 6,
                      background: visible ? "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))" : "var(--bg-panel)",
                      color: visible ? "var(--text)" : "var(--text-dim)",
                      cursor: subagentVisibilitySaving ? "wait" : "pointer",
                      opacity: subagentVisibilitySaving && !busy ? 0.58 : 1,
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  >
                    {visible ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m3 3 18 18" /><path d="M10.6 6.2A11.7 11.7 0 0 1 12 6c6.5 0 10 6 10 6a16.6 16.6 0 0 1-2.1 2.8M6.3 6.3C3.5 8.1 2 12 2 12s3.5 6 10 6a10.8 10.8 0 0 0 3.7-.6" />
                      </svg>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>}
          <button
            onClick={() => selectAgent("new")}
            style={{
              margin: "0 10px 10px", padding: "7px 9px",
              border: "1px dashed var(--accent)", borderRadius: 6,
              background: selectedId === "new" ? "rgba(59,130,246,0.09)" : "transparent",
              color: "var(--accent)", cursor: "pointer", textAlign: "left", fontSize: 12,
            }}
          >
            + New Agent
          </button>
          <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => selectAgent(agent.id)}
                style={{
                  width: "100%", padding: "8px 9px", marginBottom: 3,
                  border: "none", borderRadius: 6,
                  background: selectedId === agent.id ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)", cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{agent.name}</span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: agent.scope === "project" ? "var(--accent)" : "var(--text-dim)" }}>{agent.scope}</span>
                </div>
                <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.35, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {agent.description}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <header style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedOriginal ? `Edit ${selectedOriginal.name}` : "Create Agent"}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>.pi/agents compatible · reusable from Pi extensions</div>
            </div>
            <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20 }}>×</button>
          </header>

          {loading ? (
            <div style={{ padding: 20, color: "var(--text-muted)" }}>Loading…</div>
          ) : (
            <>
              <div style={{ flex: 1, overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
                  {fieldLabel("Name", <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="reviewer" style={inputStyle} />)}
                  {fieldLabel("Scope", (
                    <select value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as CustomAgentScope }))} style={inputStyle}>
                      <option value="project">Project</option>
                      <option value="global">Global</option>
                    </select>
                  ))}
                </div>
                {fieldLabel("Description", <input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Reviews code for correctness, security, and maintainability" style={inputStyle} />)}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 170px", gap: 12 }}>
                  {fieldLabel("Model override", (
                    <select
                      value={selectedModelValue}
                      onChange={(event) => {
                        const [provider, modelId] = event.target.value.split("\0");
                        setDraft((current) => ({ ...current, provider: provider || undefined, modelId: modelId || undefined }));
                      }}
                      style={inputStyle}
                    >
                      <option value="">Use session default</option>
                      {models.map((model) => <option key={`${model.provider}:${model.id}`} value={`${model.provider}\0${model.id}`}>{model.provider} · {model.name}</option>)}
                    </select>
                  ))}
                  {fieldLabel("Thinking", (
                    <select value={draft.thinkingLevel ?? ""} onChange={(event) => setDraft((current) => ({ ...current, thinkingLevel: (event.target.value || undefined) as CustomAgent["thinkingLevel"] }))} style={inputStyle}>
                      <option value="">Session default</option>
                      {["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option key={level}>{level}</option>)}
                    </select>
                  ))}
                </div>

                <fieldset style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 10 }}>
                  <legend style={{ padding: "0 5px", fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Tools</legend>
                  <div style={{ marginBottom: 7, fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Built-in</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {TOOL_OPTIONS.map((tool) => (
                      <label key={tool} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
                        <input
                          type="checkbox"
                          checked={draft.tools?.includes(tool) ?? false}
                          onChange={(event) => setDraft((current) => ({
                            ...current,
                            tools: event.target.checked
                              ? [...(current.tools ?? []), tool]
                              : (current.tools ?? []).filter((item) => item !== tool),
                          }))}
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    <div style={{ marginBottom: 7, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>MCP extension tools</span>
                      <span style={{ fontSize: 9, color: "var(--text-dim)" }}>available in new sessions</span>
                      <button
                        type="button"
                        disabled={mcpToolsLoading}
                        onClick={() => void loadMcpTools()}
                        style={{ marginLeft: "auto", padding: 0, border: "none", background: "none", color: "var(--accent)", cursor: mcpToolsLoading ? "wait" : "pointer", fontSize: 10 }}
                      >
                        {mcpToolsLoading ? "Discovering…" : "Refresh"}
                      </button>
                    </div>
                    {mcpToolsError ? (
                      <div style={{ fontSize: 10, color: "#ef4444" }}>{mcpToolsError}</div>
                    ) : mcpToolsLoading && mcpServers.length === 0 ? (
                      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Discovering MCP tools…</div>
                    ) : mcpServers.length === 0 ? (
                      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>No MCP servers configured.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 9, maxHeight: 180, overflow: "auto" }}>
                        {mcpServers.map((server) => (
                          <div key={server.name}>
                            <div style={{ marginBottom: 5, display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
                              <span style={{ fontWeight: 700, color: server.enabled && server.ok ? "var(--text-muted)" : "var(--text-dim)" }}>{server.name}</span>
                              {!server.enabled && <span style={{ color: "var(--text-dim)" }}>disabled in MCP settings</span>}
                              {server.enabled && !server.ok && <span title={server.error} style={{ color: "#ef4444" }}>unavailable</span>}
                            </div>
                            {server.tools.length > 0 ? (
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 5 }}>
                                {server.tools.map((tool) => {
                                  const checked = draft.tools?.includes(tool.piToolName) ?? false;
                                  const unavailable = !server.enabled || !server.ok;
                                  const disabled = unavailable && !checked;
                                  return (
                                    <label key={tool.piToolName} title={tool.description ?? `${server.name}/${tool.name}`} style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: unavailable ? "var(--text-dim)" : "var(--text-muted)" }}>
                                      <input
                                        type="checkbox"
                                        disabled={disabled}
                                        checked={checked}
                                        onChange={(event) => setDraft((current) => ({
                                          ...current,
                                          tools: event.target.checked
                                            ? [...(current.tools ?? []), tool.piToolName]
                                            : (current.tools ?? []).filter((item) => item !== tool.piToolName),
                                        }))}
                                      />
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool.name}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            ) : (
                              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{server.error ?? "No tools reported by this server."}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </fieldset>

                <fieldset style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 10 }}>
                  <legend style={{ padding: "0 5px", fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Skills</legend>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                    <input type="checkbox" checked={draft.allSkills} onChange={(event) => setDraft((current) => ({ ...current, allSkills: event.target.checked }))} />
                    Load all discovered Skills
                  </label>
                  {!draft.allSkills && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 6, maxHeight: 130, overflow: "auto" }}>
                      {uniqueSkills.map((skill) => (
                        <label key={skill.name} title={skill.description} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
                          <input
                            type="checkbox"
                            checked={draft.skills?.includes(skill.name) ?? false}
                            onChange={(event) => setDraft((current) => ({
                              ...current,
                              skills: event.target.checked
                                ? [...(current.skills ?? []), skill.name]
                                : (current.skills ?? []).filter((name) => name !== skill.name),
                            }))}
                          />
                          {skill.name}
                        </label>
                      ))}
                      {uniqueSkills.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>No Skills discovered</span>}
                    </div>
                  )}
                </fieldset>

                {fieldLabel("System prompt", (
                  <textarea
                    value={draft.systemPrompt}
                    onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
                    rows={13}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}
                  />
                ))}
                {error && <div role="alert" style={{ color: "#ef4444", fontSize: 11 }}>{error}</div>}
              </div>
              <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                {selectedOriginal && (
                  <>
                    <button onClick={() => { onOpenFile(selectedOriginal.filePath, `${selectedOriginal.name}.md`); onClose(); }} style={{ padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>Open source</button>
                    <button onClick={() => void deleteAgent()} disabled={saving} style={{ padding: "6px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 11 }}>Delete</button>
                  </>
                )}
                <button onClick={onClose} style={{ marginLeft: "auto", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}>Close</button>
                <button onClick={() => void saveAgent()} disabled={saving} style={{ padding: "6px 12px", border: "none", borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 600 }}>{saving ? "Saving…" : "Save Agent"}</button>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
