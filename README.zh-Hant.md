[English](README.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md)

# MAWF 1.0.0

MAWF 提供明確模式選擇、共用任務帳本、可選宿主適配與獨立候選驗收。
此為 1.0.0 原始碼；發佈與驗證狀態見 docs/V1_RELEASE_STATUS.md。套件名稱為 `multi-agents-workflow`，
命令為 `mawf`；同名单數套件不是本專案。Core 需要 Node >=20.17，
沒有 npm 執行期依賴；可選 Pi Autoresearch 1.9.0 需要 Node >=22。

## 從 Core 開始

```sh
node bin/mawf.js init --project /path/to/project --json
node bin/mawf.js integrations list --project /path/to/project --json
node bin/mawf.js plan --project /path/to/project --json
node bin/mawf.js mode fixed-1 --project /path/to/project --json
node bin/mawf.js mode status --project /path/to/project --json
```

新專案預設 dynamic，所有外部整合關閉。設定、計畫、模式與任務狀態不依賴
宿主、資料庫或外掛憑證。原生 `.mawf/workspace.json` 標記會在生命週期操作中保留。
啟用不等於安裝、認證、派遣或 ready；選擇 Claude 後才安裝其選定資源：

```sh
node bin/mawf.js integrations enable host.claude-code --project /path/to/project
node bin/mawf.js install --project /path/to/project
```

安裝、更新與解除安裝遵循精確所有權；關閉專案整合不會刪除其他宿主資源或使用者檔案。
詳見[安裝指南](docs/AGENT_INSTALL.md)。

## 模式與設定

Dynamic 保留 loop、orchestrator-workers、multi-agent、graph、dynamic、ultracode
及其組合。Fixed mode 1 使用獨立的 Claude 主宿主角色政策：主編排委派實作，
實作者不編寫測試，至少一名獨立 Hacker 完成反例與真實使用者路徑，工作完成後持續
補位，同根因兩次失敗後提交事實並重新制定規格。僅提示詞能保證的部分標為 policy_only。

`.mawf/settings.json` 是權威使用者設定。角色覆寫與依模式保存的自訂角色不會被
重新計畫抹除。產生檔案放入 `.mawf/generated/`，用原子指標選擇完整版本；
相容檔案只有所有權摘要符合才覆寫。`plan --out DIR` 只寫指定目錄。
排隊或執行中的主任務及後來建立的子任務維持原本模式、設定與政策快照。

舊設定透過 `mawf migrate --dry-run`、`mawf migrate` 匯入，保留完整設定、角色、
標記與符號連結備份。歷史 approved 欄位只作歷史，不變成新授權；僅有安裝目錄不會
自動啟用整合。`mawf migrate rollback` 使用真實備份路徑，設定改變後回復需明確
force。詳見[模式與遷移](docs/V1_MODES.md)。

## 執行與獨立驗收

`mawf run --guide` 明確只輸出指引。預設 `mawf run --task TEXT` 在真實身分及費用
政策允許時啟動受管 Claude 程序，呼叫 `/mawf:run`。完整套件也提供 `/mawf:mode`、
`/mawf:integrations` 與真實角色 frontmatter。就地載入使用
`claude --plugin-dir /完整套件/plugin`；單獨快取 plugin 子目錄不包含所需 Core 與文件。

原生 Agent 必須繼承已登記父程序觀察到的模型、供應商與計費方式。角色定義設定
model:inherit，Agent 工具呼叫省略 model 參數；不能只在提示詞寫模型名稱就算選模。
真實 agentId 是執行實例，未暴露的子 sessionId 或實際模型保持未知。缺少受管父模型
綁定的既有互動式 Slash 工作階段回傳 HOST_MODEL_UNVERIFIED。

帳本用原子租約、fencing token、PID/啟動身分及專案/run 並行上限管理已登記任務。
不因超過 30 分鐘刪除占位；停止無法確認時保留資源。原生控制器有獨立 deadline
keeper，宿主完成回執只涵蓋其真實 Agent 呼叫，不宣稱控制所有未登記背景程序。
詳見[執行期](docs/V1_RUNTIME.md)與[宿主執行](docs/V1_EXECUTION.md)。

produced 不等於 accepted。候選身分涵蓋 commit、dirty、相關未追蹤/建置產物與
生效設定；證據須來自不同作者實例、新執行身分、獨立 oracle 與真實路徑，並保存
原始輸出摘要。程式、設定或證據變動會使舊驗收失效。
[證據格式與門禁](docs/V1_VERIFICATION.md)說明準確介面與可證明的界線。

## 費用與可選能力

未知價格/涵蓋範圍不代表零費用。API 單價推算、歷史匯入與客戶端總額都不等於即時
實付；昂貴選擇需身分相符的核准，strict_measured 在真實涵蓋不足時拒絕。
訂閱登入不證明額度或免費使用。預設未知政策暫停；僅在使用者明確選擇後，才可對已
觀察的原生訂閱身分採用並行/時間受控的未知涵蓋風險政策，仍顯示 basis unknown、
金額 null、額度 unknown。實作與驗收專案不會自動開啟該選項。見[價格政策](docs/V1_PRICING.md)。

可選外掛指定 Kagandi/pi-plugin-cc 與 imBlanker/codex-plugin-cc fork，記錄來源與
固定版本。Pi 啟動前以真實無 prompt 的 get_state 核對模型及供應商，字串歧義不放行。
installed 不等於 ready；未暴露的逐輪身分維持 null。Pi Autoresearch 在獨占 worktree
執行真實有界實驗、保留/回退，保護指標與 oracle，最後仍交獨立 Hacker。
詳見[適配器](docs/V1_ADAPTERS.md)。

## 驗證與發行限制

獨立 Linux 證據涵蓋設定/安裝界線、真實 32 分鐘本機程序、模式隔離、Pi canonical
模型 companion 路徑、真實 Pi 最佳化/keep/停止鏈，以及普通 mode-control 獨立交接。
Windows 本機工作使用 Job Object；原生 Claude 使用獨立 AppContainer 工具，不需 WSL。
先決條件與驗證邊界見 docs/V1_WINDOWS.md；即時實付仍未驗證。

保留並執行 `npm test` 與 `node scripts/test-packed-install.mjs`；舊斷言與未解決失敗
分類記錄，不修改測試以偽造全綠。見[發行狀態](docs/V1_RELEASE_STATUS.md)、
[平台範圍](docs/CROSS_PLATFORM.md)、[架構](docs/ARCHITECTURE.md)、
[上游來源](docs/UPSTREAM_COMPATIBILITY.md)、[變更記錄](CHANGELOG.zh-Hant.md)、
[NOTICE](NOTICE.md)。本機建置與計畫不授權 push、tag、merge 或發佈。
