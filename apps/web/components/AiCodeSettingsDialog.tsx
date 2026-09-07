"use client";

import { useEffect, useState } from "react";
import {
  AI_CODE_SETTING_LIMITS,
  DEFAULT_AI_CODE_SETTINGS,
  normalizeAiCodeSettings,
  type AiCodeReasoningLevel,
  type AiCodeSettings,
} from "@/lib/ai-code-settings";
import type { UiLanguage } from "@/lib/i18n";

const REASONING_LEVELS: AiCodeReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function NumericField({
  label,
  value,
  unit,
  limits,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  limits: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>
      <span>{label}</span>
      <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", overflow: "hidden" }}>
        <input
          type="number"
          value={value}
          min={limits.min}
          max={limits.max}
          step={limits.step}
          onChange={(event) => onChange(Number(event.target.value))}
          style={{ width: "100%", minWidth: 0, height: 34, padding: "0 8px", border: "none", outline: "none", background: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
        <span style={{ padding: "0 8px", color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>{unit}</span>
      </div>
    </label>
  );
}

function ReasoningField({ label, value, onChange, zh }: { label: string; value: AiCodeReasoningLevel; onChange: (value: AiCodeReasoningLevel) => void; zh: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, color: "var(--text-muted)", fontSize: 11, fontWeight: 650 }}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as AiCodeReasoningLevel)} style={{ height: 36, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 7, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}>
        {REASONING_LEVELS.map((level) => <option key={level} value={level}>{level === "off" ? (zh ? "关闭（最快）" : "Off (fastest)") : level}</option>)}
      </select>
    </label>
  );
}

export function AiCodeSettingsDialog({
  settings,
  uiLanguage,
  onClose,
  onSaved,
}: {
  settings: AiCodeSettings;
  uiLanguage: UiLanguage;
  onClose: () => void;
  onSaved: (settings: AiCodeSettings) => void;
}) {
  const zh = uiLanguage === "zh";
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const update = <K extends keyof AiCodeSettings>(key: K, value: AiCodeSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (saving) return;
    const normalized = normalizeAiCodeSettings(draft);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/accounts/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiCode: normalized }),
      });
      const body = await response.json() as { preferences?: { aiCode?: AiCodeSettings }; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      onSaved(normalizeAiCodeSettings(body.preferences?.aiCode ?? normalized));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const sectionStyle = { padding: 12, border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg)" } as const;
  return (
    <div role="dialog" aria-modal="true" aria-label={zh ? "AI 编程设置" : "AI coding settings"} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.48)" }}>
      <div style={{ width: "min(680px, 96vw)", maxHeight: "90dvh", overflowY: "auto", padding: 16, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", boxShadow: "0 24px 70px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 800 }}>{zh ? "AI 辅助编程设置" : "AI coding settings"}</div>
            <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>{zh ? "设置按当前账号保存，对所有工程生效。" : "Saved for the current account and applied to every workspace."}</div>
          </div>
          <button type="button" onClick={onClose} style={{ width: 28, height: 28, border: "none", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: "pointer", fontSize: 17 }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(270px, 100%), 1fr))", gap: 12 }}>
          <section style={sectionStyle}>
            <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 12, fontWeight: 750 }}>{zh ? "实时代码补全" : "Inline completion"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <NumericField label={zh ? "触发延迟" : "Trigger delay"} value={draft.completionDelayMs} unit="ms" limits={AI_CODE_SETTING_LIMITS.completionDelayMs} onChange={(value) => update("completionDelayMs", value)} />
              <NumericField label={zh ? "上下文大小" : "Context size"} value={draft.completionContextChars} unit={zh ? "字符" : "chars"} limits={AI_CODE_SETTING_LIMITS.completionContextChars} onChange={(value) => update("completionContextChars", value)} />
              <NumericField label={zh ? "最大输出" : "Max output"} value={draft.completionMaxTokens} unit="tokens" limits={AI_CODE_SETTING_LIMITS.completionMaxTokens} onChange={(value) => update("completionMaxTokens", value)} />
              <ReasoningField label={zh ? "思考强度" : "Reasoning"} value={draft.completionReasoning} onChange={(value) => update("completionReasoning", value)} zh={zh} />
            </div>
          </section>

          <section style={sectionStyle}>
            <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 12, fontWeight: 750 }}>Code Review</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <NumericField label={zh ? "编辑后等待" : "Idle delay"} value={draft.reviewDelayMs} unit="ms" limits={AI_CODE_SETTING_LIMITS.reviewDelayMs} onChange={(value) => update("reviewDelayMs", value)} />
              <NumericField label={zh ? "上下文大小" : "Context size"} value={draft.reviewContextChars} unit={zh ? "字符" : "chars"} limits={AI_CODE_SETTING_LIMITS.reviewContextChars} onChange={(value) => update("reviewContextChars", value)} />
              <NumericField label={zh ? "最大输出" : "Max output"} value={draft.reviewMaxTokens} unit="tokens" limits={AI_CODE_SETTING_LIMITS.reviewMaxTokens} onChange={(value) => update("reviewMaxTokens", value)} />
              <ReasoningField label={zh ? "思考强度" : "Reasoning"} value={draft.reviewReasoning} onChange={(value) => update("reviewReasoning", value)} zh={zh} />
            </div>
          </section>
        </div>

        {error && <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 11 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14 }}>
          <button type="button" onClick={() => setDraft(DEFAULT_AI_CODE_SETTINGS)} style={{ height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{zh ? "恢复默认" : "Restore defaults"}</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{zh ? "取消" : "Cancel"}</button>
            <button type="button" disabled={saving} onClick={() => void save()} style={{ height: 32, padding: "0 14px", border: "none", borderRadius: 7, background: "var(--accent)", color: "white", cursor: saving ? "wait" : "pointer", opacity: saving ? 0.7 : 1, fontSize: 11, fontWeight: 750 }}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存" : "Save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
