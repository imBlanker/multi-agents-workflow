## Summary
<!-- One or two sentences: what does this PR do? -->

## Motivation
<!-- Why is this change needed? Link any related issues (#NNN). -->

## Changes
<!-- Bullet list of key changes. -->
-
-
-

## Tests run
<!-- Which tests did you run? Check all that apply. -->
- [ ] `npm test` — the canonical full suite passes
- [ ] `node bin/mawf.js doctor`
- [ ] Manual smoke test (describe below)

### Manual test notes
<!-- Optional: describe any manual smoke tests you ran. -->

## Upstream tracking checklist
<!-- Run before opening the PR. Registry (single source of truth): docs/UPSTREAM_COMPATIBILITY.md -->
- [ ] Tier 1 hosts (Claude Code / Codex / Pi / dsh / Trellis) checked against the registry
- [ ] Tier 2 integrations (pi-mcp-adapter / kickstart / dsh-web / cc-switch GUI / codex-plugin-cc) checked
- [ ] Tier 3 components.lock four tools (archify / write-notes / trellis-card / compound-references) checked
- [ ] Tier 4 pool-catalog optional components (codebase-memory-mcp / codegraph / agent-browser) checked
- [ ] If this PR touches an upstream consumer: the corresponding upstream version conclusion is stated under Changes
<!-- "Checked" = every release/new commit since the registry baseline was assessed, or no release in the window (write that inline instead of skipping silently). -->

## Checklist
- [ ] Tests pass locally (`npm test`)
- [ ] `node bin/mawf.js doctor` is healthy (or expected CI limitations are noted)
- [ ] Docs updated (README, CONTRIBUTING, examples) where applicable
- [ ] New and changed modules kept under 500 lines
- [ ] No secrets or credentials committed
