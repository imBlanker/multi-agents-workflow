---
name: mawf-orchestration
description: "Plan and coordinate cost-bounded multi-agent workflows for complex projects using mawf."
---

# MAW Orchestration (skill)

> Use when planning or running a multi-agent workflow for a complex codebase.

MAW (multi-agents-workflow) dynamically picks an architecture per project and writes per-agent, independently-editable configs under `.mawf/`.

## When to use
- A new complex project: after `mawf init`, run `mawf plan`.
- An existing project where a single agent is insufficient (many files, multiple languages, high risk, large context).
- You want cost-bounded multi-agent runs with Codex review gates.

## The four paradigms MAW picks between (and combines)
- **Loop engineering** — open-ended single tasks; Think→Act→Observe until done.
- **Subagents / orchestrator-workers** — dynamic, parallelizable subtasks; each subagent gets its own context window and compresses findings.
- **Multi-agent** — high-value breadth-first work that tolerates ~15× token cost.
- **Graph engineering** — predictable, inspectable control with HITL, persistence, and review gates.

MAW also understands **dynamic** (prefer the host's native dynamic-workflow/multi-agent mechanism) and **ultracode** (complex coding with implement→codex-review→fix loops + graph checkpoints).

## Quickstart
```bash
mawf init -u <user>          # init workspace
mawf plan --project .        # probe + plan + write .mawf/
mawf doctor                  # env + capability check
mawf cost                    # real cost rate from cc-switch
mawf run                     # execution guidance (batches + guards)
```

## Core invariants
- Start simple; add complexity only when it demonstrably helps.
- The cost guard is authoritative: $5/min per agent, $10/min total (defaults), measured from real cc-switch spend — not token estimates.
- Codex review is risk-gated, not on every step.
- Every file under `.mawf/` is editable; `mawf plan` regenerates from fresh signals.

See the architecture report at `docs/ARCHITECTURE.md` for the theoretical grounding.
