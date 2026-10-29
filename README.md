[English](README.md) | [简体中文](README.zh-Hans.md) | [繁體中文](README.zh-Hant.md)

# MAWF 1.0.0

MAWF provides explicit workflow selection, a shared task ledger, optional host
adapters, and independent candidate acceptance. This is the 1.0.0 source tree;
publication status and exact validation evidence are in docs/V1_RELEASE_STATUS.md.

The npm package is `multi-agents-workflow`; the executable is `mawf`. The similarly
named singular package is unrelated. Core requires Node >=20.17 and has no npm
runtime dependencies. Optional Pi Autoresearch 1.9.0 requires Node >=22.

## Start with Core

```sh
node bin/mawf.js init --project /path/to/project --json
node bin/mawf.js integrations list --project /path/to/project --json
node bin/mawf.js plan --project /path/to/project --json
node bin/mawf.js mode fixed-1 --project /path/to/project --json
node bin/mawf.js mode status --project /path/to/project --json
```

New projects default to `dynamic` and every external integration is disabled.
Core config, planning, modes and task status work without host/plugin/database
credentials. A native `.mawf/workspace.json` marker survives lifecycle operations.
Select a host or enhancement explicitly; selection does not install, authenticate,
start a model, or prove readiness:

```sh
node bin/mawf.js integrations enable host.claude-code --project /path/to/project
node bin/mawf.js install --project /path/to/project
```

Install/update materialize only selected surfaces and preserve exact ownership.
Disabling a project does not remove another host's assets. User files, credentials
and unselected integrations are retained. See [installation](docs/AGENT_INSTALL.md).

## Modes, settings and generated files

Dynamic retains the existing loop, orchestrator-workers, multi-agent, graph,
dynamic and ultracode planner. Fixed mode 1 has a separate Claude-primary role
policy: delegate implementation, do not have implementers write tests, use a
minimum of one independent Hacker, require counterexamples and a real user path,
refill ready work, and stop unchanged retries after two same-cause failures.
Role intent is policy_only until a real host boundary demonstrates enforcement.

`.mawf/settings.json` is authoritative. Role overrides and mode-scoped custom
agents survive replanning. New generations are written under `.mawf/generated/`
and selected with an atomic pointer. Compatibility files are replaced only when
ownership hashes match. `plan --out DIR` writes only DIR. Queued/running tasks
and later children retain their original mode/config/policy snapshot.

Legacy migration imports proven configuration, preserves full backups and treats
old approvals as historical. It never enables an integration merely because a
directory exists. `mawf migrate --dry-run`, `mawf migrate` and `mawf migrate
rollback` expose the import and real backup path. Changed settings require an
explicit force choice for rollback. See [modes and migration](docs/V1_MODES.md).

## Execution and acceptance

`mawf run --guide` prints guidance. Default `mawf run --task TEXT` uses a real
managed native Claude process when actual identity and cost policy permit it.
The package provides `/mawf:mode`, `/mawf:integrations`, `/mawf:run` and real role
frontmatter. Keep the complete package together for `claude --plugin-dir
/PACKAGE/plugin`; plugin-only caches lack the sibling Core runtime and contracts.

Actual native child dispatch inherits a registered parent's observed model,
provider and billing. The Agent definition has model:inherit; the tool model
argument is omitted. Agent IDs are actual execution instances; unexposed child
session IDs/model observations remain unknown. An existing interactive session
without a registered parent-model binding returns HOST_MODEL_UNVERIFIED.

The atomic ledger controls registered jobs with shared project/run caps, leases,
fencing tokens and process identities. Unknown termination retains a slot;
there is no 30-minute age eviction. Cancellation distinguishes requests from
confirmed process-tree/host invocation completion. Background native controllers
have an independent deadline keeper. See [runtime](docs/V1_RUNTIME.md) and
[native execution](docs/V1_EXECUTION.md).

A produced result is not accepted. Candidate identity includes commit, dirty
content, relevant untracked/build artifacts and effective configuration. Evidence
must come from distinct recorded actors and fresh instances, name an independent
oracle, retain raw output hashes, and match the current candidate and policy.
Product/configuration/evidence drift invalidates acceptance. See the
[evidence contract](docs/V1_VERIFICATION.md).

## Pricing and optional capabilities

Unknown prices/coverage are unknown, not zero. API price projections, historical
imports, and client totals are estimates; they do not establish measured live
payment. Expensive selections require matching identity-bound approval.
`strict_measured` refuses unsupported live coverage. Subscription login does not
prove quota or free usage. Default unknown policies pause; a separate explicit
bounded risk choice is available for an observed native subscription under
registered concurrency/deadline control. No validation project is opted in
without the user's decision. See [pricing](docs/V1_PRICING.md).

Optional companions target Kagandi/pi-plugin-cc and the imBlanker/codex-plugin-cc
fork, with pinned source/version checks. Pi model strings are resolved by an
actual no-prompt get_state check before dispatch; provider/model ambiguity fails
closed. Installed does not mean authenticated or ready. Companion per-turn actual
identity may be unavailable and stays null. Persistent Pi Autoresearch performs
real bounded experiments in a dedicated worktree, protects the oracle/metric,
and still requires a separate Hacker. See [adapters](docs/V1_ADAPTERS.md).

## Verification and release limits

Independent Linux evidence covers configuration/install boundaries, a real
32-minute local process, mode isolation, the Pi companion's verified canonical
model path, a real Pi optimization/keep/stop chain, and ordinary independent
mode-control handoff. These scopes do not prove every platform or optional host.
Windows local tasks use native Job Objects and creation identities. Native Claude
uses AppContainer tools without WSL; see docs/V1_WINDOWS.md for prerequisites and
evidence limits. Live payment telemetry remains unverified. Linux live acceptance
and Windows no-model controller tests cover different scopes.
Historical automated checks are retained; failing legacy assumptions and
unresolved failures are reported, not rewritten into green results.

Run `npm test` and `node scripts/test-packed-install.mjs` for the retained release
checks. See [release status](docs/V1_RELEASE_STATUS.md),
[platform scope](docs/CROSS_PLATFORM.md), [architecture](docs/ARCHITECTURE.md),
[upstream provenance](docs/UPSTREAM_COMPATIBILITY.md), [changelog](CHANGELOG.md)
and [NOTICE](NOTICE.md). No push, tag, merge or publication is authorized by a
plan or a local package build.
