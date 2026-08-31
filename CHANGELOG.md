# Changelog

All notable changes to **multi-agents-workflow (MAW)** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Agent-oriented summary: [`docs/AGENT_CHANGELOG.md`](docs/AGENT_CHANGELOG.md).

## [Unreleased]

## [0.7.0] - 2026-08-31

### Added

- **Stage-gated plugin-pool judgments (`mawf advise --pool`)** — add/keep/remove/noop verdicts for the batch of project-level MCP servers / skills / plugins across hosts, at every major project stage (graph gate batches / plan review points, ≥2 judgments per stage recorded in `.mawf/runtime/pool-state.json`; doctor WARNs below 2). Declarative catalog `defaults/pool-catalog.json` (schema-v1, forward-only guard) with three seeds — agent-browser, codebase-memory-mcp, codegraph — carrying multi-host footprints from their upstreams (claude-code/codex/pi; dsh detect-only honest-gap), check-then-act install procedures (never clobber), per-artifact no-residue removal checklists, and the D4 exclusion rule: codegraph and codebase-memory-mcp are never recommended together (detected pair → consolidation verdict; both absent → exactly one add, the other an alternate noop). Hysteresis (stayBonus) + removeLookback prevent verdict flapping; knobs overridable in `.mawf/config.yaml` `pool:`. **Advisory-only**: mawf never executes installs/removals — the pool's only write is its state file (invariant-tested). `mawf inventory` gains a read-only `pool` section (per-component detected/not per host with evidence); the managed block grows item 6 (≤20→≤26 lines) and the mawf-run batch loop runs the judgment at stage entry + gates, never mid-batch. Tests 296→316 (the later incumbency-only stayBonus fix keeps the exclusion-group winner stable); README ×3 badge 316.

- **Host-changelog adaptation: claude-code 2.1.238→2.1.251 / codex 0.149.0→0.151.0 / pi 0.84.2→0.84.4 / dsh 0.1.0-rc.8→0.1.2-alpha.2** (audit since the 2026-08-20 dsh rc.8 baseline; full matrix in the task tracker).
  - pi 0.84.3 skills discovery: Markdown skills nested one level inside grouping dirs (`<group>/<skill>.md`) are now discovered in ALL skill dirs (incl. `.agents/skills` surfaces); well-known non-skill markdown (README/AGENTS/CHANGELOG/CONTRIBUTING/LICENSE/NOTICE.md) is excluded everywhere (root-md and grouped scans). Fixes both under- and over-reporting drift vs pi's own discovery.
  - pi 0.84.4 + dsh 0.1.1-rc.1: deepseek vision variants (e.g. `deepseek-v4-flash-vision-exp`) classify `multimodal-generalist` (vision input) via a rule preceding the generic `^deepseek-v` text-only rule.
  - codex 0.151.0 per-repository plugin catalogs: `mawf inventory` additionally scans project `.codex/config.toml` (plugins + mcp_servers, same parse, deduped against the global config; sources `codex-project-config.toml`) and project `.codex/skills`.
  - codex 0.150.0 project trust: doctor `[INFO] codex project trust (managed block)` check + README ×3 note — untrusted codex projects ignore project-level `AGENTS.md`, so the mawf advise managed block needs codex project trust to load there.
  - dsh 0.1.2-alpha.2: `listDshProfiles` + `parseDshPlugins` verified unchanged against a REAL 0.1.2 `--dump-config` (610-line live capture, shipped as a regression fixture); profile unification and web-UI plugin grouping do not touch mawf's parse anchors. Tests 291→296; README ×3 badge 281→296.

- **Reviewer machine default under a codex ChatGPT Pro / Pro-Lite login (+ price-gate subscription exemption).** Machine policy (2026-08-24): when the local Codex CLI is logged in with an OpenAI account whose ChatGPT plan is `pro` or `prolite` (`src/codexplan.js` — reads `~/.codex/auth.json` (or `$CODEX_HOME`) and the id_token `chatgpt_plan_type` claim), the reviewer role defaults to `gpt-5.6-sol` at reasoning effort `low`, recorded as `model_reasoning_effort` in `.mawf/agents/reviewer.json`; `checkPriceGate` gains `coveredByPlan` and reports the assignment `covered:true` (flat-rate subscription — no per-token spend to gate) instead of blocking. Any other login state (API key, free/plus/team, not logged in) keeps the normal capability-aware selection + gate. Never silent: `mawf plan`/`mawf init`/`mawf models` print the login-detected line; configs record `price_gate.covered` + plan id. README ×3 document the exemption.

## [0.6.0] - 2026-08-21

### Added

- **cc-switch v3.20.0 / cc-switch-cli v5.10.2 follow-up (schema v16→v17).**
  - `readCcSwitch()` surfaces `schemaVersion` (`PRAGMA user_version`) + `schemaSupported`; doctor gains a `cc-switch schema` check; a newer-than-supported schema degrades to a warning, never a crash. All read paths verified against a v17-shaped fixture (additive migration — no regression).
  - **pi managed worldview**: `piManagedByCcSwitch()` — when the cc-switch db (schema ≥17) carries pi provider rows, providers/pricing come from the cc-switch db (exact) and `models.json` mirrors what cc-switch wrote; nothing is merged on top (no double counting — invariant tested). When unmanaged, pi providers from `models.json` join the candidate pool via `mergePiIntoCc()` (pricing fills gaps only, mirroring the dsh merge; also fixes `mawf models --app pi` being empty). `readPiAsCc(piManaged)` keeps cc-switch exact pricing on top when managed. Doctor, `mawf models` note, and README x3 state the conditional.
  - **pi real-spend metering**: when cc-switch's Pi (Session) import has rows, pi spend is measured (`piSessionUsagePresent()`), aggregates carry the upstream caveat (cache-write accounting may be incomplete), and `perSessionRate()` gains `errorCount` (status ≥400 or error_message — also the watchdog signal-d source). Without rows, the concurrency-only degradation stands.
  - `mawfSkillsUnderCcSwitch()`: doctor reports mawf-* skills under cc-switch repo management (GUI v3.20+/CLI v5.10+ `skills update` coexistence; informational).
  - Fixture `make-db.mjs` v17/v17NoPi variants: `session_usage_dedup` ledger (modeled shape), pi provider row, OpenModel provider row, pi-session usage rows (modeled placement in `proxy_request_logs`).
  - Vendored fallback prices refreshed from the cc-switch v3.20 catalog (claude-sonnet-5 2/10, deepseek-v4-pro 0.435/0.87, deepseek-v4-flash 0.14/0.28, kimi-k3 3/15) — still tagged as estimates.

### Added (2)

- **Watchdog: stall detection + cross-host rescue (opt-in)** — `mawf watchdog [--once] [--interval 15] [--project P] [--dry-run] [--json]`. Signals d→c→a→b (log error/interrupted counts incl. Pi (Session) import → transcript stall → trailing consecutive errors → permission pending); active sessions only (60-min recency). Two-phase rescue: Phase A lossless-only (read-only + config-class fixes), Phase B takeover on the next host after the 15-min window (transcript handoff, trellis context, codex native resume/fork first-try). Fixed rotation claude→pi→dsh→codex, each host once; exhaustion → human-alert. Dedicated rescue workspace `~/.mawf/watchdog/workspace/` (never watched itself); price-valve model picks; three budget layers (default cost-guard + per-incident $10 cap + price valve, window-attributed spend); knowledge-base reuse (signature → case files, failed fixes never retried as-is); git snapshot before Phase B writes (non-git → diagnose-only); original process NEVER killed (recovery closes incidents); full audit trail + ALERTS.md + optional webhook. `mawf init` registers projects in `~/.mawf/projects.json` (`--no-watchdog` opts out). Doctor: registry/alerts/scheduling checks. Tests 275/275.

- **grill-brainstorm swap**: mawf workspaces replace `trellis-brainstorm` with a wrapper running the vendored grill-with-docs interview (mattpocock/skills @5b15a47, MIT — grilling + domain-modeling, two mawf format amendments carried) while preserving the full Trellis planning contract. One-time stock backup (`.orig.md`), idempotent install, `trellis update` clobber detection + `mawf update` repair, doctor status check. Escape hatch documented.

### Verified

- Real-machine db (schema v17, pi managed: deep-worker + openai-codex, no pi-session rows yet → graceful degradation) and **trellis `@mindfoldhq/trellis` 0.6.15**: scratch `trellis init -u <u> --claude --yes` clean; MAW's platform flags (`--claude/--codex/--pi/--dsh`) still valid; tracker state matches npm latest.

### Fixed

- `tests/advise.test.js` UTC+8-day flake: the state-write call missed its `clock` injection, so the assertion was deterministically red whenever the real date ≠ the hardcoded fake day (failed on clean main).

## [0.5.1] - 2026-08-20

### Fixed

- **doctor: dsh profile list no longer misreports `node_modules` as a profile.** The pnpm/dsh symlink farm that can appear under `~/.dsh/profiles/node_modules` is now excluded by a dedicated `listDshProfiles()` reader (`src/dshprovider.js`): real profile directories only — `node_modules` and dot-entries skipped, missing `profiles/` degrades to `[]`. Regression-tested.

### Verified

- Compatibility with **DeepSeek Harness (dsh) 0.1.0-rc.8**: `agent-default-model` dump row byte-identical to rc.6 (provider/model extraction intact); `settings.yaml` `llm-pi-ai.providers` schema unchanged; `mawf inventory --verify` clean over the enlarged everything-as-a-plugin table (no duplicates); `mawf advise` scoring intact; MAW never reads dsh's session store, so rc.8's incompatible SQLite format is a non-issue; wording complies with rc.8 brand guidelines (descriptive "DeepSeek Harness (dsh)" usage is explicitly permitted).

## [0.5.0] - 2026-08-20

### Added

- **Cross-host inventory** — `mawf inventory [--json] [--verify]`: scans ALL installed supported hosts (claude-code / codex / pi / dsh) plus the project into `.mawf/inventory.json` + a compact digest. Skills (origin-tagged, symlink-deduped by real path), plugins, marketplaces, MCP servers, prompt surfaces, and the full switchable model pool (pi merges `models-store.json` catalogs). `--verify` probes each host's own CLI (`claude mcp list`, `codex mcp list --json`, dsh `--dump-config` everything-as-a-plugin table) for live statuses; UI-only truths (claude plugin enable-state, dsh full plugin/skill list, codex_apps) stay explicitly documented.
- **Cross-host advising** — `mawf advise [--task] [--difficulty 1-5] [--json] [--check-fresh]`: deterministic per-host scoring (capabilityFit/skillMatch/modelFit/costFit + stayBonus hysteresis, margin ≥ 10 to switch), usable surfaces only (failed/pending/disabled never match). On switch: pre-created `.mawf/handoff/<ts>-<from>-<to>.md` brief + the exact launch command (dsh: `kill -9 $(lsof -ti tcp:3080) && dsh web`). Advise never executes anything.
- **Proactive injection** — idempotent managed block (≤20 lines) in the project root `AGENTS.md` + `CLAUDE.md`: any host session re-runs the stay/switch analysis at session start and on the first prompt of each day (UTC+8, freshness state in `.mawf/runtime/advise-state.json`), parses the stable `ADVISE-DONE` footer, surfaces recommendations, fills/picks up handoff briefs (<48h). Reversible: keep by default, `--purge-config` strips.
- e2e CLI tests (full chain + legacy `.maw` migration); `docs/ROADMAP.md` — 10 lesson-backed next-version improvement items.

### Changed

- **`.maw` → `.mawf`** everywhere (project workspace, global manifest dir `~/.mawf`, sample dirs, docs). One-time auto-migration at CLI entry: legacy dirs renamed only when `.mawf` is absent; pre-existing `.mawf` always wins; never merges.
