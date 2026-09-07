"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type DialogOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PromptOptions = DialogOptions & {
  defaultValue?: string;
  placeholder?: string;
};

type DialogState =
  | ({ kind: "confirm" } & DialogOptions & { resolve: (value: boolean) => void })
  | ({ kind: "prompt" } & PromptOptions & { resolve: (value: string | null) => void })
  | ({ kind: "alert" } & DialogOptions & { resolve: () => void });

type AppDialogApi = {
  confirm: (options: DialogOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  alert: (options: DialogOptions) => Promise<void>;
};

const AppDialogContext = createContext<AppDialogApi | null>(null);

export function useAppDialog(): AppDialogApi {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error("useAppDialog must be used inside AppDialogProvider");
  return value;
}

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<DialogState | null>(null);
  dialogRef.current = dialog;

  const cancelCurrent = useCallback(() => {
    const current = dialogRef.current;
    if (!current) return;
    dialogRef.current = null;
    setDialog(null);
    if (current.kind === "confirm") current.resolve(false);
    else if (current.kind === "prompt") current.resolve(null);
    else current.resolve();
  }, []);

  const open = useCallback((next: DialogState) => {
    const current = dialogRef.current;
    if (current) {
      if (current.kind === "confirm") current.resolve(false);
      else if (current.kind === "prompt") current.resolve(null);
      else current.resolve();
    }
    dialogRef.current = next;
    setDialog(next);
  }, []);

  const api = useMemo<AppDialogApi>(() => ({
    confirm: (options) => new Promise<boolean>((resolve) => open({ kind: "confirm", ...options, resolve })),
    prompt: (options) => new Promise<string | null>((resolve) => open({ kind: "prompt", ...options, resolve })),
    alert: (options) => new Promise<void>((resolve) => open({ kind: "alert", ...options, resolve })),
  }), [open]);

  useEffect(() => {
    if (!dialog) return;
    const timer = window.setTimeout(() => {
      if (dialog.kind === "prompt") inputRef.current?.focus();
      else confirmRef.current?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelCurrent();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelCurrent, dialog]);

  useEffect(() => () => {
    const current = dialogRef.current;
    if (!current) return;
    if (current.kind === "confirm") current.resolve(false);
    else if (current.kind === "prompt") current.resolve(null);
    else current.resolve();
  }, []);

  const accept = useCallback(() => {
    const current = dialogRef.current;
    if (!current) return;
    dialogRef.current = null;
    setDialog(null);
    if (current.kind === "confirm") current.resolve(true);
    else if (current.kind === "prompt") current.resolve(inputRef.current?.value ?? current.defaultValue ?? "");
    else current.resolve();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept();
  };
  const isZh = typeof document === "undefined" || document.documentElement.lang.toLowerCase().startsWith("zh");

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      {dialog && typeof document !== "undefined" && createPortal(
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) cancelCurrent(); }}
          style={{ position: "fixed", inset: 0, zIndex: 5000, display: "grid", placeItems: "center", padding: 18, background: "rgba(2,6,23,0.48)" }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onSubmit={submit}
            style={{ width: "min(430px, calc(100vw - 28px))", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 13, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 24px 80px rgba(0,0,0,0.32)" }}
          >
            <div style={{ padding: "17px 18px 10px" }}>
              <div id="app-dialog-title" style={{ fontSize: 15, fontWeight: 750, lineHeight: 1.35 }}>{dialog.title}</div>
              {dialog.message && <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{dialog.message}</div>}
              {dialog.kind === "prompt" && (
                <input
                  key={`${dialog.title}:${dialog.defaultValue ?? ""}`}
                  ref={inputRef}
                  defaultValue={dialog.defaultValue ?? ""}
                  placeholder={dialog.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ width: "100%", height: 38, marginTop: 13, padding: "0 11px", border: "1px solid var(--border)", borderRadius: 8, outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)" }}
                />
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px 14px" }}>
              {dialog.kind !== "alert" && (
                <button type="button" onClick={cancelCurrent} style={secondaryButtonStyle}>{dialog.cancelLabel ?? (isZh ? "取消" : "Cancel")}</button>
              )}
              <button
                ref={confirmRef}
                type="submit"
                style={{ ...primaryButtonStyle, background: dialog.danger ? "#dc2626" : "var(--accent)", boxShadow: dialog.danger ? "0 1px 3px rgba(220,38,38,0.28)" : "0 1px 3px rgba(37,99,235,0.25)" }}
              >
                {dialog.confirmLabel ?? (dialog.kind === "alert" ? (isZh ? "知道了" : "OK") : (isZh ? "确认" : "Confirm"))}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </AppDialogContext.Provider>
  );
}

const secondaryButtonStyle = {
  height: 34, padding: "0 13px", border: "1px solid var(--border)", borderRadius: 8,
  background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
} as const;

const primaryButtonStyle = {
  height: 34, padding: "0 14px", border: "none", borderRadius: 8,
  color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700,
} as const;
