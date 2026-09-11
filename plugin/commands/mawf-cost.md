---
description: Report the current cost rate (USD/min) measured from real cc-switch spend, against per-agent and total limits
argument-hint: '[--db /path/to/cc-switch.db] [--window SECONDS]'
allowed-tools: Bash
---

Run `node --input-type=commonjs -e "Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" -- cost --project . $ARGUMENTS` and show the output verbatim. The numbers reflect *real inference spend* from the cc-switch proxy logs, not token estimates. Highlight the used-percentage against the total limit.
