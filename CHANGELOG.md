# Changelog

All notable changes to **multi-agents-workflow (MAW)** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Agent-oriented summary: [`docs/AGENT_CHANGELOG.md`](docs/AGENT_CHANGELOG.md).

## [Unreleased]

## [0.8.3] - 2026-09-21

### Added

- Authoritative four-tier upstream registry (hosts / integration contracts / components.lock tools / pool catalog, plus a concept-attribution appendix) at the top of `docs/UPSTREAM_COMPATIBILITY.md`. The PR template now requires a per-tier upstream tracking checklist before every PR, and CONTRIBUTING's PR flow points at the registry as the single source of truth.
- Fixed-cutoff ledger `2026-09-13 → 2026-09-21` across all tiers: Claude Code 2.1.270–2.1.278 (prior-ledger Sep-12 claim corrected), Codex 0.155.0/0.155.1 plus 33 prerelease/artifact rows, Pi 0.86.0/0.86.1 (0.85.1 baseline gap closed), dsh 0.1.6 alphas (npm `latest` stays 0.1.5-rc.2), Trellis quiet; pi-mcp-adapter 2.34.0/2.35.0, dsh-web 0.3.21–0.3.24, cc-switch quiet with an unreleased schema-19 watch, kickstart and codex-plugin-cc quiet; tier-3 lock follow-ups and tier-4 catalog freshness recorded. No product-code adaptation required; nothing deferred to 0.9.

### Changed

- compound-references lock bumped to v3.27.0 @ `65dd958d` (provenance refresh; upstream #1736/#1738 noted; mawf ships an adapted doc port, so no bundled bytes change).

## [0.8.1] - 2026-09-12

### Changed

- Chain Trellis lifecycle operations explicitly: `mawf update` runs `trellis update`, while `mawf upgrade` runs `trellis upgrade` and the applicable Trellis project update. `mawf uninstall` remains MAWF-only and preserves Trellis-owned files.
- Record the fixed-cutoff five-upstream release ledger after mawf v0.7.2 through `2026-09-12T23:59:59Z`. No newly released non-TUI host contract required a mawf code adaptation; third-party ecosystems and fresh live-host certification are outside this audit.

### Fixed

- Preserve Trellis's native interactive init TUI when stdin and stdout are terminals by inheriting terminal streams and omitting prompt-skipping/platform-selection flags. Redirected runs remain deterministic with `-y`, host-aware flags, and captured diagnostics.
- Keep lifecycle recovery deterministic after partial Trellis failures and re-ensure MAWF-managed blocks and the grill overlay after project updates.

### Validation limits

- Local Windows tests are release evidence. Linux adapter regression coverage is present, but native Ubuntu/Windows × Node 22/24 CI must run before release; no fresh third-party or live-host certification is claimed.

## [0.8.0] - 2026-09-12

### Changed

- Maintain one shared application core with separate Linux and native Windows platform modules, selected automatically; both platforms use the same package/plugin version.
- Adapt command discovery and launching, native paths, process/port inspection, and plugin guard execution for Windows while retaining Linux behavior and existing policy/upgrade safeguards.
- Expand CI to Ubuntu and Windows on Node 22 and 24 without installing mawf or dependencies. Native CI and external-host verification remain release gates, not implied test results.
- Document source-only development, platform boundaries, prerequisites, and synchronized releases in [Cross-platform development](docs/CROSS_PLATFORM.md).

### Fixed — upstream host compatibility

- Add required descriptions and names to the five shared mawf skills, with source and Pi installer/update regressions for both operating systems.
- Honor Pi's canonical agent directory and generate supported Agent role metadata; inventory configured package/MCP resources with provenance, filters, disabled/trust state, and redacted Git credentials.
- Emit Pi agent tool allowlists in the plain flow-list format consumed by `pi-subagents-lite@1.13.1`; live installed-runner validation now preserves exact native tool IDs.
- Read dsh versioned credential names and saved default selections correctly; report current DeepSeek adapter/model evidence, shadowed skills and staged presets without fabricated prices or live-readiness claims.
- Match Claude `Agent` and legacy `Task` spawns in the cost guard; quote watchdog Python advice for native Windows and Linux.
- Verify cc-switch schema 18 while preserving older schemas, cost attribution, future-version diagnostics and database write protections.
- Record current upstream contracts and explicitly deferred live checks in [Upstream compatibility](docs/UPSTREAM_COMPATIBILITY.md).

## [0.7.3] - 2026-09-05

### Fixed

- **codex 0.152.0 MCP-name atomicity in `mawf inventory`** — quoted TOML server names (`[mcp_servers."tools.calendar"]`) have been atomic server names since codex 0.152.0 allowed `:` `@` `/` `.` in server names; they are no longer misclassified as dotted-child config detail when a same-prefix server exists (with server `tools` configured, `"tools.calendar"` stays its own server). Genuine TOML sub-sections (`[mcp_servers.<srv>.env]`) are still dropped; package-style names (`:` `@` `/` `.`) are covered by regression tests.

### Added

- **Upstream round-2 host-changelog adaptation: dsh 0.1.2-alpha.2→0.1.2-rc.1 + the 2026-09-05 plugin-rename wave / codex 0.151.0→0.153.3 / pi 0.84.4→0.85.0 / claude-code 2.1.251→2.1.260** (audit since the 2026-08-31 baseline; full matrix in the task tracker).
  - dsh 0.1.2-rc.1: `--dump-config` anchor row re-verified byte-identical; plugin delta (`-dsh-tool-subagent-report`, superseded by two-way `send_message`; `+dsh-session-turn-outline`; `tool-web.config.fetch` default flip) covered by a NEW 630-line real capture `tests/fixtures/dsh-dump-0.1.2rc1.txt`. The 0.1.2a2 fixture is KEPT as the legacy pre-rename plugin-name regression — parse tests run over BOTH.
  - dsh plugin rename wave: `@noob-stupid/dsh-plugin-console` / `@changfenhuang/dsh-genui` / `dsh-drag-and-drop` (git deps → npm registry packages) + `@linxin666/dsh-web-all@0.3.14` sub-plugin namespacing (`@linxin666/dsh-web-all/<x>` ids with nested `config.plugin`) — tests cover renamed bundle origins, zero old-name residue, and namespaced ids; live-verified on the real machine (171 plugins, 0 dupes; doctor / inventory --verify / advise all exit 0).
  - codex 0.153.0: remote-marketplace plugin installs keep the `[plugins."name@market"]` config shape (verified against codex-rs `config/src/plugin_edit.rs`); `[marketplaces.*]` tables are not a plugin surface — regression tests document both.
  - configgen: dsh host notes gain the rc.1 headless output contract (progress streams to stderr; stdout carries only the final result).
  - pi 0.85.0 / claude-code 2.1.251→2.1.260: corpus-audited with code-cited evidence — no mawf impact (TUI/SDK/session-management and permission-rule entries only).
  - Tests 316→321; README ×3 badge 321.

## [0.7.2] - 2026-09-03

### Changed

- **Clean npm release provenance** — republish the same runtime behavior as `0.7.1` from merged, tagged, and clean `main`. The `0.7.1` runtime remains valid, but its npm metadata recorded the pre-merge feature commit because that version was published from a dirty checkout. No runtime behavior changes in `0.7.2`.

## [0.7.1] - 2026-09-03

### Fixed

- **Host-aware cross-host handoff readiness gate** — when `mawf advise` recommends a host switch, the generated handoff brief now records known source/target host facts and requires review of main/subagent models, reasoning/effort, speed/cost, and MCP/skill/plugin/prompt/harness differences. It deterministically recommends direct questions or grilling and the managed `AGENTS.md` / `CLAUDE.md` block forbids treating the switch as ready before the user responds. This is a guidance-level hard gate only: stay/switch scoring, hysteresis, CLI state, and the stable `ADVISE-DONE` footer are unchanged. Tests remain 316 passing.

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

## [0.4.2] — 2026-08-18

### Fixed
- **Upgrade refresh now inherits the installed host** (0.4.2): the spawned `bin/mawf.js update` runs with `MAW_HOST` taken from `~/.maw/installed.json`, so a bare `mawf upgrade` on e.g. a dsh-install machine that also has `~/.claude` no longer re-detects as claude-code and lets the stale-asset cleanup purge the dsh skills.
- **Installing a second special host no longer drops the first** (union semantics): `MAW_HOST=pi mawf install` on a dsh install (or vice versa) now ships BOTH hosts' assets and records both dirs in the manifest — install never silently removes another host's assets; explicit removal stays `uninstall`. A bare `mawf update` on a multi-host machine likewise keeps every recorded host.
- `npm pkg fix`: `repository.url` normalized (no more publish warning).

## [0.4.1] — 2026-08-18

### Changed
- **`mawf upgrade` now refreshes installed templates by default** (npm and checkout modes): after a successful self-upgrade it spawns the NEW `bin/mawf.js update`, so host assets (commands/agents/skills/hooks) match the upgraded CLI without a manual follow-up. Opt out with `--no-apply-templates`; a refresh failure degrades to a warning — the upgrade itself stays successful.

### Fixed
- **Stale assets from older installs are now cleaned up.** `install`/`update` diff the previous v2 manifest against the files the current version writes and remove exactly the leftovers (no prefix scanning — user-added files are never touched), then prune emptied dirs. Fixes the 2026-08-18 incident where a 0.1.0-era install left `maw-*` skills/commands on disk next to the new `mawf-*` set, with a `hooks.json` pointing at a dead `bin/maw.js`, after the CLI itself had upgraded to 0.4.0. Legacy manifests without `files[]` are skipped (uninstall's prefix fallback still covers those).

## [0.4.0] — 2026-08-18

### Breaking
- **The `maw` command is removed.** Use `mawf` (the deprecated `maw` shim shipped in 0.2.0–0.2.1 is gone).
- Claude Code plugin slash commands renamed `/maw:*` → `/mawf:*` (`/mawf:plan`, `/mawf:run`, `/mawf:cost`, `/mawf:doctor`, `/mawf:add-agent`, `/mawf:review`).
- Portable skill bundles renamed `maw-*` → `mawf-*` (`mawf-loop`, `mawf-orchestration`, `mawf-graph`, `mawf-planner`, `mawf-cost-guard`).

### Changed
- Completed the rename sweep: every doc, badge, curl/clone URL, CI script fallback, help banner, and example now says `mawf` / `multi-agents-workflow` (one historical note retained in each README for discoverability).
- Uninstall/upgrade prefix-scan safety net now removes both legacy `maw-*` and new `mawf-*` files, so upgrading from ≤ 0.2.1 uninstalls cleanly.
- `npx multi-agents-workflow@latest install` is the canonical npm install command (package is published).

### Unchanged on purpose (compat with ≤ 0.2.1 installs)
- Project config dir `.maw/`, manifest dir `~/.maw`, env `MAW_HOST`, cc-switch snapshot dir `maw-backups/`, and per-agent pi files `.pi/agents/maw-*.md`.

### Added
- This changelog (English / 简体中文 / 繁體中文) and `docs/AGENT_CHANGELOG.md` for AI agents.

## [0.2.1] — 2026-08-18

### Fixed
- `--version` / `-v` now prints the version; `upgrade --dry-run` no longer reports "upgraded".

## [0.2.0] — 2026-08-18

### Breaking / Rename
- npm name `multi-agent-workflow` → **`multi-agents-workflow`** (the old unscoped name is an unrelated third-party package); bin `maw` → `mawf` (deprecated `maw` shim kept for one release); GitHub repo renamed with 301 redirects.

### Added
- `maw upgrade` self-upgrade command (git fork-first and npm global modes).
- Complete uninstall across all hosts with manifest-driven removal, optional config retention (`--keep-config` / `--purge-config`), and a prefix-scan safety net.
- DeepSeek Harness (dsh) host support: detection, provider/model reader, config generation, installer routing, doctor, docs.
- Model price gate (pause + human approval when a model is expensive); GitHub Actions tracker for `@mindfoldhq/trellis` updates; cc-switch project feature decoupled (code kept, disabled).

## [0.1.0] — 2026-08-05

### Added
- Initial MAW release: portable dynamic multi-agent workflow system for complex codebases — reads cc-switch config, selects architecture (loop / orchestrator-workers / multi-agent / graph / dynamic / ultracode), generates per-agent configs, enforces per-agent and total cost-rate limits via a `PreToolUse` guard, integrates Codex review.
- Capability-aware model selection, cc-switch read-only policy + pre-init snapshots, trellis-init chain, multilingual READMEs (en / zh-Hans / zh-Hant), agent-oriented install docs.
- Pi Agent host support: host detection, provider/model reader without cc-switch, config generation, installer routing, doctor, docs, tests.
