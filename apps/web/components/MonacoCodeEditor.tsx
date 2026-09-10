"use client";

import { useCallback, useEffect, useRef } from "react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import "monaco-editor/esm/vs/editor/edcore.main.js";
import * as monacoEditor from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import type { UiLanguage } from "@/lib/i18n";

loader.config({ monaco: monacoEditor as unknown as typeof import("monaco-editor") });

interface Props {
  value: string;
  language: string;
  filePath: string;
  isDark: boolean;
  wrapLines: boolean;
  fontSize: number;
  location?: string;
  focusToken?: number;
  readOnly?: boolean;
  initialScrollTop?: number;
  initialScrollLeft?: number;
  uiLanguage: UiLanguage;
  onChange: (value: string) => void;
  onSave: () => void;
  onScrollChange?: (scrollTop: number, scrollLeft: number) => void;
  onMentionLines?: (startLine: number, endLine: number) => void;
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void;
}

let workersConfigured = false;
let atomThemesConfigured = false;
let circuitLanguagesConfigured = false;

function configureWorkers() {
  if (workersConfigured || typeof window === "undefined") return;
  workersConfigured = true;
  (globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
    getWorker: () => new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
  };
}

// Highlight circuit source locally. These tokens do not validate circuit behavior.
function configureCircuitLanguages(monaco: typeof monacoEditor) {
  if (circuitLanguagesConfigured) return;
  circuitLanguagesConfigured = true;
  monaco.languages.register({ id: "verilog", extensions: [".v", ".vh", ".sv", ".svh"] });
  monaco.languages.setMonarchTokensProvider("verilog", {
    keywords: ["module", "endmodule", "input", "output", "inout", "wire", "reg", "logic", "assign", "parameter", "localparam", "always", "always_comb", "always_ff", "initial", "begin", "end", "if", "else", "case", "endcase", "default", "for", "generate", "endgenerate", "posedge", "negedge", "or", "and", "not", "function", "endfunction"],
    tokenizer: {
      root: [
        [/\/\//, "comment", "@lineComment"],
        [/\/\*/, "comment", "@comment"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/(?:\d[\d_]*)?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|\d[\d_]*/, "number"],
        [/[a-zA-Z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/[~&|^!=+*/%<>?:-]+/, "operator"],
      ],
      lineComment: [[/.*$/, "comment", "@pop"]],
      comment: [[/[^/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[/*]/, "comment"]],
    },
  });
  monaco.languages.setLanguageConfiguration("verilog", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }, { open: "{", close: "}" }],
  });
  monaco.languages.register({ id: "json", extensions: [".json"] });
  monaco.languages.setMonarchTokensProvider("json", {
    tokenizer: { root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"], [/"(?:[^"\\]|\\.)*"/, "string"], [/\b(?:true|false|null)\b/, "keyword"], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"]] },
  });
}

function configureAtomThemes(monaco: typeof monacoEditor) {
  if (atomThemesConfigured) return;
  atomThemesConfigured = true;
  monaco.editor.defineTheme("fcnpilot-code-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "676F7D" },
      { token: "keyword", foreground: "E06C75" },
      { token: "keyword.control", foreground: "E06C75" },
      { token: "operator", foreground: "E06C75" },
      { token: "string", foreground: "E5C07B" },
      { token: "number", foreground: "C678DD" },
      { token: "type", foreground: "56B6C2" },
      { token: "type.identifier", foreground: "61AFEF" },
      { token: "identifier", foreground: "ABB2BF" },
      { token: "function", foreground: "98C379" },
      { token: "variable", foreground: "ABB2BF" },
      { token: "variable.language", foreground: "E06C75" },
      { token: "variable.parameter", foreground: "D19A66", fontStyle: "italic" },
      { token: "constant", foreground: "56B6C2" },
      { token: "tag", foreground: "E06C75" },
      { token: "attribute.name", foreground: "98C379" },
      { token: "regexp", foreground: "56B6C2" },
      { token: "delimiter", foreground: "ABB2BF" },
      { token: "namespace", foreground: "61AFEF" },
      { token: "class", foreground: "61AFEF" },
      { token: "parameter", foreground: "D19A66", fontStyle: "italic" },
      { token: "property", foreground: "56B6C2" },
      { token: "decorator", foreground: "C678DD" },
      { token: "key", foreground: "56B6C2" },
      { token: "string.key", foreground: "56B6C2" },
      { token: "attribute.value", foreground: "E5C07B" },
      { token: "metatag", foreground: "E06C75" },
      { token: "variable.css", foreground: "56B6C2" },
    ],
    colors: {
      "editor.background": "#282C34",
      "editor.foreground": "#ABB2BF",
      "editorLineNumber.foreground": "#495162",
      "editorLineNumber.activeForeground": "#ABB2BF",
      "editorCursor.foreground": "#F8F8F0",
      "editor.lineHighlightBackground": "#383E4A",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#3E4451",
      "editor.inactiveSelectionBackground": "#343A45",
      "editorIndentGuide.background1": "#3B4048",
      "editorIndentGuide.activeBackground1": "#5C6370",
      "editorWhitespace.foreground": "#484A50",
      "editorGutter.background": "#282C34",
      "editorWidget.background": "#21252B",
      "editorWidget.border": "#181A1F",
      "editorSuggestWidget.background": "#21252B",
      "editorSuggestWidget.selectedBackground": "#2C313A",
      "editorHoverWidget.background": "#21252B",
      "editorOverviewRuler.border": "#00000000",
      "minimap.background": "#282C34",
      "scrollbarSlider.background": "#4E566680",
      "scrollbarSlider.hoverBackground": "#5A637580",
      "scrollbarSlider.activeBackground": "#747D9180",
    },
  });
  monaco.editor.defineTheme("fcnpilot-code-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "A0A1A7", fontStyle: "italic" },
      { token: "keyword", foreground: "A626A4" },
      { token: "string", foreground: "50A14F" },
      { token: "number", foreground: "986801" },
      { token: "type", foreground: "C18401" },
      { token: "type.identifier", foreground: "C18401" },
      { token: "function", foreground: "4078F2" },
      { token: "variable", foreground: "E45649" },
      { token: "constant", foreground: "986801" },
      { token: "tag", foreground: "E45649" },
      { token: "attribute.name", foreground: "986801" },
      { token: "namespace", foreground: "4078F2" },
      { token: "class", foreground: "4078F2" },
      { token: "parameter", foreground: "986801", fontStyle: "italic" },
      { token: "property", foreground: "0184BC" },
      { token: "decorator", foreground: "A626A4" },
      { token: "key", foreground: "0184BC" },
      { token: "string.key", foreground: "0184BC" },
      { token: "attribute.value", foreground: "50A14F" },
      { token: "metatag", foreground: "E45649" },
      { token: "variable.css", foreground: "0184BC" },
    ],
    colors: {
      "editor.background": "#FAFAFA",
      "editor.foreground": "#383A42",
      "editorLineNumber.foreground": "#9DA0A7",
      "editorLineNumber.activeForeground": "#383A42",
      "editorCursor.foreground": "#526FFF",
      "editor.lineHighlightBackground": "#F0F0F1",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#D7D9E0",
      "editor.inactiveSelectionBackground": "#E5E5E6",
      "editorIndentGuide.background1": "#E1E1E2",
      "editorIndentGuide.activeBackground1": "#B4B4B5",
      "editorWhitespace.foreground": "#D0D0D1",
      "editorGutter.background": "#FAFAFA",
      "editorWidget.background": "#F3F3F3",
      "editorWidget.border": "#D0D0D0",
      "minimap.background": "#FAFAFA",
      "scrollbarSlider.background": "#9DA0A733",
      "scrollbarSlider.hoverBackground": "#9DA0A766",
      "scrollbarSlider.activeBackground": "#4078F266",
    },
  });
}

export function MonacoCodeEditor({
  value, language, filePath, isDark, wrapLines, fontSize, location, focusToken,
  readOnly = false, initialScrollTop = 0, initialScrollLeft = 0, uiLanguage,
  onChange, onSave, onScrollChange, onMentionLines, onSelectionChange,
}: Props) {
  const editorLanguage = /\.(?:v|vh|sv|svh)$/i.test(filePath)
    ? "verilog" : language === "bash" ? "shell" : language === "text" ? "plaintext" : language;
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monacoEditor.editor.IEditorDecorationsCollection | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onSave, onScrollChange, onMentionLines, onSelectionChange });
  callbacks.current = { onSave, onScrollChange, onMentionLines, onSelectionChange };

  const revealLocation = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    decorationsRef.current?.clear();
    const match = location?.match(/^L([1-9]\d*)(?:-L?([1-9]\d*))?$/i);
    if (!match) return;
    const start = Math.min(Number(match[1]), model.getLineCount());
    const end = Math.max(start, Math.min(Number(match[2] ?? match[1]), model.getLineCount()));
    const range = new monacoEditor.Range(start, 1, end, model.getLineMaxColumn(end));
    decorationsRef.current = editor.createDecorationsCollection([{ range, options: { isWholeLine: true, className: "monaco-cited-line", linesDecorationsClassName: "monaco-cited-line-gutter" } }]);
    editor.revealRangeInCenter(range);
    editor.setPosition({ lineNumber: start, column: 1 });
    editor.focus();
  }, [location]);

  const beforeMount: BeforeMount = (monaco) => {
    configureWorkers();
    configureAtomThemes(monaco);
    configureCircuitLanguages(monaco);
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const model = editor.getModel();
    if (model && model.getLanguageId() !== editorLanguage) monaco.editor.setModelLanguage(model, editorLanguage);
    editor.setScrollTop(initialScrollTop);
    editor.setScrollLeft(initialScrollLeft);
    const scroll = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged || event.scrollLeftChanged) callbacks.current.onScrollChange?.(event.scrollTop, event.scrollLeft);
    });
    const selection = editor.onDidChangeCursorSelection(({ selection }) => {
      callbacks.current.onSelectionChange?.(selection.isEmpty() ? null : { startLine: selection.startLineNumber, endLine: selection.endLineNumber });
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      const selected = editor.getSelection();
      if (selected && !selected.isEmpty()) callbacks.current.onMentionLines?.(selected.startLineNumber, selected.endLineNumber);
    });
    cleanupRef.current?.();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; editor.layout(); }, 55);
    });
    const host = editorContainerRef.current;
    if (host) observer.observe(host);
    cleanupRef.current = () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      scroll.dispose();
      selection.dispose();
    };
    editor.onDidDispose(() => cleanupRef.current?.());
    revealLocation();
  };

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== editorLanguage) monacoEditor.editor.setModelLanguage(model, editorLanguage);
  }, [editorLanguage, filePath]);
  useEffect(() => { revealLocation(); }, [focusToken, revealLocation]);
  useEffect(() => () => {
    cleanupRef.current?.();
    decorationsRef.current?.clear();
  }, []);

  return (
    <div ref={editorContainerRef} style={{ height: "100%", minHeight: 0 }}>
      <Editor
        path={filePath}
        value={value}
        language={editorLanguage}
        theme={isDark ? "fcnpilot-code-dark" : "fcnpilot-code-light"}
        beforeMount={beforeMount}
        onMount={handleMount}
        onChange={(next) => onChange(next ?? "")}
        loading={<span style={{ color: "var(--text-muted)", fontSize: 12 }}>{uiLanguage === "zh" ? "加载电路编辑器…" : "Loading circuit editor…"}</span>}
        options={{
          readOnly, automaticLayout: false, fontSize,
          fontFamily: "var(--font-mono), monospace", lineNumbers: "on", lineNumbersMinChars: 3,
          minimap: { enabled: false }, wordWrap: wrapLines ? "on" : "off", wrappingIndent: "same",
          quickSuggestions: false, suggestOnTriggerCharacters: false, inlineSuggest: { enabled: false },
          renderValidationDecorations: "off", parameterHints: { enabled: false },
          bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, indentation: true },
          renderWhitespace: "selection", renderLineHighlight: "all", scrollBeyondLastLine: false,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
          padding: { top: 12, bottom: 12 },
        }}
      />
    </div>
  );
}
