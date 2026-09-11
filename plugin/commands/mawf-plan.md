---
description: Plan a dynamic multi-agent workflow for the current project (probes codebase, reads cc-switch, picks architecture, writes .mawf/ configs)
argument-hint: '[--task-type coding|research|refactor|review|migration|greenfield] [--risk low|medium|high] [--parallel N] [--per-agent USD] [--total USD]'
allowed-tools: Bash, Read, Glob, Grep, Write
---

Run `mawf plan` for the current project, then read back `.mawf/plan.md` and summarize the selected architecture, the agent roster, and any review gates to the user.

Core steps:
1. Run `node --input-type=commonjs -e "Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" -- plan --project . $ARGUMENTS` (or `mawf plan --project . $ARGUMENTS` if on PATH).
2. Read `.mawf/plan.md`.
3. Tell the user: the primary architecture, why it was selected, the agents/roles, the cost limits, and the Codex review gates (if any).
4. Remind them they can edit any file under `.mawf/agents/` and re-run `mawf plan` to regenerate.

Do not start implementation in this command — planning only. Use `/mawf:run` for execution guidance.
