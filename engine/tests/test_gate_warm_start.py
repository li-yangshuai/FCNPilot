"""Offline archive/import tests; synthetic data are never circuit evidence.

No model, router, mapper or device simulator is invoked. Validator mocks only
exercise import bookkeeping and rejection paths inside temporary directories.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine/scripts"))
import ifcn_gate_warm_start as warm


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def geometry(internal_x):
    nodes = [
        {"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False, "x": 0, "y": 0},
        {"id": 1, "name": "g", "type": "wire", "is_input": False, "is_output": False, "x": internal_x, "y": 0},
        {"id": 2, "name": "z", "type": "wire", "is_input": False, "is_output": True, "x": 4, "y": 0}]
    return {"schema": "ifcn.native_candidate.v1", "offline_test_fixture": True,
            "algorithm": "june_random", "routed": True, "clock_scheme": "irregular", "nodes": nodes,
            "edges": [[0, 1], [1, 2]], "layers": [[0], [1], [2]],
            "routes": [{"source": 0, "target": 1, "path": [[x, 0] for x in range(internal_x + 1)]},
                       {"source": 1, "target": 2, "path": [[x, 0] for x in range(internal_x, 5)]}],
            "cells": [{"x": x, "y": 0, "phase": x % 4 + 1} for x in range(5)]}


class WarmStartArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="offline-warm-start-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.study = self.root / "old_study"
        self.destination = self.root / "new_study/inputs/warm_start"
        self.case_id = "TOY/offline.v"
        self.folder = "c01_TOY_offline"
        self.policy_dir = self.study / self.folder / "deterministic_gate"
        self.selected_dir = self.policy_dir / "selected"
        self.selected_dir.mkdir(parents=True)
        self.base, self.selected = geometry(2), geometry(1)
        self.clock = {"passed": True, "arrival_tick_ranges": {"2": [4, 4]}}
        self.initial_metrics = warm._measure(self.base, {"cell_count": 20}, self.clock)
        self.selected_metrics = warm._measure(self.selected, {"cell_count": 18}, self.clock)
        dag = {"nodes": [{k: v for k, v in n.items() if k not in ("x", "y")} for n in self.selected["nodes"]],
               "edges": self.selected["edges"]}
        save(self.selected_dir / "layout_candidate.json", self.selected)
        save(self.selected_dir / "routed_dag.json", dag)
        (self.selected_dir / "source.v").write_text("// OFFLINE SYNTHETIC SOURCE; never compiled\n")
        (self.selected_dir / "normalized.v").write_text("// OFFLINE NORMALIZED SOURCE; never compiled\n")
        (self.selected_dir / "layout.ifcn").write_text("OFFLINE IFCN STUB\n")
        (self.selected_dir / "device_energy_input.qca").write_text("OFFLINE QCA STUB; not a physical circuit\n")
        hashes = {p.name: warm._sha(p) for p in self.selected_dir.iterdir()}
        self.clock.update(ifcn_sha256=hashes["layout.ifcn"], routed_dag_sha256=hashes["routed_dag.json"])
        save(self.selected_dir / "clock.json", self.clock)
        save(self.selected_dir / "physical.json", {"passed": True, "cell_count": 18,
             "ifcn_sha256": hashes["layout.ifcn"], "qca_sha256": hashes["device_energy_input.qca"]})
        save(self.selected_dir / "interface.json", {"passed": True, "qca_sha256": hashes["device_energy_input.qca"]})
        save(self.selected_dir / "logic.json", {"status": "equivalent", "source_sha256": hashes["source.v"],
             "routed_dag_sha256": hashes["routed_dag.json"]})
        self.prepared = {"baseline": self.base, "metrics": self.initial_metrics, "clock": self.clock,
                         "manifest": {"frontend": {"inputs": ["a"], "outputs": ["z"]},
                                      "artifacts": {name: {"sha256": hashes[name]}
                                                    for name in ("source.v", "normalized.v")}}}
        self.proposal = {"schema": "ifcn.layout_search.v2", "operations": [{"op": "move", "node": 1, "to": [1, 0]}],
                         "routing_order": [[0, 1], [1, 2]], "rationale": "Offline deterministic fixture only."}
        self.row = {"round": 1, "status": "certified", "decision": "improved_retained",
                    "start_state": warm.gate.state_key(self.base), "next_state": warm.gate.state_key(self.selected),
                    "proposal_origin": "deterministic_gate_geometry", "proposal": self.proposal,
                    "start_metrics": self.initial_metrics, "metrics": self.selected_metrics}
        save(self.policy_dir / "01/candidate/start.json", self.base)
        save(self.policy_dir / "01/candidate/proposal.json", self.proposal)
        self.record = {"initial": self.initial_metrics, "selected": self.selected_metrics, "selected_round": 1,
                       "selected_artifact_source": "deterministic_gate/01/candidate", "port_policy": "movable",
                       "round_budget": 1, "rounds_completed": 1, "budget_complete": True,
                       "model_request_attempts": 0, "backend_evaluation_attempts": 1,
                       "diagnostic_backend_evaluation_attempts": 0, "rounds": [self.row]}
        self.registration = {"case_id": self.case_id, "eligible": True, "folder": self.folder,
                             "initial": self.initial_metrics}
        self.protocol = {"schema": "ifcn.gate_direct_study.v1", "port_policy": "movable",
                         "arguments": {"port_policy": "movable", "rounds": 1},
                         "case_entries": [self.registration]}
        self.seal()

    def seal(self):
        self.record["selected_hashes"] = {p.name: warm._sha(p) for p in self.selected_dir.iterdir() if p.is_file()}
        save(self.policy_dir / "01/result.json", self.row)
        save(self.policy_dir / "summary.json", self.record)
        save(self.study / "protocol.json", self.protocol)
        save(self.study / "summary.json", {"cases": [{**self.registration, "status": "completed", "policies": {
            "deterministic_gate": {k: v for k, v in self.record.items() if k != "rounds"}}}]})
        save(self.study / "audit.json", {"original_artifacts_unchanged": True, "implementation_unchanged": True,
             "artifact_hashes": {p.relative_to(self.study).as_posix(): warm._sha(p)
                                 for p in self.study.rglob("*") if p.is_file() and p.name != "audit.json"}})

    def load(self, port_policy="movable"):
        return warm.load_seed(self.study, self.case_id, self.prepared, self.destination, port_policy)

    def fake_verify(self, directory, prepared, metrics, port_policy):
        return warm._read(directory / "layout_candidate.json"), copy.deepcopy(metrics), copy.deepcopy(self.clock)

    def test_exact_selected_import_history_and_original_files_are_preserved(self):
        before = {str(p): warm._sha(p) for p in self.study.rglob("*") if p.is_file()}
        with patch.object(warm, "_verify_selected", side_effect=self.fake_verify):
            result = self.load()
        self.assertEqual(result["baseline"], self.selected)
        self.assertEqual(result["metrics"], self.selected_metrics)
        self.assertEqual(result["seed_seen"], {warm._action_key(self.base, self.proposal)})
        self.assertEqual(result["seed_expanded"], {warm.gate.state_key(self.base)})
        self.assertEqual(result["seed_provenance"]["original_initial_metrics"], self.initial_metrics)
        self.assertEqual(result["seed_provenance"]["prefix_backend_evaluation_attempts"], 1)
        self.assertEqual(result["seed_artifacts"], self.destination)
        for name, digest in result["seed_provenance"]["selected_hashes"].items():
            self.assertEqual(warm._sha(self.destination / name), digest)
        self.assertEqual(before, {str(p): warm._sha(p) for p in self.study.rglob("*") if p.is_file()})
        result["seed_history"][0]["proposal"]["rationale"] = "mutated caller copy"
        self.assertEqual(warm._read(self.policy_dir / "01/result.json"), self.row)

    def test_audit_hash_detects_changed_protocol_and_selected_qca(self):
        for target in (self.study / "protocol.json", self.selected_dir / "device_energy_input.qca"):
            with self.subTest(file=target.name):
                content = target.read_bytes()
                target.write_bytes(content + b" ")
                with self.assertRaisesRegex(ValueError, "audit hash"):
                    self.load()
                self.assertFalse(self.destination.exists())
                target.write_bytes(content)

    def test_port_policy_and_original_source_must_match(self):
        with self.assertRaisesRegex(ValueError, "port policy"):
            self.load("fixed")
        (self.selected_dir / "source.v").write_text("// different source\n")
        self.seal()
        with self.assertRaisesRegex(ValueError, "original baseline source"):
            self.load()
        self.assertFalse(self.destination.exists())

    def test_no_llm_history_or_hidden_extra_prefix_budget(self):
        self.row["proposal_origin"] = "direct_llm_gate_action"
        self.seal()
        with self.assertRaisesRegex(ValueError, "model-derived"):
            self.load()
        self.row["proposal_origin"] = "deterministic_gate_geometry"
        self.protocol["arguments"]["rounds"] = 2
        self.seal()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.load()

    def test_native_history_state_and_call_counts_must_agree(self):
        self.row["start_state"] = "wrong"
        self.seal()
        with self.assertRaisesRegex(ValueError, "native call"):
            self.load()
        self.row["start_state"] = warm.gate.state_key(self.base)
        self.record["backend_evaluation_attempts"] = 2
        self.seal()
        with self.assertRaisesRegex(ValueError, "evaluation count"):
            self.load()

    def test_existing_destination_and_writes_inside_archive_are_rejected(self):
        self.destination.mkdir(parents=True)
        sentinel = self.destination / "sentinel"
        sentinel.write_text("preserve")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            self.load()
        self.assertEqual(sentinel.read_text(), "preserve")
        with self.assertRaisesRegex(ValueError, "outside"):
            warm.load_seed(self.study, self.case_id, self.prepared, self.study / "new_seed", "movable")

    def test_dag_identity_and_certificate_bindings_are_rechecked_even_if_resigned(self):
        dag_file = self.selected_dir / "routed_dag.json"
        dag = warm._read(dag_file)
        dag["nodes"][1]["name"] = "changed_gate_identity"
        save(dag_file, dag)
        self.seal()
        with self.assertRaisesRegex(ValueError, "identities"):
            self.load()

    def test_selected_verification_calls_both_logic_checks_and_detects_metrics_mismatch(self):
        def fake_export(candidate, path, algorithm):
            path.write_text("OFFLINE IFCN STUB\n")
        with (patch.object(warm, "validate_candidate", return_value={"passed": True}),
              patch.object(warm, "export_native_ifcn", side_effect=fake_export),
              patch.object(warm, "read_clock_layout", side_effect=lambda content: content),
              patch.object(warm.api, "logic_report", return_value={"status": "equivalent"}) as logic,
              patch.object(warm, "clock_arrival_report", return_value=self.clock),
              patch.object(warm.api, "qca_interface_report", return_value={"passed": True, "cell_count": 18}),
              patch.object(warm.api, "physical_route_report", return_value={"passed": True, "cell_count": 18})):
            result = self.load()
            self.assertEqual(logic.call_count, 2)
            self.assertEqual(result["metrics"], self.selected_metrics)
            another = self.root / "verified_again"
            import shutil
            shutil.copytree(self.selected_dir, another)
            with self.assertRaisesRegex(ValueError, "measured metrics"):
                warm._verify_selected(another, self.prepared, {**self.selected_metrics, "qca_cells": 17}, "movable")

    def test_physical_file_binding_is_checked_before_reusing_native_certificate(self):
        physical = warm._read(self.selected_dir / "physical.json")
        physical["qca_sha256"] = "wrong"
        save(self.selected_dir / "physical.json", physical)
        self.seal()
        with patch.object(warm, "validate_candidate", return_value={"passed": True}):
            with self.assertRaisesRegex(ValueError, "physical certificate file binding"):
                self.load()


if __name__ == "__main__":
    unittest.main()
