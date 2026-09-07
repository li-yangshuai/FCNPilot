"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { textForLanguage, type UiLanguage } from "@/lib/i18n";

interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  exited?: boolean;
}

interface Props {
  cwd: string;
  open: boolean;
  isDark: boolean;
  onClose: () => void;
  /** Optional AI-suggested command. It is pasted into the shell but never auto-executed. */
  initialCommand?: string;
  initialCommandKey?: string;
  contextLabel?: string;
  autoFocus?: boolean;
  uiLanguage?: UiLanguage;
}

export interface TerminalOpenRequest {
  command?: string;
  key?: string;
  contextLabel?: string;
}

function sendTerminalCommand(id: string, body: { data?: string; cols?: number; rows?: number }): Promise<void> {
  return fetch(`/api/terminals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(() => undefined).catch(() => undefined);
}

type PasteIntoTerminal = (text: string) => void;

function TerminalViewport({ terminal, active, isDark, fontSize, onExit, onUserInput, onPasteReady, onPasteError, autoFocus, exitLabel }: {
  terminal: TerminalTab;
  active: boolean;
  isDark: boolean;
  fontSize: number;
  onExit: (id: string) => void;
  onUserInput?: () => void;
  onPasteReady: (id: string, paste: PasteIntoTerminal | null) => void;
  onPasteError: () => void;
  autoFocus: boolean;
  exitLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermTerminal | null>(null);
  const activeRef = useRef(active);
  const autoFocusRef = useRef(autoFocus);
  activeRef.current = active;
  autoFocusRef.current = autoFocus;

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;
    let disposed = false;
    let xterm: XtermTerminal | null = null;
    let source: EventSource | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeCommandTimer: ReturnType<typeof setTimeout> | null = null;
    let inputBuffer = "";
    let inputRequest: Promise<void> | null = null;
    let hostPasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let hostContextMenuHandler: ((event: MouseEvent) => void) | null = null;
    let lastSentCols = 0;
    let lastSentRows = 0;
    const disposables: Array<{ dispose: () => void }> = [];
    let outputFrame: number | null = null;
    let outputBuffer = "";
    let outputWritePending = false;
    const flushOutput = () => {
      outputFrame = null;
      if (!xterm || outputWritePending || !outputBuffer) return;
      const data = outputBuffer;
      outputBuffer = "";
      outputWritePending = true;
      xterm.write(data, () => {
        outputWritePending = false;
        if (disposed || !outputBuffer || outputFrame !== null) return;
        outputFrame = window.requestAnimationFrame(flushOutput);
      });
    };
    const queueOutput = (data: string) => {
      outputBuffer += data;
      if (!outputWritePending && outputFrame === null) outputFrame = window.requestAnimationFrame(flushOutput);
    };
    const flushInput = () => {
      if (inputRequest || !inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = "";
      inputRequest = sendTerminalCommand(terminal.id, { data }).finally(() => {
        inputRequest = null;
        if (inputBuffer) flushInput();
      });
    };

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xtermModule, fitModule]) => {
      if (disposed) return;
      const fitAddon = new fitModule.FitAddon();
      const bundledMono = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-noto-mono")
        .trim();
      const terminalFontFamily = [
        '"JetBrains Mono"',
        '"Cascadia Mono"',
        '"SFMono-Regular"',
        bundledMono,
        '"Noto Sans Mono"',
        '"Liberation Mono"',
        "Menlo",
        "Consolas",
        "monospace",
      ].filter(Boolean).join(", ");
      xterm = new xtermModule.Terminal({
        allowTransparency: false,
        cursorBlink: true,
        cursorStyle: "block",
        cursorWidth: 2,
        fontFamily: terminalFontFamily,
        fontSize,
        fontWeight: "400",
        fontWeightBold: "600",
        letterSpacing: 0,
        lineHeight: 1.3,
        scrollback: 5000,
        convertEol: false,
        theme: isDark
          ? {
              background: "#16161e", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#16161e",
              selectionBackground: "#33467c", black: "#15161e", red: "#f7768e", green: "#9ece6a",
              yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
              brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
              brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
            }
          : {
              background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26",
              selectionBackground: "#33467c", black: "#15161e", red: "#f7768e", green: "#9ece6a",
              yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
              brightBlack: "#565f89", brightRed: "#ff899d", brightGreen: "#a9dc76", brightYellow: "#f3c97b",
              brightBlue: "#89b4fa", brightMagenta: "#c6a0f6", brightCyan: "#89dceb", brightWhite: "#d5d6db",
            },
      });
      xterm.loadAddon(fitAddon);
      xtermRef.current = xterm;
      xterm.open(hostElement);

      const pasteIntoTerminal: PasteIntoTerminal = (clipboardText) => {
        const normalized = clipboardText.replace(/\r\n?/g, "\n").slice(0, 60 * 1024);
        if (!normalized || !xterm) return;
        xterm.paste(normalized);
        xterm.focus();
      };
      onPasteReady(terminal.id, pasteIntoTerminal);

      // Capture paste before xterm's hidden textarea so browsers cannot lose
      // the event when focus sits on the terminal canvas. stopImmediatePropagation
      // also prevents the same clipboard text from being inserted twice.
      hostPasteHandler = (event) => {
        const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
        if (!clipboardText) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        pasteIntoTerminal(clipboardText);
      };
      hostElement.addEventListener("paste", hostPasteHandler, true);

      // Match common desktop terminals: right-click pastes. Clipboard access
      // remains inside a user gesture and failures fall back to keyboard paste.
      hostContextMenuHandler = (event) => {
        event.preventDefault();
        if (!navigator.clipboard?.readText) {
          onPasteError();
          return;
        }
        void navigator.clipboard.readText()
          .then((clipboardText) => pasteIntoTerminal(clipboardText))
          .catch(onPasteError);
      };
      hostElement.addEventListener("contextmenu", hostContextMenuHandler);

      xterm.attachCustomKeyEventHandler((event) => {
        const pasteShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
        // Returning false lets the browser dispatch its native paste event;
        // the capture handler above then forwards it through xterm.paste().
        return !pasteShortcut;
      });

      const fit = () => {
        const bounds = hostElement.getBoundingClientRect();
        if (bounds.width < 2 || bounds.height < 2) return;
        try { fitAddon.fit(); } catch { return; }
        if (!xterm || (xterm.cols === lastSentCols && xterm.rows === lastSentRows)) return;
        lastSentCols = xterm.cols;
        lastSentRows = xterm.rows;
        if (resizeCommandTimer) clearTimeout(resizeCommandTimer);
        resizeCommandTimer = setTimeout(() => {
          resizeCommandTimer = null;
          sendTerminalCommand(terminal.id, { cols: lastSentCols, rows: lastSentRows });
        }, 80);
      };
      const scheduleFit = () => {
        if (fitTimer) clearTimeout(fitTimer);
        // fitAddon measures and rewrites the whole terminal grid. A trailing
        // fit avoids doing that on every pixel of a panel drag.
        fitTimer = setTimeout(() => {
          fitTimer = null;
          fit();
        }, 55);
      };
      fit();
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(hostElement);

      disposables.push(xterm.onData((data) => {
        onUserInput?.();
        inputBuffer += data;
        // Send the first keystroke immediately. Input received while that
        // request is in flight is naturally coalesced into the next request.
        flushInput();
      }));

      source = new EventSource(`/api/terminals/${encodeURIComponent(terminal.id)}/events`);
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; data?: string; exitCode?: number };
          if (payload.type === "output" && typeof payload.data === "string") queueOutput(payload.data);
          if (payload.type === "exit") {
            queueOutput(`\r\n\x1b[90m[${exitLabel} ${payload.exitCode ?? 0}]\x1b[0m\r\n`);
            onExit(terminal.id);
          }
        } catch { /* ignore malformed SSE data */ }
      };
      if (autoFocusRef.current && activeRef.current) xterm.focus();
    });

    return () => {
      disposed = true;
      onPasteReady(terminal.id, null);
      if (outputFrame !== null) window.cancelAnimationFrame(outputFrame);
      if (fitTimer) clearTimeout(fitTimer);
      if (resizeCommandTimer) clearTimeout(resizeCommandTimer);
      flushInput();
      source?.close();
      resizeObserver?.disconnect();
      if (hostPasteHandler) hostElement.removeEventListener("paste", hostPasteHandler, true);
      if (hostContextMenuHandler) hostElement.removeEventListener("contextmenu", hostContextMenuHandler);
      disposables.forEach((disposable) => disposable.dispose());
      xterm?.dispose();
      xtermRef.current = null;
    };
  }, [exitLabel, fontSize, isDark, onExit, onPasteError, onPasteReady, onUserInput, terminal.id]);

  useEffect(() => {
    if (!active || !autoFocus) return;
    const frame = window.requestAnimationFrame(() => xtermRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active, autoFocus]);

  return (
    <div
      ref={hostRef}
      className="integrated-terminal-viewport"
      aria-hidden={!active}
      style={{
        position: "absolute",
        inset: 0,
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
}

export const IntegratedTerminal = memo(function IntegratedTerminal({ cwd, open, isDark, onClose, initialCommand, initialCommandKey, contextLabel, autoFocus = true, uiLanguage = "en" }: Props) {
  const text = textForLanguage(uiLanguage).terminal;
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(13);
  const terminalIdsRef = useRef<string[]>([]);
  const terminalCreationRef = useRef(false);
  const nextTerminalNumberRef = useRef(1);
  const stagedKeysRef = useRef(new Set<string>());
  const [commandStaged, setCommandStaged] = useState(false);
  const pasteHandlersRef = useRef(new Map<string, PasteIntoTerminal>());
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const pasteNoticeTimerRef = useRef<number | null>(null);
  terminalIdsRef.current = terminals.map((terminal) => terminal.id);
  const cwdParts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  const cwdLabel = cwdParts.length > 2 ? `…/${cwdParts.slice(-2).join("/")}` : cwd || "~";

  useEffect(() => {
    const stored = Number(window.localStorage.getItem("lithochat.terminalFontSize"));
    if (Number.isFinite(stored) && stored >= 10 && stored <= 24) setFontSize(stored);
  }, []);

  const changeFontSize = (delta: number) => {
    setFontSize((current) => {
      const next = Math.max(10, Math.min(24, current + delta));
      window.localStorage.setItem("lithochat.terminalFontSize", String(next));
      return next;
    });
  };

  const createTerminal = useCallback(async () => {
    // State updates are asynchronous, so `creating` alone cannot prevent two
    // effect passes (notably React Strict Mode) from starting concurrent PTYs.
    if (terminalCreationRef.current) return;
    terminalCreationRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, cols: 100, rows: 24 }),
      });
      const body = await response.json() as { id?: string; cwd?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error || `HTTP ${response.status}`);
      const terminalNumber = nextTerminalNumberRef.current++;
      const next: TerminalTab = { id: body.id, cwd: body.cwd ?? cwd, title: `bash ${terminalNumber}` };
      setTerminals((current) => [...current, next]);
      setActiveId(next.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      terminalCreationRef.current = false;
      setCreating(false);
    }
  }, [cwd]);

  useEffect(() => {
    const command = initialCommand?.replace(/\r\n?/g, "\n").trim();
    const commandKey = initialCommandKey ?? command;
    if (!activeId || !command || !commandKey || stagedKeysRef.current.has(commandKey)) return;
    stagedKeysRef.current.add(commandKey);
    setCommandStaged(true);
    // Bracketed paste stages the suggestion without executing it. This also
    // works when generated code targets an already-running workspace shell.
    const timer = window.setTimeout(() => {
      void sendTerminalCommand(activeId, { data: `\x1b[200~${command.slice(0, 16_000)}\x1b[201~` });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeId, initialCommand, initialCommandKey]);

  useEffect(() => {
    if (open && terminals.length === 0 && !creating && !error) void createTerminal();
  }, [createTerminal, creating, error, open, terminals.length]);

  useEffect(() => () => {
    for (const id of terminalIdsRef.current) {
      void fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
    }
  }, []);

  const closeTerminal = useCallback((id: string) => {
    void fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.id !== id);
      setActiveId((active) => active === id ? (next.at(-1)?.id ?? null) : active);
      return next;
    });
  }, []);

  const markExited = useCallback((id: string) => {
    setTerminals((current) => current.map((terminal) => terminal.id === id ? { ...terminal, exited: true } : terminal));
  }, []);
  const clearCommandStaged = useCallback(() => setCommandStaged(false), []);
  const registerPasteHandler = useCallback((id: string, paste: PasteIntoTerminal | null) => {
    if (paste) pasteHandlersRef.current.set(id, paste);
    else pasteHandlersRef.current.delete(id);
  }, []);
  const showPasteError = useCallback(() => {
    setPasteNotice(text.pasteUnavailable);
    if (pasteNoticeTimerRef.current !== null) window.clearTimeout(pasteNoticeTimerRef.current);
    pasteNoticeTimerRef.current = window.setTimeout(() => setPasteNotice(null), 4200);
  }, [text.pasteUnavailable]);
  const pasteFromClipboard = useCallback(async () => {
    const paste = activeId ? pasteHandlersRef.current.get(activeId) : null;
    if (!paste || !navigator.clipboard?.readText) {
      showPasteError();
      return;
    }
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText) paste(clipboardText);
      setPasteNotice(null);
    } catch {
      showPasteError();
    }
  }, [activeId, showPasteError]);

  useEffect(() => () => {
    if (pasteNoticeTimerRef.current !== null) window.clearTimeout(pasteNoticeTimerRef.current);
  }, []);

  if (!open) return null;
  return (
    <div className={`integrated-terminal-shell ${isDark ? "is-dark" : "is-light"}`} style={{
      height: "100%",
      width: "100%",
      minHeight: 0,
      minWidth: 0,
      flex: 1,
      display: "flex", flexDirection: "column",
    }}>
      <div className="integrated-terminal-toolbar">
        <span
          className="integrated-terminal-brand"
          role="img"
          aria-label={`FCNPilot ${text.title}`}
          title={`FCNPilot · ${text.title}`}
        >
          <span className="integrated-terminal-ascii-mark" aria-hidden="true">
            <span className="integrated-terminal-ascii-edge">&lt;</span>
            <span className="integrated-terminal-ascii-letter">a</span>
            <span className="integrated-terminal-ascii-edge">&gt;</span>
          </span>
          <span className="integrated-terminal-wordmark">FCNPilot</span>
          <span className="integrated-terminal-product" aria-hidden="true">/ {text.title}</span>
        </span>
        <div className="integrated-terminal-tabs">
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              onClick={() => setActiveId(terminal.id)}
              className={`integrated-terminal-tab${terminal.id === activeId ? " active" : ""}${terminal.exited ? " exited" : ""}`}
            >
              <span className="integrated-terminal-tab-dot" />
              {terminal.title}{terminal.exited ? (uiLanguage === "zh" ? "（已退出）" : " (exited)") : ""}
            </button>
          ))}
        </div>
        {commandStaged && (
          <span className="integrated-terminal-notice">
            {text.commandReady}
          </span>
        )}
        {pasteNotice && <span title={pasteNotice} style={{ marginLeft: 4, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fca5a5", fontSize: 10 }}>{pasteNotice}</span>}
        {contextLabel && <span className="integrated-terminal-context">{contextLabel}</span>}
        <span className="integrated-terminal-cwd" title={cwd}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3.5 6.5h6l2 2h9v9h-17Z" />
          </svg>
          {cwdLabel}
        </span>
        <button className="integrated-terminal-action" type="button" onClick={() => void pasteFromClipboard()} disabled={!activeId} title={text.paste} aria-label={text.paste} style={terminalActionStyle(!activeId, 13)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="8" y="4" width="8" height="4" rx="1" /><path d="M9 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3" />
          </svg>
        </button>
        <button className="integrated-terminal-action integrated-terminal-font-action" type="button" onClick={() => changeFontSize(-1)} disabled={fontSize <= 10} title={`${text.decreaseFont} (${fontSize}px)`} style={terminalActionStyle(fontSize <= 10, 11)}><span>A</span><small>−</small></button>
        <button className="integrated-terminal-action integrated-terminal-font-action" type="button" onClick={() => changeFontSize(1)} disabled={fontSize >= 24} title={`${text.increaseFont} (${fontSize}px)`} style={terminalActionStyle(fontSize >= 24, 11)}><span>A</span><small>+</small></button>
        <button className="integrated-terminal-action" type="button" onClick={() => void createTerminal()} disabled={creating} title={text.newTerminal} style={terminalActionStyle(creating, 16)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        {activeId && <button className="integrated-terminal-action" type="button" onClick={() => closeTerminal(activeId)} title={text.killTerminal} style={terminalActionStyle(false, 14)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>
        </button>}
        <button className="integrated-terminal-action" type="button" onClick={onClose} title={text.hideTerminal} style={{ ...terminalActionStyle(false, 14), marginRight: 5 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>
      {error ? (
        <div style={{ padding: 12, color: "#f87171", fontSize: 12 }}>
          {error} <button type="button" onClick={() => { setError(null); void createTerminal(); }} style={{ marginLeft: 8, color: "#93c5fd", background: "none", border: "none", cursor: "pointer" }}>{text.retry}</button>
        </div>
      ) : creating && terminals.length === 0 ? (
        <div style={{ padding: 12, color: "#71717a", fontSize: 12 }}>{text.starting}</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {terminals.map((terminal) => (
            <TerminalViewport key={terminal.id} terminal={terminal} active={terminal.id === activeId} isDark={isDark} fontSize={fontSize} onExit={markExited} onUserInput={clearCommandStaged} onPasteReady={registerPasteHandler} onPasteError={showPasteError} autoFocus={autoFocus} exitLabel={uiLanguage === "zh" ? "进程退出，代码" : "process exited with code"} />
          ))}
        </div>
      )}
    </div>
  );
});

function terminalActionStyle(disabled: boolean, fontSize: number) {
  return {
    width: 26, height: 22,
    color: "#a1a1aa", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, fontSize,
  } as const;
}
