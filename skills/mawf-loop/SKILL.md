---
name: mawf-loop
description: "Run open-ended coding or research work with an iterative act, observe, reflect, and decide loop."
---

# MAW Loop Engineering (skill)

> Use for open-ended tasks where the number of steps cannot be predicted.

A loop agent is an LLM using tools based on environmental feedback in a loop. MAW instantiates it as the `implementer` role with a `loop` node in the graph.

## The loop contract
```
while not done:
  act (call a tool)
  observe (feed result back into context)
  reflect (is this enough? what's the gap?)
  decide: continue, escalate, or stop
```

## Stopping conditions MAW enforces
- All tests green AND reviewer approves (ultracode).
- Max iterations reached (default 5, configurable via `--max-iter`).
- Cost guard DENY (the $5/min per-agent or $10/min total limit).
- Ground-truth from the environment (tool results, test output) shows the task is complete.

## When NOT to use a loop
- Steps are fixed and decomposable → use a workflow / graph instead (cheaper, more predictable).
- The task is tiny → a single LLM call + retrieval suffices.

## Avoid the fix-forget-repeat cycle
After a loop resolves a bug, run the break-loop analysis: root-cause category, why prior fixes failed, prevention mechanism. Capture the lesson in spec.
