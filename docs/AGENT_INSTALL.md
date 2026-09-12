# MAW — Agent Install & Configure Guide

> Read this end to end. Do not summarize it. This is the machine-facing guide an
> agent follows to install, configure, and use MAW on behalf of a human user.
> Human-facing overview: [`README.md`](../README.md).

## 0. Identity & scope
- MAW = `multi-agents-workflow`, CLI `mawf`, MIT, zero runtime deps (Node ≥ 20.17).
- **Supported hosts: Claude Code, Codex, Pi Agent, and DeepSeek Harness (dsh).** If the user runs Gemini CLI / opencode / others, tell them MAW does not support their host.
- Repo: <https://github.com/imBlanker/multi-agents-workflow>

## 1. Fork-first (ask the user)
Recommend the user **fork** the repo first and clone their fork. Make personal changes in their fork; send insights/bugs as issues to upstream. If the user just wants to try it, you may clone upstream directly, but still flag the fork recommendation. Fork: <https://github.com/imBlanker/multi-agents-workflow/fork>.

## 2. Install
```bash
git clone https://github.com/<user-or-you>/multi-agents-workflow.git
cd multi-agents-workflow
npx . install          # or: node bin/mawf.js install
```
- Copies commands/agents/hooks/skills into Claude Code (and Codex agents, best-effort; Pi skills/prompts into `~/.pi/agent/` when pi is the host; dsh skills into `$DSH_HOME/skills` when dsh is the host). Install is ADDITIVE across special hosts (0.4.2): a later `MAW_HOST=<pi|dsh> install` adds that host's assets without removing another host's; explicit removal is `uninstall`.
- Non-destructive: `uninstall` removes only `maw-*` files.
- If `npx .` is unavailable, run `node bin/mawf.js install`.

### 2b. DeepSeek Harness (dsh) host setup (only when the user runs dsh)

Prerequisites: Node ≥ 20.17, `npm i -g @deepseek-ai/dsh` (verify `dsh --version`).

1. **Providers/models** — dsh is NOT cc-switch-managed. Configure via `dsh web` → Settings → Models, or edit `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml`) directly. Custom OpenAI-compatible provider example:

   ```yaml
   llm-pi-ai:
     providers:
       my-gateway:
         baseURL: https://gateway.example/v1
         api: openai-completions
         apiKeyEnv: GATEWAY_API_KEY
         models:
           - id: vision-preview
             input: [text, image]
   ```

   Keys live in `~/.dsh/.credentials.yaml` (write-only; referenced by `apiKeyEnv`). Renaming a provider id is not supported — add a new one and delete the old.
2. **Install MAW assets**: `npx . install` on a dsh host copies MAW skills into `$DSH_HOME/skills` (rank-400 user root). No prompts/commands surface exists on dsh — role specs stay portable under `.mawf/agents/`.
3. **Init**: `MAW_HOST=dsh mawf init -u <user>` (or set the env before any maw command) — writes `.mawf/`, skips cc-switch profile creation for dsh, and chains Trellis init. In an interactive terminal, use Trellis's native platform picker and select dsh; in a redirected/non-interactive run, MAW preselects `--dsh` (shared `.agents/skills/` + dsh-private `.dsh/skills/` entry skills + `.dsh/DSH.md`).
4. **Plan/run**: `mawf plan --project .` then run one orchestrator session via `dsh web` (choose the project workspace) or `dsh --profile headless "<task>"`; spawn workers with dsh's subagent tool using `.mawf/agents/<role>.md` as the payload.
5. **Troubleshooting**: `MISSING_CREDENTIAL` → store the key via the Models page or export the `apiKeyEnv` variable; `UNKNOWN_MODEL` → select a configured model or add it to the custom provider's `models` list.

## 3. Doctor (environment + policy check)
```bash
node bin/mawf.js doctor
```
Verify: Node ≥ 20, git, **host = claude-code | codex | pi | dsh**, cc-switch DB found (read-only), model pricing loaded, **routing policy compliant** (N/A for pi/dsh — they are not cc-switch-managed), codex+codex-plugin-cc available (pi/dsh hosts use native subagents instead), trellis detectable. On dsh also check: providers parsed from `~/.dsh/settings.yaml`, default model, credential key names, agent preset, pricing-sync match rate. Warnings are non-fatal; fix what you can.

## 4. cc-switch policy (HARD RULES — do not violate)
- All existing cc-switch data is **read-only**.
- **Before every `mawf init`, a packaged snapshot of ALL cc-switch config files is taken** → `~/.cc-switch/maw-backups/cc-switch-snapshot-<timestamp>.tar.gz` (directory copy + sha256 manifest if `tar` is unavailable). Mention the snapshot path to the user.
- **Project functionality is DECOUPLED by default** (2026-08-12): cc-switch's "project" feature (`profiles`) is incomplete, so MAW no longer reads/writes profiles. MAW manages project-level agent/subagent model configs itself in `.mawf/agents/*.json` and only **syncs provider config info read-only** (the high-value settings in each provider's `config.toml`/`config.json`: base_url, model, auth_mode, failover …). The legacy `MAW: <project> (<user>)` profile create/reuse is disabled unless `MAW_CC_PROJECT_SYNC=1` is set — then it creates a **NEW** profile only (never modifies existing ones).
- **NEVER** touch any profile whose name contains `默认` (e.g. `Claude Code 默认`, `Codex 默认`). The engine hard-refuses this; you must not bypass it.
- Routing (checked by `mawf doctor` / `mawf routing`; applied by `mawf routing --fix`, writing ONLY `proxy_config` for claude/codex):
  - **Claude Code:** local routing **always ON** + auto-failover **always ON**.
  - **Codex:** OpenAI-OAuth (ChatGPT) login in use → local routing **OFF**; otherwise **ON**.
  - **Pi Agent:** N/A — pi is **not** cc-switch-managed; providers/MCP/skills live in `~/.pi/agent/`.
  - **DeepSeek Harness (dsh):** N/A — dsh is **not** cc-switch-managed; providers/models live in `$DSH_HOME/settings.yaml` (`llm-pi-ai.providers`), MCP via dsh patch layers. Never write routing or profile rows for dsh.
- **Model price gate (HITL, mandatory):** assigning a model with **Input > $2/1M Tokens or Output > $10/1M Tokens** pauses the work and reports to the human first — `mawf plan`/`mawf init`/`mawf add-agent` exit 3 with a ⚠ PRICE GATE report; `mawf guard`/`mawf acquire` deny gated roles until `mawf approve-model --role <role> --yes` (or a cheaper model, or `--allow-pricey`).

If `mawf routing` reports violations, run `mawf routing --fix` (after the user consents — it writes to their cc-switch). For Claude Code, routing+failover should be ON; if off, fix it.

## 5. Initialize the project (chains trellis)
```bash
mawf init -u <user-name>
```
This: (a) **snapshots all cc-switch config** to `~/.cc-switch/maw-backups/`, (b) writes `.mawf/` configs (paused with a ⚠ PRICE GATE report + exit 3 if any model assignment is expensive — resolve via `mawf approve-model --role <role> --yes` or a cheaper model, then re-run), (c) notes that cc-switch project-profile sync is DECOUPLED by default (`MAW_CC_PROJECT_SYNC=1` re-enables), (d) checks the routing policy, (e) **automatically runs `trellis init -u <user-name>`** as the mandatory next step.

When both stdin and stdout are terminals, MAW gives Trellis direct access to stdin/stdout/stderr and does not pass Trellis `-y` or MAW-selected platform flags. Guide the human through Trellis's native selectable prompts; output is live, and the MAW log records command metadata plus the final result rather than a TUI transcript. If either stream is redirected, MAW runs Trellis non-interactively with `-y` plus host-aware platform flags and captures stdout/stderr in the log so automation cannot wait for input. The npx fallback may show its own `--yes` before the package name; that approves package acquisition and is distinct from Trellis's prompt-skipping `-y`.

**trellis conflict handling** (see README §8): if trellis touches a MAW-managed file, MAW pauses, prints the conflict + overview + log path (`.mawf/logs/trellis-init-*.log`), and asks the user to choose `[m]` keep MAW / `[t]` keep trellis / `[r]` re-run trellis. Apply the user's choice and resume. In a non-interactive context, surface the conflicts + log and let the user decide.

Use `mawf init -u <user> --no-trellis` only as an intentional opt-out when you must skip the Trellis chain. Redirected CI and automation are supported without this flag.

## 6. Plan
```bash
mawf plan --project .
# with explicit signals:
mawf plan --project . --task-type coding --risk high --parallel 6 --value high --context large
```
Reads `.mawf/workflow.json` + `plan.md` + `agents/*.json`. Report the chosen **primary architecture**, the **agents** (role→model), **cost limits**, and **review gates** back to the user.

### 5b. Explain the model choices (capability-aware)
```bash
mawf models            # capability view of all provider models + per-role assignments
```
Models differ WITHIN a leaderboard (some agentic models are full-multimodal; some are reasoning/dialogue-only; some multimodal models are not agentic). MAW classifies every available provider model (curated catalog, `estimated:true`), drops models unfit for each role, then ranks by **capability fit → provider remaining quota/balance → cost rate** (quota = cc-switch daily/monthly limits − `usage_daily_rollups` spend; unknown when no limit). Each `agents/*.json` embeds the full `model_selection` record (chosen provider+model, fit, quota, price, reasons, alternates) — walk the user through it.

## 7. Run (host-driven)
```bash
mawf run
```
The host (Claude Code) reads the batches, and **before each spawn** checks `mawf guard`, then `mawf acquire --id <id> --role <role>` / `mawf release --id <id>` around each subagent run. At review gates, `mawf review --after post-implementation` (invokes Codex via codex-plugin-cc; risk-gated).

## 8. Cost
```bash
mawf cost        # real USD/min from cc-switch logs
mawf guard       # ALLOW/DENY a new spawn
```
Defaults: $5/min per agent, $10/min total, max concurrency 16. Edit `.mawf/config.yaml` to change.

## 9. Graceful degradation
- No codex/codex-plugin-cc → MAW uses a **second Claude Code agent** as reviewer for risk ≥ medium.
- No cc-switch DB → pricing unavailable, cost guard uses concurrency-only limiting.
- trellis not installed → MAW prints the exact command to install/run it.
- **dsh host specifics** → providers/models from `~/.dsh/settings.yaml` (never cc-switch); spend rate not measured (no proxy) → cost guard is concurrency-only, but the price gate uses cc-switch's auto-synced `~/.cc-switch/model-pricing.json` where model ids match (unmatched ids price as unknown → human approval). No named agent files: spawn workers via dsh's subagent tool with `.mawf/agents/<role>.md` as the payload. `MISSING_CREDENTIAL`/`UNKNOWN_MODEL` errors come from dsh itself — fix the provider in `dsh web` → Settings → Models (or edit settings.yaml), not in cc-switch.

## 10. Uninstall / update
```bash
npx . uninstall     # removes EXACTLY what install wrote (manifest-driven, all
                    # hosts — incl. the non-maw-* plugin agents/hooks), prunes
                    # dirs it emptied; project .mawf/ configs are KEPT
npx . uninstall --purge-config [--project <dir>]
                    # also deletes <dir>/.mawf/ and .pi/agents/maw-*
                    # (never trellis-*); --keep-config is the explicit default
npx . uninstall --restore-routing
                    # rolls cc-switch proxy_config (claude/codex) back to the
                    # latest pre-MAW snapshot (~/.cc-switch/maw-backups/)
npx . update        # re-copies templates, keeps user edits; ALSO removes
                    # stale assets an older install left behind (exact v2
                    # manifest diff — user files are never touched)
npx . upgrade       # self-upgrade + template refresh BY DEFAULT (0.4.1):
                    # git fetch + ff-only pull (checkout installs; never
                    # stashes/rebases/forces) or npm i -g (npm installs),
                    # then spawns the NEW bin/mawf.js update; --dry-run to
                    # preview; --no-apply-templates to skip the refresh (a
                    # refresh failure degrades to a warning, never a failed
                    # upgrade)
```
Uninstall never removes trellis-owned files (`.trellis/`, trellis entries in `.agents/skills` / `.dsh/skills`) — mention them for manual removal. Snapshots under `~/.cc-switch/maw-backups/` are the user's audit trail and are kept.

## 11. Report back to the user
After install+plan, tell the user: the architecture chosen, the agents, the cost limits, the routing compliance, and whether the trellis chain succeeded (or what conflict needs resolving). Link the log: `.mawf/logs/trellis-init-*.log`.

## 12. Cross-host advising blocks (since the proactive-orchestration release)

`init` / `plan` / `install` / `update` / `upgrade` write an idempotent managed block (`<!-- mawf:cross-host-advise BEGIN/END -->`, ≤20 lines) into the project root `AGENTS.md` **and** `CLAUDE.md` (create-if-absent; the CLAUDE.md stub references AGENTS.md). The block makes any host session re-run `mawf advise` at session start + the first prompt of each day (UTC+8), parse the `ADVISE-DONE` footer, and offer switch/handoff actions. Never report these files as "modified user files" — they are managed; user edits outside the markers survive every re-run.

Uninstall semantics: keep-config (default) keeps the blocks and `.mawf/`; `--purge-config` strips the spans, deletes files mawf created (recorded in `.mawf/managed-blocks.json`), and removes `.mawf/` (incl. `handoff/`, `inventory*`, `runtime/advise-state.json`). The installer manifest is never involved for these files.
