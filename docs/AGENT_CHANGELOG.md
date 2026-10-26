# Agent Changelog

Machine-oriented release summary for AI agents (installers, upgrade advisors,
coding agents operating this repo). Human narrative: [`../CHANGELOG.md`](../CHANGELOG.md)
(en / zh-Hans / zh-Hant). Rules of record: [`GOVERNANCE.md`](./GOVERNANCE.md) §5.

Package: `multi-agents-workflow` · CLI: `mawf` · Node ≥ 20.17 · zero runtime deps.

## 1.0.1 (2026-10-26; local candidate, unpublished)

```yaml
version: 1.0.1
semver_impact: patch
status: local_candidate_not_published
issue: https://github.com/imBlanker/multi-agents-workflow/issues/43
fixed:
  - "windows archive operations (components install, cc-switch backup, cc-switch snapshot restore) use the system bsdtar (System32 tar.exe) via platform tarCommand regardless of PATH order; under git bash MSYS GNU tar made installs and restores fail and backups silently become copies"
  - "windows extraction never falls back to GNU tar: MSYS GNU tar writes a symlink to an existing file as a copy of it, bypassing the symlink-escape scan"
  - "A20 packed-install gate on windows: CRLF tar listing, --prefix install inside its temp dir, tarball and npm/compile caches kept in temp, cleanup on failure, smoke runs with an isolated HOME"
  - "generic batch test fixture is ASCII-only, so code page 936 cannot garble it"
added:
  - "tests: existing-target symlink escape rejected with nothing copied; .tar.gz backup->restore round trip; per-adapter tar selection"
publication: not_authorized
```

## 1.0.0 (2026-10-14; local candidate, unpublished)

```yaml
version: 1.0.0
semver_impact: major
status: local_candidate_not_published
selection: all_optional_integrations_disabled_by_default
modes: [dynamic, fixed-1]
configuration: .mawf/settings.json
migration: explicit_or_first_plan_reversible_legacy_import
runtime: canonical_fenced_ledger_no_age_based_eviction
acceptance: independent_evidence_bound_to_candidate_and_frozen_policy
cost: unknown_is_not_zero_or_measured; explicit_bounded_native_subscription_risk_optional
limits: [windows_execution_unverified, current_measured_payment_unsupported, claude_real_flow_failed_then_locally_repaired_without_live_recheck]
checks: retained_npm_test_and_packed_install_results_reported_in_V1_RELEASE_STATUS
publication: not_authorized
```

## 0.8.4 (2026-10-10)

```yaml
version: 0.8.4
semver_impact: patch
compatibility:
  cutoff: "tier-1 hosts after the 2026-09-21T23:59:59Z cutoff through 2026-10-10; tiers 2-4 per the upstream registry"
  result: "consumer-affecting window changes adapted (cc-switch schema 19/20 guard, pi-mcp-adapter v5 read face, claude -p permission pinning, guard onFailure block, overlay type filter); theory/architecture items deferred to 0.9"
added:
  - "fixed-cutoff ledger 2026-09-22..2026-10-10 across tiers 1-4; registry baselines refreshed to the locally certified set (claude 2.1.296, codex 0.162.1, pi 1.1.0, dsh 0.2.0-rc.2, pi-mcp-adapter 5.2.0, dsh-web 0.4.5, cc-switch 4.0.6/schema 20, codex-plugin-cc npm 1.1.1)"
  - "prior watches closed: codex mcp list --json shape, compound #1738 (already in lock), trellis-card v0.2.6 (CI-only), dsh Session format (unconsumed surface)"
fixed:
  - "SUPPORTED_CC_SCHEMA 18->20: cc-switch v3.20.4/v4.0.2 add-column migrations no longer trip the unsupported-schema doctor warning (v19/v20 fixture tests added)"
  - "pi MCP read face follows pi-mcp-adapter v5: adapter-owned mcp-adapter.json layers (incl. project disabled persistence), Pi-owned enabled:false/exposure:hidden translation, adapter nine-step order; piprovider reads mcp-adapter.json with whole-entry override; inventory display names match real files"
  - "pi model cache: typed non-chat catalog-overlay entries (image/classifier, pi 0.99+) excluded from chat model lists"
  - "watchdog claude -p pins --permission-mode default (2.1.285 defaults unset headless runs to auto on third-party endpoints; cc-switch proxy path)"
  - "PreToolUse guard declares onFailure block (2.1.295) completing fail-closed semantics"
docs:
  - "AGENT_INSTALL: pi 1.0.1+ npm installs no longer pin transitive deps (shrinkwrap removed); pin explicitly or use the pi.dev managed installer"
deferred_0_9:
  - "claude Mods deep plugins + built-in Workflow tool; pi OSC 7501/aborted/context_edit; codex runReview delegate drift; dsh 0.2.1-alpha surfaces; pi-mcp-adapter host-managed embedding; archify v3.0.x; write-notes; compound v3.30.x; codex-claude-companion rename migration"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.8.4"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version"
evidence_limits:
  local: "suite 527/0/10 at the release commit; live-host checks limited to version probes, dsh --dump-config/plugin-inventory parse, mcp-client settings surface, and the local tier-1/2 update pass (cc-switch GUI 4.0.6 install pending its sudo step)"
  ci: "Ubuntu/Windows x Node 22/24 must pass before release; local runs do not imply CI results"
```

## 0.8.3 (2026-09-21)

```yaml
version: 0.8.3
semver_impact: patch
compatibility:
  cutoff: "tier-1 hosts after the 2026-09-12T23:59:59Z cutoff through 2026-09-21; tiers 2-4 per the upstream registry"
  result: "no newly released host contract required a mawf code adaptation; nothing deferred to 0.9"
added:
  - "authoritative four-tier upstream registry in docs/UPSTREAM_COMPATIBILITY.md; PR template enforces a per-tier upstream tracking checklist; CONTRIBUTING PR flow references the registry"
  - "fixed-cutoff ledger 2026-09-13..2026-09-21 across tiers 1-4; registry baselines and last-checked dates refreshed to 2026-09-21"
changed:
  - "compound-references lock bumped to v3.27.0 @ 65dd958d (provenance only; no bundled bytes change)"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.8.3"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version"
evidence_limits:
  local: "suite 534/524/0/10 at the release commit; live-host checks limited to version probes and the local tier-1/2 update pass"
  ci: "Ubuntu/Windows x Node 22/24 must pass before release; local runs do not imply CI results"
```

## 0.8.1 (2026-09-12)

```yaml
version: 0.8.1
semver_impact: patch
compatibility:
  cutoff: "Claude Code, Codex, Pi, DeepSeek Harness, and Trellis releases after mawf 0.7.2 through 2026-09-12T23:59:59Z"
  result: "no newly released non-TUI host contract required another mawf code adaptation"
fixed:
  - "interactive Trellis init inherits terminal streams and preserves the native TUI; redirected init remains deterministic"
changed:
  - "mawf update/upgrade chain the applicable Trellis lifecycle stages and repair MAWF overlays after project updates"
preserved:
  - "mawf uninstall remains MAWF-only and preserves Trellis-owned and modified Trellis files"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.8.1"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version && mawf inventory --verify"
evidence_limits:
  local: "Windows tests and source/fixture evidence; no fresh live-host or third-party ecosystem certification"
  ci: "Ubuntu/Windows x Node 22/24 must pass before release; local runs do not imply CI results"
```

## 0.6.0 (2026-08-21)

```yaml
version: 0.6.0
semver_impact: minor
added:
  - "grill-brainstorm swap: trellis-brainstorm -> grill-with-docs wrapper (vendored mattpocock/skills @5b15a47 MIT, 2 mawf format amendments); trellis contract preserved; .orig.md backup; clobber detect + mawf update repair; doctor check"
  - "watchdog: stall detection + cross-host rescue (opt-in): signals d>c>a>b, Phase A lossless / Phase B takeover, fixed rotation claude>pi>dsh>codex, rescue workspace, 3-layer budget ($10/incident cap), knowledge reuse, git snapshot gate, never-kill; mawf watchdog [--once|--interval|--dry-run]; init registers ~/.mawf/projects.json (--no-watchdog)"
  - "cc-switch v3.20/cli v5.10.2 (schema v17) follow-up: readCcSwitch surfaces schemaVersion+schemaSupported (doctor schema check; >supported degrades to warn); piManagedByCcSwitch() worldview — managed: db-exact providers/pricing, models.json mirror, no merge on top (no-double-count invariant tested); unmanaged: mergePiIntoCc() fills pi candidates (also fixes empty 'mawf models --app pi'); pi real-spend metering via piSessionUsagePresent() + report() caveats (cache-write may be incomplete) + perSessionRate().errorCount (watchdog signal-d source); mawfSkillsUnderCcSwitch() doctor coexistence check (cc-switch 'skills update'); v17 fixtures (dedup ledger + pi/OpenModel rows + pi-session usage, shapes modeled); vendored fallback prices refreshed from v3.20 catalog"
verified:
  - "real db schema v17 pi-managed (deep-worker, openai-codex; no pi-session rows -> graceful degradation)"
  - "trellis @mindfoldhq/trellis 0.6.15: scratch init --claude --yes clean; platform flags valid; tracker == npm latest"
fixed:
  - "advise.test.js UTC+8-day flake (state write missed clock injection; red on clean main)"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.6.0"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version && mawf inventory --verify"
```

## 0.5.1 (2026-08-20)

```yaml
version: 0.5.1
semver_impact: patch
fixed:
  - "doctor: dsh profile list no longer reports node_modules (pnpm/dsh symlink farm at ~/.dsh/profiles/node_modules) as a profile; new listDshProfiles() in src/dshprovider.js (real dirs only, skips node_modules/dot-entries, missing profiles/ -> []); regression test added"
verified:
  - "compat with DeepSeek Harness (dsh) 0.1.0-rc.8: agent-default-model dump row byte-identical to rc.6; settings.yaml llm-pi-ai.providers schema unchanged; inventory --verify clean over the enlarged plugin table (no dupes); advise scoring intact; no dsh session-store reads (rc.8 SQLite format break = non-issue); wording compliant with rc.8 BRAND_GUIDELINES (descriptive use permitted)"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.5.1"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version && mawf inventory --verify"
```

## 0.5.0 (2026-08-20)

```yaml
version: 0.5.0
semver_impact: minor
added:
  - "mawf inventory [--json] [--verify]: scans ALL installed supported hosts (claude-code/codex/pi/dsh) + project -> .mawf/inventory.json + digest; skills (origin-tagged, realPath-deduped), plugins, marketplaces, MCP (+live status via host CLIs), models (pi merges models-store.json catalogs); init/plan regenerate"
  - "mawf advise [--task] [--difficulty] [--json] [--check-fresh]: deterministic scoring (cap30/skill30/model25/cost15 + stayBonus 8, margin>=10), usable surfaces only; switch -> .mawf/handoff/ brief + exact launch cmd (dsh: kill -9 $(lsof -ti tcp:3080) && dsh web); NEVER executes"
  - "proactive injection: managed block (<=20 lines) in project AGENTS.md+CLAUDE.md; session start + daily first prompt (UTC+8) re-advising via ADVISE-DONE footer; handoff pickup <48h; keep/purge reversible"
  - "e2e tests + docs/ROADMAP.md (10 lesson-backed next-version items)"
changed:
  - "BREAKING: .maw -> .mawf (project workspace, ~/.mawf global manifest, samples, docs); one-time auto-migration at CLI entry (pre-existing .mawf wins; never merges)"
upgrade:
  npm: "npm i -g multi-agents-workflow@0.5.0"
  checkout: "mawf upgrade"
migration: "first command after upgrade auto-renames legacy .maw dirs; see CHANGELOG 0.5.0"
smoke: "mawf doctor && mawf --version && mawf inventory --verify"
```

## 0.4.2 (2026-08-18)

```yaml
version: 0.4.2
semver_impact: patch
fixed:
  - "upgrade refresh inherits the installed host: spawned update runs with MAW_HOST from ~/.maw/installed.json (bare upgrade no longer flips a dsh/pi install to claude-code and purges its assets)"
  - "install is now ADDITIVE across special hosts: MAW_HOST=pi install on a dsh install ships both; manifest records both dirs; bare update keeps every recorded host; explicit removal = uninstall"
  - "npm pkg fix: repository.url normalized"
upgrade:
  npm: "npm i -g multi-agents-workflow@latest"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version"
```

## 0.4.1 (2026-08-18)

```yaml
version: 0.4.1
semver_impact: patch
changed:
  - "upgrade refreshes installed templates by DEFAULT after a successful self-upgrade (npm AND checkout modes); spawns the NEW bin/mawf.js update; opt out with --no-apply-templates; refresh failure degrades to a warning (upgrade still ok)"
fixed:
  - "install/update now remove stale assets from an older install via exact v2-manifest diff + empty-dir pruning (no prefix scan; user files never touched); legacy manifests without files[] are skipped"
upgrade:
  npm: "npm i -g multi-agents-workflow@latest"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version"
```

## 0.4.0 (2026-08-18)

```yaml
version: 0.4.0
semver_impact: minor # breaking command removals within 0.x
breaking:
  - command "`maw` removed → use `mawf` (shim deleted)"
  - slash commands "/maw:* → /mawf:*"
  - skill dirs "maw-* → mawf-* (mawf-loop, mawf-orchestration, mawf-graph, mawf-planner, mawf-cost-guard)"
compat_kept: [".maw/", "~/.maw", "MAW_HOST", "cc-switch maw-backups/", ".pi/agents/maw-*.md"]
fixed:
  - "uninstall/upgrade prefix-scan removes legacy maw-* AND new mawf-* files"
upgrade:
  npm: "npm i -g multi-agents-workflow@latest"
  checkout: "mawf upgrade"
smoke: "mawf doctor && mawf --version"
```

## 0.2.1 (2026-08-18)

```yaml
version: 0.2.1
semver_impact: patch
fixed: ["`--version`/`-v` prints version", "upgrade --dry-run no longer reports upgraded"]
```

## 0.2.0 (2026-08-18)

```yaml
version: 0.2.0
semver_impact: minor # rename release
breaking:
  - "npm name multi-agent-workflow → multi-agents-workflow (old name = unrelated third-party pkg)"
  - "bin maw → mawf (deprecated maw shim kept one release)"
added:
  - "maw upgrade: self-upgrade (git fork-first + npm global modes)"
  - "complete cross-host uninstall; manifest-driven; --keep-config/--purge-config"
  - "DeepSeek Harness (dsh) host support (detect/provider/configgen/installer/doctor)"
  - "model price gate (HITL pause on expensive models)"
  - "GitHub Actions tracker for @mindfoldhq/trellis updates"
  - "cc-switch project feature decoupled (code kept, disabled)"
```

## 0.1.0 (2026-08-05)

```yaml
version: 0.1.0
semver_impact: initial
added:
  - "portable dynamic multi-agent workflow for complex codebases"
  - "architecture selection: loop/orchestrator-workers/multi-agent/graph/dynamic/ultracode"
  - "per-agent config generation; PreToolUse cost-rate guard; Codex review integration"
  - "cc-switch read-only policy + pre-init snapshots; capability-aware model selection"
  - "Pi Agent host support; READMEs en/zh-Hans/zh-Hant; agent install docs"
```
