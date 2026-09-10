import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ifcn_agent_clock_validation import validate_clock_arrivals, clock_arrival_report

def fixture(long_branch=False, separate_inputs=False):
    nodes = [(0,"a","input",(0,0)),(1,"w1","wire",(1,0)),(2,"w2","wire",(0,1)),(3,"y","and",(1,1))]
    routes = [(0,1,[(0,0),(1,0)]),(0,2,[(0,0),(0,1)]),(1,3,[(1,0),(1,1)]),
              (2,3,[(0,1),(0,2),(1,2),(2,2),(2,1),(1,1)] if long_branch else [(0,1),(1,1)])]
    phases={(0,0):0,(1,0):1,(0,1):1,(1,1):2,(0,2):2,(1,2):3,(2,2):0,(2,1):1}
    if separate_inputs:
        nodes = [(n,("b" if n==2 else name),("input" if n==2 else typ),pos) for n,name,typ,pos in nodes]
        routes = [r for r in routes if r[:2] != (0,2)]
    text="#nodes info\n"+"".join(f"{n}, {name}, {typ}, ({p[0]},{p[1]});\n" for n,name,typ,p in nodes)+"#nodes info\n#paths info\n"
    text+="".join(f"({s},{t}): "+",".join(f"({x},{y})" for x,y in path)+";\n" for s,t,path in routes)
    text+="#paths info\n#phase map\n"+" ".join(f"({x},{y}):{p};" for (x,y),p in phases.items())+"\n#phase map\n"
    dag={"nodes":[{"id":n,"name":name,"type":typ,"is_input":typ=="input","is_output":n==3} for n,name,typ,p in nodes],
         "edges":[[s,t] for s,t,_ in routes]}
    return text,dag

class ClockArrivalTests(unittest.TestCase):
    def test_balanced_reconvergence_passes(self):
        result=validate_clock_arrivals(*fixture())
        self.assertTrue(result["passed"])
        self.assertEqual(result["arrival_tick_ranges"]["3"],[2,2])

    def test_modulo_equal_but_one_cycle_late_is_rejected(self):
        result=validate_clock_arrivals(*fixture(long_branch=True))
        self.assertFalse(result["passed"])
        self.assertFalse(result["relative_schedule_consistent"])
        self.assertEqual(result["arrival_tick_ranges"]["3"],[2,6])
        self.assertIsNone(result["required_input_cycle_offsets"])

    def test_pi_launch_offsets_are_diagnostic_never_implicitly_applied(self):
        result=validate_clock_arrivals(*fixture(long_branch=True,separate_inputs=True))
        self.assertFalse(result["passed"])
        self.assertTrue(result["relative_schedule_consistent"])
        self.assertEqual(result["required_input_cycle_offsets"],{"a":1,"b":0})
        self.assertFalse(result["input_schedule_applied"])

    def test_each_output_can_have_a_distinct_latency(self):
        text,dag=fixture()
        dag["edges"]=[[0,1],[0,2]]
        dag["nodes"]=[n for n in dag["nodes"] if n["id"]!=3]
        text=text.replace("3, y, and, (1,1);\n","").replace("(1,3): (1,0),(1,1);\n","").replace("(2,3): (0,1),(1,1);\n","")
        text=text.replace("(0,1):1;","(0,1):0;")
        result=validate_clock_arrivals(text,dag)
        self.assertTrue(result["passed"])
        self.assertNotEqual(result["arrival_tick_ranges"]["1"], result["arrival_tick_ranges"]["2"])

    def test_missing_phase_gate_route_and_duplicate_entries_rejected(self):
        text,dag=fixture()
        bad_texts=[text.replace("(1,1):2;",""),
                   text.replace("(1,3): (1,0),(1,1);\n",""),
                   text.replace("(0,0):0;","(0,0):0; (0,0):0;"),
                   text.replace("1, w1, wire, (1,0);","1, different, wire, (1,0);"),
                   text.replace("(1,1):2;","(1,1):0;"),
                   text.replace("(0,1): (0,0),(1,0);","(0,1): (0,0),(2,0),(1,0);")]
        for bad in bad_texts:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_clock_arrivals(bad,dag)

    def test_failure_report_is_durable_and_bound_to_actual_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            text,dag=fixture(long_branch=True)
            (root/"layout.ifcn").write_text(text)
            (root/"dag.json").write_text(json.dumps(dag))
            with self.assertRaisesRegex(ValueError,"arrival alignment"):
                clock_arrival_report(root/"layout.ifcn",root/"dag.json",root/"clock.json")
            report=json.loads((root/"clock.json").read_text())
            self.assertFalse(report["passed"])
            self.assertEqual(len(report["ifcn_sha256"]),64)
            self.assertEqual(len(report["routed_dag_sha256"]),64)

if __name__=="__main__":
    unittest.main()
