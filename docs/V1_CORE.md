# v1 Core contracts

The authoritative user configuration is `.mawf/settings.json`. It has
`schemaVersion: 1` and a monotonically increasing `configRevision`. No current
runtime or installed integration is inferred from a selected setting.

## Configuration and ownership

`readSettings(project)` returns validated settings or fresh defaults when the
file does not exist. Invalid JSON fails closed. `updateSettings(project,
mutate, {expectedRevision})` serializes synchronous mutations under a process
lock, validates before writing, and replaces the file atomically. A stale
expected revision fails without replacing settings. File permissions survive
replacement. Symlinks inside the state path are rejected; user links are not
removed or followed. The explicitly supplied project itself is canonicalized.

All integrations default disabled, including detected hosts. Core registration,
selection and listing read no upstream authentication or business data. A
selection is not installation consent, an authentication result or evidence of
readiness. Enabling dependencies is explicit; metadata lists unmet prerequisites
without enabling them on the user's behalf. Disabling only changes future
main-task selection and preserves upstream/user data and existing snapshots.

User settings own mode selection, integration choices, scheduler limits,
pricing policy/overrides, cost enforcement, acceptance policy and role overrides.
The generated plan and per-run snapshot layers are separate consumers. Legacy
configuration import and generated-plan integration belong to the migration and
planning work packages; this first Core slice does not claim those are complete.

## Public synchronous API

- `atomic-state.js`: `withLock(root,key,fn,opts)`, `readStrict(file,fallback)`,
  `writeAtomic(file,value)`, `processIdentity(pid)`, `processAlive(identity)`.
- `settings.js`: `defaultSettings()`, `settingsPath(project)`,
  `readSettings(project)`, `validateSettings(value)`, `updateSettings(...)`.
- `modes.js`: `listModes()`, `getMode(id)`, `modePolicy(id)`,
  `createModePlan(id,context)`. Dynamic generation delegates to the existing
  planner callback; fixed-1 exposes its phase and role policy.
- `integrations.js`: `INTEGRATIONS`, `listIntegrations()`, `getIntegration(id)`,
  `isEnabled(settings,id)`, `capabilityStatus(settings,id)`,
  `disableImpact(settings,id)`, `setIntegration(project,id,enabled)`.

Locks verify PID, machine identity and Linux process start identity rather than
expiring by age. A confirmed dead owner can be recovered. An ownerless lock or
unverifiable live identity fails closed after a bounded wait. Other platforms
can detect nonexistent PIDs but cannot prove PID continuity with this version;
unknown ownership is never permission to reclaim. Async callbacks are not
supported. File persistence is not a defense against a hostile process that
can concurrently modify the same filesystem paths.

## CLI

```sh
node bin/mawf.js mode list --json
node bin/mawf.js mode fixed-1 --project /path/to/project --json
node bin/mawf.js mode status --project /path/to/project --json
node bin/mawf.js integrations list --project /path/to/project --json
node bin/mawf.js integrations enable host.claude-code --project /path/to/project --json
node bin/mawf.js integrations disable trellis --dry-run --project /path/to/project --json
node bin/mawf.js config settings --project /path/to/project --set '{"scheduler":{"targetConcurrency":2}}' --expected-revision 2 --json
```

Control commands bypass automatic legacy migration. JSON output is a single
object with `schemaVersion`, `ok`, `reasonCode` and applicable identity fields;
invalid input returns nonzero. The `fixed` alias resolves to `fixed-1`, whose
display name is `fixed mode 1`. Unknown IDs do not mutate settings. Fixed-1
requires at least one independent Hacker and a real user path. Dynamic retains
its prior role behavior. Mode changes affect only newly created top-level runs.

Until runtime integration lands, mode status explicitly reports
`runtimeStatus: not_integrated`, `enforcementLevel: configuration_only` and an
empty `activeRuns`; it is not execution evidence. No Claude/Pi/Codex job has
been started by these configuration commands.
