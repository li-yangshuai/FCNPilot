"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import "monaco-editor/esm/vs/editor/edcore.main.js";
import * as monacoEditor from "monaco-editor/esm/vs/editor/editor.api.js";
import * as cssLanguage from "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import * as htmlLanguage from "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import * as jsonLanguage from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import * as typescriptLanguage from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
// The package root imports every Monaco language. Keep the languages surfaced
// by the file API, code artifacts and inline-AI providers so production builds
// do not ship dozens of unrelated tokenizers without dropping editor support.
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution.js";
import "monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/vb/vb.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import type { UiLanguage } from "@/lib/i18n";
import type { AiCodeSettings } from "@/lib/ai-code-settings";

Object.assign(monacoEditor.languages, {
  css: cssLanguage,
  html: htmlLanguage,
  json: jsonLanguage,
  typescript: typescriptLanguage,
});

loader.config({ monaco: monacoEditor as unknown as typeof import("monaco-editor") });

interface Props {
  value: string;
  language: string;
  filePath: string;
  projectRoot?: string;
  isDark: boolean;
  wrapLines: boolean;
  fontSize: number;
  location?: string;
  focusToken?: number;
  generateRequest: number;
  aiEnabled: boolean;
  aiReviewEnabled: boolean;
  aiCodeSettings: AiCodeSettings;
  diagnosticsEnabled: boolean;
  readOnly?: boolean;
  initialScrollTop?: number;
  initialScrollLeft?: number;
  uiLanguage: UiLanguage;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiagnostics: (errors: number, warnings: number) => void;
  onLanguageServiceStatus: (status: "builtin" | "connecting" | "clangd" | "unavailable") => void;
  onGenerationState: (state: GenerationState) => void;
  onScrollChange?: (scrollTop: number, scrollLeft: number) => void;
  onMentionLines?: (startLine: number, endLine: number) => void;
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void;
}

export interface GenerationState {
  status: "idle" | "generating" | "suggested" | "done" | "error";
  error?: string;
  modelName?: string;
}

interface AiReviewIssue {
  id: string;
  startLine: number;
  endLine: number;
  severity: "error" | "warning" | "info";
  message: string;
  replacement: string;
  confidence: number;
}

type MonacoEnvironmentValue = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

let workersConfigured = false;
let languageDefaultsConfigured = false;
let cppCompletionRegistered = false;
let aiInlineCompletionRegistered = false;
let atomThemesConfigured = false;
let pythonSemanticTokensRegistered = false;
let genericSemanticTokensRegistered = false;
const cppModelContexts = new Map<string, { filePath: string; cwd: string }>();
const AI_INLINE_LANGUAGES = [
  "c", "cpp", "python", "javascript", "javascriptreact", "typescript", "typescriptreact",
  "java", "kotlin", "go", "rust", "csharp", "swift", "scala", "ruby", "php", "shell", "bash",
  "lua", "r", "dart", "elixir", "fsharp", "vb", "vue", "svelte", "sql", "perl",
  "html", "css", "scss", "less", "xml",
] as const;
const aiModelContexts = new Map<string, {
  filePath: string;
  cwd: string;
  language: string;
  onGenerationState: (state: GenerationState) => void;
  settings: AiCodeSettings;
  blocked?: boolean;
}>();

const aiInlineItemMetadata = new WeakMap<object, { modelUri: string; modelName?: string }>();
function selectAiRequestContext(content: string, rawCursorOffset: number, maxChars: number): { content: string; cursorOffset: number } {
  const cursorOffset = Math.max(0, Math.min(content.length, rawCursorOffset));
  if (content.length <= maxChars) return { content, cursorOffset };

  const headChars = Math.min(6_000, Math.floor(maxChars * 0.14));
  const afterChars = Math.min(10_000, Math.floor(maxChars * 0.23));
  const beforeChars = Math.max(1, maxChars - headChars - afterChars - 80);

  const localStart = Math.max(0, cursorOffset - beforeChars);
  const localEnd = Math.min(content.length, cursorOffset + afterChars);
  if (localStart <= headChars) {
    return { content: content.slice(0, localEnd), cursorOffset };
  }

  // Preserve imports and top-level declarations as well as the larger local
  // window, without serialising the complete editor model on every request.
  const head = content.slice(0, headChars);
  const omission = "\n/* … middle of file omitted from completion context … */\n";
  const local = content.slice(localStart, localEnd);
  return {
    content: `${head}${omission}${local}`,
    cursorOffset: head.length + omission.length + cursorOffset - localStart,
  };
}

type MonacoCancellationGuardWindow = Window & {
  __amedacMonacoCancellationGuard?: boolean;
};

function isExpectedMonacoCancellation(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  if (reason.name !== "Canceled" || reason.message !== "Canceled") return false;
  const stack = reason.stack ?? "";
  return stack.includes("monaco-editor") || stack.includes("vs/base/common/");
}

function ensureMonacoCancellationGuard(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as MonacoCancellationGuardWindow;
  if (guardedWindow.__amedacMonacoCancellationGuard) return;
  guardedWindow.__amedacMonacoCancellationGuard = true;

  // Monaco deliberately rejects internal delay promises when a newer cursor
  // change supersedes an inline completion. Some dev overlays report that
  // expected cancellation as a runtime failure even though the provider and
  // action promise have already handled it. Suppress only Monaco's exact
  // Canceled error; real generation/runtime errors continue to surface.
  window.addEventListener("unhandledrejection", (event) => {
    if (!isExpectedMonacoCancellation(event.reason)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener("error", (event) => {
    if (!isExpectedMonacoCancellation(event.error)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
}

ensureMonacoCancellationGuard();

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value?: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  textEdit?: { newText?: string; range?: LspRange; insert?: LspRange; replace?: LspRange };
  additionalTextEdits?: Array<{ newText: string; range: LspRange }>;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface CommentInstruction {
  instruction: string;
  endLine: number;
  indent: string;
  cursorOffset: number;
}

function cleanCommentInstruction(value: string): string {
  return value
    .replace(/^\s*(?:ai|todo|generate|implement|实现|生成)\s*[:：-]?\s*/i, "")
    .trim();
}

function findCommentInstruction(
  model: monacoEditor.editor.ITextModel,
  position: monacoEditor.Position,
  language: string,
): CommentInstruction | null {
  let line = position.lineNumber;
  if (!model.getLineContent(line).trim() && line > 1) line -= 1;
  const current = model.getLineContent(line);
  const hashComments = ["python", "shell", "bash", "ruby", "perl", "r", "yaml"].includes(language);
  const linePattern = hashComments
    ? /^(\s*)(?:#|\/\/|--|;)\s?(.*)$/
    : /^(\s*)(?:\/\/|--|;)\s?(.*)$/;
  const lineMatch = current.match(linePattern);
  if (lineMatch) {
    const parts: string[] = [];
    for (let candidate = line; candidate >= 1; candidate -= 1) {
      const match = model.getLineContent(candidate).match(linePattern);
      if (!match || match[1] !== lineMatch[1]) break;
      parts.unshift(match[2]);
    }
    const instruction = cleanCommentInstruction(parts.join(" "));
    if (!instruction) return null;
    const endColumn = model.getLineMaxColumn(line);
    return {
      instruction,
      endLine: line,
      indent: lineMatch[1],
      cursorOffset: model.getOffsetAt({ lineNumber: line, column: endColumn }),
    };
  }

  // Block comments: locate the nearest /* ... */ block containing or ending at
  // the cursor line. This covers C/C++, JS/TS, Java, CSS-like and Vue files.
  let blockStart = -1;
  let blockEnd = -1;
  for (let candidate = line; candidate >= Math.max(1, line - 40); candidate -= 1) {
    if (model.getLineContent(candidate).includes("/*")) {
      blockStart = candidate;
      break;
    }
  }
  if (blockStart > 0) {
    for (let candidate = blockStart; candidate <= Math.min(model.getLineCount(), blockStart + 80); candidate += 1) {
      if (model.getLineContent(candidate).includes("*/")) {
        blockEnd = candidate;
        break;
      }
    }
  }
  if (blockStart > 0 && blockEnd >= line) {
    const firstLine = model.getLineContent(blockStart);
    const indent = firstLine.match(/^\s*/)?.[0] ?? "";
    const parts: string[] = [];
    for (let candidate = blockStart; candidate <= blockEnd; candidate += 1) {
      parts.push(model.getLineContent(candidate)
        .replace(/^\s*\/\*+\s?/, "")
        .replace(/^\s*\*\s?/, "")
        .replace(/\s*\*\/\s*$/, ""));
    }
    const instruction = cleanCommentInstruction(parts.join(" "));
    if (!instruction) return null;
    return {
      instruction,
      endLine: blockEnd,
      indent,
      cursorOffset: model.getOffsetAt({ lineNumber: blockEnd, column: model.getLineMaxColumn(blockEnd) }),
    };
  }
  return null;
}

function indentGeneratedCode(value: string, indent: string): string {
  const lines = value.replace(/^\s*\n|\n\s*$/g, "").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const commonIndent = nonEmpty.length > 0
    ? Math.min(...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0))
    : 0;
  return lines.map((line) => line.trim() ? `${indent}${line.slice(commonIndent)}` : "").join("\n");
}

function registerAiInlineCompletionProvider(monaco: typeof monacoEditor) {
  if (aiInlineCompletionRegistered) return;
  aiInlineCompletionRegistered = true;
  monaco.languages.registerInlineCompletionsProvider(AI_INLINE_LANGUAGES, {
    groupId: "amedac-ai-comment-generation",
    async provideInlineCompletions(model, position, context, token) {
      const modelUri = model.uri.toString();
      const modelContext = aiModelContexts.get(modelUri);
      if (!modelContext || modelContext.blocked) return { items: [], suppressSuggestions: false, enableForwardStability: false };
      const comment = findCommentInstruction(model, position, modelContext.language);
      const currentLine = model.getLineContent(position.lineNumber);
      const cursorAtLineEnd = position.column === model.getLineMaxColumn(position.lineNumber);
      const cursorAtCommentEnd = Boolean(comment && position.lineNumber === comment.endLine && cursorAtLineEnd);
      const cursorOnFollowingBlank = Boolean(comment && position.lineNumber === comment.endLine + 1 && !currentLine.trim());
      const explicitlyTriggered = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      // Cursor/content events below own the single 90 ms scheduling path. Ignore
      // Monaco's parallel automatic request so candidates do not race each other.
      if (!explicitlyTriggered) {
        return { items: [], suppressSuggestions: false, enableForwardStability: false };
      }

      if (comment) {
        if (!cursorAtCommentEnd && !cursorOnFollowingBlank) {
          return { items: [], suppressSuggestions: false, enableForwardStability: false };
        }
      }

      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      modelContext.onGenerationState({ status: "generating" });
      try {
        const requestedCursorOffset = comment?.cursorOffset ?? model.getOffsetAt(position);
        const requestedPosition = model.getPositionAt(requestedCursorOffset);
        const requestedLine = model.getLineContent(requestedPosition.lineNumber);
        const requestContext = selectAiRequestContext(model.getValue(), requestedCursorOffset, modelContext.settings.completionContextChars);
        const response = await fetch("/api/code-intelligence/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            filePath: modelContext.filePath,
            cwd: modelContext.cwd,
            content: requestContext.content,
            language: modelContext.language,
            instruction: comment?.instruction || "Infer the developer's intent from the code around the cursor and provide the most likely useful continuation. Complete unfinished expressions, statements, functions, or the next logical code block without repeating existing code.",
            cursorOffset: requestContext.cursorOffset,
            cursorLine: requestedPosition.lineNumber,
            cursorColumn: requestedPosition.column,
            linePrefix: requestedLine.slice(0, requestedPosition.column - 1),
            lineSuffix: requestedLine.slice(requestedPosition.column - 1),
          }),
        });
        const body = await response.json() as { generatedCode?: string; noSuggestion?: boolean; model?: { name?: string }; error?: string };
        if (!response.ok) {
          if (response.status === 503) modelContext.blocked = true;
          throw new Error(body.error || `HTTP ${response.status}`);
        }
        if (body.noSuggestion || !body.generatedCode) {
          modelContext.onGenerationState({ status: "idle" });
          return { items: [], suppressSuggestions: false, enableForwardStability: false };
        }
        const proposed = body.generatedCode.trimStart();
        const existingAfterCaret = requestContext.content.slice(requestContext.cursorOffset).trimStart();
        if (proposed && existingAfterCaret.startsWith(proposed)) {
          modelContext.onGenerationState({ status: "idle" });
          return { items: [], suppressSuggestions: false, enableForwardStability: false };
        }
        if (token.isCancellationRequested) return { items: [], suppressSuggestions: false, enableForwardStability: false };

        const code = comment ? indentGeneratedCode(body.generatedCode, comment.indent) : body.generatedCode;
        const range = comment && cursorOnFollowingBlank
          ? new monaco.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber))
          : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        const insertText = comment ? (cursorOnFollowingBlank ? code : `${model.getEOL()}${code}`) : code;
        modelContext.onGenerationState({ status: "suggested", modelName: body.model?.name });
        const item: monacoEditor.languages.InlineCompletion = { insertText, range };
        aiInlineItemMetadata.set(item, { modelUri, modelName: body.model?.name });
        return {
          items: [item],
          suppressSuggestions: true,
          enableForwardStability: true,
        };
      } catch (error) {
        if (controller.signal.aborted) {
          modelContext.onGenerationState({ status: "idle" });
        } else {
          modelContext.onGenerationState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
        return { items: [], suppressSuggestions: false, enableForwardStability: false };
      } finally {
        cancellation.dispose();
      }
    },
    handleEndOfLifetime(_completions, item, reason) {
      const metadata = aiInlineItemMetadata.get(item);
      if (!metadata) return;
      const modelContext = aiModelContexts.get(metadata.modelUri);
      if (reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Accepted) {
        modelContext?.onGenerationState({ status: "done", modelName: metadata.modelName });
      } else if (
        reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Rejected
        || (reason.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Ignored && !reason.supersededBy)
      ) {
        modelContext?.onGenerationState({ status: "idle" });
      }
    },
    disposeInlineCompletions() {
      // Fetch cancellation is driven by Monaco's cancellation token.
    },
  });
}

function configureWorkers() {
  if (workersConfigured || typeof window === "undefined") return;
  workersConfigured = true;
  (globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentValue }).MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === "json") {
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
      }
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
    },
  };
}

const CODE_SEMANTIC_TOKEN_TYPES = [
  "namespace", "type", "class", "function", "parameter", "variable", "property", "decorator", "constant",
] as const;
type CodeSemanticTokenType = typeof CODE_SEMANTIC_TOKEN_TYPES[number];

interface CodeSemanticToken {
  line: number;
  start: number;
  length: number;
  type: CodeSemanticTokenType;
  declaration?: boolean;
}

function maskPythonCodeLine(line: string, tripleQuote: string | null): { code: string; tripleQuote: string | null } {
  const chars = line.split("");
  const masked = [...chars];
  const singleQuote = String.fromCharCode(39);
  let cursor = 0;
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) masked[index] = " ";
  };
  while (cursor < chars.length) {
    if (tripleQuote) {
      const end = line.indexOf(tripleQuote, cursor);
      if (end < 0) {
        blank(cursor, chars.length);
        return { code: masked.join(""), tripleQuote };
      }
      blank(cursor, end + 3);
      cursor = end + 3;
      tripleQuote = null;
      continue;
    }
    if (chars[cursor] === "#") {
      blank(cursor, chars.length);
      break;
    }
    if (chars[cursor] !== "\"" && chars[cursor] !== singleQuote) {
      cursor += 1;
      continue;
    }
    const quote = chars[cursor];
    if (line.slice(cursor, cursor + 3) === quote.repeat(3)) {
      tripleQuote = quote.repeat(3);
      blank(cursor, cursor + 3);
      cursor += 3;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (cursor < chars.length) {
      if (chars[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (chars[cursor - 1] === quote) break;
    }
    blank(start, Math.min(cursor, chars.length));
  }
  return { code: masked.join(""), tripleQuote };
}

function registerPythonSemanticTokensProvider(monaco: typeof monacoEditor) {
  if (pythonSemanticTokensRegistered) return;
  pythonSemanticTokensRegistered = true;
  const legend: monacoEditor.languages.SemanticTokensLegend = {
    tokenTypes: [...CODE_SEMANTIC_TOKEN_TYPES],
    tokenModifiers: ["declaration"],
  };
  monaco.languages.registerDocumentSemanticTokensProvider("python", {
    getLegend: () => legend,
    provideDocumentSemanticTokens(model, _lastResultId, cancellationToken) {
      const tokens: CodeSemanticToken[] = [];
      const occupied = new Map<number, Array<[number, number]>>();
      const addToken = (line: number, start: number, length: number, type: CodeSemanticTokenType, declaration = false) => {
        if (length <= 0) return;
        const spans = occupied.get(line) ?? [];
        const end = start + length;
        if (spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart)) return;
        spans.push([start, end]);
        occupied.set(line, spans);
        tokens.push({ line, start, length, type, declaration });
      };
      const addMatches = (line: number, code: string, expression: RegExp, type: CodeSemanticTokenType, group = 0, declaration = false) => {
        expression.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(code))) {
          const value = match[group];
          if (!value) continue;
          const relative = match[0].indexOf(value);
          addToken(line, match.index + Math.max(0, relative), value.length, type, declaration);
          if (match[0].length === 0) expression.lastIndex += 1;
        }
      };
      let tripleQuote: string | null = null;
      let inFunctionSignature = false;
      let signatureDepth = 0;
      for (let line = 0; line < model.getLineCount(); line += 1) {
        if (line % 200 === 0 && cancellationToken.isCancellationRequested) break;
        const source = model.getLineContent(line + 1);
        const masked = maskPythonCodeLine(source, tripleQuote);
        tripleQuote = masked.tripleQuote;
        const code = masked.code;

        const classMatch = /\bclass\s+([A-Za-z_]\w*)/.exec(code);
        if (classMatch) addToken(line, classMatch.index + classMatch[0].lastIndexOf(classMatch[1]), classMatch[1].length, "class", true);

        const defMatch = /\b(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(code);
        if (defMatch) {
          addToken(line, defMatch.index + defMatch[0].lastIndexOf(defMatch[1]), defMatch[1].length, "function", true);
          inFunctionSignature = true;
          signatureDepth = 0;
        }

        const decoratorMatch = /^\s*@([A-Za-z_]\w*)/.exec(code);
        if (decoratorMatch) addToken(line, decoratorMatch.index + decoratorMatch[0].lastIndexOf(decoratorMatch[1]), decoratorMatch[1].length, "decorator");

        const fromMatch = /^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(code);
        if (fromMatch) {
          const moduleStart = fromMatch.index + fromMatch[0].lastIndexOf(fromMatch[1]);
          for (const part of fromMatch[1].matchAll(/[A-Za-z_]\w*/g)) addToken(line, moduleStart + part.index, part[0].length, "namespace");
        }
        const importMatch = /^\s*import\s+(.+)/.exec(code);
        if (importMatch) {
          const clauseStart = importMatch.index + importMatch[0].lastIndexOf(importMatch[1]);
          for (const part of importMatch[1].matchAll(/[A-Za-z_]\w*/g)) {
            if (part[0] !== "as") addToken(line, clauseStart + part.index, part[0].length, "namespace");
          }
        }

        const openCount = (code.match(/\(/g) ?? []).length;
        const closeCount = (code.match(/\)/g) ?? []).length;
        if (inFunctionSignature) {
          addMatches(line, code, /(?:^|[,(])\s*([A-Za-z_]\w*)\s*(?=[:=,)])/g, "parameter", 1);
          for (const annotation of code.matchAll(/(?:^|[:,]|->)\s*([A-Za-z_]\w*(?:\s*[\[|.,]\s*[A-Za-z_]\w*)*)/g)) {
            const annotationText = annotation[1];
            const annotationStart = annotation.index + annotation[0].lastIndexOf(annotationText);
            for (const typeName of annotationText.matchAll(/[A-Za-z_]\w*/g)) {
              if (typeName[0] !== "None") addToken(line, annotationStart + typeName.index, typeName[0].length, "type");
            }
          }
          signatureDepth += openCount - closeCount;
          if (signatureDepth <= 0 && code.includes(":")) inFunctionSignature = false;
        }

        addMatches(line, code, /\b(self|cls)\b/g, "parameter", 1);
        addMatches(line, code, /\b([A-Z][A-Z0-9_]{2,})\b/g, "constant", 1);
        addMatches(line, code, /\b([A-Z][A-Za-z0-9_]*)\b/g, "class", 1);
        addMatches(line, code, /\.([A-Za-z_]\w*)/g, "property", 1);
        for (const call of code.matchAll(/\b([A-Za-z_]\w*)\s*(?=\()/g)) {
          if (["if", "for", "while", "with", "return", "class", "def"].includes(call[1])) continue;
          addToken(line, call.index, call[1].length, /^[A-Z]/.test(call[1]) ? "class" : "function");
        }
      }
      tokens.sort((left, right) => left.line - right.line || left.start - right.start);
      const encoded: number[] = [];
      let previousLine = 0;
      let previousStart = 0;
      for (const token of tokens) {
        const deltaLine = token.line - previousLine;
        const deltaStart = deltaLine === 0 ? token.start - previousStart : token.start;
        encoded.push(deltaLine, deltaStart, token.length, CODE_SEMANTIC_TOKEN_TYPES.indexOf(token.type), token.declaration ? 1 : 0);
        previousLine = token.line;
        previousStart = token.start;
      }
      return { data: new Uint32Array(encoded) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}

const GENERIC_SEMANTIC_LANGUAGES = [
  "c", "cpp", "csharp", "java", "javascript", "typescript", "go", "rust",
  "kotlin", "swift", "scala", "ruby", "php", "shell", "powershell", "lua",
  "r", "dart", "elixir", "fsharp", "vb", "graphql", "hcl", "makefile", "perl",
] as const;
const HASH_COMMENT_LANGUAGES = new Set([
  "shell", "powershell", "ruby", "r", "elixir", "graphql", "hcl", "makefile", "perl",
]);
const DASH_COMMENT_LANGUAGES = new Set(["lua"]);
const GENERIC_CALL_KEYWORDS = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "with", "return", "class",
  "struct", "interface", "enum", "trait", "record", "protocol", "type", "def",
  "function", "func", "fn", "fun", "new", "sizeof", "typeof", "match", "when",
]);

function maskGenericCodeLine(
  line: string,
  language: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  const chars = line.split("");
  const masked = [...chars];
  const singleQuote = String.fromCharCode(39);
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) masked[index] = " ";
  };
  let cursor = 0;
  while (cursor < chars.length) {
    if (inBlockComment) {
      const end = line.indexOf("*/", cursor);
      if (end < 0) {
        blank(cursor, chars.length);
        return { code: masked.join(""), inBlockComment };
      }
      blank(cursor, end + 2);
      cursor = end + 2;
      inBlockComment = false;
      continue;
    }
    const pair = line.slice(cursor, cursor + 2);
    if (pair === "/*") {
      inBlockComment = true;
      blank(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (
      pair === "//"
      || (HASH_COMMENT_LANGUAGES.has(language) && chars[cursor] === "#")
      || (DASH_COMMENT_LANGUAGES.has(language) && pair === "--")
    ) {
      blank(cursor, chars.length);
      break;
    }
    const quote = chars[cursor];
    if (quote !== "\"" && quote !== singleQuote && quote !== "`") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (cursor < chars.length) {
      if (chars[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (chars[cursor - 1] === quote) break;
    }
    blank(start, Math.min(cursor, chars.length));
  }
  return { code: masked.join(""), inBlockComment };
}

function registerGenericSemanticTokensProvider(monaco: typeof monacoEditor) {
  if (genericSemanticTokensRegistered) return;
  genericSemanticTokensRegistered = true;
  const legend: monacoEditor.languages.SemanticTokensLegend = {
    tokenTypes: [...CODE_SEMANTIC_TOKEN_TYPES],
    tokenModifiers: ["declaration"],
  };
  monaco.languages.registerDocumentSemanticTokensProvider(GENERIC_SEMANTIC_LANGUAGES, {
    getLegend: () => legend,
    provideDocumentSemanticTokens(model, _lastResultId, cancellationToken) {
      const language = model.getLanguageId();
      const tokens: CodeSemanticToken[] = [];
      const occupied = new Map<number, Array<[number, number]>>();
      const addToken = (line: number, start: number, length: number, type: CodeSemanticTokenType, declaration = false) => {
        if (length <= 0) return;
        const spans = occupied.get(line) ?? [];
        const end = start + length;
        if (spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart)) return;
        spans.push([start, end]);
        occupied.set(line, spans);
        tokens.push({ line, start, length, type, declaration });
      };
      const addMatches = (line: number, code: string, expression: RegExp, type: CodeSemanticTokenType, group = 0, declaration = false) => {
        expression.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(code))) {
          const value = match[group];
          if (!value) continue;
          const relative = match[0].indexOf(value);
          addToken(line, match.index + Math.max(0, relative), value.length, type, declaration);
          if (match[0].length === 0) expression.lastIndex += 1;
        }
      };
      let inBlockComment = false;
      let inFunctionSignature = false;
      let signatureDepth = 0;
      for (let line = 0; line < model.getLineCount(); line += 1) {
        if (line % 200 === 0 && cancellationToken.isCancellationRequested) break;
        const masked = maskGenericCodeLine(model.getLineContent(line + 1), language, inBlockComment);
        inBlockComment = masked.inBlockComment;
        const code = masked.code;

        const typeDeclaration = /\b(?:class|struct|interface|enum|trait|record|protocol|type)\s+([A-Za-z_$][\w$]*)/.exec(code);
        if (typeDeclaration) {
          const name = typeDeclaration[1];
          addToken(line, typeDeclaration.index + typeDeclaration[0].lastIndexOf(name), name.length, "class", true);
        }

        const keywordFunction = /\b(?:function|func|fn|def|fun)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/.exec(code);
        const typedFunction = /^\s*(?:(?:public|private|protected|internal|static|final|virtual|override|abstract|async|extern|inline|constexpr|const|unsafe|suspend)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$:<>,.\[\]*&?]*\s+)+([A-Za-z_$][\w$]*)\s*\(/.exec(code);
        const functionDeclaration = keywordFunction ?? typedFunction;
        if (functionDeclaration) {
          const name = functionDeclaration[1];
          addToken(line, functionDeclaration.index + functionDeclaration[0].lastIndexOf(name), name.length, "function", true);
          inFunctionSignature = true;
          signatureDepth = 0;
        }

        const decorator = /^\s*@([A-Za-z_$][\w$]*)/.exec(code);
        if (decorator) addToken(line, decorator.index + decorator[0].lastIndexOf(decorator[1]), decorator[1].length, "decorator");

        const importClause = /^\s*(?:import|package|namespace|using|use|require|module)\s+(.+)/.exec(code);
        if (importClause) {
          const clauseStart = importClause.index + importClause[0].lastIndexOf(importClause[1]);
          for (const part of importClause[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
            if (part[0] !== "as" && part[0] !== "from") addToken(line, clauseStart + part.index, part[0].length, "namespace");
          }
        }

        const openCount = (code.match(/\(/g) ?? []).length;
        const closeCount = (code.match(/\)/g) ?? []).length;
        if (inFunctionSignature) {
          addMatches(line, code, /(?:^|[,(])\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[:=,)])/g, "parameter", 1);
          addMatches(line, code, /\b([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*(?=[,)=])/g, "parameter", 1);
          signatureDepth += openCount - closeCount;
          if (signatureDepth <= 0 && (code.includes("{") || code.includes("=>") || code.includes(":"))) inFunctionSignature = false;
        }

        addMatches(line, code, /\b([A-Z][A-Z0-9_]{2,})\b/g, "constant", 1);
        addMatches(line, code, /\b([A-Z][A-Za-z0-9_$]*)\b/g, "class", 1);
        addMatches(line, code, /(?:\.|->|::)([A-Za-z_$][\w$]*)/g, "property", 1);
        for (const call of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g)) {
          if (GENERIC_CALL_KEYWORDS.has(call[1])) continue;
          addToken(line, call.index, call[1].length, /^[A-Z]/.test(call[1]) ? "class" : "function");
        }
        for (const macro of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?=!\s*[({\[])/g)) {
          addToken(line, macro.index, macro[1].length, "function");
        }
      }
      tokens.sort((left, right) => left.line - right.line || left.start - right.start);
      const encoded: number[] = [];
      let previousLine = 0;
      let previousStart = 0;
      for (const token of tokens) {
        const deltaLine = token.line - previousLine;
        const deltaStart = deltaLine === 0 ? token.start - previousStart : token.start;
        encoded.push(deltaLine, deltaStart, token.length, CODE_SEMANTIC_TOKEN_TYPES.indexOf(token.type), token.declaration ? 1 : 0);
        previousLine = token.line;
        previousStart = token.start;
      }
      return { data: new Uint32Array(encoded) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}


function configureAtomThemes(monaco: typeof monacoEditor) {
  if (atomThemesConfigured) return;
  atomThemesConfigured = true;
  monaco.editor.defineTheme("amedac-atom-dark", {
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
  monaco.editor.defineTheme("amedac-atom-light", {
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

function parseLineLocation(location?: string): { start: number; end: number } | null {
  const match = location?.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2] ?? match[1]) };
}

function toMonacoRange(range: LspRange): monacoEditor.Range {
  return new monacoEditor.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function completionKind(kind?: number): monacoEditor.languages.CompletionItemKind {
  const kinds = monacoEditor.languages.CompletionItemKind;
  const mapping: Record<number, monacoEditor.languages.CompletionItemKind> = {
    1: kinds.Text,
    2: kinds.Method,
    3: kinds.Function,
    4: kinds.Constructor,
    5: kinds.Field,
    6: kinds.Variable,
    7: kinds.Class,
    8: kinds.Interface,
    9: kinds.Module,
    10: kinds.Property,
    11: kinds.Unit,
    12: kinds.Value,
    13: kinds.Enum,
    14: kinds.Keyword,
    15: kinds.Snippet,
    16: kinds.Color,
    17: kinds.File,
    18: kinds.Reference,
    19: kinds.Folder,
    20: kinds.EnumMember,
    21: kinds.Constant,
    22: kinds.Struct,
    23: kinds.Event,
    24: kinds.Operator,
    25: kinds.TypeParameter,
  };
  return mapping[kind ?? 0] ?? kinds.Text;
}

function registerCppCompletionProvider(monaco: typeof monacoEditor) {
  if (cppCompletionRegistered) return;
  cppCompletionRegistered = true;
  monaco.languages.registerCompletionItemProvider(["cpp", "c"], {
    triggerCharacters: [".", ":", ">", "#", "\"", "/", "<"],
    async provideCompletionItems(model, position, context, cancellationToken) {
      const modelContext = cppModelContexts.get(model.uri.toString());
      if (!modelContext) return { suggestions: [] };
      const controller = new AbortController();
      const disposable = cancellationToken.onCancellationRequested(() => controller.abort());
      try {
        const response = await fetch("/api/code-intelligence/completion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            ...modelContext,
            content: model.getValue(),
            line: position.lineNumber - 1,
            character: position.column - 1,
            triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : 1,
            triggerCharacter: context.triggerCharacter,
          }),
        });
        const body = await response.json() as { items?: LspCompletionItem[]; error?: string };
        if (!response.ok) return { suggestions: [] };
        const fallbackRange = (() => {
          const word = model.getWordUntilPosition(position);
          return new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        })();
        return {
          suggestions: (body.items ?? []).map((item) => {
            const editRange = item.textEdit?.range ?? item.textEdit?.replace ?? item.textEdit?.insert;
            const insertText = item.textEdit?.newText ?? item.insertText ?? item.label;
            return {
              label: item.label.replace(/^[\s•]+/, ""),
              kind: completionKind(item.kind),
              detail: item.detail,
              documentation: typeof item.documentation === "string"
                ? item.documentation
                : item.documentation?.value,
              insertText,
              insertTextRules: item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              filterText: item.filterText,
              sortText: item.sortText,
              range: editRange ? toMonacoRange(editRange) : fallbackRange,
              additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
                text: edit.newText,
                range: toMonacoRange(edit.range),
              })),
            } satisfies monacoEditor.languages.CompletionItem;
          }),
        };
      } catch {
        return { suggestions: [] };
      } finally {
        disposable.dispose();
      }
    },
  });
}

export function MonacoCodeEditor({
  value,
  language,
  filePath,
  projectRoot,
  isDark,
  wrapLines,
  fontSize,
  location,
  focusToken,
  generateRequest,
  aiEnabled,
  aiReviewEnabled,
  aiCodeSettings,
  diagnosticsEnabled,
  readOnly = false,
  initialScrollTop = 0,
  initialScrollLeft = 0,
  uiLanguage,
  onChange,
  onSave,
  onDiagnostics,
  onLanguageServiceStatus,
  onGenerationState,
  onScrollChange,
  onMentionLines,
  onSelectionChange,
}: Props) {
  // Monaco keeps models by file URI. When a tab is reopened or a file is
  // renamed, an existing plaintext model can otherwise survive after the file type changes.
  // Keep small Python and shell fallbacks for stale file metadata.
  const normalizedLanguage = language === "bash" ? "shell" : language;
  const editorLanguage = (normalizedLanguage === "text" || normalizedLanguage === "plaintext")
    ? (/\.pyw?$/i.test(filePath)
      ? "python"
      : (/\.(?:sh|bash|zsh|fish|ksh)$/i.test(filePath) ? "shell" : "plaintext"))
    : normalizedLanguage;
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monacoEditor.editor.IEditorDecorationsCollection | null>(null);
  const onSaveRef = useRef(onSave);
  const onScrollChangeRef = useRef(onScrollChange);
  const onMentionLinesRef = useRef(onMentionLines);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const inlineTriggerTimerRef = useRef<number | null>(null);
  const generateRef = useRef<() => void>(() => {});
  const aiEnabledRef = useRef(aiEnabled);
  const aiCodeSettingsRef = useRef(aiCodeSettings);
  const [reviewStatus, setReviewStatus] = useState<"idle" | "reviewing" | "ready" | "error">("idle");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewIssues, setReviewIssues] = useState<AiReviewIssue[]>([]);
  const [selectedReviewIndex, setSelectedReviewIndex] = useState<number | null>(null);
  const [reviewPanelHeight, setReviewPanelHeight] = useState(240);
  const [reviewPanelExpanded, setReviewPanelExpanded] = useState(false);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorLayoutCleanupRef = useRef<(() => void) | null>(null);
  const reviewResizeCleanupRef = useRef<(() => void) | null>(null);
  const reviewIssuesRef = useRef<AiReviewIssue[]>([]);
  const selectedReviewIndexRef = useRef<number | null>(null);
  const ignoredReviewIssuesRef = useRef(new Set<string>());
  const reviewDecorationsRef = useRef<monacoEditor.editor.IEditorDecorationsCollection | null>(null);
  const reviewFixAvailableRef = useRef<{ set: (value: boolean) => void } | null>(null);
  const applyReviewIssueRef = useRef<(index: number) => void>(() => {});
  reviewIssuesRef.current = reviewIssues;
  selectedReviewIndexRef.current = selectedReviewIndex;
  aiEnabledRef.current = aiEnabled;
  aiCodeSettingsRef.current = aiCodeSettings;
  onSaveRef.current = onSave;
  onScrollChangeRef.current = onScrollChange;
  onMentionLinesRef.current = onMentionLines;
  onSelectionChangeRef.current = onSelectionChange;
  generateRef.current = () => {
    if (!aiEnabled || selectedReviewIndexRef.current !== null) return;
    const editor = editorRef.current;
    editor?.focus();
    void editor?.getAction("editor.action.inlineSuggest.trigger")?.run().catch(() => {
      // Monaco rejects a superseded inline request with Canceled; the next
      // keystroke/provider invocation owns the current suggestion instead.
    });
  };

  const applyReviewIssue = useCallback((index: number) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const issue = reviewIssuesRef.current[index];
    if (!editor || !model || !issue) return;
    const range = new monacoEditor.Range(
      issue.startLine,
      1,
      issue.endLine,
      model.getLineMaxColumn(issue.endLine),
    );
    editor.executeEdits("amedac-ai-review", [{ range, text: issue.replacement, forceMoveMarkers: true }]);
    setReviewIssues((current) => current.filter((candidate) => candidate.id !== issue.id));
    setSelectedReviewIndex(null);
    editor.focus();
  }, []);
  applyReviewIssueRef.current = applyReviewIssue;

  const applyAllReviewIssues = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || reviewIssuesRef.current.length === 0) return;
    const edits = [...reviewIssuesRef.current]
      .sort((a, b) => b.startLine - a.startLine)
      .map((issue) => ({
        range: new monacoEditor.Range(issue.startLine, 1, issue.endLine, model.getLineMaxColumn(issue.endLine)),
        text: issue.replacement,
        forceMoveMarkers: true,
      }));
    editor.executeEdits("amedac-ai-review-all", edits);
    setReviewIssues([]);
    setSelectedReviewIndex(null);
    editor.focus();
  }, []);

  const ignoreSelectedReviewIssue = useCallback(() => {
    const index = selectedReviewIndexRef.current;
    const issue = index === null ? undefined : reviewIssuesRef.current[index];
    if (!issue) return;
    ignoredReviewIssuesRef.current.add(issue.id);
    setReviewIssues((current) => current.filter((candidate) => candidate.id !== issue.id));
    setSelectedReviewIndex(null);
  }, []);

  const selectReviewIssue = useCallback((index: number) => {
    if (index < 0 || index >= reviewIssuesRef.current.length) return;
    setSelectedReviewIndex(index);
    editorRef.current?.focus();
  }, []);

  const reviewPanelMaximumHeight = useCallback(() => {
    const totalHeight = editorContainerRef.current?.clientHeight ?? 640;
    return Math.max(160, totalHeight - 90);
  }, []);

  const startReviewPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = reviewPanelHeight;
    let latestHeight = startHeight;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const move = (moveEvent: globalThis.PointerEvent) => {
      latestHeight = Math.max(140, Math.min(reviewPanelMaximumHeight(), startHeight + startY - moveEvent.clientY));
      setReviewPanelHeight(latestHeight);
      setReviewPanelExpanded(false);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.localStorage.setItem("lithochat.aiReviewPanelHeight", String(Math.round(latestHeight)));
      reviewResizeCleanupRef.current = null;
    };
    reviewResizeCleanupRef.current?.();
    reviewResizeCleanupRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [reviewPanelHeight, reviewPanelMaximumHeight]);

  const toggleReviewPanelExpanded = useCallback(() => {
    setReviewPanelExpanded((expanded) => {
      if (expanded) {
        const stored = Number(window.localStorage.getItem("lithochat.aiReviewPanelHeight"));
        setReviewPanelHeight(Number.isFinite(stored) ? Math.max(140, Math.min(reviewPanelMaximumHeight(), stored)) : 240);
      } else {
        setReviewPanelHeight(reviewPanelMaximumHeight());
      }
      return !expanded;
    });
  }, [reviewPanelMaximumHeight]);

  const beforeMount: BeforeMount = (monaco) => {
    configureWorkers();
    configureAtomThemes(monaco);
    registerCppCompletionProvider(monaco);
    registerPythonSemanticTokensProvider(monaco);
    registerGenericSemanticTokensProvider(monaco);
    registerAiInlineCompletionProvider(monaco);
    if (languageDefaultsConfigured) return;
    languageDefaultsConfigured = true;
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    const compilerOptions = {
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    };
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const mountedModel = editor.getModel();
    if (mountedModel && mountedModel.getLanguageId() !== editorLanguage) {
      monaco.editor.setModelLanguage(mountedModel, editorLanguage);
    }
    editor.setScrollTop(initialScrollTop);
    editor.setScrollLeft(initialScrollLeft);
    editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged && !event.scrollLeftChanged) return;
      onScrollChangeRef.current?.(event.scrollTop, event.scrollLeft);
    });
    editor.onDidChangeCursorSelection(({ selection }) => {
      onSelectionChangeRef.current?.(selection.isEmpty() ? null : {
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
      });
    });
    editorLayoutCleanupRef.current?.();
    const layoutHost = editorContainerRef.current ?? editor.getDomNode();
    let layoutTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLayout = () => {
      if (layoutTimer) clearTimeout(layoutTimer);
      // Monaco's automatic layout runs on every pixel of a splitter drag.
      // A short trailing layout keeps the divider fluid and still settles fast.
      layoutTimer = setTimeout(() => {
        layoutTimer = null;
        editor.layout();
      }, 55);
    };
    const layoutObserver = layoutHost ? new ResizeObserver(scheduleLayout) : null;
    if (layoutHost) layoutObserver?.observe(layoutHost);
    const cleanupLayout = () => {
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutObserver?.disconnect();
    };
    editorLayoutCleanupRef.current = cleanupLayout;
    editor.onDidDispose(() => {
      cleanupLayout();
      if (editorLayoutCleanupRef.current === cleanupLayout) editorLayoutCleanupRef.current = null;
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => generateRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) return;
      onMentionLinesRef.current?.(selection.startLineNumber, selection.endLineNumber);
    });
    reviewFixAvailableRef.current = editor.createContextKey<boolean>("amedacAiFixAvailable", false);
    editor.addCommand(
      monaco.KeyCode.Tab,
      () => {
        const index = selectedReviewIndexRef.current;
        if (index !== null) applyReviewIssueRef.current(index);
      },
      "amedacAiFixAvailable",
    );
    editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      if (!line) return;
      const index = reviewIssuesRef.current.findIndex((issue) => line >= issue.startLine && line <= issue.endLine);
      if (index >= 0) selectReviewIssue(index);
    });
    const scheduleInlineSuggestion = () => {
      if (!aiEnabledRef.current || selectedReviewIndexRef.current !== null) return;
      if (inlineTriggerTimerRef.current !== null) window.clearTimeout(inlineTriggerTimerRef.current);
      inlineTriggerTimerRef.current = window.setTimeout(() => {
        inlineTriggerTimerRef.current = null;
        const activeModel = editor.getModel();
        if (!activeModel || activeModel.getValueLength() === 0) return;
        void editor.getAction("editor.action.inlineSuggest.trigger")?.run().catch(() => {
          // A newer keystroke/cursor move superseded this candidate request.
        });
      }, aiCodeSettingsRef.current.completionDelayMs);
    };
    editor.onDidChangeModelContent(scheduleInlineSuggestion);
    editor.onDidChangeCursorPosition(scheduleInlineSuggestion);
    scheduleInlineSuggestion();
    const model = editor.getModel();
    if (model && aiEnabled) {
      aiModelContexts.set(model.uri.toString(), {
        filePath,
        cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
        language,
        onGenerationState,
        settings: aiCodeSettings,
      });
    }
    if (model && diagnosticsEnabled && (language === "cpp" || language === "c")) {
      cppModelContexts.set(model.uri.toString(), {
        filePath,
        cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
      });
      onLanguageServiceStatus("connecting");
    } else {
      onLanguageServiceStatus("builtin");
    }
    editor.focus();
  };

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== editorLanguage) {
      monacoEditor.editor.setModelLanguage(model, editorLanguage);
    }
  }, [editorLanguage, filePath]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const uri = model.uri.toString();
    if (aiEnabled) {
      aiModelContexts.set(uri, {
        filePath,
        cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
        language,
        onGenerationState,
        settings: aiCodeSettings,
      });
    } else {
      aiModelContexts.delete(uri);
      onGenerationState({ status: "idle" });
    }
    return () => {
      aiModelContexts.delete(uri);
    };
  }, [aiCodeSettings, aiEnabled, filePath, language, onGenerationState, projectRoot]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model || !diagnosticsEnabled || (language !== "cpp" && language !== "c")) {
      if (model) monacoEditor.editor.setModelMarkers(model, "clangd", []);
      onDiagnostics(0, 0);
      return;
    }
    const uri = model.uri.toString();
    cppModelContexts.set(uri, {
      filePath,
      cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
    });
    return () => {
      cppModelContexts.delete(uri);
      monacoEditor.editor.setModelMarkers(model, "clangd", []);
    };
  }, [diagnosticsEnabled, filePath, language, onDiagnostics, projectRoot]);

  useEffect(() => {
    if (!diagnosticsEnabled || (language !== "cpp" && language !== "c")) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        onLanguageServiceStatus("connecting");
        const response = await fetch("/api/code-intelligence/diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            filePath,
            cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
            content: value,
          }),
        });
        const body = await response.json() as { diagnostics?: LspDiagnostic[] };
        if (!response.ok) {
          onLanguageServiceStatus("unavailable");
          return;
        }
        monacoEditor.editor.setModelMarkers(model, "clangd", (body.diagnostics ?? []).map((diagnostic) => ({
          ...toMonacoRange(diagnostic.range),
          severity: diagnostic.severity === 1
            ? monacoEditor.MarkerSeverity.Error
            : diagnostic.severity === 2
              ? monacoEditor.MarkerSeverity.Warning
              : diagnostic.severity === 3
                ? monacoEditor.MarkerSeverity.Info
                : monacoEditor.MarkerSeverity.Hint,
          code: diagnostic.code == null ? undefined : String(diagnostic.code),
          source: diagnostic.source ?? "clangd",
          message: diagnostic.message,
        })));
        onLanguageServiceStatus("clangd");
      } catch {
        if (!controller.signal.aborted) onLanguageServiceStatus("unavailable");
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [diagnosticsEnabled, filePath, language, onLanguageServiceStatus, projectRoot, value]);

  useEffect(() => {
    ignoredReviewIssuesRef.current.clear();
    setReviewIssues([]);
    setSelectedReviewIndex(null);
    setReviewError(null);
    setReviewStatus("idle");
  }, [filePath]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!aiReviewEnabled || !editor || !model || !value.trim()) {
      setReviewIssues([]);
      setSelectedReviewIndex(null);
      setReviewError(null);
      setReviewStatus("idle");
      return;
    }
    // Never leave an old patch applicable after the source has changed.
    setReviewIssues([]);
    setSelectedReviewIndex(null);
    setReviewStatus("idle");
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setReviewStatus("reviewing");
      setReviewError(null);
      try {
        const response = await fetch("/api/code-intelligence/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            filePath,
            cwd: projectRoot || filePath.replace(/[\\/][^\\/]+$/, ""),
            content: value,
            language,
            cursorLine: editor.getPosition()?.lineNumber ?? 1,
            diagnostics: monacoEditor.editor.getModelMarkers({ resource: model.uri })
              .filter((marker) => marker.owner !== "amedac-ai-review")
              .slice(0, 50)
              .map((marker) => ({
                startLine: marker.startLineNumber,
                endLine: marker.endLineNumber,
                severity: marker.severity === monacoEditor.MarkerSeverity.Error
                  ? "error"
                  : marker.severity === monacoEditor.MarkerSeverity.Warning
                    ? "warning"
                    : marker.severity === monacoEditor.MarkerSeverity.Info
                      ? "info"
                      : "hint",
                message: marker.message,
                source: marker.source,
              })),
          }),
        });
        const body = await response.json() as { issues?: Omit<AiReviewIssue, "id">[]; error?: string };
        if (!response.ok) throw new Error(body.error || `AI review failed (HTTP ${response.status})`);
        const accepted: AiReviewIssue[] = [];
        for (const issue of body.issues ?? []) {
          const id = `${issue.startLine}:${issue.endLine}:${issue.message}:${issue.replacement}`;
          if (ignoredReviewIssuesRef.current.has(id)) continue;
          if (accepted.some((current) => issue.startLine <= current.endLine && issue.endLine >= current.startLine)) continue;
          accepted.push({ ...issue, id });
        }
        setReviewIssues(accepted);
        setSelectedReviewIndex(null);
        setReviewStatus("ready");
      } catch (reviewFailure) {
        if (controller.signal.aborted) return;
        setReviewIssues([]);
        setSelectedReviewIndex(null);
        setReviewError(reviewFailure instanceof Error ? reviewFailure.message : String(reviewFailure));
        setReviewStatus("error");
      }
    }, aiCodeSettings.reviewDelayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [aiCodeSettings.reviewDelayMs, aiReviewEnabled, filePath, language, projectRoot, value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monacoEditor.editor.setModelMarkers(model, "amedac-ai-review", aiReviewEnabled ? reviewIssues.map((issue) => ({
      startLineNumber: issue.startLine,
      startColumn: 1,
      endLineNumber: issue.endLine,
      endColumn: model.getLineMaxColumn(issue.endLine),
      severity: issue.severity === "error"
        ? monacoEditor.MarkerSeverity.Error
        : issue.severity === "info"
          ? monacoEditor.MarkerSeverity.Info
          : monacoEditor.MarkerSeverity.Warning,
      source: "AI review",
      message: `${issue.message} (${Math.round(issue.confidence * 100)}% confidence)`,
    })) : []);
    return () => monacoEditor.editor.setModelMarkers(model, "amedac-ai-review", []);
  }, [aiReviewEnabled, reviewIssues]);

  useEffect(() => {
    const editor = editorRef.current;
    reviewDecorationsRef.current?.clear();
    const issue = selectedReviewIndex === null ? undefined : reviewIssues[selectedReviewIndex];
    reviewFixAvailableRef.current?.set(Boolean(issue));
    if (!editor || !issue) return;
    // Remove any ordinary cursor completion before Tab is rebound to this
    // line-based repair. Otherwise Monaco may accept the stale ghost text at
    // the caret instead of applying the selected review range.
    void editor.getAction("editor.action.inlineSuggest.hide")?.run().catch(() => {});
    editor.focus();
    reviewDecorationsRef.current = editor.createDecorationsCollection([{
      range: new monacoEditor.Range(issue.startLine, 1, issue.endLine, 1),
      options: { isWholeLine: true, className: "monaco-ai-review-selected" },
    }]);
    editor.revealRangeInCenterIfOutsideViewport(
      new monacoEditor.Range(issue.startLine, 1, issue.endLine, 1),
      monacoEditor.editor.ScrollType.Smooth,
    );
  }, [reviewIssues, selectedReviewIndex]);

  useEffect(() => {
    const editor = editorRef.current;
    const range = parseLineLocation(location);
    if (!editor || !range) {
      decorationsRef.current?.clear();
      return;
    }
    decorationsRef.current?.clear();
    decorationsRef.current = editor.createDecorationsCollection([{
      range: new monacoEditor.Range(range.start, 1, range.end, 1),
      options: {
        isWholeLine: true,
        className: "monaco-cited-line",
        overviewRuler: {
          color: "rgba(59,130,246,0.65)",
          position: monacoEditor.editor.OverviewRulerLane.Full,
        },
      },
    }]);
    editor.revealLineInCenter(range.start, monacoEditor.editor.ScrollType.Smooth);
  }, [focusToken, location]);

  useEffect(() => {
    if (!aiEnabled || generateRequest === 0) return;
    generateRef.current();
  }, [aiEnabled, generateRequest]);

  useEffect(() => () => {
    if (inlineTriggerTimerRef.current !== null) window.clearTimeout(inlineTriggerTimerRef.current);
    editorLayoutCleanupRef.current?.();
  }, []);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem("lithochat.aiReviewPanelHeight"));
    if (Number.isFinite(stored)) setReviewPanelHeight(Math.max(140, stored));
    return () => reviewResizeCleanupRef.current?.();
  }, []);

  const selectedReviewIssue = selectedReviewIndex === null ? undefined : reviewIssues[selectedReviewIndex];
  const selectedOriginal = (() => {
    const model = editorRef.current?.getModel();
    if (!model || !selectedReviewIssue) return "";
    return model.getValueInRange(new monacoEditor.Range(
      selectedReviewIssue.startLine,
      1,
      selectedReviewIssue.endLine,
      model.getLineMaxColumn(selectedReviewIssue.endLine),
    ));
  })();
  const zh = uiLanguage === "zh";
  const reviewButtonStyle = {
    height: 26,
    padding: "0 9px",
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: "var(--bg-hover)",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    whiteSpace: "nowrap",
  } as const;

  return (
    <div ref={editorContainerRef} style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
      <Editor
      height="100%"
      path={filePath}
      value={value}
      language={editorLanguage}
      theme={isDark ? "amedac-atom-dark" : "amedac-atom-light"}
      beforeMount={beforeMount}
      onMount={handleMount}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      onValidate={(markers) => {
        if (!diagnosticsEnabled) {
          onDiagnostics(0, 0);
          return;
        }
        onDiagnostics(
          markers.filter((marker) => marker.severity === monacoEditor.MarkerSeverity.Error).length,
          markers.filter((marker) => marker.severity === monacoEditor.MarkerSeverity.Warning).length,
        );
      }}
      loading={<div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>Loading Monaco Editor…</div>}
      options={{
        readOnly,
        automaticLayout: false,
        "semanticHighlighting.enabled": true,
        fontFamily: 'Consolas, "Courier New", var(--font-noto-mono), monospace',
        fontSize,
        fontLigatures: false,
        letterSpacing: 0,
        lineHeight: Math.round(fontSize + 8),
        minimap: { enabled: true, maxColumn: 90, renderCharacters: false, showSlider: "mouseover", scale: 1 },
        stickyScroll: { enabled: true },
        wordWrap: wrapLines ? "on" : "off",
        wordWrapColumn: 120,
        wrappingIndent: "same",
        wrappingStrategy: "advanced",
        quickSuggestions: { other: true, comments: false, strings: true },
        suggestOnTriggerCharacters: true,
        tabCompletion: "on",
        inlineSuggest: { enabled: aiEnabled && selectedReviewIndex === null, mode: "subwordSmart", showToolbar: "onHover" },
        renderValidationDecorations: diagnosticsEnabled || aiReviewEnabled ? "on" : "off",
        parameterHints: { enabled: true },
        formatOnPaste: true,
        formatOnType: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        renderWhitespace: "selection",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "all",
        roundedSelection: true,
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          useShadows: false,
          verticalHasArrows: false,
          horizontalHasArrows: false,
        },
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
      }}
      />
      </div>
      {aiReviewEnabled && (reviewStatus !== "idle" || reviewIssues.length > 0) && (
        <div style={{ flexShrink: 0, height: selectedReviewIssue ? reviewPanelHeight : "auto", minHeight: selectedReviewIssue ? 140 : undefined, maxHeight: selectedReviewIssue ? "calc(100% - 90px)" : undefined, borderTop: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 11, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {selectedReviewIssue && (
            <div
              role="separator"
              aria-orientation="horizontal"
              title={zh ? "拖动调整纠错面板高度" : "Drag to resize the review panel"}
              onPointerDown={startReviewPanelResize}
              onDoubleClick={toggleReviewPanelExpanded}
              style={{ height: 7, flexShrink: 0, cursor: "row-resize", display: "grid", placeItems: "center", touchAction: "none", background: "var(--bg-hover)" }}
            >
              <span style={{ width: 38, height: 2, borderRadius: 99, background: "var(--text-dim)", opacity: 0.65 }} />
            </div>
          )}
          {reviewStatus === "reviewing" && reviewIssues.length === 0 && (
            <div style={{ padding: "7px 10px" }}>{zh ? "AI 正在分析当前文件…" : "AI is reviewing this file…"}</div>
          )}
          {reviewStatus === "error" && reviewError && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", color: "#ef4444" }}>
              <span>{zh ? "AI 纠错失败：" : "AI review failed: "}{reviewError}</span>
              <button type="button" onClick={() => setReviewStatus("idle")} style={{ ...reviewButtonStyle, marginLeft: "auto" }}>×</button>
            </div>
          )}
          {reviewStatus === "ready" && reviewIssues.length === 0 && (
            <div style={{ padding: "7px 10px", color: "#22c55e" }}>{zh ? "AI 未发现高置信度问题" : "No high-confidence issues found"}</div>
          )}
          {reviewIssues.length > 0 && !selectedReviewIssue && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px" }}>
              <span>{zh ? `AI 发现 ${reviewIssues.length} 个可能的问题` : `AI found ${reviewIssues.length} possible issue${reviewIssues.length === 1 ? "" : "s"}`}</span>
              <button type="button" onClick={() => selectReviewIssue(0)} style={{ ...reviewButtonStyle, marginLeft: "auto" }}>{zh ? "查看" : "Review"}</button>
              <button type="button" onClick={applyAllReviewIssues} style={{ ...reviewButtonStyle, color: "var(--accent)" }}>{zh ? "全部应用" : "Apply all"}</button>
            </div>
          )}
          {selectedReviewIssue && (
            <div style={{ padding: "8px 10px", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", gap: 7, flex: 1, minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: selectedReviewIssue.severity === "error" ? "#ef4444" : selectedReviewIssue.severity === "warning" ? "#f59e0b" : "#3b82f6", fontWeight: 700 }}>
                  L{selectedReviewIssue.startLine}{selectedReviewIssue.endLine !== selectedReviewIssue.startLine ? `–${selectedReviewIssue.endLine}` : ""}
                </span>
                <span style={{ color: "var(--text)" }}>{selectedReviewIssue.message}</span>
                <span style={{ color: "var(--text-dim)" }}>{Math.round(selectedReviewIssue.confidence * 100)}%</span>
                <span style={{ marginLeft: "auto" }}>{selectedReviewIndex! + 1}/{reviewIssues.length}</span>
                <button type="button" onClick={toggleReviewPanelExpanded} title={reviewPanelExpanded ? (zh ? "恢复面板高度" : "Restore panel height") : (zh ? "展开纠错面板" : "Expand review panel")} style={reviewButtonStyle}>
                  {reviewPanelExpanded ? (zh ? "恢复" : "Restore") : (zh ? "展开" : "Expand")}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 7, minHeight: 0, overflow: "hidden" }}>
                <pre style={{ minWidth: 0, minHeight: 0, margin: 0, padding: 7, overflow: "auto", borderRadius: 5, background: "rgba(239,68,68,0.08)", color: "var(--text)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>− {selectedOriginal}</pre>
                <pre style={{ minWidth: 0, minHeight: 0, margin: 0, padding: 7, overflow: "auto", borderRadius: 5, background: "rgba(34,197,94,0.08)", color: "var(--text)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>+ {selectedReviewIssue.replacement}</pre>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button type="button" disabled={selectedReviewIndex === 0} onClick={() => selectReviewIssue(Math.max(0, selectedReviewIndex! - 1))} style={{ ...reviewButtonStyle, opacity: selectedReviewIndex === 0 ? 0.45 : 1 }}>‹</button>
                <button type="button" disabled={selectedReviewIndex === reviewIssues.length - 1} onClick={() => selectReviewIssue(Math.min(reviewIssues.length - 1, selectedReviewIndex! + 1))} style={{ ...reviewButtonStyle, opacity: selectedReviewIndex === reviewIssues.length - 1 ? 0.45 : 1 }}>›</button>
                <button type="button" onClick={() => applyReviewIssue(selectedReviewIndex!)} style={{ ...reviewButtonStyle, color: "var(--accent)", fontWeight: 700 }}>{zh ? "应用（Tab）" : "Apply (Tab)"}</button>
                <button type="button" onClick={ignoreSelectedReviewIssue} style={reviewButtonStyle}>{zh ? "忽略" : "Ignore"}</button>
                <button type="button" onClick={applyAllReviewIssues} style={{ ...reviewButtonStyle, marginLeft: "auto" }}>{zh ? "全部应用" : "Apply all"}</button>
                <button type="button" onClick={() => setSelectedReviewIndex(null)} style={reviewButtonStyle}>×</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
