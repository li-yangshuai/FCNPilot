import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectConfigDirectories } from "./project-config-dirs.ts";

test("limits inherited project config to the nearest Git checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-config-"));
  const repo = join(root, "repo");
  const nested = join(repo, "src", "nested");
  await mkdir(nested, { recursive: true });
  await mkdir(join(repo, ".git"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(projectConfigDirectories(nested), [
    repo,
    join(repo, "src"),
    nested,
  ]);
});

test("does not inherit ambient ancestor config outside a non-Git folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-config-"));
  const selected = join(root, "plain", "nested");
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), "{}");
  await mkdir(selected, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(projectConfigDirectories(selected), [selected]);
});
