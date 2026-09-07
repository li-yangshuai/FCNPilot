import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Directories whose project configuration may apply to a cwd. For Git
 * workspaces we walk no farther than the nearest checkout root; for ordinary
 * folders only the selected directory applies. This prevents a project opened
 * below $HOME from accidentally treating $HOME/.pi as repository config.
 */
export function projectConfigDirectories(cwd: string): string[] {
  const selected = path.resolve(cwd);
  const fromSelected: string[] = [];
  let current = selected;

  while (true) {
    fromSelected.push(current);
    if (existsSync(path.join(current, ".git"))) return fromSelected.reverse();
    const parent = path.dirname(current);
    if (parent === current) return [selected];
    current = parent;
  }
}
