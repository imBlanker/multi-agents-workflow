---
description: Environment + capability check for the multi-agent workflow system
argument-hint: ''
allowed-tools: Bash
---

Run `node --input-type=commonjs -e "Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" -- doctor` and show the output. This verifies Node, git, the host agent software, the cc-switch database (and current providers), model pricing, and Codex + codex-plugin-cc availability. Suggest fixes for any WARN items.
