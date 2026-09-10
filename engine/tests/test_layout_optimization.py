#!/usr/bin/env python3
"""Offline placement-campaign contracts and crash/rejection lifecycle tests.

The worker runs against real files, artifact hashes, interface/count validation,
and physical-certificate schema checks. Model/backend processes and proof results
are controlled fakes: these tests verify orchestration, not physical correctness
or the benefit of an LLM. No network, model credential, or native build is used.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ifcn_agent as agent
import ifcn_layout_optimization as optimizer
from ifcn_agent_layout_validation import export_native_ifcn


def candidate_fixture():
    return {
        "schema": "ifcn.native_candidate.v1", "algorithm": "compact",
        "clock_scheme": "irregular", "topology": "optimized_buffers",
        "routed": True, "native_mapping_valid": True,
        "nodes": [
            {"id": 0, "name": "a", "type": "input", "is_input": True,
             "is_output": False, "x": 2, "y": 2},
            {"id": 1, "name": "n", "type": "not", "is_input": False,
             "is_output": False, "x": 4, "y": 2},
            {"id": 2, "name": "y", "type": "output", "is_input": False,
             "is_output": True, "x": 6, "y": 2},
        ],
        "edges": [[0, 1], [1, 2]], "layers": [[0], [1], [2]],
        "routes": [
            {"source": 0, "target": 1, "path": [[2, 2], [3, 2], [4, 2]]},
            {"source": 1, "target": 2, "path": [[4, 2], [5, 2], [6, 2]]},
        ],
        "cells": [{"x": x, "y": 2, "phase": (x - 2) % 4 + 1}
                  for x in range(2, 7)],
    }


def proposal(*operations):
    return {"schema": "ifcn.layout_edit.v1", "operations": list(operations),
            "rationale": "Move only the visible selected gate coordinates."}


def moved(candidate, operations):
    after = copy.deepcopy(candidate)
    positions = {n["id"]: [n["x"], n["y"]] for n in candidate["nodes"]}
    for op in operations:
        if op["op"] == "move":
            positions[op["node"]] = op["to"]
        else:
            a, b = op["nodes"]
            positions[a], positions[b] = positions[b], positions[a]
    for node in after["nodes"]:
        node["x"], node["y"] = positions[node["id"]]
    return after


def qca_text(count):
    functions = ["QCAD_CELL_INPUT", "QCAD_CELL_OUTPUT"]
    functions += ["QCAD_CELL_NORMAL"] * (count - 2)
    return "\n".join("[TYPE:QCADCell]\ncell_function=" + f + "\n[#TYPE:QCADCell]"
                     for f in functions) + "\n"


class FakeAPI:
    """File-backed API; every simulated process call is recorded."""
    SCHEMA = agent.SCHEMA
    now = staticmethod(agent.now)
    write_json = staticmethod(agent.write_json)
    digest = staticmethod(agent.digest)
    run_path = staticmethod(agent.run_path)
    load_run = staticmethod(agent.load_run)
    artifact_path = staticmethod(agent.artifact_path)
    register_artifact = staticmethod(agent.register_artifact)
    verify_artifacts = staticmethod(agent.verify_artifacts)
    check_pnr = staticmethod(agent.check_pnr)
    record_logic = staticmethod(agent.record_logic)

    def __init__(self, directory):
        self.ROOT = directory / "engine"
        self.ROOT.mkdir(parents=True)
        (self.ROOT / "scripts").mkdir()
        self.build = self.ROOT / "build"
        self.build.mkdir()
        for name in ("ifcn_layout_edit", "ifcn_mapping_metrics", "ifcn_energy_analysis"):
            (self.build / name).write_text("offline executable fingerprint\n")
        self.STOP = False
        self.calls = []
        self.proofs = []
        self.starts = []
        self.scenarios = {}
        self.active = {}

    def configuration(self):
        return {"root": str(self.ROOT), "build_dir": str(self.build),
                "python": sys.executable, "backend": str(self.ROOT / "backend.py"),
                "energy_binary": str(self.build / "ifcn_energy_analysis")}

    def start_worker(self, path, until):
        self.starts.append((path, until))
        return self.load_run(path)

    def result_report(self, path, manifest):
        self.write_json(path / "result.json", {"status": manifest["status"],
                                               "metrics": manifest["metrics"]})
        self.register_artifact(path, manifest, "result.json", path / "result.json")

    def execute(self, command, path, step, manifest, **kwargs):
        cmd = list(map(str, command))
        self.calls.append({"command": cmd, **kwargs})
        if kwargs.get("input_path"):
            request = json.loads(Path(kwargs["input_path"]).read_text())
            index = int(request["request_id"].rsplit(":", 1)[1])
            scenario = self.scenarios.get(index, {})
            output = Path(kwargs["output_path"])
            if "raw_response" in scenario:
                output.write_text(scenario["raw_response"])
            else:
                audit = scenario.get("audit", {
                    "schema": "ifcn.layout_proposal_audit.v1", "status": "ok",
                    "proposal": proposal({"op": "move", "node": 0, "to": [2, 3]}),
                    "model": {"provider": "offline", "modelId": "fake"},
                    "response": {"raw_text": "controlled offline response"},
                    "usage": {"input": 7, "output": 3, "totalTokens": 10},
                    "latency_ms": 12,
                })
                self.write_json(output, audit)
            if scenario.get("cancel_model"):
                (path / "cancel.request").touch()
                raise InterruptedError("Cancelled after partial model output")
            if scenario.get("model_error"):
                raise RuntimeError("pnr command exited with 1. model client rejected output")
            return
        if "--edit-baseline" in cmd:
            target = Path(cmd[cmd.index("--output") + 1])
            self.active = self.scenarios.get(int(target.name), {})
            before = json.loads(Path(cmd[cmd.index("--edit-baseline") + 1]).read_text())
            edit = json.loads(Path(cmd[cmd.index("--edit-proposal") + 1]).read_text())
            after = moved(before, edit["operations"])
            if self.active.get("extra_move"):
                after["nodes"][1]["y"] += 1
            self.write_json(target / "layout_candidate.json", after)
            self.write_json(target / "routed_dag.json", {
                "nodes": after["nodes"], "edges": after["edges"]})
            # For move tests this intentionally remains an uncertified fake
            # geometry. Independent proof stubs below control its eligibility.
            export_native_ifcn(before, target / "layout.ifcn", "compact")
            self.write_json(target / "pnr.json", {
                "algorithm": "compact", "clock_scheme": "irregular",
                "layout_legal": self.active.get("fail") != "pnr",
                "failed_edge_count": 0, "clock_legal": True,
                "validation": {"passed": True},
                "area_tiles": self.active.get("area", 20),
            })
            (target / "native.log").write_text("offline native result\n")
            return
        if cmd[0] == str(self.build / "ifcn_energy_analysis"):
            target = Path(cmd[1]).parent
            count = self.active.get("cells", 10)
            qca = qca_text(count)
            if self.active.get("fail") == "interface":
                qca = qca.replace("QCAD_CELL_OUTPUT", "QCAD_CELL_NORMAL")
            (target / "device_energy_input.qca").write_text(qca)
            checks = ["ordered_route_continuity", "source_site_isolation",
                      "layer_transition_columns", "route_site_coverage",
                      "gate_connection_ports"]
            if self.active.get("fail") == "physical":
                checks.remove("gate_connection_ports")
            self.write_json(target / "device_physical_validation.json", {
                "schema": "ifcn.qca.physical_routes.v1", "passed": True,
                "checks": checks, "cell_count": count, "net_count": 2,
                "route_count": 2,
            })
            return
        raise AssertionError("Unexpected fake command: " + repr(cmd))

    def logic_report(self, source, dag, output):
        self.proofs.append("logic")
        status = "not_performed" if self.active.get("fail") == "logic" else "equivalent"
        report = {"status": status, "vectors_checked": 2, "expected_vector_count": 2,
                  "max_inputs": 11}
        self.write_json(output, report)
        return report

    def clock_report(self, ifcn, dag, output):
        self.proofs.append("clock")
        report = {"passed": self.active.get("fail") != "clock"}
        self.write_json(output, report)
        if not report["passed"]:
            raise ValueError("Controlled clock reconvergence failure")
        return report

    def qca_interface_report(self, qca, frontend, output):
        self.proofs.append("interface")
        return agent.qca_interface_report(qca, frontend, output)

    def physical_route_report(self, certificate, qca, interface, output, ifcn):
        self.proofs.append("physical")
        return agent.physical_route_report(certificate, qca, interface, output, ifcn)


def seed_baseline(api, path, registered_candidate=True):
    path.mkdir(parents=True)
    candidate = candidate_fixture()
    source = "module fixture(input a, output y); assign y = ~a; endmodule\n"
    (path / "source.v").write_text(source)
    (path / "normalized.v").write_text(source)
    dag = {"schema": "ifcn.dag.v1", "nodes": candidate["nodes"],
           "edges": candidate["edges"], "topological_order": [0, 1, 2]}
    for name in ("dag.json", "routed_dag.json"):
        api.write_json(path / name, dag)
    api.write_json(path / "layout_candidate.json", candidate)
    export_native_ifcn(candidate, path / "layout.ifcn", "compact")
    (path / "device.qca").write_text(qca_text(10))
    api.write_json(path / "physical.json", {
        "passed": True, "cell_count": 10,
        "qca_sha256": api.digest(path / "device.qca"),
        "ifcn_sha256": api.digest(path / "layout.ifcn"),
    })
    for name in ("clock.json", "interface.json", "logic.json"):
        api.write_json(path / name, {"passed": True, "status": "equivalent"})
    manifest = {
        "schema": api.SCHEMA, "run_id": path.name, "status": "completed",
        "design_type": "combinational", "source": "/source/fixture.v",
        "configuration": api.configuration(), "frontend": {"inputs": ["a"], "outputs": ["y"]},
        "parameters": {"algorithm": "compact", "clock_scheme": "irregular", "timeout_s": 10},
        "requested_until": "map", "stages": {}, "artifacts": {},
        "metrics": {"pnr": {"algorithm": "compact", "clock_scheme": "irregular", "area_tiles": 20}},
        "validation": {**optimizer.CERTIFICATES,
                       "rtl_equivalence": "exhaustive_scalar_source_vs_routed_dag"},
    }
    for file in sorted(path.iterdir()):
        if registered_candidate or file.name != "layout_candidate.json":
            api.register_artifact(path, manifest, file.name, file)
    api.write_json(path / "manifest.json", manifest)
    return manifest


class ContractTests(unittest.TestCase):
    def test_pi_po_moves_and_swaps_preserve_identity_without_mutating_input(self):
        before = candidate_fixture()
        frozen = copy.deepcopy(before)
        edit = proposal({"op": "move", "node": 0, "to": [2, 3]},
                        {"op": "swap", "nodes": [1, 2]})
        self.assertIs(optimizer.validate_proposal(edit, before), edit)
        changes = optimizer.assert_requested_moves(edit, before, moved(before, edit["operations"]))
        self.assertEqual([x["node_id"] for x in changes], [0, 1, 2])
        self.assertEqual(before, frozen)

    def test_illegal_actions_never_enter_executor(self):
        invalid = [
            proposal(), proposal(*[{"op": "swap", "nodes": [0, 1]}] * 4),
            proposal({"op": "delete", "node": 1}),
            proposal({"op": "move", "node": 99, "to": [2, 3]}),
            proposal({"op": "move", "node": 0, "to": [-1, 2]}),
            proposal({"op": "move", "node": 0, "to": [9, 2]}),
            proposal({"op": "move", "node": 0, "to": [2, 2]}),
            proposal({"op": "move", "node": 0, "to": [2.0, 3]}),
            proposal({"op": "move", "node": True, "to": [2, 3]}),
            proposal({"op": "move", "node": 0, "to": [True, 3]}),
            proposal({"op": "swap", "nodes": [0, 0]}),
            proposal({"op": "swap", "nodes": [0, 99]}),
            proposal({"op": "move", "node": 0, "to": [2, 3]},
                     {"op": "swap", "nodes": [0, 1]}),
            proposal({"op": "move", "node": 0, "to": [2, 3], "shell": "unused"}),
            {**proposal({"op": "swap", "nodes": [0, 1]}), "edges": []},
        ]
        for edit in invalid:
            with self.subTest(edit=edit), self.assertRaises(ValueError):
                optimizer.validate_proposal(edit, candidate_fixture())
        optimizer.validate_proposal(proposal(), candidate_fixture(), allow_noop=True)

    def test_executor_cannot_change_unrequested_coordinates_or_dag(self):
        before = candidate_fixture()
        edit = proposal({"op": "move", "node": 0, "to": [2, 3]})
        correct = moved(before, edit["operations"])
        mutations = [
            lambda d: d["nodes"][1].update(y=3),
            lambda d: d["nodes"][0].update(name="other"),
            lambda d: d["nodes"][0].update(is_input=False),
            lambda d: d["nodes"][2].update(is_output=False),
            lambda d: d["nodes"][1].update(type="buffer"),
            lambda d: d["edges"].pop(),
            lambda d: d["nodes"].pop(),
            lambda d: d["nodes"].append(copy.deepcopy(d["nodes"][0])),
            lambda d: d["edges"].append(d["edges"][0]),
            lambda d: d["routes"].pop(),
            lambda d: d["routes"].append(copy.deepcopy(d["routes"][0])),
        ]
        for mutation in mutations:
            after = copy.deepcopy(correct)
            mutation(after)
            with self.subTest(after=after), self.assertRaises(ValueError):
                optimizer.assert_requested_moves(edit, before, after)

    def test_controls_are_seeded_bounded_and_noop_is_explicit(self):
        candidate = candidate_fixture()
        frozen = copy.deepcopy(candidate)
        for policy in optimizer.POLICIES[1:]:
            for seed in range(20):
                with self.subTest(policy=policy, seed=seed):
                    first = optimizer.control_proposal(candidate, policy, seed)
                    self.assertEqual(first, optimizer.control_proposal(candidate, policy, seed))
                    optimizer.validate_proposal(first, candidate, allow_noop=policy == "noop")
                    self.assertEqual(len(first["operations"]) == 0, policy == "noop")
        self.assertEqual(candidate, frozen)


    def test_model_context_exposes_locked_algorithm_rules_and_last_failures(self):
        candidate = candidate_fixture()
        snapshot = {"metrics": {"area_tiles": 20, "qca_cells": 10}}
        campaign = {"rounds": [
            {"id": i, "proposal": {"operations": [{"op": "move", "node": 0, "to": [2, 3]}]},
             "acceptance": {"status": "failed", "reasons": ["gate port occupancy"]}}
            for i in range(1, 5)]}
        for algorithm, same_phase_limit, fraction in [("compact", 4, None), ("june_random", 10, 0.3)]:
            candidate["algorithm"] = algorithm
            context = optimizer.context_for(candidate, snapshot, campaign)
            self.assertEqual(context["action_space"]["movable_node_ids"], [0, 1, 2])
            self.assertEqual(context["action_space"]["coordinate_bounds"], optimizer.bounds(candidate))
            self.assertEqual(context["dag"]["edges"], candidate["edges"])
            self.assertEqual(context["routes"], candidate["routes"])
            self.assertEqual(context["rules"]["max_consecutive_same_phase_tiles"], same_phase_limit)
            self.assertEqual(context["rules"]["max_same_phase_step_fraction"], fraction)
            self.assertEqual([r["round"] for r in context["feedback"]], [2, 3, 4])
            self.assertEqual(context["feedback"][-1]["outcome"]["reasons"], ["gate port occupancy"])


class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.api = FakeAPI(self.directory)
        self.base = self.directory / "runs"
        self.baseline = self.base / ("0" * 32)
        seed_baseline(self.api, self.baseline, registered_candidate=False)
        self.baseline_hashes = {p.name: self.api.digest(p) for p in self.baseline.iterdir()}
        self.node_patch = patch.object(optimizer, "choose_node", return_value="offline-node")
        self.git_patch = patch.object(optimizer.subprocess, "check_output", return_value="offline-commit\n")
        self.node_patch.start()
        self.git_patch.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.node_patch.stop)
        self.addCleanup(self.git_patch.stop)

    def create(self, policy="noop", rounds=1):
        args = SimpleNamespace(run_id=self.baseline.name, policy=policy, rounds=rounds,
                               seed=1, candidate_timeout=10, model_timeout=10,
                               provider=None, model_id=None)
        manifest = optimizer.create_run(self.api, args, self.base)
        return self.base / manifest["run_id"]

    def run_campaign(self, path):
        with patch.object(optimizer, "clock_arrival_report", side_effect=self.api.clock_report):
            optimizer.run_worker(self.api, path, os.open(os.devnull, os.O_RDONLY))
        return self.api.load_run(path), json.loads((path / "campaign.json").read_text())

    def assert_original_unchanged(self):
        self.assertEqual(self.baseline_hashes,
                         {p.name: self.api.digest(p) for p in self.baseline.iterdir()})

    def assert_baseline_selected(self, path, manifest, campaign):
        self.assertIsNone(campaign["selected_round"])
        self.assertEqual(campaign["selected"], campaign["baseline"])
        for name in ("layout.ifcn", "layout_candidate.json", "device.qca", "physical.json"):
            self.assertEqual(manifest["artifacts"][name], manifest["artifacts"]["baseline/" + name])
        self.api.verify_artifacts(path, manifest)
        self.assert_original_unchanged()

    def test_old_unregistered_snapshot_is_bound_and_frozen_before_start(self):
        path = self.create()
        manifest = self.api.load_run(path)
        self.assertEqual(len(self.api.starts), 1)
        self.assertEqual(json.loads((path / "baseline/layout_candidate.json").read_text()), candidate_fixture())
        self.api.verify_artifacts(path, manifest)
        self.assert_original_unchanged()

    def test_old_snapshot_metadata_not_serialized_in_ifcn_still_must_match_dag(self):
        file = self.baseline / "layout_candidate.json"
        original = file.read_text()
        mutations = [lambda d: d["edges"].pop(),
                     lambda d: d["edges"].append(d["edges"][0]),
                     lambda d: d["nodes"][0].update(is_input=False),
                     lambda d: d["nodes"][2].update(is_output=False),
                     lambda d: d["nodes"].append(copy.deepcopy(d["nodes"][0])),
                     lambda d: d["routes"].pop(),
                     lambda d: d["routes"].append(copy.deepcopy(d["routes"][0]))]
        for mutate in mutations:
            candidate = json.loads(original)
            mutate(candidate)
            self.api.write_json(file, candidate)
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                self.create()
        self.assertEqual(self.api.starts, [])
        file.write_text(original)
        self.assert_original_unchanged()

    def test_old_snapshot_geometry_or_phase_disagreement_is_rejected(self):
        file = self.baseline / "layout_candidate.json"
        original = file.read_text()
        for mutation in (lambda d: d["nodes"][1].update(x=3),
                         lambda d: d["cells"][0].update(phase=2),
                         lambda d: d["routes"][0]["path"].reverse()):
            candidate = json.loads(original)
            mutation(candidate)
            self.api.write_json(file, candidate)
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                self.create()
        self.assertEqual(self.api.starts, [])
        file.write_text(original)

    def test_missing_actual_qca_hash_binding_prevents_any_model_start(self):
        manifest = self.api.load_run(self.baseline)
        qca = self.baseline / "device.qca"
        qca.write_text(qca_text(11))
        self.api.register_artifact(self.baseline, manifest, "device.qca", qca)
        self.api.write_json(self.baseline / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "physical certificate"):
            self.create(policy="llm")
        self.assertEqual(self.api.starts, [])
        self.assertEqual(self.api.calls, [])

    def test_rule_failure_at_every_gate_cannot_replace_baseline(self):
        for failure in ("pnr", "logic", "clock", "interface", "physical"):
            with self.subTest(failure=failure):
                path = self.create()
                self.api.scenarios = {1: {"area": 1, "cells": 2, "fail": failure}}
                self.api.proofs.clear()
                manifest, campaign = self.run_campaign(path)
                self.assertEqual(manifest["status"], "completed")
                self.assertEqual(campaign["rounds"][0]["status"], "failed")
                self.assertFalse(campaign["rounds"][0]["execution"].get("candidate", {}).get("validation"))
                self.assert_baseline_selected(path, manifest, campaign)
                if failure == "pnr":
                    self.assertEqual(self.api.proofs, [])
                elif failure == "logic":
                    self.assertEqual(self.api.proofs, ["logic"])
                elif failure == "clock":
                    self.assertEqual(self.api.proofs, ["logic", "clock"])
                elif failure == "interface":
                    self.assertEqual(self.api.proofs, ["logic", "clock", "interface"])
                else:
                    self.assertEqual(self.api.proofs, ["logic", "clock", "interface", "physical"])

    def test_strict_pareto_selection_uses_actual_qca_count_and_never_regresses(self):
        for area, cells, accepted in [(19, 10, True), (20, 9, True), (19, 9, True),
                                      (21, 9, False), (19, 11, False), (20, 10, False)]:
            with self.subTest(area=area, cells=cells):
                path = self.create()
                self.api.scenarios = {1: {"area": area, "cells": cells}}
                manifest, campaign = self.run_campaign(path)
                row = campaign["rounds"][0]
                self.assertEqual(row["status"], "accepted" if accepted else "rejected")
                self.assertEqual(row["execution"]["candidate"]["metrics"]["qca_cells"], cells)
                if accepted:
                    self.assertEqual(campaign["selected_round"], 1)
                    self.assertEqual(campaign["selected"]["metrics"], {"area_tiles": area, "qca_cells": cells})
                    self.assertEqual(manifest["artifacts"]["device.qca"]["path"], "rounds/01/device_energy_input.qca")
                    self.assertNotEqual(manifest["artifacts"]["device.qca"], manifest["artifacts"]["baseline/device.qca"])
                    self.api.verify_artifacts(path, manifest)
                    self.assert_original_unchanged()
                else:
                    self.assert_baseline_selected(path, manifest, campaign)

    def test_later_rule_failure_preserves_prior_accepted_result_and_original(self):
        path = self.create(rounds=2)
        self.api.scenarios = {1: {"area": 19, "cells": 9},
                              2: {"area": 18, "cells": 8, "fail": "physical"}}
        manifest, campaign = self.run_campaign(path)
        self.assertEqual([r["status"] for r in campaign["rounds"]], ["accepted", "failed"])
        self.assertEqual(campaign["selected_round"], 1)
        self.assertEqual(campaign["rounds"][1]["start"], campaign["selected"])
        self.assertEqual(manifest["artifacts"]["layout_candidate.json"]["path"], "rounds/01/layout_candidate.json")
        self.api.verify_artifacts(path, manifest)
        self.assert_original_unchanged()

    def test_nonzero_model_exit_keeps_partial_audit_model_usage_and_raw_response(self):
        path = self.create(policy="llm")
        audit = {"schema": "ifcn.layout_proposal_audit.v1", "status": "error",
                 "request": {"system_prompt": "recorded", "user_prompt": "visible design"},
                 "response": {"raw_text": '{"schema":"ifcn.layout_edit.v1",'},
                 "error": {"code": "timeout", "message": "deadline"},
                 "model": {"provider": "offline", "modelId": "fake"},
                 "usage": {"input": 12, "output": 2, "totalTokens": 14}, "latency_ms": 10000}
        self.api.scenarios = {1: {"audit": audit, "model_error": True}}
        manifest, campaign = self.run_campaign(path)
        row = campaign["rounds"][0]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["proposal"]["usage"], audit["usage"])
        self.assertEqual(row["proposal"]["model"], audit["model"])
        self.assertEqual(json.loads((path / row["proposal"]["response_artifact"]).read_text()), audit)
        self.assertIn("rounds/01/response.json", manifest["artifacts"])
        self.assertEqual(len(self.api.calls), 1)
        self.assert_baseline_selected(path, manifest, campaign)

    def test_cancelled_paid_round_is_not_repeated_on_resume(self):
        path = self.create(policy="llm")
        partial = '{"schema":"ifcn.layout_proposal_audit.v1","response":'
        self.api.scenarios = {1: {"raw_response": partial, "cancel_model": True}}
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(manifest["status"], "cancelled")
        self.assertEqual(campaign["rounds"][0]["status"], "cancelled")
        self.assertEqual(len(self.api.calls), 1)
        self.assertIn("rounds/01/response.json", manifest["artifacts"])
        (path / "cancel.request").unlink()
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(len(self.api.calls), 1)
        self.assertEqual((path / "rounds/01/response.json").read_text(), partial)
        self.assertEqual(campaign["rounds"][0]["status"], "cancelled")
        self.assert_baseline_selected(path, manifest, campaign)

    def test_crash_resume_recovers_uncheckpointed_audits_without_repeating_paid_round(self):
        for status in ("proposing", "evaluating"):
            with self.subTest(status=status):
                path = self.create(policy="llm")
                manifest = self.api.load_run(path)
                campaign = json.loads((path / "campaign.json").read_text())
                target = path / "rounds/01"
                target.mkdir(parents=True)
                raw = '{"status":"error","response":{"raw_text":"partial crash output"}}'
                (target / "response.json").write_text(raw)
                (target / "stderr.log").write_text("provider transport closed\n")
                campaign["rounds"] = [{"id": 1, "status": status,
                                       "start": copy.deepcopy(campaign["selected"]), "execution": {}}]
                optimizer.checkpoint(self.api, path, manifest, campaign)
                self.api.calls.clear()
                manifest, campaign = self.run_campaign(path)
                self.assertEqual(self.api.calls, [])
                self.assertEqual(campaign["rounds"][0]["status"], "cancelled")
                self.assertIn("rounds/01/response.json", manifest["artifacts"])
                self.assertIn("rounds/01/stderr.log", manifest["artifacts"])
                self.assertEqual((target / "response.json").read_text(), raw)
                self.assert_baseline_selected(path, manifest, campaign)

    def test_invalid_llm_noop_and_unrequested_executor_move_cannot_be_accepted(self):
        path = self.create(policy="llm")
        self.api.scenarios = {1: {"audit": {"status": "ok", "proposal": proposal()}}}
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(campaign["rounds"][0]["status"], "failed")
        self.assertEqual(len(self.api.calls), 1)
        self.assert_baseline_selected(path, manifest, campaign)
        path = self.create()
        self.api.scenarios = {1: {"area": 1, "cells": 2, "extra_move": True}}
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(campaign["rounds"][0]["status"], "failed")
        self.assert_baseline_selected(path, manifest, campaign)

    def test_changed_frozen_artifact_stops_before_any_model_request(self):
        path = self.create(policy="llm")
        (path / "baseline/layout_candidate.json").write_text("{}\n")
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(campaign["rounds"], [])
        self.assertEqual(self.api.calls, [])
        self.assertIsNone(campaign["selected_round"])

    def test_resume_consumes_remaining_rounds_without_reissuing_prior_request_id(self):
        path = self.create(policy="llm", rounds=2)
        manifest = self.api.load_run(path)
        campaign = json.loads((path / "campaign.json").read_text())
        first = path / "rounds/01"
        first.mkdir(parents=True)
        self.api.write_json(first / "request.json", {"request_id": f"{path.name}:1"})
        campaign["rounds"] = [{"id": 1, "status": "proposing", "execution": {},
                               "start": copy.deepcopy(campaign["selected"])}]
        optimizer.checkpoint(self.api, path, manifest, campaign)
        self.api.scenarios = {2: {"audit": {"status": "error", "error": {"code": "timeout"}},
                                  "model_error": True}}
        manifest, campaign = self.run_campaign(path)
        requests = [json.loads(Path(c["input_path"]).read_text())["request_id"]
                    for c in self.api.calls if c.get("input_path")]
        self.assertEqual(requests, [f"{path.name}:2"])
        self.assertEqual([r["status"] for r in campaign["rounds"]], ["cancelled", "failed"])
        self.assertIn("rounds/01/request.json", manifest["artifacts"])
        self.assert_baseline_selected(path, manifest, campaign)

    def test_candidate_routing_and_export_share_one_wall_clock_budget(self):
        path = self.create()
        self.api.scenarios = {1: {"area": 19, "cells": 9}}
        elapsed = [0.0]
        original_execute = self.api.execute

        def execute_and_advance(*args, **kwargs):
            original_execute(*args, **kwargs)
            if "--edit-baseline" in list(map(str, args[0])):
                elapsed[0] += 6

        with patch.object(optimizer.time, "monotonic", side_effect=lambda: elapsed[0]), \
             patch.object(self.api, "execute", side_effect=execute_and_advance):
            manifest, campaign = self.run_campaign(path)
        self.assertEqual(campaign["rounds"][0]["status"], "accepted")
        self.assertEqual([c["timeout_s"] for c in self.api.calls], [10.0, 4.0])
        self.api.verify_artifacts(path, manifest)

    def test_exhausted_candidate_budget_never_starts_device_export(self):
        path = self.create()
        elapsed = [0.0]
        original_execute = self.api.execute

        def execute_and_advance(*args, **kwargs):
            original_execute(*args, **kwargs)
            elapsed[0] += 10

        with patch.object(optimizer.time, "monotonic", side_effect=lambda: elapsed[0]), \
             patch.object(self.api, "execute", side_effect=execute_and_advance):
            manifest, campaign = self.run_campaign(path)
        self.assertEqual(campaign["rounds"][0]["status"], "failed")
        self.assertIn("budget exhausted", campaign["rounds"][0]["acceptance"]["reasons"][0])
        self.assertEqual(len(self.api.calls), 1)
        self.assert_baseline_selected(path, manifest, campaign)

    def test_preexisting_cancellation_stops_before_model_or_candidate_process(self):
        path = self.create(policy="llm")
        (path / "cancel.request").touch()
        manifest, campaign = self.run_campaign(path)
        self.assertEqual(manifest["status"], "cancelled")
        self.assertEqual(campaign["rounds"], [])
        self.assertEqual(self.api.calls, [])
        self.assert_baseline_selected(path, manifest, campaign)

    def test_main_worker_routes_incomplete_optimization_to_durable_campaign_worker(self):
        path = self.create(policy="llm")
        with patch.object(agent.signal, "signal"), patch.object(optimizer, "run_worker", return_value="dispatched") as run:
            self.assertEqual(agent.worker(path, 123), "dispatched")
        run.assert_called_once_with(agent, path, 123)


if __name__ == "__main__":
    unittest.main()
