---
description: List or explicitly select optional MAWF integrations for new runs
argument-hint: 'list | enable ID | disable ID'
allowed-tools: Bash, Read
---

Run `node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js" integrations <requested action> --project . --json`.
Default to list. Selection is separate from installed/authenticated/compatible/ready.
Enabling does not install, log in, start a model, or authorize a price-policy change.
Disabling applies to new run snapshots; preserve existing jobs and their evidence.
