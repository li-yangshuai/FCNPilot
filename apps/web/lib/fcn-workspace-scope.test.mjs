import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { sessionsForFcnWorkspace, isWithinFcnWorkspace, cwdForFcnWorkspace } = await jiti.import("./fcn-workspace-scope.ts");
const workspace = "/home/lys/projects/github/FCNPilot/engine";

test("circuit sessions include engine descendants without unrelated global or sibling projects", () => {
  const sessions = [
    { id: "circuit", cwd: workspace, projectRoot: "/home/lys/projects/github/FCNPilot" },
    { id: "nested", cwd: workspace + "/tests/benchmarks_pi", projectRoot: "/home/lys/projects/github/FCNPilot" },
    { id: "web", cwd: "/home/lys/projects/github/FCNPilot/apps/web", projectRoot: "/home/lys/projects/github/FCNPilot" },
    { id: "sibling", cwd: workspace + "-backup" },
    { id: "global", cwd: "/home/lys" },
  ];
  const before = JSON.stringify(sessions);
  assert.deepEqual(sessionsForFcnWorkspace(sessions, workspace).map(s => s.id), ["circuit", "nested"]);
  assert.equal(JSON.stringify(sessions), before);
  assert.equal(sessionsForFcnWorkspace(sessions), sessions);
});

test("directory boundaries normalize separators and dot segments", () => {
  assert.equal(isWithinFcnWorkspace(workspace + "/./tests/../input", workspace + "/"), true);
  assert.equal(isWithinFcnWorkspace(workspace + "/../apps/web", workspace), false);
  assert.equal(isWithinFcnWorkspace("tests/input", workspace), false);
  assert.equal(isWithinFcnWorkspace(workspace.toUpperCase(), workspace), false);
  assert.equal(isWithinFcnWorkspace("c:/WORK/FcnPilot/engine/tests", "C:\\Work\\FCNPilot\\engine"), true);
});

test("restoration and new designs cannot inherit another project's working directory", () => {
  assert.equal(cwdForFcnWorkspace("/tmp/unrelated", workspace), workspace);
  assert.equal(cwdForFcnWorkspace(null, workspace), workspace);
  assert.equal(cwdForFcnWorkspace(workspace + "/tests", workspace), workspace + "/tests");
  assert.equal(cwdForFcnWorkspace("/tmp/unrelated"), "/tmp/unrelated");
});
