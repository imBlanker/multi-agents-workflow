---
description: Dynamically add an agent/role to the current workflow plan and regenerate its config files
argument-hint: '--role NAME [--model claude-sonnet-5] [--app claude|codex] [--agent claude-code|codex] [--per-agent USD] [--tools Read,Edit,Bash] [--review] [--task "..."]'
allowed-tools: Bash, Read
---

Run `node --input-type=commonjs -e "Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" -- add-agent --project . $ARGUMENTS`. The new agent is appended to `.mawf/workflow.json` and gets its own `.mawf/agents/<role>.md` and `.mawf/agents/<role>.json`. Existing files are preserved. Confirm to the user what was added.
