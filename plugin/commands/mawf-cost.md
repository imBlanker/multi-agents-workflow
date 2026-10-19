---
description: Report the current cost rate (USD/min) measured from real cc-switch spend, against per-agent and total limits
argument-hint: '[--db /path/to/cc-switch.db] [--window SECONDS]'
allowed-tools: Bash
---

Run `node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js" cost --project . $ARGUMENTS` and show the output verbatim. The numbers reflect *real inference spend* from the cc-switch proxy logs, not token estimates. Highlight the used-percentage against the total limit.
