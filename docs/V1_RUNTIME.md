# Fenced runtime contracts (W04)

`src/runtime.js` owns one atomic `ledger.json` per canonical stateRoot. Git
worktrees resolve authority settings and default stateRoot through their common
repository; the caller's worktree remains the execution workspace. An explicitly
shared existing stateRoot retains its recorded settings authority. Run creation
locks settings before ledger and freezes mode/version/configRevision, role policy,
integration choices, initial capability metadata and effective configuration hash.
The entire snapshot has an immutable hash; pricing lives in a hash-bound sidecar.
Later children and retries inherit the run snapshot, not current mode settings.

## CLI

All commands accept `--project`, `--state-root`, `--json` and produce a schemaVersion
1 object. Admission denials exit nonzero. Configuration and process identity
errors do not become empty state or free capacity.

```sh
mawf task create --run-id R --project PROJECT --max-concurrency 2 --json
mawf task add --run-id R --task-id T --adapter local-process --role worker --command-json '["node","/absolute/authorized-command.mjs"]' --max-duration-ms 60000 --project PROJECT --json
mawf task dispatch --run-id R --task-id T --launch-key R-T-1 --project PROJECT --json
mawf task status --run-id R --project PROJECT --json
```

`dispatch` is a real foreground local supervisor: acquire → one launch claim →
spawn in a dedicated process group → bind PID/start identity → heartbeat → actual
child terminal event/result → verify stopped process/group → release. Output is
stored under `runs/R/output/T/attempt-N.stdout|stderr`, each stream bounded to 8MiB.
A failed spawn releases only with the Core adapter's confirmed-not-started fact.
A very fast child's real ChildProcess exit event is a scoped receipt, never
misclassified as a process that did not start.

For native/plugin controllers, the public management sequence is:

```text
task acquire --run-id R --task-id T --attempt N --launch-key K --actor-id A
  [--owner-pid CONTROLLER --owner-start-identity START]
task bind --lease-id L --token TOKEN --pid BACKEND --start-identity START
  [--process-group GROUP --job-id JOB --session-id SESSION]
task heartbeat --lease-id L --token TOKEN [--progress TEXT]
task result --lease-id L --token TOKEN --status produced|failed --result-json JSON
task cancel --lease-id L --token TOKEN [--grace-ms 1500]
task release --lease-id L --token TOKEN
task resume --run-id R
task list | task status --run-id R [--task-id T]
```

An acquire replay returns `action: observe`; only the first `action: start`
authorizes launching. The controller identity is separate from the backend
identity. A short-lived CLI does not pretend to be the persistent controller;
without explicit owner flags it records controller unknown. Same-attempt actor
changes are rejected; explicit next attempts retain reassignment history.
Bindings are immutable: identical replay is idempotent, changed PID/start/job/
session identity is refused. All roles/runs share the project cap plus each run's
local cap. Current authority resource limits apply only to new admission and
never delete existing reservations.

## Stop, recovery and safety boundary

Alive jobs, unbound launches and uncertain termination retain capacity regardless
of age. There is no 1800-second deletion. A dead controller is not evidence that
its backend stopped. Cancel intent survives late bind, heartbeats and launch
claims. Cancellation signals only a group established by a currently matching
owner or recorded live member identity. Unverifiable group ownership stays
cancel_pending. This conservative condition can require operator/backend evidence
instead of guessing or signaling a reused PID/group.

Stop/observation commands bypass current settings discovery, so malformed new
settings or a disabled integration cannot prevent cancelling an existing run.
Bad ledger JSON, unknown states, broken task/lease references or snapshot drift
fail closed. Fencing blocks old result/release calls from modifying a new attempt.
A reported artifact is produced, never independently accepted.

Local-process is an explicit non-model command backend, not a billing label.
Known direct model runners require their corresponding model adapter; arbitrary
scripts' self-initiated network/API costs remain out of band. Working-directory
and process-group tracking are not an OS security sandbox. Model reservations
consume the shared W03 selection gate. Host-managed bindings currently lack an
adapter-confirmed stop/resume protocol, so cancellation/recovery is unsupported
where the backend cannot be verified, and bounds-dependent unknown-price model
execution is denied until a capable adapter is connected. Windows local-process and native Claude controllers use creation identities and
non-breakaway Job Objects with empty-job verification before release. External
companion and Pi experiment transports remain unsupported on Windows. See V1_WINDOWS.md.

Old top-level acquire/release/guard use the same ledger. `--id` can alias an
existing task only with explicit run identity; releasing also requires the exact
fencing token. Unidentified legacy admission is refused. Legacy concurrency.json
with active records blocks new v1 admission pending reconciliation; records are
never expired or discarded by age. Cost reports expose the ledger occupancy and
unverified legacy count. Direct writes to the retired ledger are refused.

`guard` is a query, not a reservation; successful dispatch still requires acquire.
The ledger covers registered jobs only and does not impose global machine/API
billing limits. Independent long-heartbeat and cancellation checks are recorded
separately from author diagnostics.

Run-scoped `approve-model --scope run --run-id ID --yes` authorization issued
after queueing is recorded in the runtime ledger as an identity-bound event and
merged only into that run's admission check. The original settings/pricing/mode
snapshot stays unchanged. Persistent approvals affect future snapshots. There is
no implicit authorization from a retry. Revocation/expiry is not implemented.
