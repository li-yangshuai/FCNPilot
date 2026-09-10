"""Offline bookkeeping/fairness regressions; fixtures are not FCN evidence.

No provider, router, certifier, export or device simulator is invoked.
"""
import copy
import io
import json
import random
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "engine/scripts"), str(ROOT / "experiments/llm_joint_search")]
import run_density_ablation as study


def metrics(area=100, cells=100):
    return {"width": 10, "height": 10, "area_tiles": area, "qca_cells": cells, "edge_steps": 20}


def fixture():
    return {"offline_fixture": True, "algorithm": "june_random", "routed": True, "fixture_cells": 100,
            "nodes": [{"id": 0, "name": "a", "type": "input", "is_input": True, "is_output": False, "x": 0, "y": 0},
                      {"id": 1, "name": "g", "type": "wire", "is_input": False, "is_output": False, "x": 4, "y": 3},
                      {"id": 2, "name": "z", "type": "wire", "is_input": False, "is_output": True, "x": 0, "y": 8}],
            "edges": [[0, 1], [1, 2]], "routes": [], "cells": []}


def bundle():
    return {"baseline": fixture(), "metrics": metrics(), "clock": {"offline_fixture": True},
            "manifest": {"frontend": {}, "configuration": {}}, "source_artifacts": {}}


def menu():
    return [{"id": name, "features": {"placement_proxy": {"manhattan_edges": wire, "area_tiles": 100},
                                       "changed_nodes": 1}, "description": "offline fixture"}
            for name, wire in [("first", 50), ("global", 5), ("third", 30)]]


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="density-ablation-offline-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.starts, self.contexts, self.responses = [], [], []
        self.result_sequence = []
        self.fail_model = False
        self.native_log = True
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(study.spatial, "build_pool", side_effect=lambda *a, **k: ({}, menu())))
        self.stack.enter_context(patch.object(study.spatial, "context_for", side_effect=self.context))
        self.stack.enter_context(patch.object(study.spatial, "neighborhood", side_effect=self.neighborhood))
        self.evaluate = self.stack.enter_context(patch.object(study.search, "evaluate", side_effect=self.evaluator))
        self.model = self.stack.enter_context(patch.object(study.base, "model_call", side_effect=self.model_call))

    def context(self, candidate, metric, clock, history, density, items, number, batch, best):
        return {"state": copy.deepcopy(candidate), "metrics": copy.deepcopy(metric), "candidate_menu": items,
                "feedback": [{"round": row["round"], "status": row["status"]} for row in history]}

    def neighborhood(self, current, seed, pool, seen, limit):
        x = current["nodes"][1]["x"]
        return [{"id": f"{seed['id']}-{x}-{i}", "seed_id": seed["id"], "origin": "offline_neighbor",
                 "proposal": {"operations": [{"op": "move", "node": 1, "to": [x + i + 1, 3]}],
                              "routing_order": current["edges"], "rationale": "offline fixture"}}
                for i in range(limit)]

    def evaluator(self, current, proposal, target, *args, **kwargs):
        self.assertTrue(kwargs["lock_io"])
        self.starts.append(copy.deepcopy(current))
        target.mkdir()
        (target / "evaluation.log").write_text("OFFLINE BACKEND ATTEMPT")
        if self.native_log:
            (target / "native.log").write_text("OFFLINE NATIVE LAUNCH ATTEMPT")
        candidate = copy.deepcopy(current)
        candidate["nodes"][1]["x"] = proposal["operations"][0]["to"][0]
        if self.result_sequence:
            chosen = self.result_sequence.pop(0)
            if isinstance(chosen, dict):
                return chosen
            area, cells = chosen
        else:
            area, cells = 100, current["fixture_cells"] - (candidate["nodes"][1]["x"] - current["nodes"][1]["x"])
        candidate["fixture_cells"] = cells
        study.save(target / "layout_candidate.json", candidate)
        study.save(target / "clock.json", {"offline_fixture": True})
        return {"status": "certified", "metrics": metrics(area, cells),
                "certificates": {"logic": "equivalent", "clock": True, "physical": True, "interface": True}}

    def model_call(self, node, context, model, target, request_id):
        self.contexts.append(copy.deepcopy(context))
        study.save(target / "request.json", {"context": context, "offline_fixture": True})
        audit = {"status": "error" if self.fail_model else "ok", "model": {"modelId": "offline"},
                 "decision": {"candidate_id": context["candidate_menu"][0]["id"]},
                 "response": {"raw_text": json.dumps({"candidate_id": "first", "rationale": "actual model reason"})},
                 "usage": {"totalTokens": 44}, "error": {"code": "offline_provider_error"} if self.fail_model else None}
        study.save(target / "response.json", audit)
        if self.fail_model:
            raise ValueError("offline provider failure")
        return audit, 0.01

    def run_arm(self, policy="deterministic_density", **kwargs):
        folder = self.root / f"block-{len(self.responses)}"
        folder.mkdir()
        prepared = bundle()
        with redirect_stdout(io.StringIO()):
            report = study.run_policy(folder, policy, prepared, self.inputs, None, {},
                                      rounds=kwargs.pop("rounds", 2), timeout=20, batch_size=kwargs.pop("batch_size", 2),
                                      selection_seed=123, **kwargs)
        self.assertEqual(prepared, bundle(), "An arm must not mutate the paired baseline")
        self.responses.append(report)
        return report, folder / policy

    def test_feedback_ablation_changes_only_explicit_feedback_and_batch_start_is_frozen(self):
        first, f1 = self.run_arm("llm_text_feedback")
        feedback_contexts = self.contexts[:]
        second, f2 = self.run_arm("llm_text_no_feedback")
        no_feedback_contexts = self.contexts[2:]
        self.assertEqual(feedback_contexts[0], no_feedback_contexts[0])
        expected = copy.deepcopy(feedback_contexts[1]); expected["feedback"] = []
        self.assertEqual(expected, no_feedback_contexts[1])
        self.assertEqual([s["nodes"][1]["x"] for s in self.starts], [4, 4, 6, 6] * 2)
        self.assertEqual(first["selected"], second["selected"])
        self.assertEqual(first["initial_layout_fingerprint"], second["initial_layout_fingerprint"])
        saved = json.loads((f1 / "01/result.json").read_text())
        self.assertEqual(saved["selection"]["rationale"], "actual model reason")
        self.assertEqual(first["first_discovered_improvement"]["native_ordinal"], 1)
        self.assertEqual(first["first_retained_improvement"]["native_ordinal_at_batch_end"], 2)

    def test_model_failures_have_no_fallback_and_keep_every_allocated_slot(self):
        self.fail_model = True
        report, folder = self.run_arm("llm_text_feedback", batch_size=4)
        self.evaluate.assert_not_called()
        self.assertEqual(report["model_request_attempts"], 2)
        self.assertEqual(report["candidate_evaluation_attempts"], 0)
        self.assertEqual(report["selected"], metrics())
        self.assertEqual(report["unused_candidate_slots"], 8)
        points = json.loads((folder / "anytime.json").read_text())["points"]
        self.assertEqual([p["allocated_ordinal"] for p in points], list(range(1, 9)))
        self.assertTrue(all(p["native_ordinal"] is None and p["reason"] == "model_error_or_invalid_selection" for p in points))
        row = json.loads((folder / "02/result.json").read_text())
        self.assertEqual(row["model_audit"]["usage"], {"totalTokens": 44})
        self.assertEqual(report["status"], "completed")

    def test_batch_prefix_uses_original_lexicographic_selector_without_rebasing_calls(self):
        self.result_sequence = [(90, 80), (80, 90)]
        report, folder = self.run_arm(rounds=1)
        points = json.loads((folder / "anytime.json").read_text())["points"]
        self.assertEqual([p["best_retained_after_call"]["qca_cells"] for p in points], [80, 90])
        self.assertEqual(report["selected"], metrics(80, 90))
        self.assertEqual(self.starts[0], self.starts[1])

    def test_failed_certificate_cannot_be_retained(self):
        self.result_sequence = [{"status": "certified", "metrics": metrics(1, 1),
                                 "certificates": {"logic": "equivalent", "clock": False, "physical": True, "interface": True}},
                                {"status": "failed", "error": "offline route failure"}]
        report, folder = self.run_arm(rounds=1)
        self.assertEqual(report["selected"], metrics())
        self.assertIsNone(report["first_discovered_improvement"])
        self.assertEqual(report["candidate_evaluation_attempts"], 2)

    def test_candidate_budget_is_not_mistaken_for_native_execution(self):
        self.native_log = False
        self.result_sequence = [{"status": "failed", "error": "offline pre-native failure"}] * 2
        report, folder = self.run_arm(rounds=1)
        self.assertEqual(report["candidate_evaluation_attempts"], 2)
        self.assertEqual(report["native_launch_logs"], 0)
        self.assertEqual(report["unused_candidate_slots"], 0)
        points = json.loads((folder / "anytime.json").read_text())["points"]
        self.assertTrue(all(p["native_ordinal"] is None for p in points))

    def test_interrupt_keeps_readable_round_summary_and_starts_no_second_round(self):
        stop = threading.Event()
        snapshots = []
        def progress(row):
            snapshots.append(copy.deepcopy(row))
            if row["completed_rounds"] == 1:
                stop.set()
        report, folder = self.run_arm(on_progress=progress, stop_event=stop)
        self.assertEqual(report["status"], "interrupted")
        self.assertEqual(report["completed_rounds"], 1)
        self.assertEqual(report["candidate_evaluation_attempts"], 2)
        self.assertFalse((folder / "02").exists())
        self.assertEqual(json.loads((folder / "summary.json").read_text())["status"], "interrupted")
        self.assertEqual(snapshots[-1]["status"], "interrupted")


class ControlsAndAccountingTests(unittest.TestCase):
    def test_global_control_does_not_alias_first_seed_and_random_uses_full_menu(self):
        items = menu()
        self.assertEqual(study.control_seed("deterministic_density", items, random.Random(1))[0]["id"], "first")
        self.assertEqual(study.control_seed("deterministic_global_proxy", items, random.Random(1))[0]["id"], "global")
        rng = Mock(); rng.randrange.return_value = 2
        chosen, record = study.control_seed("random_density", items, rng)
        rng.randrange.assert_called_once_with(3)
        self.assertEqual((chosen["id"], record["menu_index"]), ("third", 2))
        self.assertEqual(study.derived_seed(7, "case", 1), study.derived_seed(7, "case", 1))
        self.assertNotEqual(study.derived_seed(7, "case", 1), study.derived_seed(7, "case", 2))

    def test_aggregate_keeps_zero_native_model_failures_and_unknown_finals_distinct(self):
        entries = [{"case_id": c, "requested": True, "eligible": ok, "status": "pending" if ok else "unavailable"}
                   for c, ok in [("a", True), ("b", True), ("u", False)]]
        def arm(cells):
            return {"status": "completed", "initial": metrics(), "selected": metrics(cells=cells),
                    "candidate_evaluation_attempts": 0, "native_launch_logs": 0, "model_request_attempts": 2}
        blocks = [{"case_id": "a", "policies": {"p": arm(90)}}, {"case_id": "b", "policies": {"p": arm(100)}}]
        summary = study.aggregate(entries, blocks, ["p"], 1, 2, 4)["policies"]["p"]
        self.assertEqual(summary["mean_qca_reduction_pct"], 5.0)
        self.assertEqual(summary["allocated_case_rep_blocks"], 2)
        self.assertEqual(summary["allocated_native_slots"], 16)
        self.assertEqual(summary["requested_registry_round_slots"], 6)
        blocks[1]["policies"]["p"] = {"status": "execution_failed", "selected": None}
        summary = study.aggregate(entries, blocks, ["p"], 1, 2, 4)["policies"]["p"]
        self.assertIsNone(summary["mean_qca_reduction_pct"])
        self.assertEqual(summary["missing_final_blocks"], 1)

    def test_entire_registry_is_preflighted_and_failures_survive_case_filter(self):
        with tempfile.TemporaryDirectory(prefix="density-registry-offline-") as temp:
            out = Path(temp)
            text = "OFFLINE SOURCE FIXTURE"
            digest = study.hashlib.sha256(text.encode()).hexdigest()
            cases = [{"id": f"TOY/c{i}.v", "group": "TOY", "source_sha256": digest, "normalized_sha256": digest} for i in range(30)]
            index = {"selection": {c["id"]: {"status": "selected" if i < 2 else "unavailable", "run_id": f"r{i}", "reasons": ["offline"]} for i, c in enumerate(cases)}}
            def prepare(origin, inputs):
                if origin.name == "r1":
                    raise ValueError("offline preflight failure")
                inputs.mkdir()
                for name in ("source.v", "normalized.v"):
                    (inputs / name).write_text(text)
                return bundle()
            with patch.object(study.base, "prepare_baseline", side_effect=prepare) as loader:
                entries, prepared, watched = study.prepare_cases(out, {"cases": cases}, index, {"TOY/c0.v"}, None)
            self.assertEqual(len(entries), 30)
            self.assertEqual(loader.call_count, 2)
            self.assertEqual(entries[1]["status"], "preflight_failed")
            self.assertFalse(entries[1]["requested"])
            self.assertEqual(sum(e["status"] == "unavailable" for e in entries), 28)
            self.assertEqual(list(prepared), ["TOY/c0.v"])

    def test_existing_output_and_mutated_prior_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="density-integrity-offline-") as temp:
            root = Path(temp)
            marker = root / "keep"; marker.write_text("preserve")
            with self.assertRaises(FileExistsError):
                study.create_output(root)
            self.assertEqual(marker.read_text(), "preserve")
            study.save(root / "audit.json", {"original_artifacts_unchanged": True, "implementation_unchanged": True,
                                             "artifact_hashes": {"keep": "0" * 64}})
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                study.checked_prior(root)

    def test_rationale_is_recovered_without_replacing_the_validated_candidate_id(self):
        result = study.model_decision({"decision": {"candidate_id": "validated"},
                                       "response": {"raw_text": '{"candidate_id":"raw","rationale":"recorded text"}'}})
        self.assertEqual(result, {"candidate_id": "validated", "rationale": "recorded text"})


if __name__ == "__main__":
    unittest.main()