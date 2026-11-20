# FCNPilot benchmark data

This directory contains the archived circuit layouts reported in Table 1 of *FCNPilot: LLM-Assisted Multi-Agent Physical Design of Quantum-Dot Cellular Automata*. It covers 20 circuits from five benchmark collections.

Files are organized as `DataBase/<benchmark collection>/<circuit>/<variant>.<format>`. The `.ifcn` files contain the gate-level layouts and clock assignments. The `.qca` files contain the corresponding cell-level mappings in QCADesigner format. Each pair comes from the archived run that produced the reported result.

| Variant | Table 1 column | Layout pairs |
| --- | --- | ---: |
| `ifcn-baseline` | Native iFCN | 18 |
| `no-reuse` | No reuse | 20 |
| `cooperative` | Cooperative | 20 |

The native iFCN run did not produce a validated layout for `IWLS93/b1` or `IWLS93/con1`. The [layout manifest](layout-manifest.json) records run status, layout metrics, and SHA-256 checksums. The paper's `TOY/clock-demo` appears here under its input name, `TOY/random_clock_cell_demo`.

For benchmark collection names and provenance, see Hofmann, Walter, and Wille, [MNT Bench](https://doi.org/10.23919/DATE58400.2024.10546596), and the [MNT Bench repository](https://github.com/cda-tum/mnt-bench).
