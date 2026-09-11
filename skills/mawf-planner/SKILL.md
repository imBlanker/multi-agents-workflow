---
name: mawf-planner
description: "Choose an agent architecture from project signals, host capabilities, risk, parallelism, and cost constraints."
---

# MAW Planner (skill)

> Use when deciding *which* agent architecture fits a task.

The planner scores six architectures against project signals (file count, languages, parallelizable subtasks, risk, context need, value/cost tolerance, HITL/persistence needs) plus host capabilities (native dynamic workflow / multi-agent / codex).

## Architecture menu
| Signal | Likely pick |
|---|---|
| tiny, fixed, low-risk | none (single call) |
| open-ended, steps unpredictable, fits one context | `loop` |
| many dynamic parallelizable subtasks / context exceeds one window | `orchestrator-workers` |
| high-value breadth-first, parallel, tolerate cost | `multi-agent` |
| need predictability, HITL, persistence, branching | `graph` |
| host has native dynamic workflow / multi-agent | `dynamic` (layered on) |
| complex coding + codex review available | `ultracode` (graph + loop + codex fix-gate) |

These are combined, not exclusive: e.g. `ultracode` = `graph` + `loop` + codex review.

## How to drive it
```bash
mawf plan --project . --task-type coding --risk high --parallel 6
```
Read `.mawf/plan.md` for the chosen architecture, rationale, agent roster, and review gates.
Edit `.mawf/config.yaml` to change cost limits, concurrency, and pricing sources, then re-run `mawf plan`.
