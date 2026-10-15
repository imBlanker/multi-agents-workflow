---
name: trellis-brainstorm
description: "Guides collaborative requirements discovery before implementation. Creates task directory, seeds PRD, runs the grill-with-docs interview (grilling + domain-modeling) to resolve the decision tree in rounds, and converges on MVP scope. Use when requirements are unclear, there are multiple valid approaches, or the user describes a new feature or complex task."
---

# Trellis Brainstorm — grill edition (mawf)

Legacy Trellis workspaces only. If `.mawf/workspace.json` selects backend `mawf`
with `trellis: false`, use `mawf-brainstorm` instead; do not run this wrapper.

This workspace's brainstorm runs the **grill-with-docs** interview: the mattpocock `grilling` methodology (rounds, design tree, frontier) with `domain-modeling` discipline (terms land in `CONTEXT.md`, irreversible decisions land as ADRs) — mapped onto the **Trellis planning contract**. The interview method is grilling's; the workflow obligations are Trellis's.

## Non-Negotiable Planning Contract (Trellis)

A request to build, implement, fix, refactor, or "go ahead" is not approval to leave planning. Task-creation consent is also not implementation approval.

For every non-trivial task, the user must respond at least once after the initial request before implementation begins. If no clarification is needed, that response must approve the final planning summary described below.

Do not edit product code, dispatch implementation, or run `task.py start` while the design tree still has open user-owned decisions, or before the final planning summary is explicitly approved.

Use this skill only after task-creation consent has been given. If no task exists yet, create one:

```bash
TASK_DIR=$(python3 ./.trellis/scripts/task.py create "<short task title>" --slug <slug>)
```

`task.py create` seeds the default `prd.md` — update it with the current understanding before each round's questions go out.

## The interview: Call the Skill tool, for "grilling"

Call the Skill tool and load **`grilling`** (interview primitive: design tree, frontier, rounds) and **`domain-modeling`** (glossary/ADR discipline). Run the interview per those skills:

- **Rounds, not single questions.** Ask the whole frontier in one round: every decision whose prerequisites are settled, each numbered, each with a recommended answer on the recommendation line (`➡️ **Recommended: (a)** — why`); lettered choices are list items, one per line. Then wait.
- **Facts are yours.** Anything the codebase, tests, configs, docs, specs, or task history can answer, you look up (or dispatch a read-only sub-agent) — never ask the user. This restates grilling's facts/decisions split and the Trellis evidence rule.
- **Decisions are the user's.** Product intent, scope boundaries, UX, compatibility, risk tolerance, acceptance behavior — put each to the user even when an existing pattern suggests an answer; patterns are recommendation evidence, not decisions.
- **Domain-modeling as you go.** Resolved terms land in `CONTEXT.md` the moment they resolve (glossary only — no implementation detail). Irreversible, surprising, real-trade-off decisions land as ADRs (`docs/adr/`, sequential numbering, from the vendored formats). Create files lazily.
- The session is done when the frontier is empty: every branch visited, nothing silently assumed. Do not act until the user confirms shared understanding.

## Mapping grill outcomes → Trellis artifacts

After every round's answers:

1. Update `prd.md`: settled decisions become requirements/acceptance criteria; cite the ADR number for decision-backed requirements (`see docs/adr/0007-…`).
2. Keep `research/` notes for facts you dug up (paths, line numbers, verbatim user answers).
3. When the frontier is empty: complex tasks get `design.md` + `implement.md` (boundaries, contracts, ordered checklist, validation commands, review gates). Lightweight tasks may stay PRD-only.
4. Present the **final planning summary** (requirements, key decisions + ADR refs, scope, out-of-scope, plan outline) and STOP. Only a subsequent user message that explicitly approves the latest summary authorizes `task.py start` and implementation. Material artifact changes after approval repeat the review.

## Degradation

If the vendored `grilling`/`domain-modeling` skills are missing from the workspace (e.g. a `trellis update` clobbered them), say so and fall back to the upstream question discipline: one highest-value question per turn with a recommendation, evidence-first. `mawf doctor` flags the clobber; `mawf upgrade` restores.

## Provenance

Interview methodology: mattpocock/skills (MIT), vendored by mawf under `skills/vendor/` with two mawf format amendments (non-empty recommendation line; one option per line). Escape hatch for the stock Trellis brainstorm: restore `.agents/skills/trellis-brainstorm.orig.md` over this file.
