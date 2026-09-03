# 變更日誌

**multi-agents-workflow (MAW)** 的所有重要變更記錄於此。
格式：[Keep a Changelog](https://keepachangelog.com/)；版本遵循
[SemVer](https://semver.org/)。

## [Unreleased]

## [0.7.2] - 2026-09-03

### Changed

- **乾淨的 npm 發布溯源**——從已合併、已打標籤且工作樹乾淨的 `main` 重新發布與 `0.7.1` 相同的執行時行為。`0.7.1` 的執行時程式碼仍然有效，但由於該版本從 dirty checkout 發布，其 npm 中繼資料記錄了合併前的功能提交。`0.7.2` 不包含執行時行為變更。

## [0.7.1] - 2026-09-03

### Fixed

- **宿主感知的跨宿主交接就緒閘控**——當 `mawf advise` 建議切換宿主時，生成的交接簡報現在會記錄已知的來源/目標宿主事實，並要求複核主智慧體/子智慧體模型、reasoning/effort、速度/成本，以及 MCP/技能/外掛/提示詞/harness 差異。系統會確定性地建議直接提問或 grilling，管理的 `AGENTS.md` / `CLAUDE.md` 區塊則禁止在使用者回應前把切換視為 ready。此機制僅是指令層硬閘控：stay/switch 評分、滯回、CLI 狀態與穩定的 `ADVISE-DONE` 尾行均未改變。測試仍為 316 項通過。

## [0.7.0] - 2026-08-31

### Added

- **階段門控插件池判定（`mawf advise --pool`）**——對專案級 MCP / 技能 / 插件批次跨宿主輸出 add/keep/remove/noop 判定，在每個大階段（graph 閘控批次 / plan 審查點）執行，每階段 ≥2 次判定記錄於 `.mawf/runtime/pool-state.json`（低於 2 次時 doctor WARN）。宣告式目錄 `defaults/pool-catalog.json`（schema v1，前向相容守衛）帶三個種子——agent-browser、codebase-memory-mcp、codegraph——足跡來自各自上游（claude-code/codex/pi 多宿主；dsh 僅可探測的誠實缺口），安裝程序一律 check-then-act（絕不破壞既有資產），移除帶逐項無殘留清單，並執行 D4 互斥：codegraph 與 codebase-memory-mcp 絕不同時推薦（已共存→整合移除；雙缺席→只推其一，另一為替代 noop）。滯回（stayBonus）+ removeLookback 防判定抖動；閾值可在 `.mawf/config.yaml` `pool:` 段覆寫。**僅建議性**：mawf 絕不執行安裝/移除——插件池唯一寫入是其狀態檔案（不變量測試覆蓋）。`mawf inventory` 新增唯讀 `pool` 段（逐元件逐宿主檢出狀態與證據）；管理塊新增第 6 條（≤20→≤26 行），mawf-run 批次循環在階段入口與閘控點運行判定、絕不在批次中途執行。測試 296→316（後續的 stayBonus 僅在位者修復保持排斥組贏家穩定）；README ×3 徽章 316。

- **宿主 changelog 適配：claude-code 2.1.238→2.1.251 / codex 0.149.0→0.151.0 / pi 0.84.2→0.84.4 / dsh 0.1.0-rc.8→0.1.2-alpha.2**（自 2026-08-20 dsh rc.8 基線以來的審計；完整矩陣見任務追蹤）。
  - pi 0.84.3 技能發現：分組目錄內嵌套一層的 Markdown 技能（`<group>/<skill>.md`）現在在所有技能目錄（含 `.agents/skills` 各面）被發現；眾所周知的非技能 Markdown（README/AGENTS/CHANGELOG/CONTRIBUTING/LICENSE/NOTICE.md）在根級與分組掃描中一律排除。修復相對 pi 自身發現的少報與多報漂移。
  - pi 0.84.4 + dsh 0.1.1-rc.1：deepseek 視覺變體（如 `deepseek-v4-flash-vision-exp`）透過先於通用 `^deepseek-v` 純文字規則的規則歸類為 `multimodal-generalist`（支援視覺輸入）。
  - codex 0.151.0 每倉庫插件目錄：`mawf inventory` 增掃專案級 `.codex/config.toml`（plugins + mcp_servers，同一解析，與全域配置去重；來源標記 `codex-project-config.toml`）及專案級 `.codex/skills`。
  - codex 0.150.0 專案信任：doctor `[INFO] codex project trust (managed block)` 檢查 + README ×3 說明——不受信任的 codex 專案會忽略專案級 `AGENTS.md`，mawf advise 管理塊需在 codex 授予專案信任後才會載入。
  - dsh 0.1.2-alpha.2：`listDshProfiles` 與 `parseDshPlugins` 經真實 0.1.2 `--dump-config`（610 行實機捕獲，隨包作為回歸 fixture）驗證不變；Profile 統一化與 Web UI 插件分組不影響 mawf 的解析錨點。測試 291→296；README ×3 徽章 281→296。

## [0.6.0] - 2026-08-21

### Added

- **cc-switch v3.20.0 / cc-switch-cli v5.10.2 跟進（schema v16→v17）。**
  - `readCcSwitch()` 暴露 `schemaVersion`（`PRAGMA user_version`）與 `schemaSupported`；doctor 新增 `cc-switch schema` 檢查；高於支援版本的 schema 降級為警告、絕不崩潰。全部讀取路徑在 v17 形狀的 fixture 上驗證通過（加性遷移——無回歸）。
  - **pi 托管世界觀**：`piManagedByCcSwitch()`——當 cc-switch 資料庫（schema ≥17）存在 pi 供應商列時，供應商/定價來自 cc-switch 資料庫（精確），`models.json` 鏡像 cc-switch 寫入的內容；不再疊加合併（無雙重計——已用不變式測試）。未托管時，來自 `models.json` 的 pi 供應商經 `mergePiIntoCc()` 進入候選池（定價僅填空隙，鏡像 dsh 合併；同時修復 `mawf models --app pi` 為空的問題）。`readPiAsCc(piManaged)` 在托管時保住 cc-switch 精確定價。doctor、`mawf models` 註記與三語 README 均改為條件表述。
  - **pi 真實計量**：當 cc-switch 的 Pi (Session) 匯入有列時，pi 花費可測（`piSessionUsagePresent()`），聚合攜帶上游告警（快取寫計帳可能不完整），`perSessionRate()` 新增 `errorCount`（狀態 ≥400 或 error_message——亦是 watchdog 訊號 d 源）。無列時維持僅並發降級。
  - `mawfSkillsUnderCcSwitch()`：doctor 回報處於 cc-switch 倉庫管理下的 mawf-* 技能（GUI v3.20+/CLI v5.10+ `skills update` 共存；資訊性）。
  - fixture `make-db.mjs` v17/v17NoPi 變體：`session_usage_dedup` 帳本（形狀為建模）、pi 供應商列、OpenModel 供應商列、pi-session 用量列（放置位置為建模）。
  - vendored 兜底價格按 cc-switch v3.20 目錄刷新（claude-sonnet-5 2/10、deepseek-v4-pro 0.435/0.87、deepseek-v4-flash 0.14/0.28、kimi-k3 3/15）——仍標記為估算。

### Added（續）

- **Watchdog：停滯偵測 + 跨 host 救援（opt-in）** — `mawf watchdog [--once] [--interval 15] [--project P] [--dry-run] [--json]`。訊號 d→c→a→b（日誌錯誤/中斷計數含 Pi (Session) 匯入 → 轉錄停滯 → 尾部連續錯誤 → 權限掛起）；僅活躍會話（60 分鐘新近性）。兩階段救援：Phase A 僅無損解阻，Phase A 15 分鐘視窗失敗後換 host 接續（轉錄交接、trellis 上下文、codex 原生 resume/fork 先試）。固定輪換 claude→pi→dsh→codex，每 host 一次；遍歷完 → human-alert。專屬救援工作區 `~/.mawf/watchdog/workspace/`（自身絕不被監視）；價格閥門選模；三層預算（預設 cost-guard + 每事故 $10 硬頂 + 價格閥門，視窗歸因記帳）；經驗庫復用（簽名 → 案例，失敗修復不再原樣重試）；Phase B 寫前 git 快照（非 git → 只診斷）；絕不殺原程序（恢復即關事故）；完整審計 + ALERTS.md + 可選 webhook。`mawf init` 登記 `~/.mawf/projects.json`（`--no-watchdog` 退出）。doctor：註冊表/警報/調度檢查。測試 275/275。

- **grill-brainstorm 替換**：mawf 工作區將 `trellis-brainstorm` 換為執行 vendored grill-with-docs 面試的包裝器（mattpocock/skills @5b15a47，MIT —— grilling + domain-modeling，攜帶兩處 mawf 格式修正），同時完整保留 Trellis 規劃契約。原版一次性備份（`.orig.md`）、冪等安裝、`trellis update` 覆寫偵測 + `mawf update` 修復、doctor 狀態檢查。逃生門已寫入文件。

### 驗證

- 真機資料庫（schema v17、pi 托管：deep-worker + openai-codex、暫無 pi-session 列→優雅降級）與 **trellis `@mindfoldhq/trellis` 0.6.15**：空白專案 `trellis init -u <u> --claude --yes` 干淨通過；MAW 的平台旗標（`--claude/--codex/--pi/--dsh`）仍然有效；tracker 狀態與 npm latest 一致。

### 修復

- `tests/advise.test.js` UTC+8 跨天 flake：狀態寫入呼叫漏注入 `clock`，導致真實日期 ≠ 硬編碼假日期時斷言必然變紅（在乾淨 main 上亦失敗）。

## [0.5.1] - 2026-08-20

### 修復

- **doctor：dsh profile 列表不再把 `node_modules` 誤報為 profile。** 新增專用讀取器 `listDshProfiles()`（`src/dshprovider.js`）：僅枚舉真實 profile 目錄——跳過 `node_modules` 與點前綴目錄，`profiles/` 缺失時安全降級為 `[]`。附回歸測試。

### 驗證

- 與 **DeepSeek Harness (dsh) 0.1.0-rc.8** 相容性驗證通過：`agent-default-model` dump 行與 rc.6 逐位元組一致（provider/model 提取不受影響）；`settings.yaml` `llm-pi-ai.providers` 結構不變；`mawf inventory --verify` 在擴容後的 everything-as-a-plugin 表上無重複、無錯報；`mawf advise` 評分正常；MAW 從不讀取 dsh 會話儲存，rc.8 的 SQLite 格式不相容對 MAW 無影響；措辭符合 rc.8 品牌規範（描述性使用 "DeepSeek Harness (dsh)" 被明確允許）。

## [0.5.0] - 2026-08-20

### 新增

- **跨宿主庫存** — `mawf inventory [--json] [--verify]`：掃描本機所有已安裝受支援宿主（claude-code / codex / pi / dsh）+ 项目，产出 `.mawf/inventory.json` + 緊湊摘要。技能（帶來源、symlink 去重）、插件、marketplaces、MCP、提示詞面、完整可切換模型池（pi 合并 `models-store.json` 目录）。`--verify` 探測各宿主自身 CLI（`claude mcp list`、`codex mcp list --json`、dsh `--dump-config` everything-as-a-plugin 表）獲取即時狀態；僅 UI 可見的真相（claude 插件启用态、dsh 全量插件/技能、codex_apps）顯式註明。
- **跨宿主建議** — `mawf advise [--task] [--difficulty 1-5] [--json] [--check-fresh]`：確定性逐宿主打分（capabilityFit/skillMatch/modelFit/costFit + stayBonus 滯回，margin ≥ 10 才建議切換），僅統計可用面（失敗/待批准/停用永不參與）。切換時：預生成 `.mawf/handoff/<时间戳>-<from>-<to>.md` 交接簡報 + 確切啟動命令（dsh：`kill -9 $(lsof -ti tcp:3080) && dsh web`）。advise 絕不執行任何命令。
- **主動注入** — 專案根 `AGENTS.md` + `CLAUDE.md` 冪等管理塊（≤20 行）：任一宿主會話在會話開始與每天（UTC+8）首個提示詞時重跑留守/切換分析（新鮮度狀態存於 `.mawf/runtime/advise-state.json`），解析穩定的 `ADVISE-DONE` footer，主動呈現建議，填寫/接續（<48h）交接簡報。可逆：預設保留，`--purge-config` 移除。
- e2e CLI 测试（全鏈路 + 舊 `.maw` 迁移）；`docs/ROADMAP.md` — 10 項帶教訓出處的下一版改進項。

### 變更

- **`.maw` → `.mawf`** 全面改名（專案工作區、全域清單目錄 `~/.mawf`、範例目錄、文件）。CLI 入口一次性自動遷移：僅當 `.mawf` 不存在时改名舊目录；預存 `.mawf` 永遠優先；絕不合併。
