"""Audited method/clock taxonomy; catalog membership does not enable execution."""

from copy import deepcopy

# Frozen production runs: source-hash deduplicated; routed-logic exhaustive
# equivalence and source-declared device terminal counts passed. These are
# individual layout samples, not a proof for every circuit in a size tier.
_FROZEN_SCALE_EVIDENCE = {
    "normal_2ddwave": {
        "small": {"status": "validated_samples", "benchmark_count": 1, "max_gate_nodes": 4,
                  "note": "冻结生产记录中 1 个去重源电路通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。"},
        "evidence_source_paths": ["experiments/archive/production/release-logic-io-20260905T110234Z/runs/79ef5fc7abc2435186a1736049c4a9d3/manifest.json"],
    },
    "compact": {
        "small": {"status": "validated_samples", "benchmark_count": 1, "max_gate_nodes": 4,
                  "note": "冻结生产记录中 1 个去重源电路通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。"},
        "evidence_source_paths": ["experiments/archive/production/release-logic-io-20260905T110234Z/runs/65b101e592324dfaa2de9da69897237e/manifest.json"],
    },
    "june_random": {
        "small": {"status": "validated_samples", "benchmark_count": 2, "max_gate_nodes": 26,
                  "note": "冻结生产记录中 2 个去重源电路（4—26 个 DAG 门节点）通过布线逻辑等价与器件端口计数检查；不代表完整波形签核。"},
        "evidence_source_paths": [
            "experiments/archive/production/release-logic-io-20260905T110907Z/runs/9001812103cf4e109fbbff9d60a3aee8/manifest.json",
            "experiments/archive/production/release-logic-io-20260905T110234Z/runs/818614b19bad478db825b3b375deb8f1/manifest.json",
        ],
    },
}


def algorithm_catalog(algorithms, sequential_available=False, scale_evidence=None):
    """Availability means an independent entry in the current main-agent flow.

    Source paths are relative to source_repository, not necessarily FCNPilot.
    Components can support an integrated backend without being a selectable
    backend themselves. Original iFCN research code is deliberately not probed,
    imported, or promoted to a runnable backend by this descriptive catalog.
    """
    ready = {item["id"]: bool(item["available"]) for item in algorithms}
    ready["sequential_cyclic"] = bool(sequential_available)
    if scale_evidence is None:
        scale_evidence = _FROZEN_SCALE_EVIDENCE
    entries = [
        {
            "id": "normal_2ddwave", "name": "Normal 2DDWave",
            "method": "graph_compaction", "method_label": "固定时钟图压缩",
            "design_route":"fixed_clock_graph_compaction",
            "clock_family": "rule_based", "clock_label": "仅规则四相 2DDWave",
            "description": "Graphviz 分层与 sifting 排序、右下单调寻路、失败驱动扩展和合法性约束压缩；相位由坐标模板确定。",
            "entry_kind": "backend", "run_algorithm": "normal_2ddwave",
            "source_repository": "FCNPilot",
            "source_paths": ["engine/python/placement/main/normal_layout.py", "engine/python/placement/src/normalGraphDraw.py"],
        },
        {
            "id": "compact", "name": "Compact Graph",
            "method": "graph_drawing", "method_label": "图绘制 / 布线后时钟分配",
            "design_route":"post_layout_graph_drawing",
            "clock_family": "irregular", "clock_label": "非规则四相 / 布线后分配",
            "description": "紧凑分层初始布局、四方向 A*、容量压力驱动扩展和压缩，再按路径约束分配相位；未使用预采样随机时钟场。",
            "entry_kind": "backend", "run_algorithm": "compact",
            "source_repository": "FCNPilot",
            "source_paths": ["engine/src/app/ifcn_combinational_pnr.cpp", "engine/include/autopr/graph/circuitGraph.cpp"],
        },
        {
            "id": "june_random", "name": "June Graph (random-clock)",
            "method": "graph_drawing", "method_label": "图绘制 / 布线后时钟分配",
            "design_route":"post_layout_graph_drawing",
            "clock_family": "irregular", "clock_label": "非规则四相 / 布线后分配",
            "description": "Graphviz 坐标量化、四方向 A* 与有界布线顺序重试，再分配和验证相位；历史名称中的 random-clock 指自由相位，不能等同于随机时钟场采样。",
            "entry_kind": "backend", "run_algorithm": "june_random",
            "source_repository": "FCNPilot",
            "source_paths": ["engine/src/app/ifcn_combinational_pnr.cpp", "engine/include/autopr/graph/circuitGraph.cpp"],
        },
        {
            "id": "sequential_cyclic", "name": "Cyclic sequential P&R",
            "method": "constraint_search", "method_label": "启发式布线 / 全局时钟约束",
            "clock_family": "irregular", "clock_label": "反馈路径四相 / epoch 与启动间隔",
            "description": "将显式状态边界接回物理反馈路径，搜索可行启动间隔并验证全局相位约束；输出候选布局与状态映射证据，不能等同于状态器件或时序波形签核。",
            "entry_kind": "backend", "run_algorithm": "sequential_cyclic",
            "source_repository": "FCNPilot",
            "source_paths": ["engine/src/app/ifcn_sequential_cyclic_pnr.cpp", "engine/include/autopr/sequential/globalPhaseSolver.cpp"],
        },
        {
            "id": "regular_clock_ga", "name": "规则时钟启发式布局布线",
            "method": "genetic", "method_label": "小规模规则时钟启发式",
            "design_route":"regular_clock_heuristic",
            "clock_family": "rule_based", "clock_label": "规则 2DDWave / USE / RES",
            "clock_schemes":["2DDWave","USE","RES"], "max_source_gate_nodes":50,
            "description": "在所选规则模板下做有种子的有限种群布局搜索。先检查完整连线、端口、交叉、器件映射、逐步相位与重汇合同步，再比较面积和器件数；初版最多50个源门节点，仅小型电路有回归证据。不支持未实现的任意模板。",
            "entry_kind": "backend", "run_algorithm":"regular_clock_ga", "source_repository": "FCNPilot",
            "source_paths": ["engine/src/app/ifcn_regular_clock_pnr.cpp", "engine/include/autopr/algorithms/genetic.cpp", "engine/include/autopr/algorithms/individual.cpp"],
        },
        {
            "id": "gcn_ppo", "name": "Legacy online GCN/PPO",
            "method": "reinforcement_learning", "method_label": "强化学习 / 策略搜索",
            "clock_family": "irregular", "clock_label": "动态非规则相位",
            "description": "原 iFCN 的在线布局训练与压缩策略，使用 GCN 初始表示、PPO 更新和 MapPhaseAStar 评估；默认动态相位与固定采样场是不同配置。训练代码和 GUI runner 保留在原仓库，尚未接入主智能体。",
            "entry_kind": "research_method", "source_repository": "iFCN",
            "source_paths": ["include/gcn_rl_layout/src/algorithm/main/train_layout_ppo.py", "include/gcn_rl_layout/src/algorithm/main/test_randomPhase.py", "include/gcn_rl_layout/scripts/gui_gcn_rl_runner.py"],
        },
        {
            "id": "memory_policy", "name": "Universal memory policy",
            "method": "reinforcement_learning", "method_label": "强化学习 / 策略搜索",
            "clock_family": "configurable", "clock_label": "采样因果时钟场 / axis / diagonal",
            "description": "原 iFCN 的循环图策略结合检索记忆，在固定采样场上生成候选并做真实布线评估；支持 stochastic-bands、axis、diagonal 和三/四相。需要原工程依赖、checkpoint 与适配，当前未接入。",
            "entry_kind": "research_method", "source_repository": "iFCN",
            "source_paths": ["include/gcn_rl_layout/scripts/gui_universal_agent_runner.py", "include/gcn_rl_layout/src/algorithm/src/universal_graph_policy.py", "include/gcn_rl_layout/src/algorithm/src/stochastic_clock.py"],
        },
        {
            "id": "global_clock_smt", "name": "Z3 global phase/epoch solver",
            "method": "smt", "method_label": "SMT 约束求解",
            "clock_family": "irregular", "clock_label": "固定布线几何上的相位 / epoch 约束",
            "description": "原 iFCN 的 Z3 脚本对已布线几何求解全局时钟问题，再由 C++ 验证。外部 Z3 包装脚本尚未接入主智能体；当前时序入口使用原生有界相位求解。该组件不独立完成布局布线。",
            "entry_kind": "component", "source_repository": "iFCN",
            "source_paths": ["scripts/solve_global_clock_z3.py", "include/autopr/sequential/globalPhaseSolver.cpp", "src/app/ifcn_paper_cyclic_pnr.cpp"],
        },
        {
            "id": "phase_aware_graph", "name": "Phase-aware graph routing",
            "method": "heuristic", "method_label": "启发式布局布线",
            "clock_family": "irregular", "clock_label": "寻路时相位约束",
            "description": "CircuitGraph 中保留的相位感知路由及压缩变体，使用多种边排序和有界相位候选搜索；库代码已保留，但没有独立主智能体运行选项。",
            "entry_kind": "research_method", "source_repository": "FCNPilot",
            "source_paths": ["engine/include/autopr/graph/circuitGraph.cpp", "engine/include/autopr/algorithms/astarwithphase.cpp"],
        },
        {
            "id": "astar_components", "name": "A* routing components",
            "method": "path_search", "method_label": "路径搜索组件",
            "clock_family": "configurable", "clock_label": "规则或动态相位 / 依调用者约束",
            "description": "通用 A*、PhaseAwareAstar、MapPhaseAStar 和右下单调路由组件。现有后端会使用其中部分；RightDownAStar 也包含直连与动态规划快路径。这些组件不是额外端到端算法。",
            "entry_kind": "component", "source_repository": "FCNPilot",
            "source_paths": ["engine/include/autopr/algorithms/astar.cpp", "engine/include/autopr/algorithms/astarwithphase.cpp", "engine/bindings/chessboard/MapPhaseAStar.cpp", "engine/bindings/chessboard/RightDownAStar.cpp"],
        },
        {
            "id": "negotiated_2ddwave", "name": "Monotone negotiated router",
            "method": "negotiated_routing", "method_label": "拥塞协商路由组件",
            "clock_family": "rule_based", "clock_label": "固定 2DDWave",
            "description": "原 iFCN 中基于有界单调 L/Z 候选与历史拥塞代价的全局协商路由器。version1.1 曾将其接入 NormalGraphDraw，后续主线仅保留库；不是网格 A* 或独立布局算法，未复制到 FCNPilot。",
            "entry_kind": "component", "source_repository": "iFCN",
            "source_paths": ["include/gcn_rl_layout/src/algorithm/src/negotiated_router.py"],
        },
        {
            "id": "ogdf_layer_ordering", "name": "OGDF fixed-layer ordering",
            "method": "crossing_minimization", "method_label": "层内交叉优化组件",
            "clock_family": "not_applicable", "clock_label": "拓扑排序 / 不直接分配时钟",
            "description": "version1.1 的 Python 入口调用 OGDF 固定层交叉优化工具；后续主线改为 Graphviz 与 sifting，OGDF 工具源码仍保留在原仓库。只调整层内顺序，不是完整布局布线后端。",
            "entry_kind": "component", "source_repository": "iFCN",
            "source_paths": ["include/gcn_rl_layout/ogdf/ogdf_layer_order.cpp", "include/gcn_rl_layout/ogdf/CMakeLists.txt"],
        },
        {
            "id": "compiled_qca_simulation", "name": "Compiled QCA simulation components",
            "method": "numerical_simulation", "method_label": "器件仿真 / 物理相互作用图",
            "clock_family": "configurable", "clock_label": "沿用输入 QCA 版图的四相时钟",
            "description": "从 version1.2 选择性合入的有序物理相互作用图、介电参数扫描复用、缓存与积分开关，以及完整内部轨迹比较。已用于物理仿真程序，不是新的布局布线选项；适用规模需按器件数、耦合数和采样长度另行评估。",
            "entry_kind": "component", "source_repository": "FCNPilot",
            "source_paths": ["engine/include/simon/OrderedInteractionGraph.hpp", "engine/include/simon/SimulationTrace.hpp", "engine/src/app/ifcn_physical_benchmark.cpp"],
        },
        {
            "id": "clock_strategy_components", "name": "Clock strategy components",
            "method": "clock_construction", "method_label": "时钟模板 / 场生成组件",
            "clock_family": "configurable", "clock_label": "TDD / USE / RES / 原始随机场",
            "description": "保留规则模板与 RandomClock 随机 4×4 块编码器。随机生成本身不保证可布线或因果合法；这些库策略不是可直接切换的完整设计流程。BANCS/CFE 仅有枚举，SplicingClock 仅为硬编码示例。",
            "entry_kind": "component", "source_repository": "FCNPilot",
            "source_paths": ["engine/include/autopr/grid/patterns.h", "engine/include/autopr/grid/patterns.cpp", "engine/bindings/chessboard/CZMFunction.hpp"],
        },
    ]
    for entry in entries:
        run_algorithm = entry.get("run_algorithm")
        entry["integration"] = "integrated" if run_algorithm else "not_integrated"
        entry["available"] = ready.get(run_algorithm, False) if run_algorithm else False
        entry["design_modes"] = (["sequential"] if entry["id"] in ("sequential_cyclic", "global_clock_smt")
                                 else ["combinational"])
        entry["origin_repository"] = "iFCN"
        entry["origin_branch"] = "feat/sequential-circuit-automation"
        entry["origin_commit"] = "2f5e4899e820f30581d9fd9fcf2eabd8d4f0e2bc"
        if entry["id"] in ("negotiated_2ddwave", "ogdf_layer_ordering"):
            entry["origin_branch"] = "version1.1"
            entry["origin_commit"] = "700cf95179ef91bf08bb069bb4998e152151e237"
        if entry["id"] == "compiled_qca_simulation":
            entry["origin_branch"] = "origin/version1.2"
            entry["origin_commit"] = "681842390925410a852a153b43dc8aea9e28c45d"
            entry["design_modes"] = ["combinational", "sequential"]
        component = entry["entry_kind"] == "component"
        entry["scale_coverage"] = {
            size: {"status": "out_of_scope" if component else "unassessed",
                   "note": "基础组件没有独立的门数覆盖范围。" if component else "尚无当前入口在该门数分档下的已验证样本。"}
            for size in ("small", "medium", "large")
        }
        if entry["entry_kind"] == "backend":
            entry["scale_coverage"]["small"] = {
                "status": "candidate", "note": "可作为该分档的候选实现；可调用不代表整个分档均能成功。"}
        evidence = (scale_evidence or {}).get(entry["id"], {})
        for size in ("small", "medium", "large"):
            if size in evidence:
                entry["scale_coverage"][size] = deepcopy(evidence[size])
        if evidence.get("evidence_source_paths"):
            entry["evidence_source_paths"] = list(evidence["evidence_source_paths"])
        if entry["id"] == "regular_clock_ga":
            for size in ("medium", "large"):
                entry["scale_coverage"][size] = {"status":"out_of_scope","note":"当前规则时钟启发式入口最多50个源门节点。"}
            entry["scale_coverage"]["small"]["note"] = "三种模板的AND、NOT、AND-OR小电路回归通过；不代表整个小规模档位都能布通，也不代替器件波形验证。"
        if entry["id"] == "sequential_cyclic" and not evidence:
            entry["scale_coverage"]["small"]["note"] = "同步复位 toggle、enable-hold 与 Johnson4 的 RTL→QCA 集成回归已通过，包含单状态及四状态反馈；尚未冻结规模覆盖产物，当前输出仍是未表征状态器件的布局候选。"
            entry["evidence_kind"] = "reproducible_integration_tests"
            entry["evidence_source_paths"] = [
                "engine/tests/test_ifcn_sequential_flow.py",
                "engine/tests/fixtures/sequential/rtl/toggle_ff.v",
                "engine/tests/fixtures/sequential/rtl/enable_hold_ff.v",
                "engine/tests/fixtures/sequential/rtl/johnson4_free_running.v",
            ]
        if entry["id"] == "normal_2ddwave":
            entry["scale_coverage"]["large"].setdefault("note", "尚无当前入口的大规模成功证据。")
            entry["historical_scale_note"] = "原分支的较大网表实验为 5 次布线失败、1 次超时、1 次进程错误；历史节点口径不等同于当前 DAG 门数，不能据此宣称大规模支持。"
            entry["historical_evidence_source"] = "iFCN@2f5e489:tests/benchmarks_f/original_large_2ddwave_results/layout_results.csv"
    return entries
