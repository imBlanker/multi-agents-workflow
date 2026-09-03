# Governance

This document records the fork / branch / issue / PR rules MAW follows. They are
synthesized from how popular, large open-source projects actually operate
([GitHub's *How to Contribute to Open Source*](https://opensource.guide/how-to-contribute/),
the standard GitHub fork-and-PR model, and Conventional Commits) and applied
here directly. This is the reference of record; [`CONTRIBUTING.md`](../CONTRIBUTING.md)
is the short contributor guide.

## 1. Fork model
- Contributors do **not** push directly to `upstream/main`. Fork the repo, branch
  in your fork, open a PR back to `upstream/main`.
- Keep your fork **synced** with upstream `main` before starting work (rebase or
  merge `upstream/main`).
- One PR = one concern. Atomic, reviewable, with tests + docs.

## 2. Branch model
- `main` is the stable, protected, always-green branch. **No direct pushes.**
- Branch off the latest `upstream/main`.
- Branch naming (Conventional Commits prefixes):

  | Prefix | Use |
  |---|---|
  | `feat/<topic>` | new feature |
  | `fix/<issue-id>` | bug fix |
  | `docs/<topic>` | documentation |
  | `refactor/<topic>` | refactor (no behavior change) |
  | `perf/<topic>` | performance |
  | `test/<topic>` | tests |
  | `ci/<topic>` | CI/build |
  | `chore/<topic>` | tooling/deps |

- Delete the branch after merge. Squash-merge keeps history linear.

## 3. Issue model
- **Search existing issues first** (open + closed) to avoid duplicates.
- Use the [bug report](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=bug_report.md) or
  [feature request](https://github.com/imBlanker/multi-agents-workflow/issues/new?template=feature_request.md)
  template; include repro steps, environment, expected/actual.
- One issue per problem. Answer maintainer questions promptly.
- `good first issue` / `help wanted` labels flag newcomer-friendly work.

## 4. Pull Request model
- Reference the issue with `Closes #N` (or `Refs #N`) in the PR body.
- Small, focused PRs; include tests and updated docs. Keep modules **< 500 lines**.
- **CI must pass** before review. The PR template checklist must be completed.
- A maintainer review is required; large changes are not self-merged.
- Conventional Commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`, `perf:`, `ci:`).

## 5. Branch protection & release
- `main` is protected: required PR review + required CI status checks; branches
  must be up to date before merge.
- Workflow-file changes have one extra operational rule: scheduled GitHub
  Actions only take effect from the default branch, so after merging workflow
  changes, smoke-test them with `workflow_dispatch`.
- The `trellis-update-tracker` workflow writes back
  `.github/trellis-tracker/state.json` as `github-actions[bot]`; if branch
  protection is tightened further, keep an allowance/bypass path for that state
  commit or the tracker will fail to persist its state.
- Semantic Versioning tags (`vMAJOR.MINOR.PATCH`) for releases; update
  [`CHANGELOG`](../docs/ARCHITECTURE.md) on release.
- [`CODEOWNERS`](./CODEOWNERS) routes review by path.

## 6. Attribution
- MAW reuses **ideas** (not code) from referenced projects; see
  [`NOTICE.md`](../NOTICE.md) and [`ACKNOWLEDGEMENTS.md`](../ACKNOWLEDGEMENTS.md).
- Contributions are attributed to their author in the commit/PR (no fabricated
  contributor names).
