import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { getAccountPreferences } from "./account-preferences";

export interface AgentSuiteInfo {
  path: string;
  isDefault: boolean;
  requiresTrust: boolean;
  trusted: boolean;
  agents: number;
  skills: number;
  extensions: number;
  hasSettings: boolean;
}

function countFiles(directory: string, predicate: (name: string) => boolean, recursive = false): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && predicate(entry.name)) count += 1;
    else if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) {
      count += countFiles(entryPath, predicate, true);
    }
  }
  return count;
}

export function resolveAgentSuitePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Agent suite path is required");
  const expanded = trimmed === "~"
    ? os.homedir()
    : trimmed.startsWith(`~${path.sep}`) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  const resolved = path.resolve(expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Agent suite directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error("Agent suite path must be a directory");
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new Error("Agent suite directory is not readable by the Web service user");
  }
  return fs.realpathSync(resolved);
}

export function inspectAgentSuite(directory: string): AgentSuiteInfo {
  const resolved = resolveAgentSuitePath(directory);
  const defaultDir = fs.existsSync(getAgentDir()) ? fs.realpathSync(getAgentDir()) : path.resolve(getAgentDir());
  const isDefault = resolved === defaultDir;
  const requiresTrust = !isDefault;
  return {
    path: resolved,
    isDefault,
    requiresTrust,
    trusted: isDefault || new ProjectTrustStore(getAgentDir()).get(resolved) === true,
    agents: countFiles(path.join(resolved, "agents"), (name) => name.endsWith(".md")),
    skills: countFiles(path.join(resolved, "skills"), (name) => name === "SKILL.md", true),
    extensions: countFiles(path.join(resolved, "extensions"), (name) => /\.(?:[cm]?[jt]s|tsx)$/.test(name), true),
    hasSettings: fs.existsSync(path.join(resolved, "settings.json")),
  };
}

/** Record an explicit operator decision before a non-default suite can load. */
export function trustAgentSuite(directory: string): AgentSuiteInfo {
  const suite = inspectAgentSuite(directory);
  if (!suite.requiresTrust) return suite;
  new ProjectTrustStore(getAgentDir()).set(suite.path, true);
  return inspectAgentSuite(suite.path);
}

export function getActiveAgentDir(accountUid: string): string {
  const configured = getAccountPreferences(accountUid).agentSuitePath;
  if (!configured) return getAgentDir();
  try {
    const suite = inspectAgentSuite(configured);
    return suite.trusted ? suite.path : getAgentDir();
  } catch {
    return getAgentDir();
  }
}
