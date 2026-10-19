---
description: Environment + capability check for the multi-agent workflow system
argument-hint: ''
allowed-tools: Bash
---

Run `node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js" doctor` and show the output. This verifies Node, git, the host agent software, the cc-switch database (and current providers), model pricing, and Codex + codex-plugin-cc availability. Suggest fixes for any WARN items.
