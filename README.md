# FCNPilot

**FCNPilot: A Tool-Grounded Agentic Framework for End-to-End Field-Coupled Nanocomputing Circuit Design**

FCNPilot 将 Pi 对话工作台、iFCN 主智能体、可执行的电路设计引擎和论文实验材料放在一个可独立构建的仓库中。用户直接与 **iFCN 主智能体** 对话；主智能体调用确定性的设计与分析工具，依据返回的产物解释结果。

网页按电路输入、时钟策略与适用规模、设计提交组织工作流，提供电路设计对话、源文件编辑、运行结果下载，以及布局布线 SVG 和 QCA 器件版图预览。主智能体固定使用电路设计工具；通用插件/技能安装、子智能体委派、MCP 管理、终端和 Git 管理入口已移除。

支持流程：Verilog → 逻辑 DAG → 门级布局布线 → QCA 器件版图 → 物理模型仿真 → 能耗估计。组合设计分为三条路线：小规模规则时钟启发式（2DDWave/USE/RES，最多50个源门节点）、自由相位图绘制（Compact/June实现变体）、仅2DDWave的图压缩。`auto` 在指定时钟约束内回退。「规模与时钟」先选组合/时序，再按电路大小（小≤50、中51–500、大>500个逻辑DAG门节点）和时钟类型选择实现。分档不是容量保证，冻结样本证据单独标注，未验证的中大规模不会标为支持。时序使用独立的 `sequential_cyclic` 入口。

## 目录

| 路径 | 保留内容 |
| --- | --- |
| `apps/web/` | 浏览器工作台、Pi 会话运行时、主智能体绑定和相关测试 |
| `engine/` | 无界面的设计/分析引擎、必要 C++/Python 源码、构建配置与冻结测试电路 |
| `integrations/pi/` | 主智能体提示词、四个 Pi 工具、安装器、最小示例及 SDK 全流程验证 |
| `paper/` | IJCTA 论文、补充材料、可编辑图及其编译依赖 |
| `experiments/` | 论文引用的冻结记录和实验复现代码 |

旧工程的 Git 元数据、构建目录、虚拟环境、模型凭据、个人会话、重复论文模板，以及未接入当前流程的训练和桌面打包代码不作为新仓库源文件保留。安装产生的依赖、`.pi` 注册文件、输出和缓存均被 Git 忽略。

## 安装与启动

推荐 Ubuntu 24.04 / WSL2，Node.js ≥22.19、Python ≥3.11，以及 C++17 编译器。

```bash
sudo apt install build-essential cmake pkg-config graphviz libgraphviz-dev \
  libboost-dev python3-dev python3-venv yosys
./setup.sh
./start.sh
```

打开 <http://127.0.0.1:30211>。首次进入时通过页面现有的工程授权入口启用本仓库引擎，并在模型设置中选择可用的模型。模型配置使用 Pi 的账户配置，不将密钥保存进仓库。

`setup.sh` 在当前仓库内创建 Python 环境、安装锁定的网页依赖、从源码构建引擎并生成可迁移的 Pi 注册。`start.sh` 默认只监听本机，网页数据保存在 `.local/web/`；可通过 `PI_WEB_PORT` 更换端口。不要在运行开发服务器时执行 Next 生产构建。

## 验证

```bash
./verify.sh
```

验证安装迁移、原生/前端测试、时序 RTL→QCA 与状态边界回归、主智能体绑定及工具范围，并通过真实 Pi 工具执行 XOR 电路的布局、两种数值仿真和标准能耗分析。该检查不向 LLM 服务发送请求。生成的运行记录位于 `engine/output/`，没有混入论文的历史数据。

也可独立检查引擎：

```bash
engine/.venv/bin/python engine/scripts/ifcn_agent.py doctor --deep
```

论文题目与新仓库名称一致，作者与单位保留原稿设置。`experiments/` 中的历史记录是论文原始实验的依据；清理和重构后新生成的结果应单独记录，不能直接替换历史记录冒充原实验。

安装带相关字体包的 TeX Live 后，可用 `python3 paper/scripts/build.py` 编译正文和补充材料；加 `--figures` 可从归档数据重绘配图。LLM 对照实验脚本 `experiments/scripts/evaluate_agents.mjs` 默认只生成试验协议，显式加 `--run` 才会调用所配置的模型并产生费用。

## 适用范围

组合模式接入单模块、标量组合逻辑子集，TOY/MAJ 冻结电路用于复现已有评估。时序模式通过 Yosys、SeqIR、显式状态切分与反馈恢复生成闭环布局和 QCA；默认运行到 map。支持范围受单时钟正沿寄存器、可降低布尔逻辑及直接 Q 输出约束。状态切分只作中间表示，完整D/Q映射和跨迭代反馈必须恢复。

时序一拍检查比较 SeqIR 与实际状态切分 DAG，不能替代独立原 RTL 或存储器件波形验证。`layout_candidate` 表示布局/相位约束候选，`physical_state_signoff=not_characterized` 原样保留；显式请求的仿真和能耗仅作数值模型探索。

有界输入的源代码/DAG 穷举等价、QCA 端子数量检查、布局合法性、数值实现一致性是不同的验证层次。通过这些检查不等于任意 RTL 的形式化签核或器件波形验证。能耗和功率是所选物理模型与参数下的估计；异常与失败需原样报告。优化保留合法基线，在同一预算内比较固定2DDWave的初排候选和June缓冲拓扑候选；门级面积与实际QCA器件数均不增加、且至少一项减少，才替换结果。所有候选须通过规则、源逻辑和器件接口检查。`auto` 在指定时钟约束内回退，不是学习型选择或全局最优保证。

## 来源与许可

本仓库导入了以下工程的工作区版本，包含整合时尚未提交的 iFCN/Pi 修改：

- [iFCN](https://github.com/li-yangshuai/iFCN)：基于提交 `2f5e4899e820f30581d9fd9fcf2eabd8d4f0e2bc`；选择性合入 `origin/version1.2`（`6818423`）的仿真图复用与轨迹比较，保留时序主线修正和原 MIT 许可。
- Pi Web UI 本地 `ifcn` 分支：基于提交 `ed0e80fa739e0db75cee5ab4ad1355ea8ddce6bc`；保留 `apps/web/LICENSE` 中的 MIT 署名及依赖许可。

整合没有修改或删除原来的两个工程。第三方代码、图标、基准电路与出版社 LaTeX 文件保留各自的许可和来源信息。Pi SDK 及网页依赖按 `apps/web/package-lock.json` 安装，不复制进源代码仓库。
