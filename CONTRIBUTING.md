# Contributing to MAW

Thanks for your interest in improving **multi-agents-workflow (MAW)** — a portable, dynamic multi-agent workflow system for complex codebases. This guide covers the basics of getting a change merged.

## Prerequisites

- **Node.js >= 20.17** (20.x LTS or 22.x recommended)
- npm (bundled with Node)
- Optional: [cc-switch](https://github.com/farion1231/cc-switch) and the Codex CLI, for full `doctor` output

## Getting started

1. **Fork** the repository on GitHub and clone your fork.
2. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-change
   ```
3. Install dependencies:
   ```bash
   npm install --no-audit --no-fund
   ```

## Development workflow

### Run the tests

```bash
npm test
```

This runs the full suite with Node's built-in test runner (`node --test`). **All 69 tests must pass** before you open a PR.

Run tests in watch mode while developing:

```bash
npm run test:watch
```

### Check your environment

```bash
node bin/mawf.js doctor
```

`doctor` verifies that cc-switch and the Codex CLI are reachable. If you don't have those tools installed locally, expect non-fatal warnings — CI runs this same step with `continue-on-error` for the same reason.

### Smoke test the CLI

```bash
node bin/mawf.js version
node bin/mawf.js doctor
```

## Code style

- **ES modules** — the package is `"type": "module"`. Use `import` / `export`, never `require`.
- **Small modules** — keep every source file **under 500 lines**. Split a module when it grows beyond that.
- **No secrets** — never hardcode API keys, tokens, or credentials. Read them from the environment or cc-switch config.
- **Test your changes** — every new behavior should land with a `tests/*.test.js` file.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add graph-based planner
fix: handle missing cc-switch db path
docs: clarify doctor output
test: cover config-gen edge cases
refactor: split installer into stages
chore: bump node engine range
```

Common types:

- `feat:` a new feature
- `fix:` a bug fix
- `docs:` documentation only
- `test:` tests only
- `refactor:` no behavior change
- `chore:` tooling, deps, or config
- Scope is optional: `feat(planner): support dynamic graphs`

## Pull requests

1. Open a PR against `main` (see `.github/PULL_REQUEST_TEMPLATE.md`).
2. Reference the issue with `Closes #N` in the PR body.
3. Make sure `npm test` passes locally and CI is green.
4. Keep PRs focused — **one logical change per PR.**
5. Update the README and `examples/` if your change affects user-facing behavior.
6. Workflow-file changes need one extra check: scheduled GitHub Actions run from the default branch, so after merging workflow changes, smoke-test them with `workflow_dispatch`.

## Governance & cc-switch policy

The fork / branch / issue / PR rules MAW follows are written down in [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) — read it before your first PR. Review routing is defined in [`.github/CODEOWNERS`](./.github/CODEOWNERS).

**cc-switch is read-only by default; the project feature is DECOUPLED.** Code changes must never `UPDATE`/`DELETE` existing cc-switch rows (providers, skills, mcp_servers, prompts, model_pricing) and must never touch any profile whose name contains `默认`. Since 2026-08-12, MAW's project functionality is **decoupled** from cc-switch's incomplete `profiles` feature: `createProjectProfile`/`readProfiles` are kept (with tests) but disabled by default — `projectSyncEnabled()` gates on `MAW_CC_PROJECT_SYNC`; do not re-enable in normal flows. The only active writes are the opt-in routing carve-out on `proxy_config` for claude/codex (`applyRouting`) and, when re-enabled, a NEW profile row only. Both are hard-guarded in `src/ccswitch.js` (`guardSql`) — do not weaken that guard.

**Model price gate is mandatory.** Assigning a model with Input > $2/1M Tokens or Output > $10/1M Tokens must PAUSE the work and report to a human first (`src/pricegate.js` `PRICE_GATE_THRESHOLDS` is the single source of truth; planner/configgen/CLI/guard/acquire all enforce it). Never add a code path that silently assigns an expensive model without the gate.

## Licensing

By contributing, you agree that your contributions will be licensed under the **MIT License** (see [LICENSE](./LICENSE)).

## Acknowledgements

MAW reuses **ideas and architectural concepts** — loop engineering, orchestrator-workers, multi-agent / graph / dynamic workflows, cost budgeting, plugin install — from referenced projects and prior art (see the *Referenced Projects & Acknowledgements* section of the README and [`NOTICE.md`](./NOTICE.md)). MAW does **not** copy source code from those projects; it is an independent implementation. When you add functionality inspired by another project, credit the idea in the commit message or docs and write your own code.
