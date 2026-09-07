export type CustomAgentScope = "global" | "project";

export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  scope: CustomAgentScope;
  filePath: string;
  systemPrompt: string;
  /** Native pi-subagents `enabled` flag; false keeps this profile main-only. */
  subagentEnabled?: boolean;
  provider?: string;
  modelId?: string;
  tools?: string[];
  skills?: string[];
  allSkills: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  mtimeMs?: number;
}

export interface AgentRuntimeConfig {
  id: string;
  name: string;
  systemPrompt: string;
  /** Exact Agent tool selection. MCP tools use their generated mcp_* names. */
  tools?: string[];
  skills?: string[];
}
