---
description: Select dynamic or fixed mode 1 for new top-level runs and inspect active snapshots
argument-hint: 'dynamic | fixed-1 | status | list'
allowed-tools: Bash, Read
---

Run `node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js" mode <requested action> --project . --json`.
Accept only dynamic, fixed-1, status, or list. Default to status. Show that mode
changes affect only new top-level runs, plus the actual active run snapshots.
Do not reset the ledger or silently switch execution hosts.
