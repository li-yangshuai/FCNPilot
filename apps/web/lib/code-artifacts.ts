import type { AgentMessage, AssistantMessage, TextContent, ToolCallContent, ToolResultMessage } from "./types";

export interface CodeArtifact {
  id: string;
  title: string;
  language: string;
  code: string;
  suggestedFileName: string;
  sourceTurn: number;
  blockIndex: number;
  complete: boolean;
  updatedAt: number;
  operation?: "generate" | "write" | "edit";
  operationKey?: string;
  baseCode?: string;
}

export interface CodeTerminalArtifact {
  id: string;
  toolCallId: string;
  command: string;
  output: string;
  complete: boolean;
  isError: boolean;
  updatedAt: number;
  source: "tool" | "snippet";
}

export interface LiveToolExecution {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  startedAt: number;
}

interface ParsedCodeBlock {
  info: string;
  language: string;
  code: string;
  complete: boolean;
  blockIndex: number;
}

interface ParsedEdit {
  oldText: string;
  newText: string;
}

const IGNORED_LANGUAGES = new Set(["", "text", "txt", "plain", "plaintext", "mermaid", "diff", "patch", "output", "console"]);
const COMMAND_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "fish", "powershell", "ps1", "bat", "cmd"]);
const MIN_AUTO_ARTIFACT_NON_EMPTY_LINES = 28;
const MIN_AUTO_ARTIFACT_CHARS = 1200;
const MIN_COMPLEX_AUTO_ARTIFACT_LINES = 16;
const MIN_COMPLEX_AUTO_ARTIFACT_CHARS = 650;

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  py3: "python",
  python3: "python",
  rs: "rust",
  rb: "ruby",
  yml: "yaml",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  "c++": "cpp",
  cplusplus: "cpp",
  cs: "csharp",
  md: "markdown",
};

const EXT_BY_LANGUAGE: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  ruby: "rb",
  yaml: "yaml",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  bash: "sh",
  cpp: "cpp",
  c: "c",
  csharp: "cs",
  java: "java",
  go: "go",
  kotlin: "kt",
  swift: "swift",
  php: "php",
  sql: "sql",
  markdown: "md",
  dockerfile: "Dockerfile",
};

const LANGUAGE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_LANGUAGE)
    .filter(([, ext]) => ext !== "Dockerfile")
    .map(([language, ext]) => [ext, language])
);

function normalizeLanguage(info: string): string {
  const first = info.trim().split(/\s+/)[0]?.toLowerCase().replace(/^language-/, "") ?? "";
  return LANGUAGE_ALIASES[first] ?? first;
}

function looksLikeCode(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.length < 24) return false;
  return [
    /\b(function|const|let|var|class|interface|type|import|export|return|async|await)\b/,
    /#include\s*[<"]/,
    /\b(def|class|import|from|return|async|await)\b/,
    /\b(fn|let|mut|impl|use)\b/,
    /<\/?[a-z][\s\S]*>/i,
    /[{;}]\s*$/,
  ].some((pattern) => pattern.test(trimmed));
}

function countPattern(code: string, pattern: RegExp): number {
  return code.match(pattern)?.length ?? 0;
}

function isLargeEnoughForAutoArtifact(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  const nonEmptyLines = trimmed.split(/\r?\n/).filter((line) => line.trim()).length;
  return nonEmptyLines >= MIN_AUTO_ARTIFACT_NON_EMPTY_LINES || trimmed.length >= MIN_AUTO_ARTIFACT_CHARS;
}

function isComplexEnoughForAutoArtifact(code: string, language: string): boolean {
  const trimmed = code.trim();
  if (!looksLikeCode(trimmed)) return false;
  const nonEmptyLines = trimmed.split(/\r?\n/).filter((line) => line.trim()).length;
  if (nonEmptyLines < MIN_COMPLEX_AUTO_ARTIFACT_LINES && trimmed.length < MIN_COMPLEX_AUTO_ARTIFACT_CHARS) return false;

  let score = 0;
  const normalizedLanguage = language || "";
  const structuralCount = countPattern(trimmed, /\b(class|struct|interface|enum|type\s+\w+\s*=|namespace|template\s*<|impl\s+|trait\s+)\b/g);
  const functionCount = countPattern(trimmed, /\b(function|def|fn)\s+\w+|\b(async\s+)?[A-Za-z_][\w:<>,~*&\s]*\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(?:const\s*)?\{/g);
  const importCount = countPattern(trimmed, /(^|\n)\s*(import|from|#include|use|package)\b/g);
  const branchCount = countPattern(trimmed, /\b(if|else\s+if|for|while|switch|case|try|catch|except|match)\b/g);

  if (structuralCount >= 1) score += 2;
  if (functionCount >= 2) score += 2;
  else if (functionCount === 1 && nonEmptyLines >= 24) score += 1;
  if (importCount >= 2) score += 1;
  if (branchCount >= 4) score += 1;
  if (/\b(async|await|Promise|thread|mutex|atomic|condition_variable|worker|goroutine|channel|lock_guard)\b/i.test(trimmed)) score += 2;
  if (/\b(public|private|protected|override|extends|implements|decorator|annotation)\b/.test(trimmed)) score += 1;
  if (normalizedLanguage === "html" && countPattern(trimmed, /<\/?[a-z][^>]*>/gi) >= 10) score += 2;

  return score >= 3;
}

function shouldOpenCodePaneForCode(code: string, language: string): boolean {
  return isLargeEnoughForAutoArtifact(code) || isComplexEnoughForAutoArtifact(code, language);
}

function parseFilename(info: string, language: string, blockIndex: number): string {
  const token = info
    .trim()
    .split(/\s+/)
    .find((part) => {
      const value = part.replace(/^file(name)?=/i, "").replace(/^["']|["']$/g, "");
      return value.includes(".") || value.includes("/");
    });
  if (token) {
    const cleaned = token.replace(/^file(name)?=/i, "").replace(/^["']|["']$/g, "");
    if (cleaned && !cleaned.includes("..") && !cleaned.startsWith("/")) return cleaned;
  }
  const ext = EXT_BY_LANGUAGE[language] ?? "txt";
  if (ext === "Dockerfile") return blockIndex === 0 ? "Dockerfile" : `Dockerfile.${blockIndex + 1}`;
  return `amedac-artifact-${blockIndex + 1}.${ext}`;
}

function languageFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (!base) return null;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  const ext = base.split(".").pop() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? null;
}

function parseCodeBlocks(markdown: string): ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (!start) continue;
    const fence = start[1];
    const marker = fence[0];
    const size = fence.length;
    const info = start[2] ?? "";
    const closeRe = new RegExp(`^ {0,3}\\${marker}{${size},}[ \\t]*$`);
    const codeLines: string[] = [];
    let complete = false;
    let end = i + 1;
    for (; end < lines.length; end++) {
      if (closeRe.test(lines[end])) {
        complete = true;
        break;
      }
      codeLines.push(lines[end]);
    }
    i = complete ? end : lines.length;
    blocks.push({
      info,
      language: normalizeLanguage(info),
      code: codeLines.join("\n"),
      complete,
      blockIndex: blocks.length,
    });
  }
  return blocks;
}

function assistantText(message: Partial<AgentMessage> | null | undefined): string {
  if (!message || message.role !== "assistant") return "";
  const assistant = message as Partial<AssistantMessage>;
  const content = assistant.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is TextContent => block?.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function assistantToolCalls(message: Partial<AgentMessage> | null | undefined): ToolCallContent[] {
  if (!message || message.role !== "assistant") return [];
  const assistant = message as Partial<AssistantMessage>;
  const content = assistant.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolCallContent => block?.type === "toolCall");
}

function stringField(input: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

interface AssistantCandidate {
  message: Partial<AgentMessage>;
  text: string;
  turn: number;
  fromStreaming: boolean;
}

interface LatestAssistantCandidate extends AssistantCandidate {
  currentTurn: number;
}

function latestAssistant(
  messages: AgentMessage[],
  streamingMessage?: Partial<AgentMessage> | null,
): LatestAssistantCandidate | null {
  let currentTurn = 0;
  for (const message of messages) if (message.role === "user") currentTurn += 1;

  const streamingText = assistantText(streamingMessage);
  if (streamingText || assistantToolCalls(streamingMessage).length > 0) {
    return {
      message: streamingMessage as Partial<AgentMessage>,
      text: streamingText,
      turn: currentTurn,
      currentTurn,
      fromStreaming: true,
    };
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== "assistant") continue;
    let turn = 0;
    for (let j = 0; j <= i; j += 1) if (messages[j].role === "user") turn += 1;
    return {
      message: messages[i],
      text: assistantText(messages[i]),
      turn,
      currentTurn,
      fromStreaming: false,
    };
  }
  return null;
}

function currentTurnAssistants(
  messages: AgentMessage[],
  streamingMessage?: Partial<AgentMessage> | null,
): AssistantCandidate[] {
  let userTurns = 0;
  for (const message of messages) if (message.role === "user") userTurns += 1;
  const candidates: AssistantCandidate[] = [];
  const streamingText = assistantText(streamingMessage);
  if (streamingText || assistantToolCalls(streamingMessage).length > 0) {
    candidates.push({
      message: streamingMessage as Partial<AgentMessage>,
      text: streamingText,
      turn: userTurns,
      fromStreaming: true,
    });
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") break;
    if (messages[i].role !== "assistant") continue;
    candidates.push({
      message: messages[i],
      text: assistantText(messages[i]),
      turn: userTurns,
      fromStreaming: false,
    });
  }
  return candidates;
}

function collectToolResults(
  messages: AgentMessage[],
  extras: ToolResultMessage[],
  requiredIds: Set<string>,
): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const result of extras) {
    if (requiredIds.has(result.toolCallId)) results.set(result.toolCallId, result);
  }
  if (results.size >= requiredIds.size) return results;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || !requiredIds.has(message.toolCallId) || results.has(message.toolCallId)) continue;
    results.set(message.toolCallId, message);
    if (results.size >= requiredIds.size) break;
  }
  return results;
}

function basename(fileName: string): string {
  return fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
}

function normalizePathForCompare(fileName: string): string {
  return fileName.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

function fileMatchesArtifact(fileName: string | null, artifact: CodeArtifact | null | undefined): boolean {
  if (!fileName || !artifact) return true;
  const a = normalizePathForCompare(artifact.suggestedFileName || artifact.title);
  const b = normalizePathForCompare(fileName);
  return a === b || basename(a) === basename(b);
}

function parseInfoFileName(info: string): string | null {
  const token = info
    .trim()
    .split(/\s+/)
    .find((part) => {
      const value = part.replace(/^file(name)?=/i, "").replace(/^["']|["']$/g, "");
      return value.includes(".") || value.includes("/");
    });
  if (!token) return null;
  const cleaned = token.replace(/^file(name)?=/i, "").replace(/^["']|["']$/g, "");
  return cleaned || null;
}

function isEditToolName(toolName: string): boolean {
  return toolName === "edit" ||
    toolName.startsWith("edit_") ||
    toolName.endsWith(".edit") ||
    toolName.endsWith("_edit") ||
    toolName.includes("str_replace") ||
    toolName.includes("replace_editor");
}

function isWriteToolName(toolName: string): boolean {
  return toolName === "write" ||
    toolName.endsWith(".write") ||
    toolName.endsWith("_write") ||
    toolName.includes("write_file") ||
    toolName.includes("create_file");
}

function isBashToolName(toolName: string): boolean {
  return toolName === "bash" ||
    toolName.endsWith(".bash") ||
    toolName.endsWith("_bash") ||
    toolName === "shell" ||
    toolName.includes("run_command") ||
    toolName.includes("terminal");
}

function toolResultText(result: ToolResultMessage | undefined): string {
  if (!result) return "";
  return result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function looksLikeTerminalCommand(command: string, artifact?: CodeArtifact | null): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const artifactFile = artifact?.suggestedFileName ? basename(artifact.suggestedFileName) : "";
  if (artifactFile && trimmed.includes(artifactFile)) return true;
  return [
    /\b(g\+\+|gcc|clang\+\+|clang|cc|c\+\+|rustc|javac|java)\b/,
    /\b(make|cmake|ninja|meson|bazel)\b/,
    /\b(cargo|go|dotnet|mvn|gradle|swift)\s+(build|test|run)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|start|dev)\b/,
    /\b(pytest|vitest|jest|mocha|ctest)\b/,
    /\b(python|python3)\s+(-m\s+pytest|.+\.py)\b/,
    /\b(tsc|eslint)\b/,
    /(^|\s)\.\/[^\s]+/,
  ].some((pattern) => pattern.test(trimmed));
}

function canCodeBlockReplaceArtifact(block: ParsedCodeBlock, baseArtifact: CodeArtifact | null): boolean {
  if (!block.code.trim()) return false;
  if (!baseArtifact) return true;
  if (block.language === "diff" || block.language === "patch") return true;

  // Once a code pane is open, shell commands, compiler output, and unlabeled text
  // must not replace the code pane. They are execution context, not source.
  const explicitInfoFileName = parseInfoFileName(block.info);
  if (COMMAND_LANGUAGES.has(block.language)) {
    if (!explicitInfoFileName) return false;
    if (!fileMatchesArtifact(explicitInfoFileName, baseArtifact)) return false;
  }
  if (IGNORED_LANGUAGES.has(block.language)) return false;

  const baseLanguage = baseArtifact.language || "text";
  if (block.language && block.language !== baseLanguage && (!explicitInfoFileName || !fileMatchesArtifact(explicitInfoFileName, baseArtifact))) {
    return false;
  }
  return true;
}

function canCodeBlockJoinArtifactList(block: ParsedCodeBlock): boolean {
  if (!block.code.trim()) return false;
  if (COMMAND_LANGUAGES.has(block.language)) {
    return Boolean(parseInfoFileName(block.info)) || /^#!\s*\/(?:usr\/bin\/env\s+)?(?:ba|z|fi)?sh\b/m.test(block.code);
  }
  if (IGNORED_LANGUAGES.has(block.language)) return looksLikeCode(block.code);
  return true;
}

function parseEdits(input: Record<string, unknown>): ParsedEdit[] {
  let rawEdits = input.edits;
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits) as unknown;
    } catch {
      rawEdits = undefined;
    }
  }

  const fromArray = Array.isArray(rawEdits)
    ? rawEdits
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
        .map((edit) => {
          const oldText = stringField(edit, ["oldText", "old_text", "oldString", "old_string"]);
          const newText = stringField(edit, ["newText", "new_text", "newString", "new_string"]) ?? "";
          return oldText ? { oldText, newText } : null;
        })
        .filter((edit): edit is ParsedEdit => edit !== null)
    : [];

  const legacyOld = stringField(input, ["oldText", "old_text", "oldString", "old_string"]);
  if (legacyOld) {
    fromArray.push({
      oldText: legacyOld,
      newText: stringField(input, ["newText", "new_text", "newString", "new_string"]) ?? "",
    });
  }

  return fromArray;
}

function artifactBaseCode(base: CodeArtifact, operationKey: string): string {
  return base.operationKey === operationKey && typeof base.baseCode === "string"
    ? base.baseCode
    : base.code;
}

function applyTargetedEdits(baseCode: string, edits: ParsedEdit[]): string | null {
  if (edits.length === 0) return null;
  let next = baseCode;
  for (const edit of edits) {
    if (!edit.oldText) return null;
    const index = next.indexOf(edit.oldText);
    if (index < 0) return null;
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
}

function parseHunkHeader(line: string): { oldStart: number } | null {
  const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!match) return null;
  return { oldStart: Number(match[1]) };
}

function applyUnifiedPatch(baseCode: string, patch: string): string | null {
  if (!patch.includes("@@")) return null;
  const baseLines = baseCode.split("\n");
  const patchLines = patch.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  let sawHunk = false;

  for (let i = 0; i < patchLines.length; i++) {
    const header = parseHunkHeader(patchLines[i]);
    if (!header) continue;
    sawHunk = true;
    const hunkStart = Math.max(0, header.oldStart - 1);
    if (hunkStart < sourceIndex || hunkStart > baseLines.length) return null;
    while (sourceIndex < hunkStart) output.push(baseLines[sourceIndex++]);

    for (i += 1; i < patchLines.length; i++) {
      const line = patchLines[i];
      if (parseHunkHeader(line)) {
        i -= 1;
        break;
      }
      if (line.startsWith("\\ No newline")) continue;
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === " ") {
        output.push(sourceIndex < baseLines.length ? baseLines[sourceIndex] : text);
        sourceIndex += 1;
      } else if (prefix === "-") {
        sourceIndex += 1;
      } else if (prefix === "+") {
        output.push(text);
      } else if (line === "") {
        // A streaming patch may temporarily contain a blank incomplete line.
        continue;
      }
    }
  }

  if (!sawHunk) return null;
  while (sourceIndex < baseLines.length) output.push(baseLines[sourceIndex++]);
  return output.join("\n");
}

function buildArtifact(params: {
  conversationKey: string;
  turn: number;
  blockIndex: number;
  code: string;
  language: string;
  fileName: string;
  complete: boolean;
  operation: CodeArtifact["operation"];
  operationKey?: string;
  baseCode?: string;
}): CodeArtifact {
  const id = [
    "code-artifact",
    encodeURIComponent(params.conversationKey),
    params.turn,
    params.blockIndex,
  ].join(":");
  return {
    id,
    title: params.fileName,
    language: params.language || "text",
    code: params.code,
    suggestedFileName: params.fileName,
    sourceTurn: params.turn,
    blockIndex: params.blockIndex,
    complete: params.complete,
    updatedAt: Date.now(),
    operation: params.operation,
    operationKey: params.operationKey,
    baseCode: params.baseCode,
  };
}

interface ExtractCodeArtifactOptions {
  allowSmall?: boolean;
  baseArtifact?: CodeArtifact | null;
  toolResults?: ToolResultMessage[];
  includeAll?: boolean;
}

export function extractLatestCodeArtifacts(
  messages: AgentMessage[],
  streamingMessage: Partial<AgentMessage> | null,
  conversationKey: string,
  options: ExtractCodeArtifactOptions = {},
): CodeArtifact[] {
  const candidates = currentTurnAssistants(messages, streamingMessage);
  for (const candidate of candidates) {
    const artifacts = extractCodeArtifactsFromAssistant(messages, conversationKey, candidate, options);
    if (artifacts.length > 0) return artifacts;
  }
  return [];
}

function extractCodeArtifactsFromAssistant(
  messages: AgentMessage[],
  conversationKey: string,
  latest: AssistantCandidate,
  options: ExtractCodeArtifactOptions,
): CodeArtifact[] {

  const baseArtifact = options.baseArtifact ?? null;
  const complete = !latest.fromStreaming;
  const calls = assistantToolCalls(latest.message);
  const toolResults = collectToolResults(
    messages,
    options.toolResults ?? [],
    new Set(calls.map((call) => call.toolCallId).filter(Boolean)),
  );

  const artifacts: CodeArtifact[] = [];
  const textBlocks = parseCodeBlocks(latest.text);
  for (const block of textBlocks) {
    if ((block.language === "diff" || block.language === "patch") && baseArtifact) {
      const operationKey = `patch:${latest.turn}:${block.blockIndex}`;
      const baseCode = artifactBaseCode(baseArtifact, operationKey);
      const patched = applyUnifiedPatch(baseCode, block.code);
      if (patched !== null) {
        artifacts.push(buildArtifact({
          conversationKey,
          turn: latest.turn,
          blockIndex: block.blockIndex,
          code: patched,
          language: baseArtifact.language,
          fileName: baseArtifact.suggestedFileName,
          complete: block.complete && complete,
          operation: "edit",
          operationKey,
          baseCode,
        }));
      }
      continue;
    }

    const shouldUseBlock = (options.includeAll
      ? canCodeBlockJoinArtifactList(block)
      : canCodeBlockReplaceArtifact(block, baseArtifact))
      && (options.allowSmall || shouldOpenCodePaneForCode(block.code, block.language));
    if (!shouldUseBlock) continue;
    const language = block.language || "text";
    artifacts.push(buildArtifact({
      conversationKey,
      turn: latest.turn,
      blockIndex: block.blockIndex,
      code: block.code,
      language,
      fileName: parseFilename(block.info, language, block.blockIndex),
      complete: block.complete && complete,
      operation: "generate",
    }));
  }

  calls.forEach((call, index) => {
    const input = call.input ?? {};
    const fileName = stringField(input, ["filePath", "file_path", "path", "targetPath", "target_path", "filename", "file"]);
    const lowerName = call.toolName.toLowerCase();
    const blockIndex = textBlocks.length + index;
    const operationKey = call.toolCallId || `${latest.turn}:${blockIndex}:${call.toolName}`;

    if (isEditToolName(lowerName) && baseArtifact && fileMatchesArtifact(fileName, baseArtifact)) {
      const baseCode = artifactBaseCode(baseArtifact, operationKey);
      const edited = applyTargetedEdits(baseCode, parseEdits(input));
      const result = toolResults.get(call.toolCallId);
      const patch = typeof result?.details === "object" && result.details !== null && !Array.isArray(result.details)
        ? stringField(result.details as Record<string, unknown>, ["patch", "diff"])
        : null;
      const patched = edited ?? (patch ? applyUnifiedPatch(baseCode, patch) : null);
      if (patched !== null) {
        artifacts.push(buildArtifact({
          conversationKey,
          turn: latest.turn,
          blockIndex,
          code: patched,
          language: fileName ? languageFromFileName(fileName) ?? baseArtifact.language : baseArtifact.language,
          fileName: fileName ?? baseArtifact.suggestedFileName,
          complete,
          operation: "edit",
          operationKey,
          baseCode,
        }));
      }
      return;
    }

    if (!isWriteToolName(lowerName)) return;
    const code = stringField(input, ["content", "code", "newContent", "new_content", "newString", "new_string"]);
    if (!code) return;
    if (!fileName) return;
    const language = fileName ? languageFromFileName(fileName) ?? "" : "";
    if (!options.allowSmall && !shouldOpenCodePaneForCode(code, language)) return;
    if (IGNORED_LANGUAGES.has(language) && !looksLikeCode(code)) return;
    artifacts.push(buildArtifact({
      conversationKey,
      turn: latest.turn,
      blockIndex,
      code,
      language: language || "text",
      fileName: fileName ?? parseFilename(call.toolName, language || "text", blockIndex),
      complete,
      operation: "write",
    }));
  });

  return artifacts;
}

export function extractLatestCodeArtifact(
  messages: AgentMessage[],
  streamingMessage: Partial<AgentMessage> | null,
  conversationKey: string,
  options: ExtractCodeArtifactOptions = {},
): CodeArtifact | null {
  return extractLatestCodeArtifacts(messages, streamingMessage, conversationKey, options).at(-1) ?? null;
}

export function extractLatestTerminalArtifact(
  messages: AgentMessage[],
  streamingMessage: Partial<AgentMessage> | null,
  conversationKey: string,
  options: { baseArtifact?: CodeArtifact | null; toolResults?: ToolResultMessage[]; toolExecutions?: LiveToolExecution[] } = {},
): CodeTerminalArtifact | null {
  const latest = latestAssistant(messages, streamingMessage);
  const liveExecutions = options.toolExecutions ?? [];
  const calls = latest ? assistantToolCalls(latest.message) : [];
  const requiredResultIds = new Set([
    ...liveExecutions.map((execution) => execution.toolCallId),
    ...calls.map((call) => call.toolCallId),
  ].filter(Boolean));
  const toolResults = collectToolResults(messages, options.toolResults ?? [], requiredResultIds);
  let userTurns = latest?.currentTurn ?? 0;
  if (!latest) for (const message of messages) if (message.role === "user") userTurns += 1;
  for (let index = liveExecutions.length - 1; index >= 0; index--) {
    const execution = liveExecutions[index];
    const toolName = execution.toolName.toLowerCase();
    if (!isBashToolName(toolName)) continue;
    const command = stringField(execution.input ?? {}, ["command", "cmd", "script"]);
    if (!command || !looksLikeTerminalCommand(command, options.baseArtifact)) continue;
    const result = toolResults.get(execution.toolCallId);
    const output = toolResultText(result);
    const running = !result || output.trim() === "Running...";
    return {
      id: [
        "code-terminal",
        encodeURIComponent(conversationKey),
        userTurns,
        execution.toolCallId || index,
      ].join(":"),
      toolCallId: execution.toolCallId,
      command,
      output: running ? "" : output,
      complete: !running,
      isError: Boolean(result?.isError),
      updatedAt: Date.now(),
      source: "tool",
    };
  }

  if (!latest) return null;
  if (latest.turn < latest.currentTurn) return null;

  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    const toolName = call.toolName.toLowerCase();
    if (!isBashToolName(toolName)) continue;
    const command = stringField(call.input ?? {}, ["command", "cmd", "script"]);
    if (!command || !looksLikeTerminalCommand(command, options.baseArtifact)) continue;
    const result = toolResults.get(call.toolCallId);
    const output = toolResultText(result);
    const running = !result || output.trim() === "Running...";
    return {
      id: [
        "code-terminal",
        encodeURIComponent(conversationKey),
        latest.turn,
        call.toolCallId || index,
      ].join(":"),
      toolCallId: call.toolCallId,
      command,
      output: running ? "" : output,
      complete: !running,
      isError: Boolean(result?.isError),
      updatedAt: Date.now(),
      source: "tool",
    };
  }

  const textBlocks = parseCodeBlocks(latest.text);
  for (let index = textBlocks.length - 1; index >= 0; index--) {
    const block = textBlocks[index];
    if (!COMMAND_LANGUAGES.has(block.language)) continue;
    const command = block.code.trim();
    if (!looksLikeTerminalCommand(command, options.baseArtifact)) continue;
    return {
      id: [
        "code-terminal-snippet",
        encodeURIComponent(conversationKey),
        latest.turn,
        block.blockIndex,
      ].join(":"),
      toolCallId: `snippet:${latest.turn}:${block.blockIndex}`,
      command,
      output: "",
      complete: block.complete && !latest.fromStreaming,
      isError: false,
      updatedAt: Date.now(),
      source: "snippet",
    };
  }
  return null;
}
