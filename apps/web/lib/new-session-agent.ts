import { realpathSync } from "node:fs";
import { CustomAgentFileError, resolveCustomAgentRuntimeConfig } from "./custom-agent-files";
import type { AgentRuntimeConfig } from "./custom-agents";
import { IFCN_AGENT_ID, readIfcnWorkspaceConfiguration } from "./ifcn-workspace";

/** Apply the workspace's main Agent on the server, even for older clients. */
export async function resolveNewSessionAgentConfig(
  cwd: string,
  accountUid: string,
  requested?: { id?: unknown },
): Promise<AgentRuntimeConfig | undefined> {
  if (requested !== undefined) {
    return resolveCustomAgentRuntimeConfig(cwd, accountUid, requested?.id);
  }
  const workspace = readIfcnWorkspaceConfiguration();
  if (!workspace.cwd || realpathSync(cwd) !== workspace.cwd) return undefined;
  // A missing/broken profile must not silently create an ordinary coding Agent.
  if (!workspace.valid) {
    throw new CustomAgentFileError(workspace.message ?? "iFCN 主智能体配置无效", 409);
  }
  return resolveCustomAgentRuntimeConfig(cwd, accountUid, IFCN_AGENT_ID);
}
