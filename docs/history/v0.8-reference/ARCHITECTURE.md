# MAW — Architecture & Theoretical Grounding

> Grounded in `src/planner.js`, `src/graph.js`, `src/cost.js`, `src/pricing.js`,
> `src/ccswitch.js`, `src/codex.js`, and the project `README.md`. Code paths and
> scoring constants are taken from the implementation, not invented.

## 1. Overview

MAW (Multi-Agent Workflow for a complicated codebase) is a **portable, dynamic**
multi-agent workflow system. Given a new complex project, it reads the local
[cc-switch](https://github.com/farion1231/cc-switch) SQLite database, probes the
codebase, and selects an agent architecture — `loop`, `orchestrator-workers`,
`multi-agent`, `graph`, `dynamic`, or `ultracode` — or a **combination** of
them. It then emits per-agent, independently-editable configs, enforces
**real-spend** cost-rate limits, and integrates Codex review through
`codex-plugin-cc`.

The guiding principle is the one stated at the top of `src/planner.js`:

> Start simple; add complexity only when it demonstrably helps.

MAW never hardcodes one topology. It scores each architecture against real
project signals (file count, languages, parallelizable subtasks, risk, context
need, value/cost tolerance, HITL/persistence needs) plus the host's native
capabilities, picks the best fit, and combines others as appropriate. The host
agent software (Claude Code, Codex, Pi Agent, DeepSeek Harness, …) drives execution; MAW provides the
**plan**, the **cost gate**, and the **review gates**. When the host already
offers a native dynamic-workflow or multi-agent mechanism, MAW layers `dynamic`
on top and lets the host drive — instead of re-implementing coordination.

This is the Anthropic *workflow-vs-agent* distinction made operational: MAW
starts from the simplest workflow that can work and only escalates to agents,
subagents, or full multi-agent breadth when the signals justify the cost.

## 2. The Four Paradigms + Two MAW Modes

MAW composes six selectable architectures. Four are the well-known paradigms;
two (`dynamic`, `ultracode`) are MAW-specific combinations.

| Architecture | One-line definition | When it fits | Cost / complexity |
|---|---|---|---|
| **loop** | A single agent that iterates act→observe→reflect until an exit criterion holds. | Open-ended single task, steps unpredictable, context fits one window. | Low cost, low complexity. One context, one model. |
| **orchestrator-workers** (subagents) | An orchestrator decomposes the task and delegates subtasks to subagents with **their own context windows**, then synthesizes. | Many dynamic parallelizable subtasks, or context that exceeds one window. | Medium. Each subagent pays its own context; orchestrator adds coordination tokens. |
| **multi-agent** | Multiple agents run breadth-first in parallel on independent facets, communicating via a shared bus/memory. | High-value work with many independent parallel directions that tolerates elevated cost. | High. Anthropic's multi-agent research system reports ~15× token cost vs single agent, offset by a 90.2% eval-quality gain. |
| **graph** | A declarative graph of nodes (work) and edges (transitions, including conditional) executed in topological batches with gates. | Predictability, human-in-the-loop, persistence/checkpoints, branching, high risk. | Medium complexity, deterministic and inspectable. |
| **dynamic** (MAW mode) | Layer MAW's plan/cost/review on top of the **host's native** dynamic-workflow/multi-agent runtime; the host drives execution. | The host already provides dynamic-workflow or multi-agent (e.g. Claude Code `Task`). | Lowest coordination overhead — no re-implementation. |
| **ultracode** (MAW mode) | `graph` + `loop` + a Codex fix-gate: checkpoints, an implement→test→fix loop, and a Codex review at the gate. | Complex coding (≥20 files or risk ≥ medium) with `codex-plugin-cc` available. | Highest value/complexity, but risk-gated so review only fires at selected gates. |

**Theoretical grounding.** The *loop* paradigm follows Lilian Weng's
*LLM Powered Autonomous Agents* — the ReAct (reason→act→observe) and Reflexion
(self-reflection) loops. The *orchestrator-workers* pattern and the
workflow-vs-agent distinction come from Anthropic's *Building Effective Agents*;
the multi-agent cost awareness (subagent context compression, ~15× token cost,
~90.2% eval gain) comes from Anthropic's *How we built our multi-agent research
system*. The *graph* paradigm mirrors LangGraph: structure is a graph of nodes
and edges, the path through it can be fully dynamic via conditional edges, and
designated nodes can loop, with first-class persistence and human-in-the-loop —
captured by LangGraph's own framing that "the hard part is context at each step."

## 3. Selection Rubric

The planner (`scoreArchitectures` in `src/planner.js`) is a **deterministic
scoring function** — fully testable, no hidden LLM call. Each architecture earns
points from matching signals; the highest non-`none` score becomes `primary`.

### Signal → architecture mapping (reproduced from README §5, with the *why*)

| Signal | Likely pick | Why (from the scoring code) |
|---|---|---|
| tiny, fixed, low-risk | `none` (single call) | `files ≤ 3 && parallel === 0 && risk ≤ 1 && ctx === "small"` → `none` +100. A single LLM call + retrieval suffices. |
| open-ended, steps unpredictable, one context | `loop` | `ctx !== "large" && risk ≥ 1` → `loop` +45 (+10 if coding). ReAct/Reflexion fits single-window open work. |
| many dynamic parallelizable subtasks / context exceeds one window | `orchestrator-workers` | `parallel ≥ 3 \|\| ctxLarge` → +55 + `min(parallel,6)*4`. Subagents carry their own windows; orchestrator compresses. |
| high-value breadth-first, parallel, tolerate ~15× cost | `multi-agent` | `value ≥ 2 && parallel ≥ 4` → +50 + `value*6` (+10 if research). Worth the ~15× token cost for breadth. |
| need predictability, HITL, persistence, branching | `graph` | `needHITL \|\| needPersistence \|\| risk ≥ 2` → +40 + HITL/persistence/risk bonuses (+12 for migration). Graph gives inspectable, checkpointed control. |
| host has native dynamic workflow / multi-agent | `dynamic` (layered on) | `host.hasDynamicWorkflow \|\| host.hasMultiAgent` → +30. Drive the host's runtime instead of re-implementing. |
| complex coding + Codex review available | `ultracode` | `taskType === "coding" && (files ≥ 20 \|\| risk ≥ 2) && host.codexPluginInstalled` → +45 + bonuses. Graph checkpoints + implement→review→fix loop. |

### How architectures combine

The set is **not exclusive** — `planWorkflow` builds a `selected[]` array from
`primary`:

- `primary === "ultracode"` → `selected = ["graph", "loop", "ultracode"]`. This
  is the canonical combination: a *graph* backbone with checkpoints, a *loop*
  for implement→test→fix, and a Codex review at the fix-gate.
- `primary === "multi-agent"` with `host.hasDynamicWorkflow` →
  `selected = ["dynamic", "multi-agent"]`: `dynamic` is layered on the
  orchestrator-workers topology so the host drives execution natively, while MAW
  keeps the multi-agent breadth.
- `primary === "orchestrator-workers"` with a host that has native dynamic
  workflow → `selected = ["dynamic"]` only: the host *is* the orchestrator;
  MAW supplies plan + cost gate + review, not coordination glue.
- `primary === "graph"` → `selected = ["graph"]` alone (no loop unless `loop`
  was also scored).

So `ultracode = graph + loop + codex fix-gate`, and `dynamic` is layered on
`orchestrator-workers`/`multi-agent` precisely when the host can drive it
natively.

## 4. Engine Modules

Each module is a single responsibility; all are plain ESM with `node:` built-ins
(no runtime npm deps).

| Module | Responsibility (one line) |
|---|---|
| `ccswitch.js` | Read-only access to the cc-switch SQLite DB via `node:sqlite` (`readOnly: true`), falling back to the `sqlite3` CLI; returns providers, `model_pricing`, `settings`, and the real-spend cost rate from `proxy_request_logs`. **Project functionality is DECOUPLED by default**: profile read/write (`readProfiles`/`createProjectProfile`/`guardSql`) is kept but disabled unless `MAW_CC_PROJECT_SYNC=1`; only provider-config sync (each provider's `config.toml`/`config.json` high-value settings) + the routing carve-out remain active. Pi is NOT cc-switch-managed (no pi app_type / traffic) → routing is skipped for pi hosts, and cost degrades to concurrency-only. dsh is likewise NOT cc-switch-managed: `dshprovider.js` reads `$DSH_HOME/settings.yaml` (`llm-pi-ai.providers`) into the same provider shape (app_type "dsh"), and `readCcPricingJson()` imports cc-switch's auto-synced `~/.cc-switch/model-pricing.json` so matched model ids keep real prices for the price gate. |
| `pricegate.js` | The HITL model price gate: assigning a model with Input > $2/1M or Output > $10/1M tokens pauses the work (`checkPriceGate` / `priceGateReport`); enforced by planner, configgen, plan/init/add-agent (exit 3), guard/acquire (deny), and `mawf approve-model`. |
| `pricing.js` | Model price resolution with a documented fallback chain (cc-switch → multiplier → vendored estimate → `null`); `projectRate` is a planning projection only. |
| `planner.js` | The deterministic `scoreArchitectures` + `planWorkflow`: scores six architectures, picks `primary`, builds the `selected[]` set, the agent roster, parallel/serial groups, risk-gated review points, loops, cost config, and the `priceGate` block list (roles whose model assignment exceeds the HITL price gate). |
| `graph.js` | `WorkflowGraph`: nodes/edges, validation (cycles permitted only via explicit `loop` self-edges), `topoBatches()` (Kahn-style parallel batches with `review`/`gate` nodes forcing their own batch, `loop` nodes expanding to `maxIterations`), and `graphFromPlan()`. |
| `configgen.js` | Writes the per-agent, independently-editable `.mawf/` files: `workflow.json`, `config.yaml`, `plan.md`, `agents/<role>.md` + `.json`, `graph.json`; materializes `.pi/agents/maw-*.md` (pi-native agent files) when the host is pi. Price-gated roles get a `price_gate` block in their json/md (+ sticky `approved` across re-plans). |
| `cost.js` | The cost guard: `guard()`/`acquire()`/`release()` enforce **total** rate, **per-session** (per-agent) rate, and concurrency cap, using real spend from `ccswitch.costRate`/`perSessionRate` and a small `.mawf/runtime/concurrency.json` state file. |
| `codex.js` | Codex review via the `codex-plugin-cc` companion script (`status`, `runReview`, `shouldReview`); risk-gated, degrades gracefully when codex or the plugin is missing. |
| `piprovider.js` | Pi provider/model reader: reads `~/.pi/agent/` (`settings.json`, `models.json`, `auth.json` existence-only) and emits cc-switch-shaped providers + estimated pricing (apiKey bytes never exported). |
| `trellis.js` | Chains `trellis init -u <user>` after `mawf init`; host-aware platform flags (`--pi` vs `--claude --codex`), MAW-file snapshot/diff conflict detection. |
| `trellistracker.js` | Pure upstream tracker for `@mindfoldhq/trellis` (npm latest + GitHub repo health), used by `.github/workflows/trellis-tracker.yml`; the only exception is upstream deletion (404 → one notice issue, pause, workflow still succeeds). |
| `installer.js` | Copies the Claude Code plugin (commands/agents/hooks/skills) into host dirs, writes `~/.mawf/installed.json`; best-effort Codex agent copy; pi skills/prompts into `~/.pi/agent/` and dsh skills into `$DSH_HOME/skills` when those are the host. **Manifest v2 records every written file**, so `uninstall` removes exactly those files across all hosts (including the non-`maw-*` plugin agents/hooks; legacy pre-v2 manifests fall back to the prefix scan), prunes directories it emptied (never the host home itself), keeps project `.mawf/` configs by default (`--purge-config` deletes them plus `.pi/agents/maw-*`), and `--restore-routing` (ccswitch.js) rolls `proxy_config` back to the pre-init snapshot. |
| `host.js` | Detects the host agent software (`claude-code`/`codex`/`pi`/`unknown`) and its capabilities (`hasSubagents`, `hasMultiAgent`, `hasDynamicWorkflow`, `hasGraphWorkflow`, `codexPluginInstalled`); `MAW_HOST=pi` forces pi. |
| `doctor.js` | `mawf doctor`: environment + capability report (Node version, cc-switch DB, host, codex status, pi config + spend note). |
| `probe.js` | Derives workflow signals (`files`, `loc`, `languages`) from a real directory tree, ignoring `node_modules`/`.git`/build dirs; feeds `inferSignals` in the planner. |

## 5. Cost Control

MAW measures the **real inference spend** from cc-switch's
`proxy_request_logs` — `SUM(total_cost_usd)` over a time window divided by the
window in minutes (see `costRate` in `src/ccswitch.js`). This is the
**authoritative** rate. Token-based estimates (`pricing.projectRate`) exist only
for planning/labelling and are never used as the enforcement rate. Real spend is
preferred because it captures actual provider billing multipliers, cache hits,
and retries that token math would miss.

Two **independent** constraints, both enforced in `cost.js`:

- **Per-agent (per-session) rate**: $5.00/min default — a `session_id` exceeding
  it blocks new spawns for that session (a proxy for a single agent run).
- **Total workflow rate**: $10.00/min default — independent of the per-agent sum,
  so four agents each at $0.90/min (under the per-agent cap) still trip the
  $10/min total if their aggregate crosses it.
- **Max concurrency**: 4 default — a hard slot cap in `concurrency.json`.

`guard()` returns `ALLOW` only when total rate < total limit **and** every
session rate < per-agent limit **and** a concurrency slot is free; otherwise it
returns `DENY` with the precise reason. The Claude Code `PreToolUse` hook calls
`guard` before every `Task` spawn.

**Pricing source chain** (used to *label* model prices in configs — never as the
enforcement rate), from `src/pricing.js`:

1. cc-switch `model_pricing` → `source: "cc-switch"`, `estimated: false`.
2. cc-switch provider `cost_multiplier` applied on top →
   `source: "cc-switch:multiplier"`.
3. vendored fallback estimate (`defaults/pricing.fallback.json`) →
   `source: "fallback:estimate"`, `estimated: true`.
4. unknown → `null`. **Never faked as exact.**

When a price is an estimate, configs, `mawf cost`, and `mawf doctor` say so
explicitly via the `estimated: true` flag.

## 6. Codex Integration

**Pi/dsh cost degradation.** Pi and dsh are not routed via the cc-switch
proxy, so `proxy_request_logs` contains no pi/dsh traffic → `costRate()`
reports 0 for them and `mawf cost` marks their spend as estimated/unknown; the
guard falls back to concurrency-only limiting (the same graceful degradation
as a missing cc-switch DB). dsh additionally sources prices from the synced
`model-pricing.json`, so its **price gate** stays live for matched ids.

Codex is invoked through the **`codex-plugin-cc` companion script**, discovered
by `findCodexCompanion` under `~/.claude/plugins/marketplaces/openai-codex` (and
the installed cache). `runReview` spawns the companion with `node`, passing
`command` (`review` / `adversarial-review` / `delegate`), `--scope`
(`auto` / `working-tree` / `branch`), `--base`, and `--wait`/`--background`.
Codex's stdout is returned verbatim; MAW parses nothing about Codex's reasoning.

Review is **risk-gated**, not fired on every step. The planner only adds review
points when codex is available **and** risk justifies it:

- `risk ≥ medium` (level ≥ 1) → a `post-implementation` auto-scope review.
- `risk ≥ high` (level ≥ 2) → an additional `working-tree` architecture/security
  review.
- `primary === "ultracode"` → a `branch`-scope **fix-gate** review.

`shouldReview(plan, { after })` confirms at runtime that a matching gate exists
before the runner invokes Codex — so review fires only at the gates the planner
selected.

**Graceful degradation.** When `host.codexPluginInstalled` is false but
`risk ≥ medium` (`riskLevel(signals.risk) >= 2` in `planWorkflow`), the planner
substitutes a **second Claude Code agent** as the reviewer (role `reviewer`,
model `claude`, tools `Read`/`Grep`/`Glob`). The plan still ships a review gate;
it is just not Codex. `codex.status()` reports `ready: false` with the reason
(binary missing vs. companion missing) so `mawf doctor` can tell the user exactly
what to install.

## 7. Portability

The plan and per-agent configs are plain **JSON / YAML / Markdown** under
`.mawf/`, so any agent software can read them with zero MAW runtime: `workflow.json`
(the plan), `config.yaml` (global knobs), `plan.md` (human guide), `agents/<role>.md`
(portable agent definition) + `<role>.json` (machine config), and `graph.json`
(nodes/edges). Nothing is hardcoded — agents/roles come from the plan, and the
user can add, remove, or edit any file; the runner re-reads it at execute time.

- **Claude Code** gets the full plugin: commands (`/mawf:plan`, `/mawf:run`,
  `/mawf:cost`, `/mawf:doctor`, `/mawf:add-agent`, `/mawf:review`), agent
  definitions, a `PreToolUse` hook that calls the cost guard before each `Task`,
  and portable skills.
- **Codex** gets agent definitions copied to `~/.codex/agents` (best-effort) and
  is invoked as the reviewer via `codex-plugin-cc`.
- **Pi Agent** reads `.mawf/` and gets native pi agent files (`.pi/agents/maw-*.md`) + pi prompts + skills during `mawf plan` / `mawf install`; spawn via the native subagent tool. Pi is NOT cc-switch-managed: its providers/MCP/skills live in `~/.pi/agent/`, and cost control is concurrency-only (spend not measured).
- **DeepSeek Harness (dsh)** reads `.mawf/` and gets skills copied into `$DSH_HOME/skills` during `mawf install`. dsh has no named agent-definition surface: the portable `.mawf/agents/<role>.md` IS the spawn payload, passed through dsh's prompt-driven subagent tool from one orchestrator session (`dsh web` / `--profile headless`). Providers/models come from `$DSH_HOME/settings.yaml` via `dshprovider.js`; MCP servers are managed by dsh patch layers (MAW reports only); AGENTS.md context is loaded by dsh's agent-instructions (user-global + project root down to cwd, 64 KiB cap).
- **Gemini CLI / opencode / others** read `.mawf/` directly; no native glue yet.

Crucially, when the host has a **native** dynamic-workflow or multi-agent
mechanism (`host.hasDynamicWorkflow || host.hasMultiAgent`), MAW layers
`dynamic` on top and lets the host drive execution — MAW provides the plan, the
cost gate, and the review gates, and the host coordinates. MAW never
re-implements coordination the host already does.

## 8. Graceful Degradation Matrix

| Failure / absence | What MAW does | Where it's handled |
|---|---|---|
| Host missing Codex (`codexPluginInstalled: false`), risk ≥ medium | Degrades to a **second Claude Code reviewer** at the same gate; `codex.enabled` stays false. | `planWorkflow` roster branch in `src/planner.js`; `codex.status()` in `src/codex.js` |
| Host missing Codex, risk < medium | No reviewer agent added; workflow runs without a review gate. | `src/planner.js` |
| cc-switch DB missing (`findDb()` → null) | `readCcSwitch` returns empty providers/pricing; models fall back to defaults (`claude-opus-5`, `gpt-5.2-codex`, …); cost rate reads as 0 (no enforcement) and `impl: "none"`. | `src/ccswitch.js` |
| Model unavailable (not in `model_pricing`) | `pricing.resolvePrice` returns the vendored `fallback:estimate` (`estimated: true`), or `null` if also unknown — never faked. Models in the roster fall back to hardcoded ids via `pickModel`. | `src/pricing.js`, `src/planner.js` |
| Pricing source unknown | `null` price; configs/labels show "unknown"; `projectRate` returns `source: "unknown"`. | `src/pricing.js` |
| Concurrency saturated (`running >= maxConcurrency`) | `guard`/`acquire` return `DENY: max concurrency reached`; the PreToolUse hook blocks the spawn until a slot frees. | `src/cost.js` |
| Total rate over limit | `DENY: total cost-rate limit reached` (independent of per-agent). | `src/cost.js` |
| Per-session rate over limit | `DENY: session … >= per-agent limit` for that session. | `src/cost.js` |
| `node:sqlite` binding unavailable (Node < 22.5) | Falls back to the `sqlite3` CLI in JSON mode, still read-only. | `src/ccswitch.js` |

## 9. References

MAW studied these sources and adopted their **ideas**; the implementation is
original (see `NOTICE.md` in the repo for what was borrowed and why).

**Articles / posts**

- Anthropic — *Building Effective Agents*: the workflow-vs-agent distinction and
  the orchestrator-workers pattern. <https://www.anthropic.com/research/building-effective-agents>
- Anthropic — *How we built our multi-agent research system*: subagent context
  compression, ~15× token cost, ~90.2% eval-quality gain, risk-gated evaluation.
  <https://www.anthropic.com/engineering/multi-agent-research-system>
- LangChain / LangGraph — graph-as-nodes-and-edges, declarative structure with
  dynamic conditional paths, persistence and human-in-the-loop.
  <https://blog.langchain.com/langgraph/>
- Lilian Weng — *LLM Powered Autonomous Agents*: the ReAct and Reflexion loops.
  <https://lilianweng.github.io/posts/2023-06-23-agent/>

**Open-source projects (ideas adopted)**

- [`mbruhler/claude-orchestration`](https://github.com/mbruhler/claude-orchestration) (MIT) — multi-agent orchestration plugin layout.
- [`garyqlin/glink-engine`](https://github.com/garyqlin/glink-engine) (MIT) — zero-dependency YAML graph engine + shared event bus.
- [`milanglacier/pi-dynamic-workflow`](https://github.com/milanglacier/pi-dynamic-workflow) (MIT) — dynamic workflow selection.
- [`srijansk/agent-relay`](https://github.com/srijansk/agent-relay) (MIT) — YAML workflow + agent relay.
- [`x-glacier/SwarmFlow`](https://github.com/x-glacier/SwarmFlow) (Apache-2.0) — multi-agent orchestration + cost awareness.
- [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) — the Codex review integration target.
- [star-history](https://github.com/star-history/star-history) — the GitHub Stars trend chart used in the README.

## 10. Cross-host Awareness & Advising (proactive orchestration)

### Data flow

```
src/inventory.js ──scan──▶ ~/.claude ~/.codex ~/.pi/agent $DSH_HOME + project
        │  InventoryReport → .mawf/inventory.json + inventory-digest.md (≤200 lines)
        ▼
src/advise.js ── deterministic scoring (caps/skills/models/prices) ──▶ AdviseResult
        │  .mawf/runtime/advise-state.json (UTC+8 freshness)  ·  .mawf/handoff/<ts>-<from>-<to>.md
        ▼  text output ends with the stable `ADVISE-DONE …` footer
src/injectblock.js ── managed block in project AGENTS.md + CLAUDE.md
        (mawf:cross-host-advise BEGIN/END · idempotent · ≤26 lines)
```

### InventoryReport (per host)

`{ generatedAt, projectDir, hosts[] }`; each host: `{ app, homeDir, detected[], capabilities[], skills[{name,path,realPath,description,origin}], plugins[{name,source,status?}], marketplaces[], mcps[{name,source,status?}], prompts{global,project[]}, models[{id,provider,source,isCurrent,family,tags[],price}], workflowsHarnesses[], error?, mcpNote?, harnessNote? }`. Skill `origin`: user-global | agents-global | project | project-ancestor | npm-package. Symlinked skills dedupe by realPath. Missing host → skipped; per-host failure → `{app, error}`; broken JSON tolerated.

Truth sources (verified against each host's own introspection): claude MCP = `~/.claude.json` global + ALL `projects[*].mcpServers` + project `.mcp.json`; claude plugins = `installed_plugins.json` keys (marketplaces are their own category; plugin enable-state is UI-only); codex MCP = `config.toml [mcp_servers.*]` (quoted names, env sub-sections filtered; `codex_apps` builtin is UI-only); codex plugins = `config.toml [plugins."name@marketplace"]`; pi MCP = `~/.pi/agent/mcp.json`; pi skills = `~/.pi/agent/skills` + `~/.agents/skills` + project `.pi/skills`/`.agents/skills` (+ ancestors to git root) + npm package `skills/`; pi models = `models.json` providers + `models-store.json` cached catalogs (switchable via `/model`); dsh plugins = `--dump-config` everything-as-a-plugin component table (full plugin/skill list is web-UI-only); dsh MCP = `settings.yaml` `mcp-client:` (report-only). `inventory --verify` probes host CLIs for live statuses (claude connected/failed/pending-approval; codex auth unsupported/…; injectable runner, hermetic tests).

### AdviseResult

`{ currentHost, task{text,domain,difficulty}, tokens[], recommendation: stay|switch, target, margin, scores[{host,total,breakdown{capabilityFit,skillMatch,modelFit,costFit},stayBonus,matched{skills,plugins,mcps,models},reasons[]}], launch{command,note}|null, handoffPath|null, stateUpdated }`. Weights/stayBonus/margin overridable in `.mawf/config.yaml` `advise:`. Output contract: text mode ends with `ADVISE-DONE recommendation=… target=… margin=… handoff=…` for the injected block to parse. On `switch`, `handoffPath` points to the host-aware handoff gate brief: inspect source/target differences from MAW evidence, ask/grill only unresolved model/workflow decisions, and do not treat the switch as ready before the user responds.

### Scoring rules (defaults)

| dimension | max | rule |
|---|---|---|
| capabilityFit | 30 | difficulty tier (1-2: 5/15/18/20, 3: 5/20/25/27, 4-5: 5/22/30/30 base +subagents +multi-agent +dynamic-workflow) — capped at 30 |
| skillMatch | 30 | task tokens (ASCII words + CJK bigrams, stopwords dropped) vs skills/plugins/MCP names+descriptions: exact name 3 / name-substring 2 / description 1; raw × 2 capped; usable surfaces only (no-status or connected/active) |
| modelFit | 25 | 0 models → 0; no suitable → 5; else 15 + min(10, 3×suitable); no agentic/coding model at difficulty ≥4 → capped 12 |
| costFit | 15 | cheapest-suitable ratio across hosts; estimated prices capped at 70%; no price data → 55% neutral |
| stayBonus | +8 | current host only |
| switch | — | winner ≠ current AND margin ≥ 10 |

### Launch resolution

claude → `claude`; codex → `codex`; pi → `pi` (run in the project directory). dsh → resolve the PID holding 127.0.0.1:3080 (`lsof -ti tcp:3080` → `ss` pid= parse → null): resolved → `kill -9 <PID> && dsh web`; unresolved → template `kill -9 $(lsof -ti tcp:3080) && dsh web` + note. **Advise only prints; it never executes.** Port-kill is a user-environment quirk (old dsh instance holds the web port), documented here and in README §10.

### Injection & reversibility

Managed block written to project `AGENTS.md` + `CLAUDE.md` (create-if-absent; CLAUDE.md stub references AGENTS.md) at init/plan/install/update/upgrade. On `switch`, the block makes the handoff review a guidance-level hard gate: inspect source/target differences, ask/grill only unresolved model/workflow decisions, and do not treat the switch as ready before the user responds. Foreign managed spans (e.g. Trellis) stay contiguous; corrupt single-marker spans are repaired non-destructively. Reversibility: keep-config keeps blocks; `--purge-config` strips spans and deletes mawf-created files recorded in `.mawf/managed-blocks.json` (project scope — NEVER the installer manifest `files[]`, which means whole-file removal).

---

*License: MIT. This document is architecture-level prose grounded in the
implementation at the time of writing; where the code and this text disagree,
the code in `src/` is authoritative.*
