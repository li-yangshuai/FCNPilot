"""Audit actual combinational QCA exports, including fail-closed certificates."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("IFCN_BUILD_DIR", ROOT / "build"))


def layout(nodes, routes):
    occupied = {point for _, _, path in routes for point in path}
    return "\n".join([
        "#mapping mode: combinational", "#nodes info",
        *(f"{index}, n{index}, {kind}, ({x},{y});" for index, kind, (x, y) in nodes),
        "#nodes info", "#paths info",
        *(f"({source},{sink}): " + ",".join(f"({x},{y})" for x, y in path) + ";"
          for source, sink, path in routes),
        "#paths info", "#phase map",
        *(f"({x},{y}): 0;" for x, y in sorted(occupied)), "#phase map", "",
    ])


def qca_sites(text):
    """Read cell objects independently, retaining the physical layer identity."""
    result = {}
    names = {"Main Cell Layer": 0, "second layer": 1, "third layer": 2}
    for block in text.split("[TYPE:QCADLayer]")[1:]:
        name = re.search(r"^pszDescription=(.+)$", block, re.MULTILINE).group(1)
        if name not in names:
            continue
        for cell in block.split("[TYPE:QCADCell]")[1:]:
            cell = cell.split("[#TYPE:QCADCell]", 1)[0]
            x = (float(re.search(r"^x=(.+)$", cell, re.MULTILINE).group(1)) - 200) / 20
            y = (float(re.search(r"^y=(.+)$", cell, re.MULTILINE).group(1)) - 200) / 20
            site = (x, y, names[name])
            if site in result:
                raise AssertionError(f"duplicate exact QCA site {site}")
            result[site] = re.search(r"^cell_options.mode=(.+)$", cell, re.MULTILINE).group(1)
    return result


class PhysicalExportValidationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fcn-physical-export-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def export(self, text, contraction=False):
        source = self.directory / "layout.ifcn"
        source.write_text(text)
        command = [str(BUILD / "ifcn_energy_analysis"), str(source),
                   str(self.directory / "device"), "--qca-only"]
        if contraction:
            command.append("--io-contraction")
        result = subprocess.run(command, capture_output=True, text=True, timeout=8)
        certificate = json.loads((self.directory / "device_physical_validation.json").read_text())
        return result, certificate

    def assert_valid(self, text, *, contraction=False, nets, routes):
        result, certificate = self.export(text, contraction)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(certificate["schema"], "ifcn.qca.physical_routes.v1")
        self.assertTrue(certificate["passed"])
        self.assertEqual((certificate["net_count"], certificate["route_count"]), (nets, routes))
        self.assertEqual(certificate["io_contraction"], contraction)
        self.assertTrue({"ordered_route_continuity", "source_site_isolation",
                         "layer_transition_columns", "route_site_coverage",
                         "gate_connection_ports"}.issubset(certificate["checks"]))
        qca = (self.directory / "device_energy_input.qca").read_text()
        sites = qca_sites(qca)
        self.assertEqual(len(sites), qca.count("[TYPE:QCADCell]"))
        self.assertEqual(certificate["cell_count"], len(sites))
        self.assertEqual(certificate["emitted_cell_count"], len(sites))
        metrics = subprocess.run([str(BUILD / "ifcn_mapping_metrics"),
                                  str(self.directory / "layout.ifcn")]
                                 + ([] if contraction else ["--no-io-contraction"]),
                                 capture_output=True, text=True, timeout=8)
        self.assertEqual(metrics.returncode, 0, metrics.stdout + metrics.stderr)
        self.assertEqual(int(metrics.stdout.split()[0]), len(sites))
        return sites

    def test_crossing_preserves_both_complete_transition_columns(self):
        text = layout([(0, "input", (0, 1)), (10, "output", (2, 1)),
                       (1, "input", (1, 0)), (11, "output", (1, 2))],
                      [(0, 10, [(0, 1), (1, 1), (2, 1)]),
                       (1, 11, [(1, 0), (1, 1), (1, 2)])])
        for contraction in (False, True):
            with self.subTest(contraction=contraction):
                sites = self.assert_valid(text, contraction=contraction, nets=2, routes=2)
                pillars = [(x, y) for x, y, layer in sites if layer == 1]
                self.assertEqual(len(pillars), 2)
                for x, y in pillars:
                    for layer in range(3):
                        self.assertEqual(sites[(x, y, layer)], "QCAD_CELL_MODE_VERTICAL")
                self.assertTrue(any(layer == 2 and mode == "QCAD_CELL_MODE_CROSSOVER"
                                    for (_, _, layer), mode in sites.items()))

    def test_legal_bends_and_terminal_trimming_remain_supported(self):
        text = layout([(0, "input", (0, 0)), (10, "output", (2, 1))],
                      [(0, 10, [(0, 0), (1, 0), (1, 1), (2, 1)])])
        for contraction in (False, True):
            with self.subTest(contraction=contraction):
                sites = self.assert_valid(text, contraction=contraction, nets=1, routes=1)
                self.assertTrue(all(layer == 0 for _, _, layer in sites))

    def test_disconnected_legacy_offset_candidate_cannot_reuse_old_certificate(self):
        legal = layout([(0, "input", (0, 0)), (10, "output", (2, 0))],
                       [(0, 10, [(0, 0), (1, 0), (2, 0)])])
        self.assert_valid(legal, nets=1, routes=1)
        # Reduced from an old accepted Normal par_gen layout. Local crossover
        # shape validation passed while its directed fine-cell boundary did not.
        broken = layout([(0, "input", (0, 1)), (10, "output", (3, 1)),
                         (1, "input", (1, 0)), (11, "output", (2, 2))],
                        [(0, 10, [(0, 1), (1, 1), (2, 1), (3, 1)]),
                         (1, 11, [(1, 0), (1, 1), (2, 1), (2, 2)])])
        result, certificate = self.export(broken)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing a directed tile boundary", result.stderr)
        self.assertFalse(certificate["passed"])
        self.assertNotIn("checks", certificate)

    def test_missing_or_forged_node_boundaries_are_rejected(self):
        examples = [
            ([(0, "input", (0, 0)), (10, "output", (2, 0))],
             [(0, 10, [(0, 1), (1, 1), (2, 1)])], "endpoints disagree"),
            ([(0, "input", (0, 0)), (10, "output", (2, 0))],
             [(0, 99, [(0, 0), (1, 0), (2, 0)])], "missing source/sink"),
            ([(0, "input", (0, 0)), (10, "output", (2, 0)), (1, "input", (0, 0))],
             [(0, 10, [(0, 0), (1, 0), (2, 0)])], "multiple nodes occupy"),
            ([(0, "input", (0, 0)), (10, "output", (2, 0)), (1, "input", (1, 0))],
             [(0, 10, [(0, 0), (1, 0), (2, 0)])], "another node tile"),
            ([(0, "input", (0, 0)), (10, "output", (2, 0))],
             [(0, 10, [(0, 0), (2, 0)])], "non-adjacent"),
        ]
        for nodes, routes, diagnostic in examples:
            with self.subTest(diagnostic=diagnostic):
                result, certificate = self.export(layout(nodes, routes))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
                self.assertFalse(certificate["passed"])
                self.assertFalse((self.directory / "device_energy_input.qca").exists())


if __name__ == "__main__":
    unittest.main()
