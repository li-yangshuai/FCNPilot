import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { buildSlashCommandLayout } = await jiti.import("./ChatInput.tsx");

test("keeps only FCN conversation commands with contiguous palette selection indices", () => {
  const layout = buildSlashCommandLayout([
    { name: "skill:general", source: "skill" },
    { name: "external", source: "extension" },
    { name: "compact", description: "Compact", source: "builtin" },
    { name: "name", description: "Name this circuit design", source: "builtin" },
  ]);
  assert.deepEqual(layout.commands.map((command) => command.name), ["compact", "name"]);
  assert.deepEqual(layout.groups.flatMap((group) => group.items.map((item) => item.index)), [0, 1]);
});
