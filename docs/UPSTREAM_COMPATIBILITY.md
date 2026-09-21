# Upstream compatibility through 2026-09-21

## Upstream registry (authoritative)

This registry is the single source of truth for every upstream whose updates can affect mawf. The PR template's upstream tracking checklist and CONTRIBUTING's PR flow reference this section — do not copy the list elsewhere. Tracking policy: an upstream change that does not touch mawf's theory or architecture is tracked directly into the current release; only theory/architecture-level changes are recorded and deferred to the next minor (0.9). Evidence classes P/A/L are defined in the ledger sections below.

| Tier | Upstream | Track line (repo / registry) | mawf consumer | Baseline | Last checked |
| --- | --- | --- | --- | --- | --- |
| 1 host | Claude Code | npm `@anthropic-ai/claude-code`; changelog `anthropics/claude-code` | `claude -p` (`src/watchdog/dispatch.js`), PreToolUse `Agent\|Task` (`plugin/hooks/hooks.json`, `bin/guard.mjs`), installer assets (`src/installer.js`), cost (`src/cost.js`) | 2.1.269 | 2026-09-12 |
| 1 host | Codex | `openai/codex` releases; official changelog | `codex exec`/resume/fork, `mcp list --json` (`src/watchdog/dispatch.js`, `src/inventory.js`) | 0.154.0 | 2026-09-12 |
| 1 host | Pi | npm `@earendil-works/pi-coding-agent`; `earendil-works/pi` releases | canonical agent root, skills/MCP layouts, model cache (`src/piprovider.js`, `src/pi-resources.js`) | 0.85.1 | 2026-09-12 |
| 1 host | DeepSeek Harness (dsh) | npm `@deepseek-ai/dsh`; `deepseek-ai/deepseek-harness` releases | `--profile`, `--dump-config`, positional headless tasks, default model alias (`src/dshprovider.js`, `src/modelcap.js`) | 0.1.5-rc.2 | 2026-09-12 |
| 1 host | Trellis | npm `@mindfoldhq/trellis`; `mindfold-ai/Trellis` tags | `init`/`-y`/platform-flag interactive contract (`src/trellis.js`) | 0.6.17 | 2026-09-12 |
| 2 integration | pi-mcp-adapter | `nicobailon/pi-mcp-adapter` | six configuration layers, same-name overrides, disabled state | 2.33.0 | 2026-09-05 |
| 2 integration | kickstart (pi-subagents-lite) | `orionpax1997/kickstart.pi` | Agent guidance, array tool lists, provider/model frontmatter; not installed — run its scripts per its tutorial when needed | pi-subagents-lite | 2026-09-05 |
| 2 integration | dsh-web | `zhu1090093659/dsh-web` | component-local disabled state, conservative skill discovery, staged preset library | 0.3.20 | 2026-09-05 |
| 2 integration | cc-switch (GUI upstream) | `farion1231/cc-switch` releases, 3.x line | SQLite DB schema (`src/ccswitch.js`), schema 18 cost tables; track line is the GUI upstream — `cc-switch-cli` is a downstream installed tool, not this baseline | 3.20.3 / schema 18 | 2026-09-05 |
| 2 integration | codex-plugin-cc | `openai/codex-plugin-cc` | out-of-process Codex review gate bridge | — | 2026-09-05 |
| 3 lock | archify | fork `imBlanker/archify` ← author `tt-a1i/archify` | locked engine adapter (`src/archify.js`, `src/archify-registry.js`) | 2.17.0-dev.1 @ `c3e15cc` | 2026-09-17 |
| 3 lock | write-notes (notes-board) | fork `imBlanker/write-notes-like-deepseek` ← author `czm15053/write-notes-like-deepseek` | vendored board asset (`vendor/notes-board/`) | @ `2aef219` | 2026-09-17 |
| 3 lock | trellis-card | fork `imBlanker/trellis-card` ← author `czm15053/trellis-card` | managed component; in-app update check disabled in managed mode | 0.2.5 @ `4e24d42` | 2026-09-17 |
| 3 lock | compound-references | `EveryInc/compound-engineering-plugin` | adapted skill references (`skills/`, NOTICE retained) | @ `082c83e` | 2026-09-17 |
| 4 pool | codebase-memory-mcp | `DeusData/codebase-memory-mcp` | optional component pool entry | catalog | — |
| 4 pool | codegraph | `colbymchenry/codegraph` | optional component pool entry (installed locally, outside mawf update scope) | catalog | — |
| 4 pool | agent-browser | `vercel-labs/agent-browser` | optional component pool entry (installed locally, outside mawf update scope) | catalog | — |

### Appendix: concept attributions (not tracked)

Referenced for ideas only — no runtime dependency, updates never affect mawf: Anthropic engineering essays, LangChain/LangGraph, Lilian Weng's agent survey, `mbruhler/claude-orchestration`, `garyqlin/glink-engine`, `milanglacier/pi-dynamic-workflow`. See [NOTICE.md](../NOTICE.md).

## Audit history

### Fixed-cutoff audit through 2026-09-12 (v0.8.1 era)

This fixed-cutoff audit covers every formal Claude Code, Codex, Pi, DeepSeek
Harness (dsh), and Trellis release after mawf v0.7.2 (2026-09-03) through
`2026-09-12T23:59:59Z`. It found no new non-TUI product-code adaptation. The
only release-window product impact, dsh's `deepseek-flash` default/model
contract, was already repaired in v0.8.0. The separate Trellis interactive-init
repair corrects pre-existing mawf behavior; neither new Trellis release caused
it.

`P` means primary official release/registry/changelog/tagged-source evidence;
`A` means archived mawf source/fixture/test evidence; `L` means a live
installed-host check. These rows are `P+A` unless stated otherwise, with no
fresh `L` check. Platform conclusions are source-derived unless a native run
is named.

## Fixed-cutoff formal-release ledger

### Claude Code

Sources: official [npm publication ledger](https://registry.npmjs.org/@anthropic-ai%2fclaude-code)
and [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
There were no official `2.1.262` or `2.1.264` package publications.

| Release (UTC) | Delta, mawf consumer, and platform effect | Response / limit |
| --- | --- | --- |
| `2.1.261` (Sep 4 17:49:34) | Subagent prompt-file/resumed-hook additions do not change top-level `claude -p` in `src/watchdog/dispatch.js`. Native-Windows Remote Control fix is host-owned; no Linux delta. | **No action.** `P+A`; no live host run. |
| `2.1.263` (Sep 6 02:07:58) | Official note says only bug/reliability fixes; no changed contract maps to a mawf consumer on either OS. | **No action.** `P`; substantive detail unavailable. |
| `2.1.265` (Sep 8 19:05:16) | `--plugin-dir` and plugin/MCP fixes do not affect conventional assets copied by `src/installer.js`. Windows AppContainer and Unix path fixes are host-owned. | **No action.** No live plugin certification. |
| `2.1.266` (Sep 8 23:32:32) | Gateway-login revert concerns an environment variable mawf neither sets nor parses; same on both OSes. | **No action.** Authentication stays host-owned. |
| `2.1.267` (Sep 9 18:25:42) | Hook/task fixes preserve exact PreToolUse `Agent|Task` consumed by `plugin/hooks/hooks.json` and `bin/guard.mjs`. Unix containment/Windows CRLF fixes need no adapter change. | **No action.** v0.8.0 guard repair remains valid. |
| `2.1.268` (Sep 10 18:41:11) | Added auth/plugin fields and task-tool changes are not consumed; the guard still consumes only `Agent|Task`. Unix hardening is host-owned. | **No action.** Archived endpoint; no live auth/MCP claim. |
| `2.1.269` (Sep 11 18:12:49) | Host concurrency and headless/plugin/MCP fixes do not change `src/configgen.js`, `src/cost.js`, or `claude -p`. PowerShell lifetime fix is Claude-owned. | **New ledger gap closed; no code action.** No live host run. |

### Codex

Source: official [Codex release inventory](https://api.github.com/repos/openai/codex/releases?per_page=100).
It contains three stable Rust CLIs, fifteen Rust prereleases, the Python SDK,
and one CI-only voice-build release in the window.

| Release (UTC) | Delta, mawf consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.153.3`](https://github.com/openai/codex/releases/tag/rust-v0.153.3) (Sep 4 19:01:32) | Bedrock catalog change is outside `codex exec` consumed by `src/watchdog/dispatch.js`; no OS delta. | **No action.** Historical v0.7.3 endpoint. |
| [`0.153.4`](https://github.com/openai/codex/releases/tag/rust-v0.153.4) (Sep 4 23:25:48) | Host default-model change is compatible: dispatch passes `-m` only when mawf selected one, on both OSes. | **New ledger gap closed; no code action.** Do not pin the old default. |
| [`0.154.0`](https://github.com/openai/codex/releases/tag/rust-v0.154.0) (Sep 9 22:35:38) | `exec`/resume/fork and `mcp list --json` consumed by `src/watchdog/dispatch.js` and `src/inventory.js` remain; removed `mcp-server` is unconsumed. Windows daemon is outside mawf's foreground contract. | **No additional action.** No live MCP claim. |
| [`0.154.0-alpha.6`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.6) (Sep 7 18:03:36) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.7`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.7) (Sep 8 17:44:04) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.8`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.8) (Sep 8 23:15:41) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.10.2`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.10.2) (Sep 9 07:55:45) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.11`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.11) (Sep 9 09:14:16) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.6.1`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.6.1) (Sep 9 11:51:56) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; official order is non-monotonic. |
| [`0.155.0-alpha.1`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.1) (Sep 10 11:53:05) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.2`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.2) (Sep 10 18:02:58) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.2.3`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.2.3) (Sep 11 00:28:26) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.154.0-alpha.6.2`](https://github.com/openai/codex/releases/tag/rust-v0.154.0-alpha.6.2) (Sep 11 01:25:48) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; official order is non-monotonic. |
| [`0.155.0-alpha.3`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.3) (Sep 11 02:35:52) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.3.7`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.3.7) (Sep 11 07:58:14) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.3.8`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.3.8) (Sep 11 09:18:04) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.3.9`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.3.9) (Sep 11 11:51:30) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.155.0-alpha.3.10`](https://github.com/openai/codex/releases/tag/rust-v0.155.0-alpha.3.10) (Sep 11 15:52:58) | Release-only body establishes no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`python-v0.154.0`](https://github.com/openai/codex/releases/tag/python-v0.154.0) (Sep 10 19:51:43) | SDK events/history are unconsumed because mawf imports no Python Codex SDK; no OS effect. | **No action; unconsumed package.** No SDK validation. |
| [`voice-cygwin-108b38cf67cbb731`](https://github.com/openai/codex/releases/tag/voice-cygwin-108b38cf67cbb731) (Sep 10 20:19:50) | CI-only inputs are absent from user packages and have no mawf consumer; not a Windows runtime prerequisite. | **No action; build artifact only.** `P`. |

### Pi

Sources: official [Pi releases](https://github.com/earendil-works/pi/releases)
and [npm ledger](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent).

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.85.0`](https://github.com/earendil-works/pi/releases/tag/v0.85.0) (Sep 4 10:18:28) | SDK/session and provider additions leave the CLI, canonical agent root, resource/MCP layouts, and model cache consumed by `src/piprovider.js` and `src/pi-resources.js` unchanged. Linux musl/seccomp fixes are Pi-owned; no Windows delta. | **No action.** Historical v0.7.3 conclusion retained; `P+A`, no fresh live run. |
| [`0.85.1`](https://github.com/earendil-works/pi/releases/tag/v0.85.1) (Sep 5 12:29:01) | Model and SDK-packaging fixes are additive; supported local SDK/stdio RPC APIs remain unchanged, and mawf imports neither experimental subpaths nor Pi sessions. Node `>=22.19.0` applies on Windows and Linux. | **No release-specific action.** v0.8.0 repaired older directory, metadata, and discovery gaps; no fresh live run. |

### DeepSeek Harness (dsh)

Sources: official [dsh releases](https://github.com/deepseek-ai/deepseek-harness/releases)
and [npm ledger](https://registry.npmjs.org/@deepseek-ai%2Fdsh). All six are
prereleases; `0.1.3-alpha.1` is GitHub-only with no npm artifact.

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.1.3-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1) (Sep 4 11:34:32) | Model discovery expanded, while breaking Session v2/SDK APIs are unconsumed by `src/dshprovider.js`. Windows drive-root and hidden-console fixes are dsh-owned; no Linux counterpart was announced. | **Historical gap closed; no standalone code action.** `P`; source-only, no live claim. |
| [`0.1.3-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) (Sep 7 13:59:29) | Default-tool/persona and subprocess-handle changes are unconsumed; generic provider/model rows remain mawf's boundary. Windows Python startup and cross-platform cleanup fixes are dsh-owned. | **No action.** `P+A`; no live run. |
| [`0.1.5-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-alpha.1) (Sep 8 16:16:04) | Session v3/plugin APIs are unconsumed. Tagged CLI source retains `--profile`, `--dump-config`, and positional headless tasks used by `src/dshprovider.js`, `src/inventory.js`, and `src/watchdog/dispatch.js`. Linux local-build fix is dsh-owned. | **No action.** Keep Session/plugin APIs out of scope. |
| [`0.1.5-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-alpha.2) (Sep 9 14:23:10) | Model-setting, MCP-pagination, minimal-profile, and panel changes do not alter mawf's static composition/resource boundary. Windows folder-picker behavior is dsh-owned. | **No action.** No live MCP/panel claim. |
| [`0.1.5-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) (Sep 10 03:09:00) | New sessions default to `deepseek-official/deepseek-flash`, reaching selection in `src/dshprovider.js` and capability evidence in `src/modelcap.js`. Config is shared; cumulative Windows/Linux process fixes are dsh-owned. | **Action already complete in v0.8.0.** Archived fixtures/tests cover direct-provider/default selection, unresolved/catalog completeness, exact capabilities, and unknown prices. |
| [`0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2) (Sep 10 15:09:34) | Feedback confirmation and delivered-file presentation do not change retained CLI grammar or a mawf parser; no OS delta. | **No action.** `P+A`; no fresh live run. |

### Trellis

Sources: official [npm ledger](https://registry.npmjs.org/%40mindfoldhq%2Ftrellis),
tagged [0.6.17](https://github.com/mindfold-ai/Trellis/tree/v0.6.17), and
[0.7.0-beta.4](https://github.com/mindfold-ai/Trellis/tree/v0.7.0-beta.4).
The GitHub Releases collection is empty; npm publications corroborated by
repository tags define formal releases here.

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| `0.6.17` (Sep 11 17:05:32) | Maintenance changes do not alter `init`, `-y`, platform flags, Node floor, or Python probing consumed by `src/trellis.js`. Windows npm shims and Linux native execution remain adapter-owned. | **No action.** `P+A`; `latest` advanced from historical `0.6.16`. |
| `0.7.0-beta.4` (Sep 11 18:10:13) | Beta sync/generated DSH assets do not alter init, and mawf's fallback selects `@latest`, not `beta`. Launch semantics are unchanged on Windows and Linux. | **No action; prerelease not selected by default.** `P`; no beta live run. |

Trellis's interactive contract is unchanged from `0.6.16`: omitting command-level
`-y` and platform flags opens native selection and requires inherited streams.
mawf's prior always-`-y`, piped-stream behavior was a pre-existing wrapper defect,
not a release regression. v0.8.1 repairs it by preserving the native interactive
TUI while retaining deterministic redirected operation.

## Fixed-cutoff conclusion

All formal releases for the five upstreams are classified above. No non-TUI
mawf code adaptation is required. Windows/Linux differences are host-owned or
continue through the existing shared platform facade. No release was published
on September 12 before the inclusive cutoff.

## Historical v0.8.0 evidence (preserved)

The remainder of this file preserves the v0.8.0-era report as historical
evidence. None of its validation statements is a fresh v0.8.1 run. At that
earlier cutoff, the source update audited changes after the mawf 0.7.3 release
on September 5, 2026 and repaired older integration gaps found by that audit.
It kept one shared core and the existing Linux/Windows adapters; v0.8.0 was
still unreleased at that time.

## Audited contracts

| Integration | Evidence target | mawf response |
| --- | --- | --- |
| Pi | 0.85.1 | Canonical agent directory, valid skill and Agent role metadata, static package/MCP discovery with provenance and trust states |
| pi-mcp-adapter | 2.33.0 | Six documented configuration layers, same-name overrides, disabled state and secret-safe metadata |
| kickstart Pi runner | pi-subagents-lite | `Agent` guidance, array tool lists, provider/model frontmatter, no nested child spawns; external Codex roles remain external |
| DeepSeek Harness | 0.1.5-rc.1 and rc.2 | Saved selection before composed fallback, versioned credential reference names, direct DeepSeek adapter evidence and current default alias |
| dsh-web | 0.3.20 | Component-local disabled state, conservative skill discovery and separate staged preset library |
| Claude Code | 2.1.268 and current hooks reference | Guard intercepts current `Agent` and legacy `Task`; unrelated tools are excluded |
| Codex | 0.154.0 | Existing exec/resume and external MCP-client integration retained; no dependency on removed `codex mcp-server` |
| cc-switch | 3.20.3 / schema 18 | Additive byte-cursor fixture verified; schemas 16/17 and future-version diagnostics retained; no user database migration |
| Trellis | 0.6.16 | Published before the cutoff; existing initialization contract retained |

The missing skill descriptions, canonical Pi directory variable, dsh versioned credential/saved-selection readers, Claude hook matcher and schema 18 declaration are older gaps uncovered here. They are not all new upstream breaking changes after September 5.

## Shared skill repair

The five shipped skills `mawf-cost-guard`, `mawf-graph`, `mawf-loop`, `mawf-orchestration`, and `mawf-planner` now declare YAML `name` and `description` fields. Installer and update fixtures verify the same source assets reach Pi unchanged on either OS. Existing installed copies receive the fix during an explicit template refresh; editing this checkout alone does not alter a user's home directory. The separate Trellis brainstorm wrapper keeps its intentional name.

## Configuration and discovery

Pi home precedence is an explicit caller directory, `PI_CODING_AGENT_DIR`, the legacy mawf `PI_AGENT_DIR` alias, then `~/.pi/agent`. A configured or discovered package is not proof that an extension is loaded. Project resources require Pi trust; testing a disposable project may explicitly approve that project, without setting global trust to always.

Package discovery reads metadata without executing extension code. It covers normal npm, Git and local sources, scoped packages, resource manifests and supported filters. Git URL credentials/query strings are removed from inventory. Static discovery is deliberately incomplete: full ignore-file semantics, advanced brace/class globs, custom MCP paths, foreign-host imports, and live trust decisions require further host evidence. The inventory reports this limitation instead of claiming live readiness.

DSH credential reports expose reference names only, retaining legacy compatibility. Saved model selection wins over composition; an unresolved explicitly selected provider remains unresolved instead of silently switching providers. `deepseek-flash` has only evidenced capability metadata, with unknown pricing unless an exact configured price source exists. DSH spend-rate measurement remains unavailable.

DSH skill rows expose precedence and shadowing for documented default filesystem roots. Custom composed roots and enabled-preset discovery are not inferred. Entries under the preset library are staged, not active agents. JS-tagged dump configuration is never evaluated; component `disabled` metadata is distinguished from nested configuration fields.

## Validation and rollout

Source tests cover skill copies, actual guard matcher dispatch, override precedence, generated roles, package/MCP metadata, credential sentinel redaction, model selection, schema 18 costs/read-only behavior, and Windows/Linux command quoting. Full Windows and Linux regressions are required before committing the source update. Existing Node 20 compatibility belongs to mawf; newer Pi/Claude hosts can require Node 22 or 24.

Real plugin loading, MCP connectivity, authentication, host tool use and the
then-current dsh composed dumps were deferred until after the requested host
installations. These source-derived fixtures did not certify those live
integrations. No host installation, global configuration change, API call or
publication was part of that source-only stage.

## Primary references

- [Pi 0.85.1 documentation](https://github.com/earendil-works/pi/tree/v0.85.1/packages/coding-agent/docs) and [package manager](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/package-manager.ts)
- [Kickstart installation](https://github.com/orionpax1997/kickstart.pi/blob/main/docs/installation.md) and [MCP adapter](https://github.com/nicobailon/pi-mcp-adapter)
- [DSH 0.1.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) and [dsh-web 0.3.20](https://github.com/zhu1090093659/dsh-web/releases/tag/v0.3.20)
- [Claude hook reference](https://code.claude.com/docs/en/hooks) and [Claude changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Official Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [cc-switch schema 18 DDL](https://github.com/farion1231/cc-switch/blob/v3.20.3/src-tauri/src/database/schema.rs)
