# Complete-layout search and clock repair

FCNPilot runs the two design modes from the paper as separate jobs. Both modes use the iFCN research backend and default to rule-based selection. The backend checks clocks and routing, and FCNPilot records the validated gate-level layout and its logic check. The [Table 1 benchmark data](https://github.com/li-yangshuai/FCNPilot/tree/paper-data/DataBase) contain the archived gate and cell layouts.

## Set up the backend

Build the iFCN research backend using the [backend source and build notes](paper-backend/). Configure FCNPilot with the absolute paths to that source tree and its executable:

```sh
export IFCN_MULTI_AGENT_ROOT=/path/to/ifcn-research
export IFCN_MULTI_AGENT_BINARY="$IFCN_MULTI_AGENT_ROOT/build-paper/ifcn_combinational_pnr"
python3 engine/scripts/ifcn_agent.py doctor
```

If the research backend needs a different Python interpreter, set `IFCN_MULTI_AGENT_PYTHON` to its path. Check `multi_agent_research.available` in the `doctor` output before starting a job.

## Run the design modes

Complete-layout search starts from a Verilog file. It can reuse candidate layouts during placement and routing:

```sh
python3 engine/scripts/ifcn_agent.py multi_agent /path/to/circuit.v \
  --budget 60 --max-model-calls 0
```

Local repair starts from the source Verilog and a native candidate JSON containing a complete routed layout with a clock conflict. A legal reference JSON can set output timing limits:

```sh
python3 engine/scripts/ifcn_agent.py clock_repair /path/to/circuit.v \
  --snapshot /path/to/failed-candidate.json \
  --reference /path/to/legal-reference.json \
  --condition clock_window --budget 20 --max-model-calls 0
```

These commands submit a job and return a run ID. Use the `status` command to inspect the run and find the output files. From Pi, the corresponding `ifcn_run` actions are `multi_agent` and `clock_repair`, and `ifcn_status` reports progress.

The repository provides the current source implementation. The timings and layouts reported in the paper come from the archived runs.
