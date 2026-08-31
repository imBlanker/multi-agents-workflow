[English](./README.md) | [简体中文](./README.zh-Hans.md) | [繁體中文](./README.zh-Hant.md)

[![CI](https://github.com/imBlanker/multi-agents-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/imBlanker/multi-agents-workflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-green.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-315%20passing-success.svg)](#testing)
[![GitHub stars](https://img.shields.io/github/stars/imBlanker/multi-agents-workflow?style=social&label=Stars)](https://github.com/imBlanker/multi-agents-workflow/stargazers)

# MAW — 面向複雜程式碼庫的多智慧體工作流系統

[變更日誌](./CHANGELOG.zh-Hant.md)（[English](./CHANGELOG.md)·[简](./CHANGELOG.zh-Hans.md)）

> 一個可攜、**動態**的多智慧體工作流系統。面對全新的複雜專案，MAW 會讀取你的 [cc-switch](https://github.com/farion1231/cc-switch) 設定，探測程式碼庫，並挑選合適的智慧體架構 —— *迴圈工程*、*編排者-工人*（子智慧體）、*多智慧體*、*圖工作流*、*動態工作流* 或 *ultracode* —— 或其組合。它為每個智慧體產生可獨立編輯的設定，強制執行**真實消費的成本速率限制**，並透過 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 整合 **Codex 審查**。

> **支援的宿主：Claude Code、Codex、Pi Agent 與 DeepSeek Harness (dsh)。** 其他智慧體軟體（Gemini CLI、opencode……）刻意**不予**支援。注意：dsh **不**經 cc-switch 管理——其供應商/模型位於 `~/.dsh/settings.yaml`，價格按 id 交叉引用 cc-switch 自動同步的 `~/.cc-switch/model-pricing.json`。自 **cc-switch v3.20（資料庫 schema v17）起 pi 可能由 cc-switch 管理**：當 cc-switch 資料庫出現 pi 供應商列時，供應商/定價來自 cc-switch 資料庫（精確），`~/.pi/agent/models.json` 鏡像 cc-switch 寫入的內容；無 pi 列時，pi 供應商仍來自 `models.json`（同既有行為）。僅當 cc-switch 的 Pi (Session) 匯入有資料時 pi 花費可測（快取寫計帳可能不完整）；dsh 花費速率不可測（不經代理），速率限額降級為僅並發。

---

## 🍴 先 fork

**強烈建議：在使用前先 fork 本儲存庫。** 在*你的* fork 中進行任何個人修改，使其與此上游保持同步，並將改進與心得回饋至此。

- **Fork：** <https://github.com/imBlanker/multi-agents-workflow/fork>
- **分支命名（Conventional Commits）：** `feat/<topic>`、`fix/<issue>`、`docs/<topic>`、`chore/<topic>`、`refactor/<topic>`、`ci/<topic>`、`test/<topic>`。
- **禁止直接推送至 `main`** —— 從你的功能分支發起 Pull Request。
- **一個 PR 對應一個關注點**，小而聚焦；用 `Closes #N` 連結 issue；CI 必須通過後才能審查。
- **issue：** 先搜尋[現有 issue](https://github.com/imBlanker/multi-agents-workflow/issues?q=is%3Aissue) 以避免重複，再使用 [bug](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=bug_report.md) / [feature](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=feature_request.md) 模板。

完整規則見 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 與 [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)。參見 [§貢獻者](#15-貢獻者) 與 [§聯絡方式](#16-聯絡方式)。

---

## 人類指南

> **提示：你可以把整份 README 交給你的智慧體，讓它為你安裝並設定 MAW —— 見下方 [Agent 指南](#agent-指南)。**

MAW 是一個 CLI（`mawf`）加上一個 Claude Code 外掛。最快路徑：

```bash
# 1. Fork the repo (see 🍴 Fork first), then clone YOUR fork:
git clone https://github.com/<you>/multi-agents-workflow.git
cd multi-agents-workflow

# 2. Install the plugin + skills into Claude Code (and Codex, best-effort):
npx . install          # or: node bin/mawf.js install

# 3. Initialize a project (cc-switch 專案設定檔同步預設脫鉤):
mawf init -u <your-name>

# 4. The next step is automatic: MAW runs `trellis init -u <your-name>` for you.
#    (skip the trellis chain with --no-trellis)

# 5. Plan + run:
mawf plan --project .
mawf run
```

若 Claude Code 的路由／自動故障轉移在 cc-switch 中為關閉，一條指令即可修復（只寫入 claude/codex 的 `proxy_config` 列 —— 絕不動你的設定檔／供應商）：

```bash
mawf routing --fix
```

隨時檢查環境：`mawf doctor`。

## Agent 指南

> **把這段交給你的智慧體（Claude Code、Codex、Cursor……）。它會為使用者正確地安裝、設定並使用 MAW。**

取得完整的智慧體安裝／設定指南並從頭到尾遵循 —— 不要摘要：

```bash
curl -fsSL https://raw.githubusercontent.com/imBlanker/multi-agents-workflow/main/docs/AGENT_INSTALL.md
```

該指南涵蓋：fork 與 clone、`npx . install`、`mawf init -u <user>`（建立 cc-switch 專案設定檔＋檢查路由策略＋鏈接 `trellis init`）、`mawf plan`、`mawf run`、`mawf cost`、`mawf guard`、`mawf review`、[人類指南](#人類指南) 工作流、[cc-switch 策略](#7-cc-switch-整合與路由策略)、[trellis init 規則](#8-trellis-init-作為強制的下一步)、優雅降級與解除安裝。完整閱讀；不要猜測。

最小智慧體提示：*"依循 https://github.com/imBlanker/multi-agents-workflow 中的 `docs/AGENT_INSTALL.md` 安裝並設定 MAW，然後對此專案執行 `mawf plan`，並回報所選架構、智慧體與成本限制。"*

---

## 目錄
1. [專案目標](#1-專案目標)
2. [何時使用](#2-何時使用)
3. [系統架構](#3-系統架構)
4. [支援的智慧體軟體](#4-支援的智慧體軟體)
5. [工作流選擇機制](#5-工作流選擇機制)
6. [智慧體與子智慧體設定](#6-智慧體與子智慧體設定)
7. [cc-switch 整合與路由策略](#7-cc-switch-整合與路由策略)
8. [trellis init 作為強制的下一步](#8-trellis-init-作為強制的下一步)
9. [成本控制機制](#9-成本控制機制)
10. [跨宿主感知与建议](#10-跨宿主感知与建议)
11. [安裝](#11-安裝)
12. [使用範例](#12-使用範例)
13. [目錄結構](#13-目錄結構)
14. [安全性說明](#14-安全性說明)
15. [已知限制](#15-已知限制)
16. [貢獻者](#16-貢獻者)
17. [聯絡方式](#17-聯絡方式)

## 1. 專案目標
- **動態，而非固定。** MAW 依據真實專案訊號＋宿主能力對六種架構評分，挑選最適配者 —— 或其組合。見 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。
- **可攜＋限定智慧體軟體。** 僅 Claude Code、Codex、Pi Agent 與 DeepSeek Harness（依策略收窄）。規劃＋各智慧體設定為宿主可讀的純 JSON/YAML/Markdown。
- **成本有界。** 來自 cc-switch 日誌的真實推理消費，而非權杖估計。預設：**每智慧體 $5/分鐘**、**總計 $10/分鐘**、最大並發 16 —— 皆可編輯。
- **能力感知的模型選擇。** 模型在**同一榜單內**也有差異（有些 agentic 模型是全多模態；有些僅限推理／對話；有些多模態模型根本不具 agentic 能力），因此每個智慧體／子智慧體會先依能力適配過濾可用的供應商模型，再依剩餘額度／餘額與花銷速率挑選 provider（API key）＋模型。
- **Codex 審查，依風險設關卡。** 當 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 可用時，Codex 在基於風險的關卡擔任獨立審查者 —— 而非每一步。
- **cc-switch 安全＋專案脫鉤。** 既有 cc-switch 資料皆為唯讀；MAW 的**專案**功能與 cc-switch 不完整的 `profiles` 功能**暫時脫鉤**（程式碼保留、預設停用；`MAW_CC_PROJECT_SYNC=1` 可臨時重開）。MAW 仍對專案級各 agents/subagents 的模型設定握有強力權限（`.mawf/agents/*.json`），只從 cc-switch **唯讀同步供應商設定資訊**——各供應商 `config.toml`／`config.json` 中的高價值設定（base_url、model、auth_mode、failover……）。另有（可選）路由豁免。

## 2. 何時使用
**全新的複雜專案**：`mawf init -u <user>` → `mawf plan`。當單一智慧體不敷使用（檔案繁多、多種語言、高風險、上下文超出單一視窗）且你需要有成本上限的多智慧體執行與 Codex 審查關卡時使用。**不要**用於微小的固定任務（單一迴圈工程智慧體更便宜）。

**背景閱讀——智慧體系統概念。** 對 MAW 評分與選擇的這些範式仍陌生？請閱讀線上報告——[智慧體架構範式研究報告](https://imblanker.github.io/multi-agents-workflow/agent-architecture-paradigms.html)（由 GitHub Pages 渲染；源檔：[`docs/agent-architecture-paradigms.html`](./docs/agent-architecture-paradigms.html)）：一份短小的研究報告，釐清 **Augmented LLM**、**Workflow 與 Agent 的區別**、**Multi-Agent**、**Subagents**、**Orchestrator-Worker**、**Loop Engineering**、**Graph Engineering** —— 各自是什麼、何時用、需要什麼前提。

## 3. 系統架構
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
- **引擎**（`src/`）：[`ccswitch.js`](./src/ccswitch.js)（唯讀供應商設定同步＋路由；專案設定檔同步預設脫鉤）、[`planner.js`](./src/planner.js)、[`graph.js`](./src/graph.js)、[`configgen.js`](./src/configgen.js)、[`cost.js`](./src/cost.js)、[`codex.js`](./src/codex.js)、[`trellis.js`](./src/trellis.js)、[`pricegate.js`](./src/pricegate.js)、[`installer.js`](./src/installer.js)、[`doctor.js`](./src/doctor.js)、[`host.js`](./src/host.js)、[`probe.js`](./src/probe.js)。
- **外掛**（`plugin/`）：Claude Code 指令（`/mawf:plan`、`/mawf:run`、`/mawf:cost`、`/mawf:doctor`、`/mawf:add-agent`、`/mawf:review`）、智慧體定義、一個 `PreToolUse` 成本護欄 hook。
- **技能**（`skills/`）：可攜的技能檔案。

## 4. 支援的智慧體軟體
| 宿主 | 狀態 | 說明 |
|---|---|---|
| **[Claude Code](https://docs.claude.com/en/docs/claude-code)** | ✅ 完整 | 指令、智慧體、hook、技能；原生 `Task`/delegate 支援子智慧體與多智慧體；**本地路由＋自動故障轉移恆為開啟**。 |
| **[Codex](https://github.com/openai/codex)** | ✅ 支援 | 智慧體定義＋透過 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 的審查者；除非 OpenAI OAuth 登入，否則本地路由為開啟。 |
| **Pi Agent** | ✅ 支援 | 設定位於 `~/.pi/agent/`（不經 cc-switch）；智慧體 → `.pi/agents/maw-*.md`、prompts → pi prompts、技能 → `.agents/skills`；透過原生子智慧體工具呼叫；花費不可測（僅並發的成本控制）。 |
| **DeepSeek Harness (dsh)** | ✅ 支援 | 設定位於 `~/.dsh/settings.yaml`（`llm-pi-ai.providers`；不經 cc-switch）；無命名智慧體檔案——可攜的 `.mawf/agents/<role>.md` 即是透過 dsh 提示驅動的子智慧體工具 spawn 的載荷；技能 → `$DSH_HOME/skills` + `.agents/skills`；花費速率不可測（僅並發），價格從 cc-switch 同步的 `model-pricing.json` 按 id 匹配；MCP 由 dsh patch 層管理。 |
| Gemini CLI / opencode / 其他 | ❌ 不支援 | （其 cc-switch 定價仍可能被讀取用於成本估計。） |

`mawf doctor` 回報宿主＋路由策略合規性。

## 5. 工作流選擇機制
| 訊號 | 可能選擇 |
|---|---|
| 微小、固定、低風險 | `none`（單次呼叫） |
| 開放式、步驟不可預測、單一上下文 | `loop` |
| 多個可動態並行化的子任務／上下文超出單一視窗 | `orchestrator-workers` |
| 高價值廣度優先、並行、可容忍約 15× 成本 | `multi-agent` |
| 需要可預測性、人工介入(HITL)、持久化、分支 | `graph` |
| 宿主具原生動態工作流／多智慧體 | `dynamic`（疊加其上） |
| 複雜程式碼撰寫＋codex 審查可用 | `ultracode`（圖工作流 + 迴圈工程 + codex 修復關卡） |

架構可**組合**（例如 `ultracode` = `graph` + `loop` + 一個 Codex 審查關卡）。完整評分表：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 6. 智慧體與子智慧體設定
`mawf plan` 在 `.mawf/` 下為每個角色寫入**可獨立編輯**的設定（`workflow.json`、`config.yaml`、`plan.md`、`graph.json`、`agents/<role>.md`+`.json`、`runtime/`）。動態新增／移除：`mawf add-agent --role <r> ...`／`mawf remove-agent --role <r>`。直接編輯任一檔案 —— 執行器會在執行時重新讀取。

**能力感知的模型選擇**（[`src/modelcap.js`](./src/modelcap.js)，靈感來自 [Artificial Analysis](https://artificialanalysis.ai) 的約 10 個分能力模型榜單 —— intelligence／coding／math／agentic／multimodal-vision／image／image-edit／video／tts／stt）。對每個角色，MAW 會：① 將 cc-switch 中**每個可用的供應商模型**依能力分類（全多模態的 agentic 模型、僅推理／對話的 agentic 模型、多模態但非 agentic 的模型是三種不同的東西）；② 剔除不適合該角色的模型（例如圖像生成模型絕不可能成為實現者）；③ 將其餘模型依**能力適配 → 供應商剩餘額度／餘額 → 花銷速率**排序（額度 = `limit_daily/monthly_usd` − `usage_daily_rollups` 中的消費；未設定上限時額度為未知）。精選目錄一律標記為估算值（`estimated:true`）。即時檢視：

```bash
mawf models                # capability view of all provider models + per-role assignments
mawf models --app codex    # same for the codex app_type
```

每個智慧體的 `.json`／`.md` 都帶有完整的 `model_selection` 記錄（所選 provider＋模型、能力適配、剩餘額度、價格、理由、備選）—— 見 [`examples/.mawf-sample/agents/orchestrator.json`](./examples/.mawf-sample/agents/orchestrator.json)。

**模型價格閘門（HITL，強制）。** 每當 MAW 要配用單價較高的模型——**Input > $2/1M Tokens 或 Output > $10/1M Tokens**（[`src/pricegate.js`](./src/pricegate.js)，唯一事實來源）——都會**暫停相關工作並先向人工報告**：

- `mawf plan`／`mawf init`／`mawf add-agent` 列印 ⚠ PRICE GATE 報告（角色、供應商、模型、價格、閾值）並**以退出碼 3 暫停**；生成的 `.mawf/` 檔案保留在磁碟上供人工審查。
- `mawf guard`／`mawf acquire` 對尚未獲人工批准的昂貴模型角色**拒絕放行**，暫停狀態得以維持。
- 人工可透過三種方式恢復：改用更便宜的模型（編輯 `.mawf/agents/<role>.json` 後重跑 `mawf plan`）、按角色明確批准（`mawf approve-model --role <role> --yes`——重跑 plan 後仍然有效）、或單次執行覆蓋（`--allow-pricey`）。

**訂閱覆蓋豁免（codex 登入 ChatGPT Pro / Pro-Lite）。** 機器級策略（2026-08-24）：當本機 Codex CLI 登入的 OpenAI 帳戶其 ChatGPT plan 為 `pro` 或 `prolite`（[`src/codexplan.js`](./src/codexplan.js) 讀取 `~/.codex/auth.json`（或 `$CODEX_HOME`）及 id_token 的 `chatgpt_plan_type` 聲明）時，**reviewer** 角色預設使用 `gpt-5.6-sol`（reasoning effort `low`），價格閘門將其標記為 `covered:true` 而非攔截——該登入下的 codex 用量是 flat-rate 訂閱，不按 token 計費，沒有可閘門的按 token 開銷。其他任何登入狀態（API key、free/plus/team、未登入）保持原有的能力感知選型＋閘門。豁免從不靜默：`mawf plan`／`mawf init` 會列印偵測到的登入行，`.mawf/agents/reviewer.json` 記錄 `price_gate.covered` 與 plan id。

## 7. cc-switch 整合與路由策略
MAW 預設將你的 cc-switch 視為**唯讀**。以下規則在程式碼中強制執行（[`src/ccswitch.js`](./src/ccswitch.js)、`guardSql`）：

- **每次 init 前先做快照。** `mawf init` **首先**將**所有** cc-switch 設定檔打包為帶時間戳的歸檔，位於 `~/.cc-switch/maw-backups/cc-switch-snapshot-<timestamp>.tar.gz`（在無 `tar` 可用的環境退為目錄複製＋sha256 清單）——早於 MAW 觸碰任何其他內容之前。只讀取既有檔案；只在 `maw-backups/` 下寫入**新**檔案。
- **既有 cc-switch 資料皆為唯讀。** 讀取使用唯讀 SQLite 連線（`node:sqlite` `readOnly:true`）。
- **專案功能預設脫鉤。** cc-switch 的「專案」功能（`profiles` 表）不完整，MAW 不再讀寫 profiles：MAW 自己在 `.mawf/agents/*.json` 管理專案級 agents/subagents 模型設定，只**唯讀同步供應商設定資訊**（各供應商 `config.toml`／`config.json` 的高價值設定——base_url、model、auth_mode、failover 佇列……）。profile 相關程式碼模組保留在 `src/ccswitch.js`（含測試）但已停用；設 `MAW_CC_PROJECT_SYNC=1` 可臨時重開舊的建立／重用 `MAW: <project> (<user>)` profile 行為。
- **絕不碰 `默认` 設定檔。** 任何名稱含 `默认`（例如 `Claude Code 默认`、`Codex 默认`）的設定檔**絕不**被寫入、更新或刪除 —— 一道硬性護欄會予以拒絕（即使重開舊同步也仍然生效）。
- **路由規則**（`mawf routing`／`mawf doctor` 檢查；`mawf routing --fix` 套用豁免，**只**寫入 claude/codex 的 `proxy_config`）：
  - **Claude Code：** 本地路由**恆為開啟**＋自動故障轉移**恆為開啟**。
  - **Codex：** 當使用 **OpenAI OAuth（ChatGPT）登入** 時 → 本地路由**關閉**；否則**開啟**。（OAuth 由 `codex_oauth_auth.json`＋供應商的 `auth.auth_mode === "chatgpt"` 偵測。）

- **技能共存（cc-switch v3.20+ / CLI v5.10+）。** cc-switch 可管理倉庫託管的技能（`skills` 表；`cc-switch skills update`）。若你由 mawf 安裝的 `mawf-*` 技能落入 cc-switch 倉庫管理之下，`cc-switch skills update` 可能覆寫它們——`mawf doctor` 會標記這一點，重跑 `mawf install`/`mawf update` 可恢復 mawf 的副本。`mawf-*` 技能的版本權威是 mawf 安裝器。

## 8. trellis init 作為強制的下一步
**務必在 `mawf init` 之後立即執行 `trellis init -u <user-name>`。** MAW 會自動為你完成（它呼叫 [`@mindfoldhq/trellis`](https://github.com/mindfoldhq/trellis) —— 一個更強大、更嚴謹的工作流框架）。使用 `mawf init --no-trellis` 跳過。

由於 trellis 與 MAW 都能管理檔案，發生衝突時 MAW 會**暫停** trellis init：
1. **快照** MAW 管理的檔案（`.mawf/*`，排除 `runtime/`／`logs/`）。
2. **執行** `trellis init -u <user> -y --claude --codex`，將輸出串流至 `.mawf/logs/trellis-init-<timestamp>.log`。
3. **偵測** trellis 動過的任何 MAW 管理檔案 → **暫停**，在終端機印出衝突詳情＋概覽＋日誌路徑。
4. **你逐項選擇**：`[m]` 保留 MAW（透過 `mawf plan` 重新產生）· `[t]` 保留 trellis · `[r]` 重新執行 trellis init 以**恢復進度**。
5. MAW 套用你的選擇並繼續。

（黑箱 CLI 無法在寫入途中暫停，因此 MAW 在衝突寫入後立即偵測，再透過重新執行冪等的 `trellis init` 來恢復。）見 [`src/trellis.js`](./src/trellis.js)。

**Trellis 更新追蹤器。** 本倉庫的 GitHub Actions 工作流程 [`trellis-update-tracker`](./.github/workflows/trellis-tracker.yml) 會自動追蹤 `@mindfoldhq/trellis` 的更新（每週＋手動觸發）：出現新 npm 版本時，它會開啟一個 `[trellis-tracker]` issue（含版本與連結）並推進 `.github/trellis-tracker/state.json`。唯一例外：**如果 trellis 刪庫**（上游 404），追蹤器會開啟一條 notice issue、暫停追蹤，且工作流程仍然成功——上游恢復後自動恢復追蹤。MAW 透過 `@latest` 呼叫 trellis，因此 MAW 本身無需升級動作；issue 只是提醒人工審閱變更日誌。

**在 mawf 工作區中，`trellis brainstorm` 執行 grill 版。** `trellis init` 後，mawf 會把 `.agents/skills/trellis-brainstorm/SKILL.md` 換成執行 vendored **grill-with-docs** 面試的包裝器（mattpocock/skills，MIT：`grilling` 輪次/設計樹/frontier + `domain-modeling` 術語表/ADR），同時完整保留 Trellis 規劃契約（任務目錄、PRD 種子、consent 門、`task.py start` 前不寫碼）。術語落入 `CONTEXT.md`，不可逆決策記 ADR，收斂的輪次更新 `prd.md`。逃生門：還原備份於 `.agents/skills/trellis-brainstorm.orig.md` 的原版檔案。`trellis update` 覆寫後 `mawf update` 會重打補丁；`mawf doctor` 標記狀態。

## 9. 成本控制機制
來自 cc-switch `proxy_request_logs` 的真實推理消費 → USD/分鐘。**每智慧體** $5/分鐘、**總計** $10/分鐘（獨立）、**最大並發** 16 —— 可在 `.mawf/config.yaml` 或透過旗標編輯。定價來源鏈：cc-switch `model_pricing` → 供應商 `cost_multiplier` → 內建**估計值**（標記 `estimated:true`）→ `null`（絕不偽造）。不經 cc-switch 代理路由的宿主（pi、dsh）沒有可測的消費速率 → 速率限額降級為僅並發；dsh 上的**價格門**仍透過 cc-switch 自動同步的 `~/.cc-switch/model-pricing.json` 生效（命中的模型 id 獲得真實價格，未命中保持未知）。

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

**`mawf advise --pool [--task "<文本>"] [--json]`** ——階段門控的**插件池判定**：對專案級 MCP / 技能 / 插件批次（宣告式目錄 `defaults/pool-catalog.json`；種子：agent-browser、codebase-memory-mcp、codegraph——按各自上游均為多宿主，dsh 僅可探測的誠實缺口）輸出 `add / keep / remove / noop` 判定，附理由與**防禦性程序**：安裝一律 check-then-act（絕不破壞既有資產），移除帶逐項**無殘留清單**；排斥組保證代碼知識圖索引器互斥（codegraph 與 codebase-memory-mcp 絕不同時推薦——已共存則輸出整合移除，雙缺席則只推薦其一）。階段來自 graph 閘控批次 / plan 審查點；每階段 ≥2 次判定記錄於 `.mawf/runtime/pool-state.json`，低於 2 次時 `mawf doctor --project` 給出 WARN。**僅建議性**——mawf 絕不執行安裝/移除；插件池唯一的寫入就是其狀態檔案。判定閾值（`threshold` / `stayBonus` / `removeLookback`）可在 `.mawf/config.yaml` 的 `pool:` 段覆寫。

**主动注入（仅项目级——绝不碰全局提示词文件）。** `init/plan/install/update/upgrade` 会向项目根 `AGENTS.md` + `CLAUDE.md`（所有受支持宿主都会加载的面）写入幂等管理块（≤26 行，`<!-- mawf:cross-host-advise BEGIN/END -->`）。该块指示任何会话中的 agent：在会话开始及每天（UTC+8）第一个提示词时重新运行留守/切换分析（新鲜度状态存于 `.mawf/runtime/advise-state.json`）；主动向人类呈现建议与理由；切换时填好交接简报并原样展示命令；接续 48 小时内的交接简报；在声称本机"缺少"某能力之前先查摘要；并在每个阶段边界（graph 门控批次 / plan 审查点）运行 `mawf advise --pool`（每阶段 ≥2 次判定），把增/留/删判定呈现给人类，绝不在批次中途执行安装/移除。`mawf uninstall` 默認保留管理塊；`--purge-config` 將其移除。注意（codex ≥0.150.0）：不受信任的專案會忽略專案級 `AGENTS.md`——需在 codex 中授予專案信任，否則管理塊不會在 codex 會話中載入（`mawf doctor` 有提示）。

## 10b. Watchdog：停滯偵測與跨 host 救援（opt-in）

`mawf watchdog` 週期性（預設 15 分鐘）檢查所有 mawf 初始化專案中**活躍**的 agent/subagent 會話是否被報警阻礙，並可換 host 救援：

- **訊號（優先級 d→c→a→b）**：cc-switch 日誌的按會話錯誤/中斷計數（含 Pi (Session) 匯入）→ 轉錄停滯（程序存活但檔案不再增長）→ 尾部連續同類錯誤 → 權限/審批掛起。閾值在 `.mawf/config.yaml`（`watchdog.thresholds`）；超過 60 分鐘無變動的舊會話絕不算活躍。
- **兩階段**：Phase A 僅無損解阻（唯讀診斷、設定類修復；絕不寫目標專案、絕不殺程序）。Phase A 在 15 分鐘視窗失敗後才進入 Phase B——換下一家 host 接續任務，以停滯轉錄為交接（mawf+trellis 工作區注入 trellis 任務上下文；codex-on-codex 先試原生 `exec resume`/`fork`）。
- **host 輪換固定**：claude → pi → dsh → codex，跳過停滯/不可用 host；每 host 每事故至多一次；遍歷完 → `human-alert`（終態）。救援模型必須過價格閘門（claude/codex 按次 `--model`/`-m`；pi/dsh 用其設定預設——預設 cost-guard 仍約束花費）。
- **專屬救援工作區** `~/.mawf/watchdog/workspace/`（標準 mawf 工作區，絕不註冊為被監視專案）按預設設定分派 subagents——數量「無上限」，預設 cost-guard 約束仍然生效。
- **預算三層**：預設 cost-guard + 每事故硬頂（預設 **$10**，`watchdog.incidentBudgetUsd`）+ 價格閥門。視窗歸因的救援花費記到事故帳上；任一層觸發 → `budget-stop`。
- **經驗復用**：問題簽名（host + 錯誤類別 + 規範化 token）解析到救援工作區 `knowledge/` 的案例檔案；過往成功注入為先例，失敗過的修復絕不再原樣重試，新解回寫。
- **安全**：絕不殺原程序；原 agent 恢復則事故以 `original-recovered` 關閉、停止後續派發。Phase B 寫入前必須有 git 快照（`refs/rescue/<incident>`）；非 git 專案降級為唯讀診斷。
- **審計**：每事故記錄於 `<專案>/.mawf/watchdog/`（訊號、派發、花費、結論）；終態追加到 `ALERTS.md`；可選 `watchdog.webhookUrl` POST 摘要。

僅在被呼叫時執行：常駐 `mawf watchdog [--interval 15]`，或 cron/systemd 用 `*/15 * * * * mawf watchdog --once`（時鐘制狀態跨呼叫存活）。`mawf init` 把專案登記進 `~/.mawf/projects.json`（`--no-watchdog` 退出；config `extra`/`exclude` 調整）。`--dry-run` 只列印派發 prompt、不 spawn。

## 11. 安裝
**來自 npm：** `npx multi-agents-workflow@latest install`。
**來自 fork／clone（目前）：**
```bash
git clone https://github.com/<you>/multi-agents-workflow.git
cd multi-agents-workflow
npx . install          # or node bin/mawf.js install
```
`install` 將指令／智慧體／hook／技能複製進 Claude Code（並盡力處理 Codex），並在 `~/.mawf/installed.json` 清單記錄**每一個寫入的檔案**，且為非破壞性（解除安裝會跨全部宿主精確移除這些檔案——包括不帶 `maw-*` 前綴的外掛 agents/hooks——並清理因此變空的目錄）。**install 在特殊宿主間是疊加式的**（0.4.2）：在 dsh 安裝上 `MAW_HOST=pi install` 會同時分發兩個宿主的資產並記錄兩個目錄——install 絕不靜默丟棄另一宿主的資產；明確移除用 `uninstall`。專案 `.mawf/` 設定預設**保留**，傳 `--purge-config` 才刪除；`--restore-routing` 可將 cc-switch `proxy_config` 回滾到 init 前的快照。`update` 重新複製模板、保留你的編輯，並**清理舊版安裝殘留的資產**（按 v2 清單精確差異——絕不碰使用者自建檔案）。`upgrade` 自升級**且預設自動重新整理已安裝範本**：checkout 安裝走 `git fetch` + ff-only 拉取，npm 安裝走 `npm i -g`（`--dry-run`/`--remote`；絕不 stash/rebase/force），隨後 spawn 新版 `bin/mawf.js update`，並**繼承已安裝宿主**（用 `--no-apply-templates` 跳過；重新整理失敗僅降級為警告）。

## 12. 使用範例
**最小：** `mawf init -u alice`（先對 cc-switch 做快照）→ `mawf plan --project .` → `mawf run` → `mawf cost`。
**模型選擇：** `mawf models` —— 檢視每個角色分得哪個 provider（API key）＋模型，以及原因（能力適配 → 剩餘額度 → 花銷速率）。
**完整：** `mawf plan --project . --task-type coding --risk high --parallel 6 --value high --context large` → 每次產生前執行 `mawf guard` → `mawf acquire/release` → `mawf review --after post-implementation`。
見 [`examples/complex-project-workflow.md`](./examples/complex-project-workflow.md) 與產生的 [`examples/.mawf-sample/`](./examples/.mawf-sample/)。

**常見錯誤：** `cc-switch database not found` → `mawf doctor`；`DENY spawn ... per-agent limit` → 降低並發或調高 `--per-agent`；`codex not ready` → 安裝 codex＋codex-plugin-cc（MAW 在風險 ≥ 中等時降級為第二個 Claude 審查者）；`routing NOT compliant` → `mawf routing --fix`。

## 13. 目錄結構
```
bin/mawf.js  src/  plugin/  skills/  defaults/  examples/  tests/  docs/
.github/workflows/ci.yml  README.{md,zh-Hans,zh-Hant}  LICENSE(MIT)
```

## 14. 安全性說明
cc-switch 預設唯讀；唯一的寫入為 (a) 已脫鉤的專案設定檔同步——**預設停用**，僅當 `MAW_CC_PROJECT_SYNC=1` 時重開（只建立新設定檔，絕不觸碰 `默认`）——與 (b) claude/codex 的可選 `proxy_config` 豁免 —— 兩者皆有硬性護欄（無 `DELETE`／`DROP`，對 profiles／providers／skills 無 `UPDATE`，絕不作用於 `默认`）。價格閘門會暫停昂貴的模型配用直到人工處理。`PreToolUse` hook 只**阻擋**超預算的產生。外部程式碼在重用前已審查（授權條款＋無隱藏網路／憑證竊取）—— 見 [`NOTICE.md`](./NOTICE.md)、[`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md)。

## 15. 已知限制
- 尚未上架 npm（使用 `npx . install`）。
- 成本護欄衡量的是**過去**消費；短時間尖峰可能短暫超過限制。
- Codex 審查依賴 codex-plugin-cc；若無，MAW 以第二個 Claude 審查者替代。
- 路由豁免直接寫入 cc-switch 的 SQLite；cc-switch GUI 可能需要重新啟動才會反映。
- 跨進程圖工作流崩潰恢復已列入規劃。

## 16. 貢獻者
- **imBlanker** —— 初始實作。
> 歡迎貢獻 —— 見 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 與 [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)。*(未捏造其他貢獻者。)*

## 17. 聯絡方式
- issue：<https://github.com/imBlanker/multi-agents-workflow/issues>
- 作者：**imBlanker**（GitHub）。*(聯絡資訊待補；未捏造。)*

---

<a id="testing"></a>
## 測試
```bash
npm test        # 69 node:test cases
node bin/mawf.js doctor
```

## GitHub Stars 趨勢
頂部的徽章恆顯示即時星數（透過 [shields.io](https://shields.io)）。下方趨勢圖透過官方 [star-history](https://www.star-history.com/blog/how-to-use-github-star-history#how-to-embed-the-chart-in-your-readme)「**Generate embed code**」流程，以封裝的儲存庫讀取權杖（`sealed_token`）內嵌——無論 star-history 共享權杖池狀態如何皆可靠渲染，感知深色／淺色模式，每次檢視皆自動更新：

<a href="https://www.star-history.com/?type=date&repos=imBlanker%2Fmulti-agents-workflow">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&theme=dark&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=imBlanker/multi-agents-workflow&type=date&legend=top-left&sealed_token=PYzm97OB-CHuFqRbxwItWNfcNPaj1VeB_w7lokYexF6G_txF6lQ5fkUsDSa2CA-OXsxYMZMRjbrqcsM4xF_3tlnZqyQRfDYzMvEEFRDiRV2FhIbBv3Ythw" />
 </picture>
</a>

> `sealed_token` 由 star-history 加密——原始 GitHub 權杖不會暴露於本 README。若圖表停止渲染（權杖遭撤銷或過期），請在 [star-history.com](https://www.star-history.com/) 重新產生嵌入碼並替換此片段。

---

授權條款：**MIT** —— 見 [`LICENSE`](./LICENSE)。
