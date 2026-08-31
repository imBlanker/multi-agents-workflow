[English](./README.md) | [简体中文](./README.zh-Hans.md) | [繁體中文](./README.zh-Hant.md)

[![CI](https://github.com/imBlanker/multi-agents-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/imBlanker/multi-agents-workflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-green.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-296%20passing-success.svg)](#testing)
[![GitHub stars](https://img.shields.io/github/stars/imBlanker/multi-agents-workflow?style=social&label=Stars)](https://github.com/imBlanker/multi-agents-workflow/stargazers)

# MAW — 面向复杂代码库的多智能体工作流系统

[变更日志](./CHANGELOG.zh-Hans.md)（[English](./CHANGELOG.md)·[繁](./CHANGELOG.zh-Hant.md)）

> 一个可移植的、**动态的**多智能体工作流系统。面对一个新的复杂项目，MAW 会读取你的 [cc-switch](https://github.com/farion1231/cc-switch) 配置，探测代码库，并选择合适的智能体架构——*循环*、*编排者-工人*（子智能体）、*多智能体*、*图工作流*、*动态工作流*或 *ultracode*——或它们的组合。它会为每个智能体生成可独立编辑的配置，强制执行基于真实花费的成本速率限制，并通过 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 集成 **Codex 审查**。

> **支持的宿主：Claude Code、Codex、Pi Agent 与 DeepSeek Harness (dsh)。** 其他智能体软件（Gemini CLI、opencode 等）有意地**不予支持**。注意：dsh **不**通过 cc-switch 管理——其供应商/模型位于 `~/.dsh/settings.yaml`，价格按 id 交叉引用 cc-switch 自动同步的 `~/.cc-switch/model-pricing.json`。自 **cc-switch v3.20（数据库 schema v17）起 pi 可能由 cc-switch 管理**：当 cc-switch 数据库中出现 pi 供应商行时，供应商/定价来自 cc-switch 数据库（精确），`~/.pi/agent/models.json` 镜像 cc-switch 写入的内容；无 pi 行时，pi 供应商仍来自 `models.json`（同旧有行为）。仅当 cc-switch 的 Pi (Session) 导入有数据时 pi 花费可测（缓存写计账可能不完整）；dsh 花费速率不可测（不经代理），速率限额降级为仅并发。

---

## 🍴 先 fork

**强烈建议：在使用本仓库之前先 fork 它。** 在*你的* fork 中进行任何个人改动，使其与本上游保持同步，并将改进与见解回馈到这里。

- **Fork：** <https://github.com/imBlanker/multi-agents-workflow/fork>
- **分支命名（约定式提交）：** `feat/<topic>`、`fix/<issue>`、`docs/<topic>`、`chore/<topic>`、`refactor/<topic>`、`ci/<topic>`、`test/<topic>`。
- **禁止直接推送到 `main`** —— 从你的功能分支发起一个 Pull Request。
- **每个 PR 只解决一个关注点**，小而聚焦；用 `Closes #N` 关联 issue；审查前 CI 必须通过。
- **Issue：** 先搜索[已有 issue](https://github.com/imBlanker/multi-agents-workflow/issues?q=is%3Aissue) 以避免重复，再使用 [bug](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=bug_report.md) / [feature](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=feature_request.md) 模板。

完整规则见 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 与 [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)。参见 [§贡献者](#15-贡献者) 与 [§联系方式](#16-联系方式)。

---

## 人类指南

> **提示：你可以把整份 README 交给你的智能体，让它为你安装并配置 MAW——参见下方的 [Agent 指南](#agent-指南)。**

MAW 是一个 CLI（`mawf`）外加一个 Claude Code 插件。最快的路径：

```bash
# 1. Fork the repo (see 🍴 Fork first), then clone YOUR fork:
git clone https://github.com/<you>/multi-agents-workflow.git
cd multi-agents-workflow

# 2. Install the plugin + skills into Claude Code (and Codex, best-effort):
npx . install          # or: node bin/mawf.js install

# 3. Initialize a project (cc-switch 项目 profile 同步默认脱钩):
mawf init -u <your-name>

# 4. The next step is automatic: MAW runs `trellis init -u <your-name>` for you.
#    (skip the trellis chain with --no-trellis)

# 5. Plan + run:
mawf plan --project .
mawf run
```

如果 cc-switch 中的 Claude Code 路由 / 自动故障转移处于关闭状态，用一条命令修复它（**仅**写入 claude/codex 的 `proxy_config` 行——绝不触碰你的 profiles/providers）：

```bash
mawf routing --fix
```

随时检查环境：`mawf doctor`。

## Agent 指南

> **把本节交给你的智能体（Claude Code、Codex、Cursor 等）。它会正确地为用户安装、配置并使用 MAW。**

获取完整的智能体安装/配置指南，并从头到尾照做——不要概括它：

```bash
curl -fsSL https://raw.githubusercontent.com/imBlanker/multi-agents-workflow/main/docs/AGENT_INSTALL.md
```

该指南涵盖：fork 与 clone、`npx . install`、`mawf init -u <user>`（创建 cc-switch 项目 profile + 检查路由策略 + 串联 `trellis init`）、`mawf plan`、`mawf run`、`mawf cost`、`mawf guard`、`mawf review`、[人类指南](#人类指南)中的工作流、[cc-switch 策略](#7-cc-switch-集成与路由策略)、[trellis init 规则](#8-trellis-init-作为强制性的下一步)、优雅降级与卸载。请完整阅读；不要猜测。

最简智能体提示词：*"Install and configure MAW by following `docs/AGENT_INSTALL.md` in https://github.com/imBlanker/multi-agents-workflow , then run `mawf plan` on this project and report the chosen architecture, agents, and cost limits."*

---

## 目录
1. [项目目标](#1-项目目标)
2. [何时使用](#2-何时使用)
3. [系统架构](#3-系统架构)
4. [支持的智能体软件](#4-支持的智能体软件)
5. [工作流选择机制](#5-工作流选择机制)
6. [智能体与子智能体配置](#6-智能体与子智能体配置)
7. [cc-switch 集成与路由策略](#7-cc-switch-集成与路由策略)
8. [trellis init 作为强制性的下一步](#8-trellis-init-作为强制性的下一步)
9. [成本控制机制](#9-成本控制机制)
10. [跨宿主感知与建议](#10-跨宿主感知与建议)
11. [安装](#11-安装)
12. [用法示例](#12-用法示例)
13. [目录结构](#13-目录结构)
14. [安全说明](#14-安全说明)
15. [已知限制](#15-已知限制)
16. [贡献者](#16-贡献者)
17. [联系方式](#17-联系方式)

## 1. 项目目标
- **动态，而非固定。** MAW 依据真实的项目信号 + 宿主能力对六种架构打分，并选择最合适的——或一个组合。见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。
- **可移植 + 限定于智能体软件。** 仅 Claude Code、Codex、Pi Agent 与 DeepSeek Harness（依策略收窄）。plan + 各智能体配置都是宿主可读的纯 JSON/YAML/Markdown。
- **成本有界。** 来自 cc-switch 日志的真实推理花费，而非 token 估算。默认值：**每智能体 $5/分钟**、**总计 $10/分钟**、最大并发 16——全部可编辑。
- **能力适配的模型选择。** 同一榜单之内的模型也各不相同（有些 agentic（智能体化）模型是全多模态的；有些仅支持推理/对话；有些多模态模型完全不具备 agentic 能力），因此每个智能体/子智能体先按能力适配筛选可用的 provider 模型，再按剩余额度/余额与花销速率挑选 provider（api key）+模型。
- **Codex 审查，按风险把关。** 当 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 可用时，Codex 在基于风险的关卡充当独立审查者——而非每一步都审查。
- **对 cc-switch 安全 + 项目脱钩。** 所有既有 cc-switch 数据均为只读；MAW 的**项目**功能与 cc-switch 不完整的 `profiles` 功能**暂时脱钩**（代码保留、默认停用；`MAW_CC_PROJECT_SYNC=1` 可临时重开）。MAW 仍然对项目级各 agents/subagents 的模型配置执有强力权限（`.mawf/agents/*.json`），只从 cc-switch **只读同步供应商配置信息**——各供应商 `config.toml`/`config.json` 中的高价值设置（base_url、model、auth_mode、failover……）。另有（可选的）路由 carve-out。

## 2. 何时使用
一个**新的复杂项目**：`mawf init -u <user>` → `mawf plan`。当单个智能体不够用时（文件多、多种语言、高风险、上下文超过一个窗口）使用，且你需要带 Codex 审查关卡、成本有界的多智能体运行。**不要**用于琐碎的固定任务（单个循环智能体更便宜）。

**背景阅读——智能体系统概念。** 对 MAW 评分与选择的这些范式还陌生？请阅读在线报告——[智能体架构范式研究报告](https://imblanker.github.io/multi-agents-workflow/agent-architecture-paradigms.html)（由 GitHub Pages 渲染；源文件：[`docs/agent-architecture-paradigms.html`](./docs/agent-architecture-paradigms.html)）：一份短小的研究报告，厘清 **Augmented LLM**、**Workflow 与 Agent 的区别**、**Multi-Agent**、**Subagents**、**Orchestrator-Worker**、**Loop Engineering**、**Graph Engineering** —— 各自是什么、何时用、需要什么前提。

## 3. 系统架构
```
   user/project → mawf plan: probe → score architectures → select → generate per-agent configs (.mawf/)
        │
   ┌────┴───────────────────────────────────────────────────────┐
   ▼              ▼                                            ▼
 cc-switch      host agent (Claude Code)              codex-plugin-cc (Codex reviewer)
 (SQLite, RO)   drives execute via Task/delegate     risk-gated review gates
 providers,     │
 model_pricing, ▼
 request_logs   cost guard (pre-spawn): $/min per-agent + total, concurrency cap
```
- **引擎**（`src/`）：[`ccswitch.js`](./src/ccswitch.js)（只读供应商配置同步 + 路由；项目 profile 同步默认脱钩）、[`planner.js`](./src/planner.js)、[`graph.js`](./src/graph.js)、[`configgen.js`](./src/configgen.js)、[`cost.js`](./src/cost.js)、[`codex.js`](./src/codex.js)、[`trellis.js`](./src/trellis.js)、[`pricegate.js`](./src/pricegate.js)、[`installer.js`](./src/installer.js)、[`doctor.js`](./src/doctor.js)、[`host.js`](./src/host.js)、[`probe.js`](./src/probe.js)。
- **插件**（`plugin/`）：Claude Code 命令（`/mawf:plan`、`/mawf:run`、`/mawf:cost`、`/mawf:doctor`、`/mawf:add-agent`、`/mawf:review`）、智能体定义、一个 `PreToolUse` 成本护栏 hook。
- **技能**（`skills/`）：可移植的 skill 文件。

## 4. 支持的智能体软件
| 宿主 | 状态 | 备注 |
|---|---|---|
| **[Claude Code](https://docs.claude.com/en/docs/claude-code)** | ✅ 完整 | 命令、智能体、hooks、技能；针对子智能体与多智能体的原生 `Task`/delegate；**本地路由 + 自动故障转移始终开启**。 |
| **[Codex](https://github.com/openai/codex)** | ✅ 支持 | 智能体定义 + 通过 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 的审查者；除非使用 OpenAI OAuth 登录，否则本地路由开启。 |
| **Pi Agent** | ✅ 支持 | 配置位于 `~/.pi/agent/`（不经 cc-switch）；智能体 → `.pi/agents/maw-*.md`、prompts → pi prompts、技能 → `.agents/skills`；通过原生子智能体工具调用；花费不可测（仅并发的成本控制）。 |
| **DeepSeek Harness (dsh)** | ✅ 支持 | 配置位于 `~/.dsh/settings.yaml`（`llm-pi-ai.providers`；不经 cc-switch）；无命名智能体文件——便携的 `.mawf/agents/<role>.md` 即是通过 dsh 提示驱动的子智能体工具 spawn 的载荷；技能 → `$DSH_HOME/skills` + `.agents/skills`；花费速率不可测（仅并发），价格从 cc-switch 同步的 `model-pricing.json` 按 id 匹配；MCP 由 dsh patch 层管理。 |
| Gemini CLI / opencode / 其他 | ❌ 不支持 | （其 cc-switch 定价仍可能被读取用于成本估算。） |

`mawf doctor` 报告宿主 + 路由策略合规情况。

## 5. 工作流选择机制
| 信号 | 大概率选择 |
|---|---|
| 琐碎、固定、低风险 | `none`（单次调用） |
| 开放式、步骤不可预测、单一上下文 | `loop` |
| 许多动态的、可并行的子任务 / 上下文超过一个窗口 | `orchestrator-workers` |
| 高价值、广度优先、并行、可容忍约 15× 成本 | `multi-agent` |
| 需要可预测性、人工介入(HITL)、持久化、分支 | `graph` |
| 宿主有原生动态工作流 / 多智能体 | `dynamic`（叠加其上） |
| 复杂编码 + codex 审查可用 | `ultracode`（graph + loop + codex fix-gate） |

架构会**组合**（例如 `ultracode` = `graph` + `loop` + 一个 Codex 审查关卡）。完整规则：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 6. 智能体与子智能体配置
`mawf plan` 在 `.mawf/` 下为每个角色写入一份**可独立编辑**的配置（`workflow.json`、`config.yaml`、`plan.md`、`graph.json`、`agents/<role>.md`+`.json`、`runtime/`）。动态增删：`mawf add-agent --role <r> ...` / `mawf remove-agent --role <r>`。直接编辑任意文件——运行器会在执行时重新读取它。

**能力适配的模型选择**（[`src/modelcap.js`](./src/modelcap.js)，灵感来自 [Artificial Analysis](https://artificialanalysis.ai) 的约 10 个按能力划分的模型榜单——intelligence / coding / math / agentic / multimodal-vision / image / image-edit / video / tts / stt）。对每个角色，MAW 会：① 按能力对 cc-switch 中**每一个可用的 provider 模型**分类（全多模态的 agentic 模型、仅推理/对话的 agentic 模型、以及多模态但非 agentic 的模型，是三种不同的东西）；② 剔除不适合该角色的模型（例如图像生成模型绝不可能成为实现者）；③ 按**能力适配 → provider 剩余额度/余额 → 花销速率**对剩余模型排序（额度 = `limit_daily/monthly_usd` − `usage_daily_rollups` 中的花费；未设置限额时额度未知）。精选目录一律标记 `estimated:true`。实时查看：

```bash
mawf models                # capability view of all provider models + per-role assignments
mawf models --app codex    # same for the codex app_type
```

每个智能体的 `.json`/`.md` 都携带完整的 `model_selection` 记录（所选 provider+模型、能力适配、剩余额度、价格、理由、备选）——见 [`examples/.mawf-sample/agents/orchestrator.json`](./examples/.mawf-sample/agents/orchestrator.json)。

**模型价格门禁（HITL，强制）。** 每当 MAW 要配用单价较高的模型——**Input > $2/1M Tokens 或 Output > $10/1M Tokens**（[`src/pricegate.js`](./src/pricegate.js)，唯一事实来源）——都会**暂停相关工作并先向人工报告**：

- `mawf plan` / `mawf init` / `mawf add-agent` 打印 ⚠ PRICE GATE 报告（角色、供应商、模型、价格、阈值）并**以退出码 3 暂停**；生成的 `.mawf/` 文件保留在磁盘上供人工审查。
- `mawf guard` / `mawf acquire` 对未获人工批准的昂贵模型角色**拒绝放行**，暂停状态得以保持。
- 人工可通过三种方式恢复：改用更便宜的模型（编辑 `.mawf/agents/<role>.json` 后重跑 `mawf plan`）、按角色显式批准（`mawf approve-model --role <role> --yes`——重跑 plan 后仍然有效）、或单次运行覆盖（`--allow-pricey`）。

**订阅覆盖豁免（codex 登录 ChatGPT Pro / Pro-Lite）。** 机器级策略（2026-08-24）：当本机 Codex CLI 登录的 OpenAI 账户的 ChatGPT plan 为 `pro` 或 `prolite`（[`src/codexplan.js`](./src/codexplan.js) 读取 `~/.codex/auth.json`（或 `$CODEX_HOME`）及 id_token 的 `chatgpt_plan_type` 声明）时，**reviewer** 角色默认使用 `gpt-5.6-sol`（reasoning effort `low`），价格门禁将其标记为 `covered:true` 而非拦截——该登录下的 codex 用量是 flat-rate 订阅，不按 token 计费，没有可门禁的按 token 开销。其他任何登录状态（API key、free/plus/team、未登录）保持原有的能力感知选型 + 门禁。豁免从不静默：`mawf plan`/`mawf init` 会打印检测到的登录行，`.mawf/agents/reviewer.json` 记录 `price_gate.covered` 与 plan id。

## 7. cc-switch 集成与路由策略
MAW 把你的 cc-switch 视为**默认只读**。以下规则在代码中强制执行（[`src/ccswitch.js`](./src/ccswitch.js)、`guardSql`）：

- **每次 init 前先做快照。** `mawf init` **首先**把**所有** cc-switch 配置文件打包成一个带时间戳的归档，存放在 `~/.cc-switch/maw-backups/cc-switch-snapshot-<timestamp>.tar.gz`（在 `tar` 不可用时退化为目录拷贝 + sha256 清单）——发生在 MAW 触碰任何其他内容之前。只读取既有文件；只在 `maw-backups/` 下写入新文件。
- **所有既有 cc-switch 数据均为只读。** 读取使用只读 SQLite 连接（`node:sqlite` `readOnly:true`）。
- **项目功能默认脱钩。** cc-switch 的「项目」功能（`profiles` 表）不完整，MAW 不再读写 profiles：MAW 自己在 `.mawf/agents/*.json` 管理项目级 agents/subagents 模型配置，只**只读同步供应商配置信息**（各供应商 `config.toml`/`config.json` 的高价值设置——base_url、model、auth_mode、failover 队列……）。profile 相关代码模块保留在 `src/ccswitch.js`（含测试）但已停用；设 `MAW_CC_PROJECT_SYNC=1` 可临时重开旧的创建/复用 `MAW: <project> (<user>)` profile 行为。
- **绝不触碰“默认” profiles。** 任何名称含 `默认` 的 profile（如 `Claude Code 默认`、`Codex 默认`）**绝不**被写入、更新或删除——一道硬护栏会拒绝它（即使重开旧同步也仍然生效）。
- **路由规则**（`mawf routing` / `mawf doctor` 检查；`mawf routing --fix` 应用该 carve-out，**仅**为 claude/codex 写入 `proxy_config`）：
  - **Claude Code：** 本地路由**始终开启** + 自动故障转移**始终开启**。
  - **Codex：** 当使用 **OpenAI OAuth（ChatGPT）登录**时 → 本地路由**关闭**；否则**开启**。（OAuth 通过 `codex_oauth_auth.json` + provider 的 `auth.auth_mode === "chatgpt"` 检测。）

- **技能共存（cc-switch v3.20+ / CLI v5.10+）。** cc-switch 可管理仓库托管的技能（`skills` 表；`cc-switch skills update`）。若你由 mawf 安装的 `mawf-*` 技能落入 cc-switch 仓库管理之下，`cc-switch skills update` 可能覆写它们——`mawf doctor` 会标记这一点，重跑 `mawf install`/`mawf update` 可恢复 mawf 的副本。`mawf-*` 技能的版本权威是 mawf 安装器。

## 8. trellis init 作为强制性的下一步
**始终把 `trellis init -u <user-name>` 作为 `mawf init` 之后的下一步来运行。** MAW 会自动为你完成这一步（它调用 [`@mindfoldhq/trellis`](https://github.com/mindfoldhq/trellis)——一个更强大、更严谨的工作流框架）。用 `mawf init --no-trellis` 跳过。

因为 trellis 与 MAW 都能管理文件，发生冲突时 MAW 会**暂停** trellis init：
1. **快照** MAW 管理的文件（`.mawf/*`，排除 `runtime/`/`logs/`）。
2. **运行** `trellis init -u <user> -y --claude --codex`，把输出流式写入 `.mawf/logs/trellis-init-<timestamp>.log`。
3. **检测** trellis 触碰过的任何 MAW 管理文件 → **暂停**，在终端打印冲突详情 + 概览 + 日志路径。
4. **由你逐个冲突选择**：`[m]` 保留 MAW（通过 `mawf plan` 重新生成）· `[t]` 保留 trellis · `[r]` 重新运行 trellis init 以**恢复进度**。
5. MAW 应用你的选择并继续。

（一个黑盒 CLI 无法在写入中途暂停，因此 MAW 会在冲突写入之后立即检测到冲突，然后通过重新运行幂等的 `trellis init` 来恢复。）见 [`src/trellis.js`](./src/trellis.js)。

**Trellis 更新跟踪器。** 本仓库的 GitHub Actions 工作流 [`trellis-update-tracker`](./.github/workflows/trellis-tracker.yml) 会自动跟踪 `@mindfoldhq/trellis` 的更新（每周 + 手动触发）：出现新 npm 版本时，它会打开一个 `[trellis-tracker]` issue（含版本与链接）并推进 `.github/trellis-tracker/state.json`。唯一例外：**如果 trellis 删库**（上游 404），跟踪器会打开一条 notice issue、暂停跟踪，且工作流仍然成功——上游恢复后自动恢复跟踪。MAW 通过 `@latest` 调用 trellis，因此 MAW 本身无需升级动作；issue 只是提醒人工审阅变更日志。

**在 mawf 工作区中，`trellis brainstorm` 运行 grill 版。** `trellis init` 后，mawf 会把 `.agents/skills/trellis-brainstorm/SKILL.md` 换成运行 vendored **grill-with-docs** 面试的包装器（mattpocock/skills，MIT：`grilling` 轮次/设计树/frontier + `domain-modeling` 术语表/ADR），同时完整保留 Trellis 规划契约（任务目录、PRD 种子、consent 门、`task.py start` 前不写码）。术语落入 `CONTEXT.md`，不可逆决策记 ADR，收敛的轮次更新 `prd.md`。逃生门：恢复备份于 `.agents/skills/trellis-brainstorm.orig.md` 的原版文件。`trellis update` 覆写后 `mawf update` 会重打补丁；`mawf doctor` 标记状态。

## 9. 成本控制机制
来自 cc-switch `proxy_request_logs` 的真实推理花费 → USD/分钟。**每智能体** $5/分钟、**总计** $10/分钟（独立）、**最大并发** 16——可在 `.mawf/config.yaml` 或通过 flags 编辑。定价来源链：cc-switch `model_pricing` → provider `cost_multiplier` → 内置的**估算值**（标记 `estimated:true`）→ `null`（绝不伪造）。不经 cc-switch 代理路由的宿主（pi、dsh）没有可测的花费速率 → 速率限额降级为仅并发；dsh 上的**价格门**仍通过 cc-switch 自动同步的 `~/.cc-switch/model-pricing.json` 生效（命中的模型 id 得到真实价格，未命中保持未知）。

```bash
mawf cost      # current rate + top sessions + used% vs limit
mawf guard     # ALLOW/DENY a new spawn right now (pre-spawn check)
mawf acquire --id <id> --role <r>   # take a slot
mawf release --id <id>             # release a slot
```

## 10. 跨宿主感知与建议

MAW 项目中任一受支持宿主的会话都掌握整机的全貌。三个组成部分：

**`mawf inventory`** 扫描本机所有已安装的受支持宿主（claude-code / codex / pi / dsh）+ 当前项目，产出 `.mawf/inventory.json`（全量）与 `.mawf/inventory-digest.md`（紧凑摘要，≤200 行）：技能（带来源标签、symlink 去重）、插件、marketplaces、MCP 服务器、提示词面、完整可切换模型池（pi 合并 `models-store.json` 目录）。**`--verify`** 探测各宿主自己的 CLI（`claude mcp list`、`codex mcp list --json`、dsh `--dump-config`）并附实时状态——connected ✓ / failed ✗ / pending-approval ⏸ / unsupported ⚠；dsh 输出其 everything-as-a-plugin 组件表。诚实缺口保持显式标注：claude 插件启用态、dsh 全量插件/技能清单、codex_apps 仅 UI 可见（见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)）。

**`mawf advise [--task "<文本>"] [--difficulty 1-5] [--json]`** 用纯确定性规则为每个宿主打分——capabilityFit（≤30）、skillMatch（≤30；失败/待批准的 MCP 与已禁用插件永不参与匹配）、modelFit（≤25）、costFit（≤15），另对当前宿主 +8 留守加分；仅当领先者超出 ≥10 分才建议切换（滞回，防反复横跳）。判定为 `switch` 时预生成 `.mawf/handoff/<时间戳>-<from>-<to>.md` 交接简报，并打印确切的启动命令——dsh 的命令是 `kill -9 $(lsof -ti tcp:3080) && dsh web`（旧实例占用 3080 端口）。**advise 绝不执行任何命令**，由人类自己运行。

**主动注入（仅项目级——绝不碰全局提示词文件）。** `init/plan/install/update/upgrade` 会向项目根 `AGENTS.md` + `CLAUDE.md`（所有受支持宿主都会加载的面）写入幂等管理块（≤20 行，`<!-- mawf:cross-host-advise BEGIN/END -->`）。该块指示任何会话中的 agent：在会话开始及每天（UTC+8）第一个提示词时重新运行留守/切换分析（新鲜度状态存于 `.mawf/runtime/advise-state.json`）；主动向人类呈现建议与理由；切换时填好交接简报并原样展示命令；接续 48 小时内的交接简报；在声称本机"缺少"某能力之前先查摘要。`mawf uninstall` 默认保留管理块；`--purge-config` 将其移除。注意（codex ≥0.150.0）：不受信任的项目会忽略项目级 `AGENTS.md`——需在 codex 中授予项目信任，否则管理块不会在 codex 会话中加载（`mawf doctor` 有提示）。

## 10b. Watchdog：停滞检测与跨 host 救援（opt-in）

`mawf watchdog` 周期性（默认 15 分钟）检查所有 mawf 初始化项目中**活跃**的 agent/subagent 会话是否被报警阻碍，并可换 host 救援：

- **信号（优先级 d→c→a→b）**：cc-switch 日志的按会话错误/中断计数（含 Pi (Session) 导入）→ 转录停滞（进程存活但文件不再增长）→ 尾部连续同类错误 → 权限/审批挂起。阈值在 `.mawf/config.yaml`（`watchdog.thresholds`）；超过 60 分钟无变动的旧会话绝不算活跃。
- **两阶段**：Phase A 仅无损解阻（只读诊断、配置类修复；绝不写目标项目、绝不杀进程）。Phase A 在 15 分钟窗口失败后才进入 Phase B——换下一家 host 接续任务，以停滞转录为交接（mawf+trellis 工作区注入 trellis 任务上下文；codex-on-codex 先试原生 `exec resume`/`fork`）。
- **host 轮换固定**：claude → pi → dsh → codex，跳过停滞/不可用 host；每 host 每事故至多一次；遍历完 → `human-alert`（终态）。救援模型必须过价格闸门（claude/codex 按次 `--model`/`-m`；pi/dsh 用其配置默认——默认 cost-guard 仍约束花费）。
- **专属救援工作区** `~/.mawf/watchdog/workspace/`（标准 mawf 工作区，绝不注册为被监视项目）按默认设置分派 subagents——数量"无上限"，默认 cost-guard 约束仍然生效。
- **预算三层**：默认 cost-guard + 每事故硬顶（默认 **$10**，`watchdog.incidentBudgetUsd`）+ 价格阀门。窗口归因的救援花费记到事故账上；任一层触发 → `budget-stop`。
- **经验复用**：问题签名（host + 错误类别 + 规范化 token）解析到救援工作区 `knowledge/` 的案例文件；过往成功注入为先例，失败过的修复绝不再原样重试，新解回写。
- **安全**：绝不杀原进程；原 agent 恢复则事故以 `original-recovered` 关闭、停止后续派发。Phase B 写入前必须有 git 快照（`refs/rescue/<incident>`）；非 git 项目降级为只诊断。
- **审计**：每事故记录于 `<project>/.mawf/watchdog/`（信号、派发、花费、结论）；终态追加到 `ALERTS.md`；可选 `watchdog.webhookUrl` POST 摘要。

仅在被调用时运行：常驻 `mawf watchdog [--interval 15]`，或 cron/systemd 用 `*/15 * * * * mawf watchdog --once`（时钟制状态跨调用存活）。`mawf init` 把项目登记进 `~/.mawf/projects.json`（`--no-watchdog` 退出；config `extra`/`exclude` 调整）。`--dry-run` 只打印派发 prompt、不 spawn。

## 11. 安装
**从 npm：** `npx multi-agents-workflow@latest install`。
**从 fork/clone（现在）：**
```bash
git clone https://github.com/<you>/multi-agents-workflow.git
cd multi-agents-workflow
npx . install          # or node bin/mawf.js install
```
`install` 把 commands/agents/hooks/skills 拷贝到 Claude Code（以及 Codex，尽力而为），并在 `~/.mawf/installed.json` 清单中记录**每一个写入的文件**，且是非破坏性的（卸载会跨全部宿主精确移除这些文件——包括不带 `maw-*` 前缀的插件 agents/hooks——并清理因此变空的目录）。**install 在特殊宿主间是叠加式的**（0.4.2）：在 dsh 安装上 `MAW_HOST=pi install` 会同时分发两个宿主的资产并记录两个目录——install 绝不静默丢弃另一宿主的资产；显式移除用 `uninstall`。项目 `.mawf/` 配置默认**保留**，传 `--purge-config` 才删除；`--restore-routing` 可将 cc-switch `proxy_config` 回滚到 init 前的快照。`update` 重新拷贝模板、保留你的编辑，并**清理旧版安装残留的资产**（按 v2 清单精确差异——绝不触碰用户自建文件）。`upgrade` 自升级**且默认自动刷新已装模板**：checkout 安装走 `git fetch` + ff-only 拉取，npm 安装走 `npm i -g`（`--dry-run`/`--remote`；绝不 stash/rebase/force），随后 spawn 新版 `bin/mawf.js update`，并**继承已安装宿主**（用 `--no-apply-templates` 跳过；刷新失败仅降级为警告）。

## 12. 用法示例
**最简：** `mawf init -u alice`（先对 cc-switch 做快照）→ `mawf plan --project .` → `mawf run` → `mawf cost`。
**模型选择：** `mawf models`——查看每个角色分到哪个 provider（api key）+模型，以及为什么（能力适配 → 剩余额度 → 花销速率）。
**完整：** `mawf plan --project . --task-type coding --risk high --parallel 6 --value high --context large` → 每次 spawn 前执行 `mawf guard` → `mawf acquire/release` → `mawf review --after post-implementation`。
参见 [`examples/complex-project-workflow.md`](./examples/complex-project-workflow.md) 与生成的 [`examples/.mawf-sample/`](./examples/.mawf-sample/)。

**常见错误：** `cc-switch database not found` → `mawf doctor`；`DENY spawn ... per-agent limit` → 降低并发或调高 `--per-agent`；`codex not ready` → 安装 codex + codex-plugin-cc（MAW 对 risk ≥ medium 降级为第二个 Claude 审查者）；`routing NOT compliant` → `mawf routing --fix`。

## 13. 目录结构
```
bin/mawf.js  src/  plugin/  skills/  defaults/  examples/  tests/  docs/
.github/workflows/ci.yml  README.{md,zh-Hans,zh-Hant}  LICENSE(MIT)
```

## 14. 安全说明
cc-switch 默认只读；仅有的写入是 (a) 已脱钩的项目 profile 同步——**默认停用**，仅当 `MAW_CC_PROJECT_SYNC=1` 时重开（只创建新 profile，绝不触碰 `默认`）——与 (b) 为 claude/codex 写入的可选 `proxy_config` carve-out——两者都有硬护栏（无 `DELETE`/`DROP`，对 profiles/providers/skills 无 `UPDATE`，绝不动 `默认`）。价格门禁会暂停昂贵的模型配用直到人工处理。`PreToolUse` hook 只**阻止**超预算的 spawn。外部代码在复用前已审查（许可证 + 无隐藏的网络/凭据窃取）——见 [`NOTICE.md`](./NOTICE.md)、[`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md)。

## 15. 已知限制
- 尚未发布到 npm（使用 `npx . install`）。
- 成本护栏度量的是**过去**的花费；突发流量可能短暂超过限制。
- Codex 审查依赖 codex-plugin-cc；缺少它时，MAW 以第二个 Claude 审查者替代。
- 路由 carve-out 直接写入 cc-switch 的 SQLite；cc-switch GUI 可能需要重启才能反映。
- 跨进程的图工作流崩溃恢复已列入路线图。

## 16. 贡献者
- **imBlanker** —— 初始实现。
> 欢迎贡献——见 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 与 [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)。*（不捏造其他贡献者。）*

## 17. 联系方式
- Issues：<https://github.com/imBlanker/multi-agents-workflow/issues>
- 作者：**imBlanker**（GitHub）。*（联系方式待补充；不捏造。）*

---

<a id="testing"></a>
## 测试
```bash
npm test        # 69 node:test cases
node bin/mawf.js doctor
```

## GitHub Stars 趋势
顶部的徽章始终显示实时星标数（通过 [shields.io](https://shields.io)）。下方的趋势图通过官方 [star-history](https://www.star-history.com/blog/how-to-use-github-star-history#how-to-embed-the-chart-in-your-readme)「**Generate embed code**」流程，以封装的仓库读取令牌（`sealed_token`）内嵌——无论 star-history 共享令牌池状态如何都能可靠渲染，感知深色/浅色模式，每次查看时自动更新：

<a href="https://www.star-history.com/?type=date&repos=imBlanker%2Fmulti-agents-workflow">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&theme=dark&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
 </picture>
</a>

> `sealed_token` 由 star-history 加密——原始 GitHub 令牌不会暴露在本 README 中。若图表停止渲染（令牌被吊销或过期），请在 [star-history.com](https://www.star-history.com/) 重新生成嵌入代码并替换此片段。

---

许可证：**MIT** —— 见 [`LICENSE`](./LICENSE)。
