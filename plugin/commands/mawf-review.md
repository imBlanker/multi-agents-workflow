---
description: Invoke a Codex review via codex-plugin-cc (risk-gated by the plan; pass --force to review anyway)
argument-hint: '[--after post-implementation|architecture/security|ultracode fix-gate] [--scope auto|working-tree|branch] [--base <ref>] [--force]'
allowed-tools: Bash, Read
---

Run `node --input-type=commonjs -e "Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" -- review --project . $ARGUMENTS`.

The command checks whether the plan has a review gate matching `--after`. If yes (or if `--force` is set) and codex-plugin-cc is available, it invokes the codex companion review and returns Codex's output verbatim. If codex is unavailable, it reports that and suggests using a second Claude Code agent as the reviewer (graceful degradation).

This is review-only: do not apply patches or make changes from this command.
