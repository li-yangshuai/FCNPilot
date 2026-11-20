# iFCN back end for the FCNPilot paper

`ifcn-paper-backend.patch` adds the current implementation of the paper's multi-agent complete-layout search and local clock-conflict repair to public iFCN commit `60908578ef53e3539b073e422a907b484389cccd`. It also includes focused regression tests and the optional Pi model adapter. The patch contains source code only. It is not a claim that this source will reproduce the exact executable hashes or timings of earlier archived runs.

From a directory containing your FCNPilot checkout, prepare a separate iFCN checkout:

```sh
release_root="$PWD/FCNPilot"
git clone https://github.com/li-yangshuai/iFCN.git iFCN-paper
git -C iFCN-paper checkout --detach 60908578ef53e3539b073e422a907b484389cccd
(cd "$release_root/docs/paper-backend" && sha256sum -c SHA256SUMS)
git -C iFCN-paper apply --check "$release_root/docs/paper-backend/ifcn-paper-backend.patch"
git -C iFCN-paper apply "$release_root/docs/paper-backend/ifcn-paper-backend.patch"
cmake -S iFCN-paper -B iFCN-paper/build-paper -DCMAKE_BUILD_TYPE=Release \
  -DIFCN_BUILD_TOOLS=ON -DIFCN_BUILD_TESTS=OFF
cmake --build iFCN-paper/build-paper --target ifcn_combinational_pnr --parallel
```

The iFCN build uses a C++17 compiler, CMake, Boost, Graphviz, and Qt5. For SAT equivalence checks on larger circuits, install `z3-solver` for the Python interpreter used by FCNPilot or supply a Z3 root when invoking the action. The deterministic modes use zero model calls by default. Optional model calls use FCNPilot's configured Pi runtime.

Set the back-end paths before running either FCNPilot paper action:

```sh
export IFCN_MULTI_AGENT_ROOT="$PWD/iFCN-paper"
export IFCN_MULTI_AGENT_BINARY="$IFCN_MULTI_AGENT_ROOT/build-paper/ifcn_combinational_pnr"
export IFCN_MULTI_AGENT_PYTHON="$(command -v python3)"
```

To run the included regressions, configure with `-DIFCN_BUILD_TESTS=ON`, build `ifcn_combinational_pnr` and `multi_agent_layout_tests`, then run:

```sh
ctest --test-dir iFCN-paper/build-paper \
  -R 'multi_agent_|cooperation_|test_clock_repair|test_verify_sat' --output-on-failure
```

The SAT regression tests can also take `IFCN_TEST_Z3_ROOT` pointing to a packaged Z3 installation. The optional Node test uses mocked model responses.
