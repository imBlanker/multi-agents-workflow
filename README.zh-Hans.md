[English](README.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md)

# MAWF 1.0.0

MAWF 提供显式模式选择、共享任务账本、可选宿主适配和独立候选验收。
当前是本地发布候选，尚未发布到 npm。包名为 `multi-agents-workflow`，
命令为 `mawf`；同名单数包不是本项目。Core 需要 Node >=20.17，
没有 npm 运行时依赖；可选 Pi Autoresearch 1.9.0 需要 Node >=22。

## 从 Core 开始

```sh
node bin/mawf.js init --project /path/to/project --json
node bin/mawf.js integrations list --project /path/to/project --json
node bin/mawf.js plan --project /path/to/project --json
node bin/mawf.js mode fixed-1 --project /path/to/project --json
node bin/mawf.js mode status --project /path/to/project --json
```

新项目默认 dynamic，全部外部集成关闭。配置、计划、模式和任务状态不依赖
宿主、数据库或插件凭据。原生 `.mawf/workspace.json` 标记在生命周期操作中保留。
启用不等于安装、认证、派遣或 ready；选择 Claude 后才安装其所选资源：

```sh
node bin/mawf.js integrations enable host.claude-code --project /path/to/project
node bin/mawf.js install --project /path/to/project
```

安装、更新和卸载遵循精确所有权；关闭项目集成不会删除其他宿主资源或用户文件。
参见[安装指南](docs/AGENT_INSTALL.md)。

## 模式与配置

Dynamic 保留 loop、orchestrator-workers、multi-agent、graph、dynamic、ultracode
及其组合。Fixed mode 1 使用独立的 Claude 主宿主角色策略：主编排委派实施，
实现者不编写测试，至少一名独立 Hacker 完成反例与真实用户路径，任务完成后持续
补位，同根因两次失败后提交事实并重新制定方案。仅提示词能保证的部分标为 policy_only。

`.mawf/settings.json` 是权威用户配置。角色覆盖和按模式保存的自定义角色不会被
重新计划抹掉。生成文件放入 `.mawf/generated/`，通过原子指针选择完整版本；
兼容文件只有所有权摘要匹配才覆盖。`plan --out DIR` 只写指定目录。
排队或运行中的主任务及后来创建的子任务保持原始模式、配置和政策快照。

旧配置用 `mawf migrate --dry-run`、`mawf migrate` 导入，保留完整配置、角色、标记、
设置与符号链接备份。历史 approved 字段只作历史，不变成新授权；仅有安装目录不会
自动启用集成。`mawf migrate rollback` 返回并使用真实备份路径，设置改变后回滚需
显式 force。详见[模式与迁移](docs/V1_MODES.md)。

## 执行与独立验收

`mawf run --guide` 明确只输出指导。默认 `mawf run --task TEXT` 在真实身份和费用
政策允许时启动受管 Claude 进程，调用 `/mawf:run`。完整包还提供 `/mawf:mode`、
`/mawf:integrations` 与真实角色 frontmatter。就地加载使用
`claude --plugin-dir /完整包/plugin`；单独缓存 plugin 子目录不包含所需 Core 和文档。

原生 Agent 必须继承已登记父进程观察到的模型、供应商和计费方式。角色定义设置
model:inherit，Agent 工具调用省略 model 参数；不能在提示词中写模型名就算选模。
真实 agentId 是执行实例，未暴露的子 sessionId 或实际模型保持未知。没有受管父模型
绑定的既有交互式 Slash 会话返回 HOST_MODEL_UNVERIFIED。

账本用原子租约、fencing token、PID/启动身份、项目和 run 并发上限管理已登记任务。
不因超过 30 分钟删除占位；停止无法确认时保留资源。原生控制器有独立 deadline
keeper，宿主完成回执只覆盖其真实 Agent 调用，不宣称控制所有未登记后台进程。
详见[运行时](docs/V1_RUNTIME.md)和[宿主执行](docs/V1_EXECUTION.md)。

produced 不等于 accepted。候选身份覆盖 commit、dirty、相关未跟踪/构建产物与
生效配置；证据必须来自不同作者实例、新执行身份、独立 oracle 与真实路径，并保存
原始输出摘要。代码、配置或证据漂移会使旧验收失效。
[证据格式与门禁](docs/V1_VERIFICATION.md)说明了准确接口和可证明的边界。

## 费用与可选能力

未知价格/覆盖不是零费用。API 单价推算、历史导入和客户端总额都不等于实时实付；
昂贵选择需要身份匹配的审批，strict_measured 在真实覆盖不足时拒绝。
订阅登录不证明额度或免费使用。默认未知政策暂停；仅在用户明确选择后，可对已观察
原生订阅身份采用并发/时间受控的未知覆盖风险策略，仍显示 basis unknown、金额 null、
额度 unknown。实现与验收项目不会被自动开启该选项。见[价格政策](docs/V1_PRICING.md)。

可选插件指定 Kagandi/pi-plugin-cc 与 imBlanker/codex-plugin-cc fork，并记录来源与
固定版本。Pi 启动前用真实无 prompt 的 get_state 核对模型与供应商，字符串歧义不放行。
installed 不等于 ready；未暴露的逐轮身份保持 null。Pi Autoresearch 在独占 worktree
执行真实有界实验、保留/回退，保护指标与 oracle，最后仍交独立 Hacker。
见[适配器](docs/V1_ADAPTERS.md)。

## 验证与发布限制

独立 Linux 证据覆盖配置/安装边界、真实 32 分钟本地进程、模式隔离、Pi canonical
模型 companion 路径、真实 Pi 优化/keep/停止链，以及普通 mode-control 独立换手。
这些范围不代表全部产品已 accepted。Windows v1 进程树、实时实付和完整 Claude
Slash→Agent→独立验收链仍按实际阻断/未验状态报告。

保留并运行 `npm test` 和 `node scripts/test-packed-install.mjs`；旧断言与未解决失败
分类记录，不修改测试来伪造全绿。参见[发布状态](docs/V1_RELEASE_STATUS.md)、
[平台范围](docs/CROSS_PLATFORM.md)、[架构](docs/ARCHITECTURE.md)、
[上游来源](docs/UPSTREAM_COMPATIBILITY.md)、[变更记录](CHANGELOG.zh-Hans.md)、
[NOTICE](NOTICE.md)。本地构建和计划不授权 push、tag、merge 或发布。
