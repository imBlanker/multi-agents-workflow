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

Locks use complete, atomically published UUID claims and Lamport bakery ticket
ordering. They verify PID, machine identity and Linux process start identity
rather than expiring by age. Confirmed dead claims can be removed without
unlinking a later owner; a crash before publication leaves only an ignored
temporary file. Other platforms can detect nonexistent PIDs but cannot prove
PID continuity with this version; unknown ownership participates in normal
ticket ordering and is never permission to reclaim. Earlier unverifiable
contenders cause bounded waiting and fail closed. Invalid claim data fails closed. Async callbacks are not
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

## Selection-first lifecycle (W02)

The lightweight `index.js` entry dispatches Core without importing optional
host readers, Trellis, cc-switch, inventory or enhancement adapters. Compatibility
plan/graph/cost/agent commands retain their implementations in `legacy-cli.js`,
whose dependency closure now contains only Core modules. Selected usage functions
are passed explicitly into cost and watchdog code rather than discovered there.

`loadContext(project, {settings, piDir, dshHome, dshDumpConfig, dbPath})` accepts an
explicit settings snapshot. That snapshot and path overrides flow through the
inventory model readers, so an inventory operation or future run snapshot cannot
silently read a newer project's integration selection. Managed Pi rows preserve
DB provider identity; local model files only enrich model lists. Model discovery
never reads Pi MCP adapter configuration unless that capability is selected.

`scanInventory()` and the exported lifecycle seams (`runUpdateLifecycle`,
`runUpgradeLifecycle`, `repairMawOverlays`) now return promises; callers must
await them. The CLI already awaits these paths. Historical synchronous test
assertions are retained as historical assets and need independent classification;
they were not edited to disguise the API change.

New init writes explicit settings and a native workspace marker unless Trellis
was selected. Existing native marker bytes remain unchanged. A selected Trellis
adapter probes only a local executable and the pinned 0.6.17 compatibility
contract; it never invokes npx or fetches upstream. Actual initialization also
requires an explicitly selected target host. A native marker retains its
lifecycle opt-out even when a conflicting Trellis selection is present.

Installer updates serialize the complete manifest read/copy/stale-file/write
transaction under the shared atomic-state lock. They reuse recorded host roots,
preserve unselected surfaces, and remove only old manifest entries absent from
the selected surfaces refreshed by this update. Uninstall removes exact manifest
entries and retains project data; legacy manifests without an ownership list are
reported for migration rather than guessed with a prefix scan.

Pool judgments retain graph/plan stages, the derived task profile, configured
thresholds and per-stage cadence. Watchdog registry scans apply each project's
selection independently. Workspace transport does not authorize SSH or tmux:
these have separate gates. A bridge workspace chosen at handshake rechecks its
own selection and advertises only its allowed knowledge/terminal capabilities.

This slice does not claim authenticated plugin execution, dispatch leases,
strict cost accounting, mode snapshots, migration completion or release readiness.
Those remain the subsequent work packages.
