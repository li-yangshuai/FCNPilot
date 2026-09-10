import { realpathSync } from "node:fs";
import { CustomAgentFileError, resolveCustomAgentRuntimeConfig } from "./custom-agent-files";
import type { AgentRuntimeConfig } from "./custom-agents";
import { readIfcnWorkspaceConfiguration } from "./ifcn-workspace";
import { FCN_AGENT_ID } from "./fcn-agent-policy";

/** Every new or restored session runs the configured FCN main Agent. */
export async function resolveNewSessionAgentConfig(
  cwd: string, accountUid: string, requested?: { id?: unknown },
): Promise<AgentRuntimeConfig> {
  if (requested !== undefined && requested.id !== FCN_AGENT_ID) {
    throw new CustomAgentFileError("FCNPilot only supports the FCN main Agent", 409);
  }
  const workspace = readIfcnWorkspaceConfiguration();
  if (!workspace.valid || !workspace.cwd) {
    throw new CustomAgentFileError(workspace.message ?? "FCN main Agent is not configured", 409);
  }
  if (realpathSync(cwd) !== workspace.cwd) {
    throw new CustomAgentFileError("FCN design sessions must use the configured circuit workspace", 403);
  }
  return resolveCustomAgentRuntimeConfig(workspace.cwd, accountUid, FCN_AGENT_ID);
}
