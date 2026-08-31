---
description: Emit execution guidance for the current .mawf/ workflow plan (topological batches, cost-guard checks, codex review points)
argument-hint: ''
allowed-tools: Bash, Read
---

1. Run `node ${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js run --project $PWD` and show the batched execution plan.
2. For each batch:
   a. Run `mawf guard --project $PWD`. If DENY, stop and report why (cost-rate limit or concurrency cap reached) — do NOT spawn agents.
   b. **Stage entry** (first batch of a stage — the batches before/after a review/gate
      node in the plan) and **each review gate**: run `mawf advise --pool --project $PWD`
      BEFORE spawning the batch, present the add/keep/remove verdicts + procedures
      to the user, and parse the `POOL-DONE` footer. NEVER execute installs/removals
      yourself; never run a pool judgment mid-batch (only at batch boundaries/gates).
   c. If ALLOW, spawn the batch's agents as subagents (Claude Code Task tool). Pass each agent the verbatim task from its `.mawf/agents/<role>.md`.
   d. For each spawned agent, call `mawf acquire --id <id> --role <role> --app claude` before it starts and `mawf release --id <id>` when it returns.
3. At each review gate listed in the plan, run `/mawf:review --after <label>` to invoke Codex (via codex-plugin-cc) if available; otherwise fall back to a second Claude Code agent reviewer.
4. Synthesize results from the `synthesize` batch and present to the user.

Key rules:
- Never bypass the cost guard. The total cost-rate limit ($10/min by default) and per-agent limit ($5/min by default) are hard constraints measured from real cc-switch spend.
- If a required agent/model is unavailable, degrade gracefully: replace the codex reviewer with a second claude reviewer (the planner already does this), and skip unreachable subagents rather than failing the whole workflow.
