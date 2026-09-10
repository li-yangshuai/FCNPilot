export type CustomAgentScope = "global" | "project";

export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  scope: CustomAgentScope;
  filePath: string;
  systemPrompt: string;
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
  /** Fixed FCN circuit-design tool selection. */
  tools?: string[];
  skills?: string[];
}
