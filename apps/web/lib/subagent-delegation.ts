import type { SubagentOption } from "./subagents";

type DelegatedAgent = Pick<SubagentOption, "name" | "displayName" | "description" | "scope">;

const DELEGATION_BLOCK_RE = /\n*<pi-web-subagent-delegation>[\s\S]*?<\/pi-web-subagent-delegation>\s*$/;

function compactDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Keep the user's visible chat message unchanged while giving the parent model
 * an explicit, machine-readable delegation request. The installed subagent
 * package discovers the selected definitions again at execution time, so the
 * UI only needs to pass the registered subagent type name.
 */
export function buildSubagentDelegationPrompt(message: string, agents: DelegatedAgent[]): string {
  if (!message.trim() || agents.length === 0 || message.trimStart().startsWith("/")) return message;

  const agentRows = agents.map((agent) => (
    `- subagent_type=${JSON.stringify(agent.name)}; label=${JSON.stringify(agent.displayName)}; source=${agent.scope}; description=${JSON.stringify(compactDescription(agent.description))}`
  )).join("\n");
  const invocation = agents.length === 1
    ? [
        `Call the Agent tool exactly once with subagent_type=${JSON.stringify(agents[0].name)}.`,
        "Set prompt to a complete, self-contained version of the user's request, description to a short 3-5 word summary, and run_in_background=false.",
      ].join(" ")
    : [
        `Issue one Agent tool call for each selected subagent_type (${agents.map((agent) => JSON.stringify(agent.name)).join(", ")}), preferably as parallel tool calls in the same turn.`,
        "For every call, set prompt to a complete, self-contained version of the request tailored to that role, description to a short 3-5 word summary, and run_in_background=true.",
        "After launching them, wait for the package's grouped completion follow-up before synthesizing the results; do not present the launch acknowledgements as the final answer.",
      ].join(" ");

  return `${message}\n\n<pi-web-subagent-delegation>\n`
    + "Pi Web UI control metadata: the user explicitly selected these @tintinweb/pi-subagents types for this message:\n"
    + `${agentRows}\n`
    + `${invocation}\n`
    + "If the request includes attachments, include any attachment facts needed by the delegated task in its prompt. "
    + "Do not simulate the roles: invoke the Agent tool, verify the completed work, and synthesize one response for the user.\n"
    + "</pi-web-subagent-delegation>";
}

/** Hide Pi Web's orchestration metadata when rendering a stored user turn. */
export function stripSubagentDelegationPrompt(message: string): string {
  return message.replace(DELEGATION_BLOCK_RE, "").trimEnd();
}
