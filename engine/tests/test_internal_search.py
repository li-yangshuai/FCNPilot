"""Behavioral checks for fixed-port study provenance and ablation isolation."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/"engine/scripts"), str(ROOT/"experiments/llm_joint_search")]
import ifcn_internal_search as interior
import ifcn_joint_search as search
import run_internal_study as study


def circuit():
    nodes = [
        {"id":0,"name":"a","type":"input","is_input":True,"is_output":False,"x":0,"y":0},
        {"id":1,"name":"g","type":"wire","is_input":False,"is_output":False,"x":4,"y":3},
        {"id":2,"name":"z","type":"wire","is_input":False,"is_output":True,"x":0,"y":6},
    ]
    return {"algorithm":"june_random","nodes":nodes,"edges":[[0,1],[1,2]],
            "layers":[[0],[1],[2]],"cells":[],
            "routes":[{"source":0,"target":1,"path":[[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3]]},
                      {"source":1,"target":2,"path":[[4,3],[3,3],[2,3],[1,3],[0,3],[0,4],[0,5],[0,6]]}]}


class InternalSearchTests(unittest.TestCase):
    def test_context_excludes_ports_and_no_old_boundary_suggestions(self):
        candidate = circuit()
        metrics = {"area_tiles":35,"qca_cells":100}
        context = interior.context_for(candidate, metrics, {}, [], [])
        self.assertEqual(context["action_space"]["movable_node_ids"], [1])
        self.assertIs(context["rules"]["port_coordinates_movable"], False)
        self.assertNotIn("geometric_cut_suggestions", context["state_features"])
        self.assertEqual(context["state_features"]["fixed_port_envelope"]["area_lower_bound_tiles"], 7)
        self.assertEqual(context["action_space"]["selection_mode"], "direct_internal")

    def test_change_record_reports_internal_node_and_rejects_port_change(self):
        before = circuit()
        after = search.apply_positions(before, [{"op":"move","node":1,"to":[2,3]}])
        record = interior.change_record(before, after)
        self.assertTrue(record["all_port_coordinates_unchanged"])
        self.assertEqual([n["id"] for n in record["moved_internal_nodes"]], [1])
        after["nodes"][0]["x"] = 1
        with self.assertRaisesRegex(ValueError, "input/output"):
            interior.change_record(before, after)

    def test_internal_actions_do_not_alias_source_and_exclude_seen(self):
        before = circuit()
        original = copy.deepcopy(before)
        actions = interior.internal_actions(before)
        self.assertTrue(actions)
        for item in actions:
            search.validate_proposal({k:item[k] for k in
                                     ("schema","operations","routing_order","rationale")},
                                     before, lock_io=True)
        excluded = {item["id"] for item in actions}
        self.assertEqual(interior.internal_actions(before, excluded), [])
        actions[0]["operations"][0]["to"][0] = 999
        self.assertEqual(before, original)

    def test_failed_and_unchanged_cases_remain_in_mean(self):
        rows = []
        for improved in (True,False):
            data = {"initial":{"area_tiles":100,"qca_cells":100},
                    "selected":{"area_tiles":100,"qca_cells":80 if improved else 100},
                    "live_native_evaluations":1,"real_model_requests":1,
                    "outcomes":{"accepted" if improved else "failed":1}}
            rows.append({"eligible":True,"status":"completed",
                         "policies":{policy:copy.deepcopy(data) for policy in study.POLICIES}})
        result = study.aggregate(rows)
        self.assertEqual(result["policies"]["llm_internal"]["mean_qca_reduction_pct"], 10)
        rows.append({"eligible":True,"status":"execution_failed"})
        self.assertIsNone(study.aggregate(rows)["policies"]["llm_internal"]["mean_qca_reduction_pct"])

    def test_shadow_failure_cannot_discard_live_gain_or_enter_model_feedback(self):
        before = circuit()
        initial = {"area_tiles":35,"qca_cells":100}
        proposal = {"schema":"ifcn.layout_search.v2",
                    "operations":[{"op":"move","node":1,"to":[2,3]}],
                    "routing_order":[[0,1],[1,2]],"rationale":"Move internal wire toward its fixed neighbors."}
        bundle = {"baseline":before,"metrics":initial,"clock":{},
                  "manifest":{"frontend":{},"configuration":{}}}
        contexts = []
        def model_call(node, context, model, target, request_id):
            contexts.append(copy.deepcopy(context))
            (target/"request.json").write_text("{}")
            if len(contexts) == 2:
                raise RuntimeError("Recorded model failure; no retry")
            return {"model":{"provider":"test","modelId":"test"},"proposal":proposal,
                    "usage":{"totalTokens":7}}, 0
        def evaluate(current, action, target, inputs, prepared, timeout):
            if target.name == "routing_only":
                raise RuntimeError("Diagnostic-only failure")
            target.mkdir()
            after = search.apply_positions(current, action["operations"])
            after["routes"] = [{"source":0,"target":1,"path":[[0,0],[1,0],[2,0],[2,1],[2,2],[2,3]]},
                               {"source":1,"target":2,"path":[[2,3],[1,3],[0,3],[0,4],[0,5],[0,6]]}]
            (target/"layout_candidate.json").write_text(json.dumps(after))
            (target/"clock.json").write_text("{}")
            (target/"evaluation.log").write_text("unit-test executor")
            return {"status":"certified","proposal":action,
                    "metrics":{"area_tiles":35,"qca_cells":90}}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)/"case"
            folder.mkdir()
            with patch.object(study,"model_call",side_effect=model_call), \
                 patch.object(study,"evaluate",side_effect=evaluate):
                report = study.run_policy(folder,"llm_internal",bundle,"node",None,2,20)
            self.assertEqual(report["selected"]["qca_cells"],90)
            self.assertEqual(report["selected_round"],1)
            self.assertEqual(report["outcomes"],{"accepted":1,"failed":1})
            self.assertEqual(report["real_model_requests"],2)
            first = json.loads((folder/"llm_internal/01/result.json").read_text())
            self.assertEqual(first["usage"]["totalTokens"],7)
            self.assertNotIn("Diagnostic-only failure",json.dumps(contexts[1]))
            attribution = json.loads((folder/"llm_internal/01/attribution.json").read_text())
            self.assertIsNone(attribution["joint_strictly_dominates_routing_only"])


if __name__ == "__main__":
    unittest.main()

