# 变更日志

**multi-agents-workflow (MAW)** 的所有重要变更记录于此。
格式：[Keep a Changelog](https://keepachangelog.com/)；版本遵循
[SemVer](https://semver.org/)。

## [Unreleased]

## [0.7.0] - 2026-08-31

### Added

- **阶段门控插件池判定（`mawf advise --pool`）**——对项目级 MCP / 技能 / 插件批次跨宿主输出 add/keep/remove/noop 判定，在每个大阶段（graph 门控批次 / plan 审查点）执行，每阶段 ≥2 次判定记录于 `.mawf/runtime/pool-state.json`（低于 2 次时 doctor WARN）。声明式目录 `defaults/pool-catalog.json`（schema v1，前向兼容守卫）带三个种子——agent-browser、codebase-memory-mcp、codegraph——足迹来自各自上游（claude-code/codex/pi 多宿主；dsh 仅可探测的诚实缺口），安装程序一律 check-then-act（绝不破坏既有资产），移除带逐项无残留清单，并执行 D4 互斥：codegraph 与 codebase-memory-mcp 绝不同时推荐（已共存→整合移除；双缺席→只推其一，另一为替代 noop）。滞回（stayBonus）+ removeLookback 防判定抖动；阈值可在 `.mawf/config.yaml` `pool:` 段覆写。**仅建议性**：mawf 绝不执行安装/移除——插件池唯一写入是其状态文件（不变量测试覆盖）。`mawf inventory` 新增只读 `pool` 段（逐组件逐宿主检出状态与证据）；管理块新增第 6 条（≤20→≤26 行），mawf-run 批次循环在阶段入口与门控点运行判定、绝不在批次中途执行。测试 296→316（后续的 stayBonus 仅在位者修复保持排斥组赢家稳定）；README ×3 徽章 316。

- **宿主 changelog 适配：claude-code 2.1.238→2.1.251 / codex 0.149.0→0.151.0 / pi 0.84.2→0.84.4 / dsh 0.1.0-rc.8→0.1.2-alpha.2**（自 2026-08-20 dsh rc.8 基线以来的审计；完整矩阵见任务追踪）。
  - pi 0.84.3 技能发现：分组目录内嵌套一层的 Markdown 技能（`<group>/<skill>.md`）现在在所有技能目录（含 `.agents/skills` 各面）被发现；众所周知的非技能 Markdown（README/AGENTS/CHANGELOG/CONTRIBUTING/LICENSE/NOTICE.md）在根级与分组扫描中一律排除。修复相对 pi 自身发现的少报与多报漂移。
  - pi 0.84.4 + dsh 0.1.1-rc.1：deepseek 视觉变体（如 `deepseek-v4-flash-vision-exp`）通过先于通用 `^deepseek-v` 纯文本规则的规则归类为 `multimodal-generalist`（支持视觉输入）。
  - codex 0.151.0 每仓库插件目录：`mawf inventory` 增扫项目级 `.codex/config.toml`（plugins + mcp_servers，同一解析，与全局配置去重；来源标记 `codex-project-config.toml`）及项目级 `.codex/skills`。
  - codex 0.150.0 项目信任：doctor `[INFO] codex project trust (managed block)` 检查 + README ×3 说明——不受信任的 codex 项目会忽略项目级 `AGENTS.md`，mawf advise 管理块需在 codex 授予项目信任后才会加载。
  - dsh 0.1.2-alpha.2：`listDshProfiles` 与 `parseDshPlugins` 经真实 0.1.2 `--dump-config`（610 行实机捕获，随包作为回归 fixture）验证不变；Profile 统一化与 Web UI 插件分组不影响 mawf 的解析锚点。测试 291→296；README ×3 徽章 281→296。

## [0.6.0] - 2026-08-21

### Added

- **cc-switch v3.20.0 / cc-switch-cli v5.10.2 跟进（schema v16→v17）。**
  - `readCcSwitch()` 暴露 `schemaVersion`（`PRAGMA user_version`）与 `schemaSupported`；doctor 新增 `cc-switch schema` 检查；高于支持版本的 schema 降级为警告、绝不崩溃。全部读路径在 v17 形状的 fixture 上验证通过（加性迁移——无回归）。
  - **pi 托管世界观**：`piManagedByCcSwitch()`——当 cc-switch 数据库（schema ≥17）存在 pi 供应商行时，供应商/定价来自 cc-switch 数据库（精确），`models.json` 镜像 cc-switch 写入的内容；不再叠加合并（无双计——已用不变式测试）。未托管时，来自 `models.json` 的 pi 供应商经 `mergePiIntoCc()` 进入候选池（定价仅填空隙，镜像 dsh 合并；同时修复 `mawf models --app pi` 为空的问题）。`readPiAsCc(piManaged)` 在托管时保住 cc-switch 精确定价。doctor、`mawf models` 注记与三语 README 均改为条件表述。
  - **pi 真实计量**：当 cc-switch 的 Pi (Session) 导入有行时，pi 花费可测（`piSessionUsagePresent()`），聚合携带上游告警（缓存写计账可能不完整），`perSessionRate()` 新增 `errorCount`（状态 ≥400 或 error_message——亦是 watchdog 信号 d 源）。无行时维持仅并发降级。
  - `mawfSkillsUnderCcSwitch()`：doctor 报告处于 cc-switch 仓库管理下的 mawf-* 技能（GUI v3.20+/CLI v5.10+ `skills update` 共存；信息性）。
  - fixture `make-db.mjs` v17/v17NoPi 变体：`session_usage_dedup` 账本（形状为建模）、pi 供应商行、OpenModel 供应商行、pi-session 用量行（放置位置为建模）。
  - vendored 兜底价格按 cc-switch v3.20 目录刷新（claude-sonnet-5 2/10、deepseek-v4-pro 0.435/0.87、deepseek-v4-flash 0.14/0.28、kimi-k3 3/15）——仍标记为估算。

### Added（续）

- **Watchdog：停滞检测 + 跨 host 救援（opt-in）** — `mawf watchdog [--once] [--interval 15] [--project P] [--dry-run] [--json]`。信号 d→c→a→b（日志错误/中断计数含 Pi (Session) 导入 → 转录停滞 → 尾部连续错误 → 权限挂起）；仅活跃会话（60 分钟新近性）。两阶段救援：Phase A 仅无损解阻，Phase A 15 分钟窗口失败后换 host 接续（转录交接、trellis 上下文、codex 原生 resume/fork 先试）。固定轮换 claude→pi→dsh→codex，每 host 一次；遍历完 → human-alert。专属救援工作区 `~/.mawf/watchdog/workspace/`（自身绝不被监视）；价格阀门选模；三层预算（默认 cost-guard + 每事故 $10 硬顶 + 价格阀门，窗口归因记账）；经验库复用（签名 → 案例，失败修复不再原样重试）；Phase B 写前 git 快照（非 git → 只诊断）；绝不杀原进程（恢复即关事故）；完整审计 + ALERTS.md + 可选 webhook。`mawf init` 登记 `~/.mawf/projects.json`（`--no-watchdog` 退出）。doctor：注册表/警报/调度检查。测试 275/275。

- **grill-brainstorm 替换**：mawf 工作区将 `trellis-brainstorm` 换为运行 vendored grill-with-docs 面试的包装器（mattpocock/skills @5b15a47，MIT —— grilling + domain-modeling，携带两处 mawf 格式修正），同时完整保留 Trellis 规划契约。原版一次性备份（`.orig.md`）、幂等安装、`trellis update` 覆写检测 + `mawf update` 修复、doctor 状态检查。逃生门已写入文档。

### 验证

- 真机数据库（schema v17、pi 托管：deep-worker + openai-codex、暂无 pi-session 行→优雅降级）与 **trellis `@mindfoldhq/trellis` 0.6.15**：空白项目 `trellis init -u <u> --claude --yes` 干净通过；MAW 的平台旗标（`--claude/--codex/--pi/--dsh`）仍然有效；tracker 状态与 npm latest 一致。

### 修复

- `tests/advise.test.js` UTC+8 跨天 flake：状态写入调用漏注入 `clock`，导致真实日期 ≠ 硬编码假日期时断言必然变红（在干净 main 上亦失败）。

## [0.5.1] - 2026-08-20

### 修复

- **doctor：dsh profile 列表不再把 `node_modules` 误报为 profile。** 新增专用读取器 `listDshProfiles()`（`src/dshprovider.js`）：仅枚举真实 profile 目录——跳过 `node_modules` 与点前缀目录，`profiles/` 缺失时安全降级为 `[]`。附回归测试。

### 验证

- 与 **DeepSeek Harness (dsh) 0.1.0-rc.8** 兼容性验证通过：`agent-default-model` dump 行与 rc.6 逐字节一致（provider/model 提取不受影响）；`settings.yaml` `llm-pi-ai.providers` 结构不变；`mawf inventory --verify` 在扩容后的 everything-as-a-plugin 表上无重复、无错报；`mawf advise` 评分正常；MAW 从不读取 dsh 会话存储，rc.8 的 SQLite 格式不兼容对 MAW 无影响；措辞符合 rc.8 品牌规范（描述性使用 "DeepSeek Harness (dsh)" 被明确允许）。

## [0.5.0] - 2026-08-20

### 新增

- **跨宿主库存** — `mawf inventory [--json] [--verify]`：扫描本机所有已安装受支持宿主（claude-code / codex / pi / dsh）+ 项目，产出 `.mawf/inventory.json` + 紧凑摘要。技能（带来源、symlink 去重）、插件、marketplaces、MCP、提示词面、完整可切换模型池（pi 合并 `models-store.json` 目录）。`--verify` 探测各宿主自身 CLI（`claude mcp list`、`codex mcp list --json`、dsh `--dump-config` everything-as-a-plugin 表）获取实时状态；仅 UI 可见的真相（claude 插件启用态、dsh 全量插件/技能、codex_apps）显式注明。
- **跨宿主建议** — `mawf advise [--task] [--difficulty 1-5] [--json] [--check-fresh]`：确定性逐宿主打分（capabilityFit/skillMatch/modelFit/costFit + stayBonus 滞回，margin ≥ 10 才建议切换），仅统计可用面（失败/待批准/禁用永不参与）。切换时：预生成 `.mawf/handoff/<时间戳>-<from>-<to>.md` 交接简报 + 确切启动命令（dsh：`kill -9 $(lsof -ti tcp:3080) && dsh web`）。advise 绝不执行任何命令。
- **主动注入** — 项目根 `AGENTS.md` + `CLAUDE.md` 幂等管理块（≤20 行）：任一宿主会话在会话开始与每天（UTC+8）首个提示词时重跑留守/切换分析（新鲜度状态存于 `.mawf/runtime/advise-state.json`），解析稳定的 `ADVISE-DONE` footer，主动呈现建议，填写/接续（<48h）交接简报。可逆：默认保留，`--purge-config` 移除。
- e2e CLI 测试（全链路 + 旧 `.maw` 迁移）；`docs/ROADMAP.md` — 10 项带教训出处的下一版改进项。

### 变更

- **`.maw` → `.mawf`** 全面改名（项目工作区、全局清单目录 `~/.mawf`、示例目录、文档）。CLI 入口一次性自动迁移：仅当 `.mawf` 不存在时改名旧目录；预存 `.mawf` 永远优先；绝不合并。
