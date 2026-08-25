# NOTICE

**MAW — Multi-Agent Workflow for Complex Codebases**
Repository: <https://github.com/imBlanker/multi-agents-workflow>

MAW is licensed under the **MIT License**. Copyright © 2026 imBlanker.
The full license text is in [`LICENSE`](./LICENSE). All source code in this
repository is original work by the MAW authors unless a different
attribution is recorded in this file.

MAW is an **independent implementation**. While designing the system we
studied a number of open-source projects and engineering articles and adopted
their *ideas* and *architectural structures* — never their source code. This
file records, for each referenced source: its name, its license, what we
borrowed, why it fit MAW's needs, and whether any code was copied. In every
case the answer is the same: **no verbatim code was copied; only structures
and concepts were adopted.** A summary of the same list appears in the
*Referenced Projects & Acknowledgements* section of [`README.md`](./README.md);
this file is the detailed, license-focused record.

---

## Third-party ideas and structures referenced

### Anthropic — "Building effective agents" & "How we built our multi-agent research system"

- **License:** Not applicable — published engineering articles; concepts cited with attribution. No source code is redistributed.
- **Borrowed:** The workflow-vs-agent distinction; the orchestrator-workers pattern; subagent context compression; the ~15× token-cost awareness of breadth-first multi-agent search; and the principle of risk-gated evaluation.
- **Why it fit:** MAW's central premise is selecting among architectures (`loop`, `orchestrator-workers`, `multi-agent`, `graph`, `dynamic`, `ultracode`) per project. These two posts are the canonical taxonomy that MAW's planner encodes, and the multi-agent post's real cost/coordination lessons directly shaped MAW's cost guard and risk-based review gates.
- **Code copied:** No — these are essays, not source code.
- **Sources:** <https://www.anthropic.com/engineering/building-effective-agents> · <https://www.anthropic.com/engineering/multi-agent-research-system>

### LangChain / LangGraph

- **License:** MIT — <https://github.com/langchain-ai/langchain> · <https://github.com/langchain-ai/langgraph>
- **Borrowed:** The graph-as-nodes-and-edges mental model; declarative structure combined with dynamic, conditional paths; persistence and human-in-the-loop (HITL) checkpoints; and the hard-won principle that "the hard part is context at each step."
- **Why it fit:** MAW's `graph` architecture and its `graph.json` / `src/graph.js` encode a workflow graph with persistence and HITL gates, directly mirroring LangGraph's design philosophy. LangGraph is the clearest existing expression of "predictable graph + human checkpoints," which is exactly the shape MAW needed for high-risk, inspectable runs.
- **Code copied:** No — MAW implements its own graph engine in `src/graph.js`; only the structural mental model was adopted.

### Lilian Weng — Lil'Log, "LLM Powered Autonomous Agents"

- **License:** Not applicable — published survey article; concepts cited with attribution.
- **Borrowed:** The ReAct (reason + act) loop and the Reflexion (self-criticism / self-refinement) mechanics.
- **Why it fit:** MAW's `loop` architecture is a ReAct-style iterate-until-done loop, and the Codex review gate's "review → fix → re-review" cycle is a Reflexion pattern. This survey provided the conceptual vocabulary and the canonical references MAW's `docs/ARCHITECTURE.md` builds on.
- **Code copied:** No — an essay, not source code.
- **Source:** <https://lilianweng.github.io/posts/2023-06-23-agent/>

### OpenAI — `codex-plugin-cc`

- **License:** Apache-2.0 — <https://github.com/openai/codex-plugin-cc>
- **Borrowed:** Nothing copied. `codex-plugin-cc` is the **Codex review integration target** that MAW *invokes*: MAW shells out to its companion script to run Codex as an independent reviewer at risk-based gates. MAW does not embed or redistribute it.
- **Why it fit:** MAW needs an independent reviewer that is not the same model/session as the implementer. `codex-plugin-cc` provides the Codex-side bridge, so MAW can treat Codex as an external reviewer without re-implementing the Codex CLI glue itself.
- **Code copied:** No — MAW invokes it out-of-process; no source is vendored or embedded.

### mbruhler / `claude-orchestration`

- **License:** MIT — <https://github.com/mbruhler/claude-orchestration>
- **Borrowed:** The multi-agent orchestration **plugin layout** — i.e., how commands, agent definitions, and hooks are organized for a Claude Code plugin.
- **Why it fit:** MAW ships its own Claude Code plugin under `plugin/`. The organizational conventions of this project informed MAW's plugin directory structure (commands / agents / hooks / skills) and its non-destructive install/update model.
- **Code copied:** No — MAW's plugin files are original; only the organizational pattern was referenced.

### garyqlin / `glink-engine`

- **License:** MIT — <https://github.com/garyqlin/glink-engine>
- **Borrowed:** The zero-dependency YAML graph engine and the shared event-bus pattern.
- **Why it fit:** MAW's `src/graph.js` is likewise a small, dependency-light graph engine, and MAW's `config.yaml` / `graph.json` follow a declarative YAML/JSON graph description. The event-bus idea informed how MAW's runtime coordinates step transitions and handoffs.
- **Code copied:** No — MAW's graph engine is an independent implementation; only the structural approach was adopted.

### milanglacier / `pi-dynamic-workflow`

- **License:** MIT — <https://github.com/milanglacier/pi-dynamic-workflow>
- **Borrowed:** The **dynamic workflow selection** approach — picking the right topology for a given task rather than hardcoding one.
- **Why it fit:** MAW's headline feature is `mawf plan`, which scores and selects among six architectures against real project signals. This project validated that dynamic selection (vs. a fixed graph) is a sound design, and it shaped MAW's "score → select → combine" planner.
- **Code copied:** No — MAW's planner (`src/planner.js`) is original scoring logic; no source reused.

### srijansk / `agent-relay`

- **License:** MIT — <https://github.com/srijansk/agent-relay>
- **Borrowed:** The YAML workflow description and the agent-relay (handoff between agents) pattern.
- **Why it fit:** MAW's portable `.maw/` plan files are YAML/JSON/Markdown so any host can read them, and orchestrator→subagent handoff is central to the `orchestrator-workers` architecture. The relay concept informed how MAW describes and triggers handoffs.
- **Code copied:** No — MAW's plan-file format and relay mechanics are original.

### x-glacier / `SwarmFlow`

- **License:** Apache-2.0 — <https://github.com/x-glacier/SwarmFlow>
- **Borrowed:** Multi-agent orchestration with **cost awareness** — budgeting spend across agents rather than ignoring it.
- **Why it fit:** MAW's cost guard (`src/cost.js`) measures real USD/min per agent and a total workflow rate. SwarmFlow's cost-aware framing confirmed MAW's central thesis: a multi-agent system needs hard spend limits grounded in real cost, not token estimates. This is the basis of MAW's pre-spawn `guard`/`acquire`/`release` budget model.
- **Code copied:** No — MAW's cost engine is original; only the cost-awareness principle was adopted.

### star-history / `star-history`

- **License:** MIT — <https://github.com/star-history/star-history>
- **Borrowed:** The GitHub Stars trend chart shown in the README.
- **Why it fit:** It provides a dependency-free repository-stars visualization via the public `api.star-history.com` SVG endpoint, which MAW embeds as a single badge URL with no self-hosted statistics service.
- **Code copied:** No — only the public SVG endpoint is referenced via URL; no star-history source is vendored.

---

## Security review performed before reuse

Before referencing or depending on any external project, MAW performed a
lightweight but deliberate security review. The checks applied to each source:

1. **License permits reuse.** We confirmed the license of each project permits
   adoption of its ideas/structures (MIT and Apache-2.0 both permit this; the
   referenced articles are cited for concepts with attribution). No GPL/AGPL or
   other copyleft source was incorporated in a way that would impose
   obligations on MAW's MIT-licensed code.
2. **No obvious security risk.** We reviewed what each project does and how
   MAW interacts with it. The only external process MAW shells out to is
   `codex-plugin-cc`, invoked explicitly at review gates by user-driven
   commands — never silently or automatically in the background.
3. **No hidden network calls, credential harvesting, or dangerous auto-execution.**
   MAW itself reads cc-switch **read-only** (`node:sqlite` in `readOnly: true`
   mode; it never mutates provider data), redacts auth tokens in `doctor` /
   `cost` output, and does not embed credentials anywhere. The `PreToolUse`
   cost hook only **blocks** spawns that exceed the budget — it does not modify
   tool inputs. No referenced project introduced hidden network calls,
   credential exfiltration, or auto-execution behavior into MAW.
4. **Sources recorded.** Every referenced source is listed above with its
   canonical URL and license, and the same list is mirrored in `README.md` §14.

## No wholesale copy or renaming

**No referenced project was copied wholesale, renamed, or rebranded as MAW.**
MAW is original code: its engine (`src/`), Claude Code plugin (`plugin/`),
portable skills (`skills/`), CLI (`bin/mawf.js`), and tests (`tests/`) were all
written from scratch by the MAW authors. From the projects above we adopted
only *ideas* and *architectural structures*; where an external tool is used at
runtime (only `codex-plugin-cc`), it is invoked as an out-of-process dependency
and is not redistributed within this repository.

## Vendored skills — mattpocock/skills (MIT, © 2026 Matt Pocock)

`skills/vendor/{grilling,grill-with-docs,domain-modeling}` are vendored from
https://github.com/mattpocock/skills at commit 5b15a47. Local modifications:
grilling SKILL.md carries two mawf format amendments (non-empty recommendation
line; lettered choices one per line) — see skills/vendor/LICENSE. mawf installs
them into workspaces alongside the trellis-brainstorm grill-edition wrapper
(`skills/mawf-grill/`), preserving the full Trellis planning contract.
