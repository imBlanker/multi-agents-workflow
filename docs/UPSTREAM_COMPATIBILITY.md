# Upstream compatibility through 2026-09-21

## Upstream registry (authoritative)

This registry is the single source of truth for every upstream whose updates can affect mawf. The PR template's upstream tracking checklist and CONTRIBUTING's PR flow reference this section — do not copy the list elsewhere. Tracking policy: an upstream change that does not touch mawf's theory or architecture is tracked directly into the current release; only theory/architecture-level changes are recorded and deferred to the next minor (0.9). Evidence classes P/A/L are defined in the ledger sections below.

| Tier | Upstream | Track line (repo / registry) | mawf consumer | Baseline | Last checked |
| --- | --- | --- | --- | --- | --- |
| 1 host | Claude Code | npm `@anthropic-ai/claude-code`; changelog `anthropics/claude-code` | `claude -p` (`src/watchdog/dispatch.js`), PreToolUse `Agent\|Task` (`plugin/hooks/hooks.json`, `bin/guard.mjs`), installer assets (`src/installer.js`), cost (`src/cost.js`) | 2.1.278 | 2026-09-21 |
| 1 host | Codex | `openai/codex` releases; official changelog | `codex exec`/resume/fork, `mcp list --json` (`src/watchdog/dispatch.js`, `src/inventory.js`) | 0.155.1 | 2026-09-21 |
| 1 host | Pi | npm `@earendil-works/pi-coding-agent`; `earendil-works/pi` releases | canonical agent root, skills/MCP layouts, model cache (`src/piprovider.js`, `src/pi-resources.js`) | 0.86.1 | 2026-09-21 |
| 1 host | DeepSeek Harness (dsh) | npm `@deepseek-ai/dsh`; `deepseek-ai/deepseek-harness` releases | `--profile`, `--dump-config`, positional headless tasks, default model alias (`src/dshprovider.js`, `src/modelcap.js`) | 0.1.5-rc.2 | 2026-09-21 |
| 1 host | Trellis | npm `@mindfoldhq/trellis`; `mindfold-ai/Trellis` tags | `init`/`-y`/platform-flag interactive contract (`src/trellis.js`) | 0.6.17 | 2026-09-21 |
| 2 integration | pi-mcp-adapter | `nicobailon/pi-mcp-adapter` | six configuration layers, same-name overrides, disabled state | 2.35.0 | 2026-09-21 |
| 2 integration | kickstart (pi-subagents-lite) | `orionpax1997/kickstart.pi` | Agent guidance, array tool lists, provider/model frontmatter; not installed — run its scripts per its tutorial when needed | pi-subagents-lite | 2026-09-21 |
| 2 integration | dsh-web | `zhu1090093659/dsh-web` | component-local disabled state, conservative skill discovery, staged preset library | 0.3.24 | 2026-09-21 |
| 2 integration | cc-switch (GUI upstream) | `farion1231/cc-switch` releases, 3.x line | SQLite DB schema (`src/ccswitch.js`), schema 18 cost tables; track line is the GUI upstream — `cc-switch-cli` is a downstream installed tool, not this baseline | 3.20.3 / schema 18 | 2026-09-21 |
| 2 integration | codex-plugin-cc | `openai/codex-plugin-cc` | out-of-process Codex review gate bridge | 1.0.6 | 2026-09-21 |
| 3 lock | archify | fork `imBlanker/archify` ← author `tt-a1i/archify` | locked engine adapter (`src/archify.js`, `src/archify-registry.js`) | 2.17.0-dev.1 @ `c3e15cc` | 2026-09-21 |
| 3 lock | write-notes (notes-board) | fork `imBlanker/write-notes-like-deepseek` ← author `czm15053/write-notes-like-deepseek` | vendored board asset (`vendor/notes-board/`) | @ `2aef219` | 2026-09-21 |
| 3 lock | trellis-card | fork `imBlanker/trellis-card` ← author `czm15053/trellis-card` | managed component; in-app update check disabled in managed mode | 0.2.5 @ `4e24d42` | 2026-09-21 |
| 3 lock | compound-references | `EveryInc/compound-engineering-plugin` | adapted skill references (`skills/`, NOTICE retained) | 3.27.0 @ `65dd958d` | 2026-09-21 |
| 4 pool | codebase-memory-mcp | `DeusData/codebase-memory-mcp` | optional component pool entry | catalog | 2026-09-21 |
| 4 pool | codegraph | `colbymchenry/codegraph` | optional component pool entry (installed locally, outside mawf update scope) | catalog | 2026-09-21 |
| 4 pool | agent-browser | `vercel-labs/agent-browser` | optional component pool entry (installed locally, outside mawf update scope) | catalog | 2026-09-21 |

### Appendix: concept attributions (not tracked)

Referenced for ideas only — no runtime dependency, updates never affect mawf: Anthropic engineering essays, LangChain/LangGraph, Lilian Weng's agent survey, `mbruhler/claude-orchestration`, `garyqlin/glink-engine`, `milanglacier/pi-dynamic-workflow`. See [NOTICE.md](../NOTICE.md).

## Fixed-cutoff formal-release ledger (2026-09-13 → 2026-09-21)

This audit covers every formal release of the five tier-1 hosts after the
v0.8.2-era cutoff (`2026-09-12T23:59:59Z`) through 2026-09-21 (research
pass 2026-09-21T03:40Z, with the same-day on-cutoff npm publication
`pi-mcp-adapter@2.35.0` at 06:45Z included). Tier-2 contracts share the
window; tier-3 entries are judged window-free by new commits after their
locked SHA; tier-4 by latest release versus the pool catalog and this
host. Evidence: `P` primary official registry/release/tag/commit
metadata (live API/atom feed); `A` archived mawf source/contract greps at
`main` @ `645e0aa`; `L` live installed-host checks, measured before and
re-measured after this release's local update pass (claude `2.1.278`,
codex `0.155.1`, pi `0.86.1`, dsh `0.1.5-rc.2`, trellis `0.6.17`,
pi-mcp-adapter `2.35.0`, codex-plugin-pi `0.2.1`, dsh-web `0.3.24`,
cc-switch GUI `3.20.3`, cc-switch-cli `5.10.5`).

### Claude Code

Sources: official [npm publication ledger](https://registry.npmjs.org/@anthropic-ai%2fclaude-code)
and [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
Eight formal publications in the window (`latest` = `next` = `2.1.278`;
`stable` dist-tag remains `2.1.267`). Boundary gap-close: `2.1.270`
(Sep 12 18:52:44Z) published after the audited baseline `2.1.269`; the
prior ledger's "no September 12 publications" claim is corrected here.

| Release (UTC) | Delta, mawf consumer, and platform effect | Response / limit |
| --- | --- | --- |
| `2.1.270` (Sep 12 18:52:44) — outside window, gap-close | Bash permission re-prompt regression fix; interactive permission behavior only. `claude -p` (`src/watchdog/dispatch.js`) and the PreToolUse `Agent\|Task` matcher (`plugin/hooks/hooks.json`, `bin/guard.mjs`) untouched. | **No action.** `P`; prior-ledger claim corrected. |
| `2.1.271` (Sep 14 19:45:19) | Remote fast mode, per-command sandbox `allowed_domains`, subagent `omitClaudeMd`, `--accept-command <sha256>` — additive/interactive; `modelPricing.multiplier` affects managed/gateway pricing, not the cc-synced pricing read by `src/cost.js`. | **No action.** `P+A`. |
| `2.1.272` (Sep 14 23:34:13) | Official note: bug/reliability fixes only; no mapped consumer change. | **No action.** `P`; detail unavailable. |
| `2.1.273` (Sep 15 18:06:34) | Opt-in gateway hint headers, MCP-disconnect notice; `--output-format stream-json` subagent delivery and permission-checker fidelity changes on output mawf already parses — no `claude -p` grammar or verdict-shape change. | **No action.** `P+A`. |
| `2.1.274` (Sep 16 22:36:09) | `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` optional knob (recorded, not consumed); headless/SDK no longer make a per-background-task model call (cost win for watchdog-dispatched runs); hooks `$schema` notice fix leaves the guard contract intact. | **No action.** `P+A`. |
| `2.1.275` (Sep 17 20:20:31) | claude.ai skills/plugins sync opt-outs, plugin install integrity (`npm pack --ignore-scripts`) — host installation flows; conventional assets copied by `src/installer.js` unaffected; `/update-config` `Edit(path)` rules do not touch `src/configgen.js` output. | **No action.** `P+A`. |
| `2.1.276` (Sep 18 01:39:31) | Single gateway-proxy regression fix on the `ANTHROPIC_BASE_URL` request path mawf neither sets nor ships. | **No action.** `P`. |
| `2.1.277` (Sep 18 16:22:26) | AGENTS.md fallback read (additive); `claude -p` internal errors now report and exit 1 instead of hanging — strictly narrows the failure surface consumed by `src/watchdog/dispatch.js`; stray Haiku auto-title spend removed from non-SDK `-p`; deprecated TaskOutput removed (unconsumed). | **No action.** `P+A`. |
| `2.1.278` (Sep 19 01:48:59) | Server-side classifier for interactive auto mode (opt-out env) with billing notice — outside the headless `-p` contract; `/status` row is TUI. | **No action.** `P`. Local `L`: upgraded to `2.1.278` in this release's update pass. |

As of cutoff: stable latest `2.1.278`; no separate prerelease channel.

### Codex

Source: official [release inventory](https://api.github.com/repos/openai/codex/releases?per_page=100)
corroborated by the npm ledger. Two stable Rust CLIs, 32 Rust prereleases
(every alpha body is the bare line "Release x.y.z" — deltas unresolved by
construction; official order is non-monotonic, including patched
`alpha.x.y` tags), and one CI-only build artifact. No `python-v*` release
in the window.

| Release (UTC) | Delta, mawf consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.155.0`](https://github.com/openai/codex/releases/tag/rust-v0.155.0) (Sep 17 23:14:43) | Experimental `/voice`, TUI reasoning summaries, daemon update schedules, Bedrock credential commands, tmux/MCP-OAuth/approval hardening; session-start hooks distinguish forked sessions (#44349 — mawf ships no codex hooks). Consumed contracts unchanged: `codex exec [resume\|fork <id>] --` and `-m` (`src/watchdog/dispatch.js`), `codex mcp list --json` (`src/inventory.js`); no JSON schema break announced. | **No action.** `P+A`; live `mcp list --json` shape re-check rides the local update pass. |
| [`0.155.1`](https://github.com/openai/codex/releases/tag/rust-v0.155.1) (Sep 18 20:03:04) | TUI-only reasoning-summary default fix; non-interactive `codex exec` out of scope. | **No action.** `P+A+L` (local already `0.155.1`). |
| `rusty-v8-v152.2.0` (Sep 16 12:58:44) | CI/dependency build artifact (rusty_v8 static library); absent from user packages on any OS. | **No action; build artifact only.** `P`. |
| `0.155.0-alpha.4` (Sep 14 11:48:08) | Release-only body; no stable consumed or OS contract. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.2.4` (Sep 14 23:04:27) | Release-only body; order non-monotonic. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.5` (Sep 15 00:31:51) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.6` (Sep 15 02:00:26) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.7` (Sep 15 21:09:02) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.8` (Sep 15 22:26:34) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.9` (Sep 16 01:34:34) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.2.5` (Sep 16 13:17:47) | Release-only body; order non-monotonic. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.10` (Sep 16 04:20:06) | Release-only body; order non-monotonic. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.11` (Sep 16 17:13:20) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.12` (Sep 16 18:25:35) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.2.6` (Sep 16 20:03:32) | Release-only body; order non-monotonic. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.13` (Sep 16 21:43:35) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.14` (Sep 16 23:06:38) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.15` (Sep 17 01:21:10) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.16` (Sep 17 04:34:06) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.17` (Sep 17 21:16:29) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.18` (Sep 17 22:37:07) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.1` (Sep 18 00:23:01) | New 0.156.0 prerelease line; release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.155.0-alpha.9.2` (Sep 18 03:09:42) | Patched alpha; order non-monotonic. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.2` (Sep 18 04:56:20) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.3` (Sep 18 18:20:37) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.4` (Sep 18 21:18:45) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.5` (Sep 19 00:22:35) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.6` (Sep 19 02:18:41) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.7` (Sep 19 04:08:15) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.8` (Sep 19 17:20:24) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.9` (Sep 20 00:17:45) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.10` (Sep 20 21:18:52) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.11` (Sep 20 22:49:40) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| `0.156.0-alpha.12` (Sep 21 00:06:46) | Release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |
| [`0.156.0-alpha.13`](https://github.com/openai/codex/releases/tag/rust-v0.156.0-alpha.13) (Sep 21 02:15:06) | Newest tag at the research cutoff; release-only body. | **No action; prerelease unsupported.** `P`; detail unresolved. |

As of cutoff: stable latest `0.155.1`; newest prerelease
`0.156.0-alpha.13`.

### Pi

Sources: official [Pi releases](https://github.com/earendil-works/pi/releases)
and [npm ledger](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent).
The window closes the full baseline gap: `0.85.1` is followed directly by
`0.86.0` and `0.86.1`, both stable; no prerelease ahead of `0.86.1`.

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.86.0`](https://github.com/earendil-works/pi/releases/tag/v0.86.0) (Sep 19 23:14:16 npm) | Prompt cache warming, `/bug`, transcript-aware `before_agent_start`, offline Radius model catalog overlay, per-model compaction budgets. **Breaking changes confined to the extension/custom-provider API** (normalized `TranscriptContext`, JSON-compatible tool arguments, fail-closed `user_bash`) — mawf ships no Pi extension or custom provider, so that surface is outside mawf's boundary. Agent-root files read by `src/piprovider.js` (`settings.json`, `models.json`, `models-store.json`, `mcp.json`, `auth.json`) and the resource layouts read by `src/pi-resources.js` unchanged; catalog content churn is data consumed generically by id-driven rules in `src/modelcap.js`. | **No action.** `P+A`; exact `models-store.json` cache-schema drift under the Radius overlay unresolved — watch at the next release. |
| [`0.86.1`](https://github.com/earendil-works/pi/releases/tag/v0.86.1) (Sep 20 11:16:39 npm) | Meta provider via `/login` (additive row); Node persistent compile cache (host-owned); `/bug`, clipboard, z.ai context-overflow, Cerebras tool-schema fixes. No consumer-layout change. | **No action.** `P+A+L` (local `0.86.1`; never downgrade to 0.85.x). |

As of cutoff: stable latest `0.86.1`; no newer prerelease.

### DeepSeek Harness (dsh)

Sources: official [dsh releases](https://github.com/deepseek-ai/deepseek-harness/releases)
and [npm ledger](https://registry.npmjs.org/@deepseek-ai%2fdsh). Both
window releases are prereleases; npm `latest` remains `0.1.5-rc.2` — no
stable/rc advance in the window.

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| [`0.1.6-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1) (Sep 15 03:23:13 npm) — prerelease | Headless additions strictly additive to the grammar mawf consumes (`--profile headless <prompt>` positional retained): stdin task input, `--session-id` resume, `--json` events. Migration notes (Messages-protocol default for DeepSeek, PTC rename, async `agent/created`, deprecated sync Session APIs) are host-owned wire/internals; provider/model rows still arrive via `dsh --profile <p> --dump-config` parsed by `src/dshprovider.js`. | **No action; prerelease unsupported.** `P+A`. Watch at 0.1.6 rc/stable: dump-config provider-row shape under the Messages default. |
| [`0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2) (Sep 17 13:30:16 GitHub) — prerelease | Plugin manager with runtime dependency resolution/unload — potentially touches the manifest reading in `src/dsh-plugin-inventory.js`; manifest format change not specified (detail unresolved). Default model list removes V4 Flash / V4 Flash Vision Exp — id-driven rules in `src/modelcap.js` go dormant, not broken; `agent-default-model` selection contract unchanged. New `dsh <profile>` launch syntax additive. | **No action; prerelease unsupported.** `P+A`. Watch at 0.1.6 rc/stable: plugin-inventory format and default-model list contents. |

As of cutoff: stable latest `0.1.5-rc.2` (unchanged); newest prerelease
`0.1.6-alpha.2`. Local `L`: `0.1.5-rc.2` after this release's update pass
(from a stale `0.1.2-rc.1`).

### Trellis

Sources: official [npm ledger](https://registry.npmjs.org/%40mindfoldhq%2Ftrellis)
and [tags](https://github.com/mindfold-ai/Trellis/tags). No publication,
tag, or commit since 2026-09-13.

| Release (UTC) | Delta, consumer, and platform effect | Response / limit |
| --- | --- | --- |
| (none in window) | No `0.6.18`/new beta activity. The `init`/`-y`/platform-flag interactive contract consumed by `src/trellis.js` is unchanged; the v0.8.1 interactive-init repair stands. | **No action.** `P+A+L` (local `0.6.17`). |

As of cutoff: stable latest `0.6.17`; newest prerelease `0.7.0-beta.4`
(both unchanged; mawf's fallback selects `@latest`, not `beta`).

### Tier-2 integration contracts

| Contract | Window finding | mawf consumer effect | Response / limit |
| --- | --- | --- | --- |
| pi-mcp-adapter | `v2.34.0` (Sep 14 20:53) and `v2.35.0` (Sep 21 06:45, on-cutoff tail); releases note faster startup, OAuth Client ID Metadata Documents, opt-in `encrypted-file` credential store, and state "existing configurations continue to work". Repo releases list lacks a `v2.33.0` entry while the tag exists — baseline per tag; reason unresolved. | Six configuration layers, same-name overrides, disabled state: intact (additions opt-in). | **No action.** `P+L` (local `2.35.0` after the update pass). |
| kickstart (pi-subagents-lite) | No commits/releases since Sep 9 (pre-window). | None. Not installed by policy — run its scripts per its tutorial when needed. | **No action.** `P`. |
| dsh-web | `v0.3.21` (Sep 12, boundary), `v0.3.22` (Sep 13), `v0.3.23` (Sep 16), `v0.3.24` (Sep 20): no breaking migrations, no renamed persistent identifiers; tool-family pagination with on-demand `tool_activate` is runtime presentation; presets sync to `~/.dsh/.agent-presets` at boot, reinforcing staged semantics. | Component-local disabled overrides, conservative skill discovery, staged preset library: intact. | **No action.** `P+L` (profile web bundle `@linxin666/dsh-web-all` updated to `0.3.24`; effective next profile boot). |
| cc-switch (GUI upstream) | No release in window (= baseline `v3.20.3`, Sep 11). Unreleased main line adds a schema 18→19 additive migration (`06082e18`, #7383, Sep 15: idempotent `enabled_mcode` column on `mcp_servers`/`skills`). | Read-only consumption on schema 18 (`src/ccswitch.js`) unaffected. | **No action; watch.** `P+A`. Re-check read-only paths when a release ships schema 19. Downstream cc-switch-cli updated `5.10.4 → 5.10.5` locally, outside this baseline. |
| codex-plugin-cc | No release (`v1.0.6`, Jul 8); no commits since Sep 13. | Subprocess review-gate contract unchanged. | **No action.** `P`. |

### Tier-3 components.lock follow-up (window-free)

| Component (locked) | New upstream activity | mawf consumer effect | Response |
| --- | --- | --- | --- |
| archify (`c3e15cc` = 2.17.0-dev.1) | +8 commits: delta arrowhead fix (#434), fast-uri dependency fix (#347), six docs/ci; no new release. | IR/render contracts untouched. | **Record only; lock not bumped.** `P`. |
| write-notes (`2aef219`) | +1 commit `a6073d39` (Sep 17): DSH note-format sync, import auto-seal. | Format-contract impact unresolved. | **Record only; lock not bumped.** `P`. Diff check delegated to the P2 persistent-knowledge work as a precondition. |
| trellis-card (`4e24d42` = 0.2.5) | +2 commits; released `v0.2.6` (rpm CI + version bump only). | None; in-app update check stays disabled in managed mode. | **Record only; lock not bumped** (zero-risk alignment available if wanted). `P`. |
| compound-references (`082c83e`) | +11 commits; released `compound-engineering-v3.27.0` (Sep 19) including #1736 (extract-metadata resumed-session preamble fix) and #1738 (manual-only skills stay manual-only on Codex). | mawf ships an adapted doc port — CE-format semantics captured by the `mawf knowledge` CLI, not upstream tooling — so no bundled bytes change; the provenance refresh keeps the lock current. | **Lock bumped to 3.27.0 @ `65dd958d` in this release**; registry tests green; knowledge CLI roundtrip smoke re-run at the release commit (create/search/verify/CAS update/verify-doc OK). #1738 noted for the four-host skill injection work. `P+A`. |

### Tier-4 pool catalog freshness

| Component | Latest (UTC) | Local / catalog delta | Response |
| --- | --- | --- | --- |
| codebase-memory-mcp | `v0.11.0` (Sep 15; 171 merged PRs) | Catalog entry to verify against. | **Record only.** `P`. |
| codegraph | `v1.6.0` (Aug 26, out of window) | Local `1.5.0` — pre-existing gap, not window news. | **Record only; no local update (outside this release's scope).** `P`. |
| agent-browser | `v0.38.1` (Sep 16; `v0.38.0` + `v0.38.1` in window) | Local `0.33.2` — five minors behind. | **Record only; no local update (outside this release's scope).** `P`. |

### Fixed-cutoff conclusion (2026-09-21)

All formal tier-1 releases in the window are classified above. No release
requires a mawf product-code adaptation, and nothing rises to a
deferrable theory/architecture concern. The single product action in this
release is the compound-references lock bump (provenance only; no
behavior change). Watch items carried to the next milestone: Codex
`mcp list --json` live shape; Pi `models-store.json` cache-schema drift
under the Radius overlay; dsh 0.1.6 plugin-inventory format versus
`src/dsh-plugin-inventory.js` and default-model list versus dormant
`src/modelcap.js` rules; cc-switch schema 19 read-only recheck once
released; write-notes `a6073d39` diff check (P2 precondition); and
compound #1738 for the four-host skill injection work. Platform deltas in
the window are host-owned throughout.

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
