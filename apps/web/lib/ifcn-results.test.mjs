import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  authorizeIfcnResults, ifcnArtifactHeaders, IfcnResultsError,
  listIfcnRuns, readIfcnRun, readIfcnArtifact,
} = await jiti.import("./ifcn-results.ts");
const { trustProject } = await jiti.import("./project-trust.ts");

const id = "cbf7d6b9834644ed9eee19e7532bce5c";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fcn-results-"));
  const directory = path.join(root, "output", "pi-runs", id);
  fs.mkdirSync(path.join(directory, "02_pnr_1"), { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const qca = "[TYPE:DESIGN]\n[TYPE:QCADCell]\ncell_options.clock=0\n[#TYPE:QCADCell]\n";
  const manifest = {
    schema: "ifcn.pi.run.v1", run_id: id,
    frontend: { module: "xor2" }, source: "/private/circuit/xor2.v",
    status: "completed", current_stage: "map", requested_until: "map",
    created_at: "2026-09-07T03:16:20+00:00", updated_at: "2026-09-07T03:17:38+00:00",
    parameters: { algorithm: "normal_2ddwave" },
    stages: { parse: { status: "completed", attempt: 1 }, map: { status: "completed", attempt: 1 } },
    metrics: { pnr: { width: 3, height: 4, area_tiles: 12 }, mapping: { cell_count: 79 } },
    validation: { physical_function: "not_verified", energy: "model_estimate; not a power signoff" },
    artifacts: {}, error: null,
  };
  const addArtifact = (name, relative, content) => {
    fs.writeFileSync(path.join(directory, relative), content);
    manifest.artifacts[name] = { path: relative, bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"), absolute_path: "/ignored/unsafe/path" };
  };
  const writeManifest = () => fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  addArtifact("pnr/normalized_physical.svg", "02_pnr_1/layout.svg", svg);
  addArtifact("device.qca", "device.qca", qca);
  writeManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, manifest, svg, qca, writeManifest, addArtifact };
}

test("lists a real run-shaped manifest and returns exact verified SVG/QCA bytes with evidence scope", (t) => {
  const f = fixture(t);
  const list = listIfcnRuns(f.root);
  assert.equal(list.total, 1);
  assert.equal(list.runs[0].module, "xor2");
  assert.equal(list.runs[0].sourceName, "xor2.v");
  assert.equal(list.runs[0].artifactCount, 2);
  assert.equal(list.runs[0].algorithm, "normal_2ddwave");
  assert.equal(JSON.stringify(list).includes("/private/"), false);
  const detail = readIfcnRun(f.root, id);
  assert.deepEqual(detail.metrics, f.manifest.metrics);
  assert.deepEqual(detail.validation, f.manifest.validation);
  assert.equal(detail.stages[1].id, "map");
  assert.equal(detail.artifacts[0].preview, "svg");
  assert.match(detail.artifacts[1].previewUrl, /preview=1$/);
  assert.equal(readIfcnArtifact(f.root, id, "pnr/normalized_physical.svg").bytes.toString(), f.svg);
  assert.equal(readIfcnArtifact(f.root, id, "device.qca").bytes.toString(), f.qca);
  assert.match(ifcnArtifactHeaders(detail.artifacts[0], false)["Content-Disposition"], /^attachment;/);
  const headers = ifcnArtifactHeaders(detail.artifacts[0], true);
  assert.match(headers["Content-Disposition"], /^inline;/);
  assert.match(headers["Content-Security-Policy"], /^sandbox;/);
  assert.match(headers["Content-Security-Policy"], /script-src 'none'/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("rejects traversal, cross-run files, unlisted files, and manifest mismatches", (t) => {
  const f = fixture(t);
  for (const value of ["../device.qca", "/etc/passwd", "C:\\secret", "pnr/../device.qca", "device.qca\n"]) {
    assert.throws(() => readIfcnArtifact(f.root, id, value), IfcnResultsError);
  }
  assert.throws(() => readIfcnRun(f.root, "../" + id), /编号无效/);
  assert.throws(() => readIfcnArtifact(f.root, id, "unlisted.qca"), /未列入/);
  for (const maliciousPath of ["../other/device.qca", "/etc/passwd", "C:/secret", "02_pnr_1/../device.qca"]) {
    f.manifest.artifacts["device.qca"].path = maliciousPath;
    f.writeManifest();
    assert.throws(() => readIfcnArtifact(f.root, id, "device.qca"), /路径无效/);
    assert.equal(readIfcnRun(f.root, id).artifacts.length, 1, "invalid manifest entries are not offered as downloads");
  }
  f.manifest.run_id = "a".repeat(32);
  f.writeManifest();
  assert.throws(() => readIfcnRun(f.root, id), /编号不一致/);
  assert.equal(listIfcnRuns(f.root).total, 0);
});

test("refuses modified artifacts even when byte length is unchanged", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, "device.qca"), f.qca.replace("clock=0", "clock=1"));
  assert.throws(() => readIfcnArtifact(f.root, id, "device.qca"), (error) => error.status === 409);
  f.manifest.artifacts["device.qca"].sha256 = "";
  f.writeManifest();
  assert.throws(() => readIfcnArtifact(f.root, id, "device.qca"), /校验值/);
});

test("rejects file, intermediate-directory, run-directory, and manifest symlinks", (t) => {
  const f = fixture(t);
  const originalQca = path.join(f.directory, "device.qca");
  const sibling = path.join(f.root, "outside.qca");
  fs.writeFileSync(sibling, f.qca);
  fs.unlinkSync(originalQca);
  fs.symlinkSync(sibling, originalQca);
  assert.throws(() => readIfcnArtifact(f.root, id, "device.qca"), /符号链接/);
  fs.unlinkSync(originalQca);
  fs.writeFileSync(originalQca, f.qca);

  const layoutDirectory = path.join(f.directory, "02_pnr_1");
  const movedLayout = path.join(f.root, "moved-layout");
  fs.renameSync(layoutDirectory, movedLayout);
  fs.symlinkSync(movedLayout, layoutDirectory, "dir");
  assert.throws(() => readIfcnArtifact(f.root, id, "pnr/normalized_physical.svg"), /符号链接/);

  const manifestFile = path.join(f.directory, "manifest.json");
  const movedManifest = path.join(f.root, "moved-manifest.json");
  fs.renameSync(manifestFile, movedManifest);
  fs.symlinkSync(movedManifest, manifestFile);
  assert.throws(() => readIfcnRun(f.root, id), /符号链接/);
  fs.unlinkSync(manifestFile);
  fs.renameSync(movedManifest, manifestFile);

  const movedRun = path.join(f.root, "moved-run");
  fs.renameSync(f.directory, movedRun);
  fs.symlinkSync(movedRun, f.directory, "dir");
  assert.throws(() => readIfcnRun(f.root, id), /符号链接/);
  assert.equal(listIfcnRuns(f.root).total, 0);
});

test("empty output is a normal empty result and oversized files are bounded", (t) => {
  const f = fixture(t);
  assert.deepEqual(listIfcnRuns(path.join(f.root, "missing-engine")), { runs: [], total: 0 });
  fs.truncateSync(path.join(f.directory, "device.qca"), 64 * 1024 * 1024 + 1);
  assert.throws(() => readIfcnArtifact(f.root, id, "device.qca"), (error) => error.status === 413);
});

test("authorization requires an account and project trust without invoking any engine process", async (t) => {
  const f = fixture(t);
  const saved = Object.fromEntries(["IFCN_ROOT", "PI_CODING_AGENT_DIR", "PI_WEB_CONFIG_DIR", "PI_WEB_SHARED_ROOTS"]
    .map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const agentDir = path.join(f.root, "agent");
  fs.mkdirSync(agentDir);
  process.env.IFCN_ROOT = f.root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_CONFIG_DIR = path.join(f.root, "web-config");
  process.env.PI_WEB_SHARED_ROOTS = f.root;
  const extension = path.join(f.root, ".pi", "extensions", "ifcn");
  fs.mkdirSync(extension, { recursive: true });
  fs.mkdirSync(path.join(f.root, ".pi", "agents"));
  fs.mkdirSync(path.join(f.root, "scripts"));
  fs.writeFileSync(path.join(extension, "index.ts"), "throw new Error('must never execute');\n");
  const marker = path.join(f.root, "engine-was-invoked");
  fs.writeFileSync(path.join(f.root, "scripts", "ifcn_agent.py"),
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  fs.writeFileSync(path.join(f.root, ".pi", "agents", "ifcn.md"),
    '---\nname: ifcn\ndescription: FCN design\ntools: "ifcn_capabilities, ifcn_run, ifcn_status, ifcn_artifact"\n---\nDesign FCN circuits.\n');
  await assert.rejects(authorizeIfcnResults(""), (error) => error.status === 401);
  const uid = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(authorizeIfcnResults(uid), /信任/);
  trustProject(f.root, agentDir);
  assert.equal(await authorizeIfcnResults(uid), f.root);
  assert.equal(fs.existsSync(marker), false);
});


test("sequential candidate and state verification are preserved independently from completed execution stages", (t) => {
  const f = fixture(t);
  f.manifest.design_type = "sequential";
  f.manifest.status = "layout_candidate";
  f.manifest.metrics.sequential = { mapping_mode: "sequential", state_boundary_count: 1, feedback_routes: 1, tile_phase_drc: true, physical_state_signoff: "not_characterized" };
  f.manifest.validation = { state_transition: "checked_next_state_logic", physical_function: "not_verified" };
  f.writeManifest();
  assert.equal(listIfcnRuns(f.root).runs[0].designType, "sequential");
  const result = readIfcnRun(f.root, id);
  assert.equal(result.designType, "sequential");
  assert.equal(result.status, "layout_candidate");
  assert.equal(result.stages[1].status, "completed");
  assert.equal(result.metrics.sequential.physical_state_signoff, "not_characterized");
  assert.equal(result.validation.physical_function, "not_verified");
  assert.equal(result.metrics.logic, undefined);
});

test("old manifests do not acquire a fabricated combinational or sequential designation", (t) => {
  const f = fixture(t);
  assert.equal(readIfcnRun(f.root, id).designType, null);
  f.manifest.design_type = "invented";
  f.writeManifest();
  assert.equal(listIfcnRuns(f.root).runs[0].designType, null);
  f.manifest.design_type = "combinational";
  f.writeManifest();
  assert.equal(readIfcnRun(f.root, id).designType, "combinational");
});


test("native IFCN preview remains verified plain text, and clocks come only from recorded PNR", (t) => {
  const f = fixture(t);
  const source = "#phase count: 4\n#nodes info\n";
  f.addArtifact("layout.ifcn", "02_pnr_1/layout.ifcn", source);
  f.manifest.parameters = { algorithm: "regular_clock_ga", clock_scheme: "USE" };
  f.writeManifest();
  assert.equal(readIfcnRun(f.root, id).clockScheme, null, "a requested clock does not prove the generated clock");
  f.manifest.metrics.pnr.clock_scheme = "RES";
  f.writeManifest();
  const run = readIfcnRun(f.root, id);
  assert.equal(run.clockScheme, "RES");
  assert.equal(listIfcnRuns(f.root).runs[0].clockScheme, "RES");
  const artifact = run.artifacts.find((item) => item.name === "layout.ifcn");
  assert.equal(artifact.preview, "ifcn");
  assert.match(artifact.previewUrl, /preview=1$/);
  const headers = ifcnArtifactHeaders(artifact, true);
  assert.equal(headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Content-Security-Policy"], /script-src 'none'/);
  assert.equal(readIfcnArtifact(f.root, id, "layout.ifcn").bytes.toString(), source);
  fs.writeFileSync(path.join(f.directory, "02_pnr_1/layout.ifcn"), source.replace("4", "3"));
  assert.throws(() => readIfcnArtifact(f.root, id, "layout.ifcn"), (error) => error.status === 409);
});

test("optimization source labels use only the explicit manifest policy and preserve the circuit algorithm", (t) => {
  const f = fixture(t);
  assert.equal(readIfcnRun(f.root, id).optimizationPolicy, null);
  for (const policy of ["llm", "noop", "random", "heuristic"]) {
    f.manifest.optimization = { policy };
    f.writeManifest();
    assert.equal(readIfcnRun(f.root, id).optimizationPolicy, policy);
    assert.equal(listIfcnRuns(f.root).runs[0].optimizationPolicy, policy);
    assert.equal(readIfcnRun(f.root, id).algorithm, "normal_2ddwave");
  }
  for (const policy of ["LLM", "unknown", true, {}, null]) {
    f.manifest.optimization = { policy };
    f.writeManifest();
    assert.equal(readIfcnRun(f.root, id).optimizationPolicy, null);
  }
  delete f.manifest.optimization;
  f.manifest.frontend.module = "llm_optimization";
  f.writeManifest();
  assert.equal(readIfcnRun(f.root, id).optimizationPolicy, null, "circuit names cannot imply an experiment source");
});
