export const FCN_AGENT_ID = "project:ifcn" as const;

/** The FCN main Agent owns all circuit work through these seven tools. */
export const FCN_TOOL_NAMES = [
  "read", "write", "edit", "ifcn_capabilities", "ifcn_run", "ifcn_status", "ifcn_artifact",
] as const;

export function isFcnToolSelection(value: unknown): value is string[] {
  return Array.isArray(value) && value.length === FCN_TOOL_NAMES.length
    && new Set(value).size === FCN_TOOL_NAMES.length
    && FCN_TOOL_NAMES.every((name) => value.includes(name));
}

const FCN_SESSION_COMMANDS = new Set([
  "ensure_session", "prompt", "abort", "get_state", "set_model", "fork", "navigate_tree",
  "set_thinking_level", "compact", "set_session_name", "get_session_stats",
  "get_last_assistant_text", "set_auto_compaction", "clear_queue", "steer", "follow_up",
  "get_tools", "set_tools", "reload", "abort_compaction", "extension_ui_response",
  "extension_ui_input", "set_auto_retry",
]);

export function isFcnSessionCommand(value: unknown): boolean {
  return typeof value === "string" && FCN_SESSION_COMMANDS.has(value);
}

/** Explicit extension loading prevents unrelated installed packages from running. */
export function fcnResourceLoaderOptions(extensionPath: string, systemPrompt: string) {
  return {
    systemPrompt,
    noExtensions: true,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
}
