---
name: mawf-cost-guard
description: "Check real-spend cost limits and concurrency before spawning agents or continuing a mawf workflow."
---

# MAW Cost Guard (skill)

> Use before spawning any subagent. Enforces real-spend cost-rate limits.

MAW measures cost from **actual inference spend** in the cc-switch proxy logs (`proxy_request_logs.total_cost_usd` over a time window → USD/min), not token estimates. This is the authoritative rate.

## Defaults (editable in `.mawf/config.yaml`)
- Per-agent: **$5/min**
- Total workflow: **$10/min** (independent constraint; enforced via concurrency + rate gating)
- Max concurrency: 16

## Commands
```bash
mawf cost                         # current rate + top sessions + used% vs limit
mawf guard                        # ALLOW/DENY a new spawn right now
mawf acquire --id <id> --role <r>  # take a slot (refuses if over budget)
mawf release --id <id>             # release a slot
```

## Pricing source chain (per spec)
1. cc-switch `model_pricing` (exact)
2. cc-switch provider `cost_multiplier` (applied on top)
3. vendored fallback estimate (clearly tagged `estimated: true`)
4. unknown → `null` (never faked as exact)

When the price is an estimate, configs and the `mawf cost`/`doctor` output say so. Do not present estimates as exact.

## Degradation
If cc-switch is unavailable, the guard degrades to concurrency-only limiting (no spend tracking) and `mawf doctor` reports the gap. Codex reviewer availability is independent: if codex is missing, the planner substitutes a second Claude Code agent reviewer for risk >= medium.

## Watchdog interaction

`mawf watchdog` dispatches rescue agents through THIS guard's world: the rescue workspace (`~/.mawf/watchdog/workspace/`) runs under default settings, so per-agent $5/min, workflow $10/min and concurrency 16 all apply; on top sits a per-incident cap (default $10, `watchdog.incidentBudgetUsd`) and the price valve on rescue model picks. Rescue spend is window-attributed from cc-switch logs (pi/dsh untelemetered spend stays bounded by the guard layer only).
