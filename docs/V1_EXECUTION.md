# Native execution and the ready queue

`mawf run --guide` is explicitly informational. Default `mawf run --task TEXT`
creates a frozen run and, when the selected native Claude account and model pass
the same price policy, launches real `claude -p /mawf:run` against the complete
local package's plugin directory. It records the actual stream init/session,
Agent tool calls/results, model, plugin paths and final client cost estimate.
The native process owns a fenced slot; subscription authentication alone never
establishes verified quota or free API billing. An OAuth/API/provider mismatch
fails before model launch. Current missing billing coverage remains blocked.

Direct host commands are `/mawf:mode`, `/mawf:integrations`, `/mawf:run`. Their
Markdown uses the host-expanded literal `${CLAUDE_PLUGIN_ROOT}`; copied command
assets are materialized to the owning package's absolute Core path. The complete
package must contain plugin, bin, src and docs together. In-place plugin loading
has been metadata-validated; a plugin-only cache is not claimed equivalent.
Fixed roles are top-level `mawf-fixed-*` agents with real frontmatter/tool lists.
Native CLI uses the default built-in tool pool; each role's frontmatter narrows
that pool. A global Read/Bash-only pool would also disable Implementer Write/Edit.
The fixed main role remains mawf:mawf-fixed-orchestrator; existing permission
rules still apply. Fixed-1 native sessions use acceptEdits so an authorized
Implementer can use Write/Edit for ordinary files inside the working directory;
dynamic sessions keep dontAsk. The main fixed role still excludes Write/Edit.
Claude ignores permissionMode in plugin subagent definitions, so this is an
explicit per-launch mode, not a claimed role-specific permission override.
Slash-command allowed-tools apply only to the turn that invoked /mawf:run; a
background Agent notification starts a new main turn. Native launches therefore
pass the same list (read from plugin/commands/run.md) as session-level
--allowedTools, so post-notification turns keep the first turn's permissions
instead of auto-denying Core calls, spec-file writes or evidence reads. This
does not widen what the first turn already had; managed/user/project deny rules
and protected paths still apply. It does not enforce each task's owned scope:
orchestration-only and file scope stay policy_only.

Native launches enforce Claude Code's Bash sandbox. On Linux it needs bubblewrap
and socat on PATH; without them the run is refused with NATIVE_SANDBOX_UNAVAILABLE
before any reservation. `--settings` turns the sandbox on with failIfUnavailable,
forbids the unsandboxed retry (allowUnsandboxedCommands:false), keeps the regular
permission flow (autoAllowBashIfSandboxed:false) and pins the weakening switches
off. Every Bash command, subagents' included, then runs without network and can
write only the working directory and the per-user temp directory, minus the MAWF
state root and package (filesystem.denyWrite). `--disallowedTools` adds
`Edit(//STATE_ROOT/**)` and `Edit(//PACKAGE/**)`, which keep Edit, Write and
NotebookEdit out of both. The only excludedCommands are plain calls of this
package's Core entry with `run` or `task`, so Core alone writes the ledger,
receipts and events, and a session cannot rewrite the Core it runs. A workspace
inside the package is refused (NATIVE_WORKSPACE_INSIDE_PACKAGE). Sessions write
queue specs under the prepare response's inputDirectory (`.mawf/inputs/RUN/`);
Hackers write evidence under `.mawf/evidence/RUN/TASK/ATTEMPT/`, which run next
creates and names in the dispatch. Both are in the run workspace, outside the
state root and product scope.

Limits of that boundary: adapter starts and anything that needs network fail
inside a native session. Sandbox arrays and directories from user or managed
settings (excludedCommands, allowWrite, allowedDomains, additionalDirectories)
still merge in and can widen it; repository settings cannot, because
allowUnsandboxedCommands:false from `--settings` makes the sandbox
admin-required. `node` in a Core call resolves through the session PATH, which
must not contain a session-writable directory. The stream does not report
sandbox status, so enforcement rests on failIfUnavailable. Hooks, MCP servers
and other processes Claude Code itself starts run outside the sandbox. This
follows https://code.claude.com/docs/en/sandboxing,
https://code.claude.com/docs/en/permissions,
https://code.claude.com/docs/en/cli-reference and
https://code.claude.com/docs/en/sub-agents.

A registered native launch writes a private schemaVersion 1 request under its
run's native directory and sends only `--request-ref UUID` to Slash.
`run prepare --host-managed --request-ref UUID` resolves the inherited native
context, verifies the active controller/lease, run and project identities,
canonical runtime path, bounded regular file and registered SHA256. Task text
is limited to 128 KiB; request files to 256 KiB. Overrides and expired controller
references fail closed. The response's taskDescription retains the full original
user task without requiring the model to retype its encoding. Legacy
`--request-base64` and direct task text remain supported. This shared-storage
integrity check is not an OS isolation boundary.

`run prepare --host-managed --task TEXT` is the management handshake inside an
existing Claude session. It returns frozen policy/roles, but does not claim a
child was dispatched. The existing session is outside worker billing coverage.
`run queue --run-id R --input FILE` consumes `{tasks:[...]}`. Each entry requires
plain taskId, role, concrete prompt, expectedMinutes, owned scope array, dependsOn
array, and an explicit workspace. Native Agent tasks use selection:"inherit"; the
prepare response exposes nativeExecution.observedSelection plus a complete queue
example. Null/empty/unknown plan placeholders inherit that observation. Concrete
conflicting fields or frozen role overrides are rejected before any task is
added. External adapter tasks use explicit selection{providerId,modelId,billingMode}.
Optional fields include actorId, adapter (default host-managed), maxDurationMs,
writesProduct, verificationOf. Writable work needs a concrete nonempty scope.
For fixed-1 hacker roles (including hacker-N), Core defaults writesProduct to
false and verificationOf to the currently frozen candidate ID; the resulting
concrete values are persisted in dispatchSpec. Explicit verificationOf tasks in
any mode receive the same non-product-writing policy. An explicit true,
conflicting target, missing candidate or author actor is rejected with a specific
reason. Dynamic custom roles named hacker do not acquire this fixed-role policy.
A later candidate never redirects an already queued verification task. Field
errors distinguish expectedMinutes, array types and an empty writable scope.
The task candidate response supplies hackerQueueExample for the exact candidate.
Adapt its prompt's concrete oracle/evidence directory; run next supplies real
lease identity and the verification contract. Hackers return their evidence paths;
the coordinator registers evidence only after produced and confirmed release.

`run next --run-id R` returns currently ready tasks up to target concurrency,
respecting dependencies, overlapping write scopes, the project cap, and model
policy. Native dispatches already have their unique lease. The actual Agent prompt
includes a MAWF_LEASE marker; the Core pre-tool hook consumes that permission
exactly once, even when the optional watchdog is off. Hook-free/out-of-band launches
are outside the stated guarantee. Call next on each completion to refill slots
while slower independent jobs continue. Adapter jobs acquire through their own
start entrypoints. Repeated queue submissions preserve identical task identities.

The host actually invokes Agent with run_in_background and the returned
subagent_type. The definition has model:inherit; the Agent model argument is
omitted because this host accepts only named aliases there, not inherit or
arbitrary full IDs. task bind records the real returned agentId, optional
resolvedModel, and the actual parent session/tool-use correlation. An unexposed
child sessionId remains null; the fresh agentId is the independent instance. and emits heartbeats while waiting. After the
actual tool returns, task result records produced/failed plus artifacts and
failureCause (`--status produced --result-json '{"artifacts":["actual/path"]}'`;
there is no --produced flag). Registered native jobs can use
`task host-complete --job-id ACTUAL_AGENT_ID --native-receipt` with their exact
run/task/lease/token/project flags: Core selects the original completed
task_notification event by job, tool-use and parent session IDs, stores the raw
line in the run's native/receipts directory, and uses the existing fenced
completion path. Missing/ambiguous events keep the slot reserved. No model-made
timestamps or completion assertions are used. Other hosts still use explicit
receipt files. `task host-complete --job-id ACTUAL_AGENT_ID --receipt-file FILE` checks the exact fenced binding and retains the tool-return hash before
release. This is a host_managed completion receipt, not OS proof that every
unregistered detached descendant has stopped. Unknown jobs retain reservations.
Native process adapters still require real process-tree termination.

Two failed attempts with the same explicit failureCause and unchanged spec cause
REPLAN_REQUIRED before a third launch. `run respec --run-id R --task-id T --input
FILE` records a new concrete prompt/spec for a stopped failed task. The role
policy also requires facts and an advisor route when appropriate; it does not
permit the orchestrator to take over implementation inline.

Freeze the integrated candidate, queue fresh verificationOf jobs, gather the
independent evidence contract, and call task accept. An outer native controller
finishes and releases its own slot before final acceptance. A proposed fallback,
produced candidate, metadata listing, or successful main CLI exit cannot become
accepted without the run's evidence policy.


## Explicit bounded unknown subscription coverage

Default `pricing.unknownCoveragePolicy` is `pause`. Authentication is not quota
verification. A separate, user-selected `bounded` coverage policy permits an
observed Claude subscription identity only under configured concurrency and
elapsed-time bounds. It reports basis unknown, amountUsd null, quota unknown;
API unit-price tables are not represented as actual subscription payment.
`strict_measured` still refuses absent verified payment telemetry. This option
has not been enabled in the implementation or validation projects automatically.

An example for a **new temporary validation project**, only after the user's
explicit risk choice, is:

```sh
node /ABSOLUTE/PACKAGE/bin/mawf.js config settings --project /TMP/VALIDATION --set '{"scheduler":{"targetConcurrency":3,"maxConcurrency":4},"pricing":{"unknownPricePolicy":"bounded","unknownCoveragePolicy":"bounded","bounds":{"maxConcurrency":4,"maxDurationMs":180000}},"cost":{"enforcement":"best_effort"}}'
node /ABSOLUTE/PACKAGE/bin/mawf.js integrations enable host.claude-code --project /TMP/VALIDATION
node /ABSOLUTE/PACKAGE/bin/mawf.js mode fixed-1 --project /TMP/VALIDATION
node /ABSOLUTE/PACKAGE/bin/mawf.js run --project /TMP/VALIDATION --provider anthropic --model claude-sonnet-4-6 --billing subscription --max-duration-ms 180000 --task 'Perform the small isolated verification task and hand off to an independent Hacker'
```

The model name is an explicit requested model; availability and actual init
selection must still be observed. This is an invocation recipe, not evidence of
a completed host run. The current account/provider must match and existing auth
is retained. Do not change billing to api, use bare authentication, or mutate a
prior run's snapshot to make this work.

Only a registered Linux native controller whose actual init model/provider passes
policy may dispatch these bounded children. Queue selections inherit that actual
parent model and observed billing. Different role-model overrides are rejected,
not silently ignored. Each child records controllerLeaseId and parent
PID/start/process-group, with a deadline no later than the parent. An independent
deadline keeper survives the initiating CLI's exit, requests cancellation and
checks the recorded process group before release. Controller stop settles only
its associated children, retaining unknown jobs. This bounds registered local
host execution, not upstream payment after transport cancellation.

An ordinary already-open interactive Slash session lacks that registered,
observed parent-model binding: it may manage snapshots and queues, but dispatch
returns HOST_MODEL_UNVERIFIED. The currently implemented real route is the Core
managed native process invoking `/mawf:run`; metadata registration is not proof
of a successful model/Agent/acceptance chain.

The registered native process passes a non-secret MAWF_NATIVE_RUN_CONTEXT to
its Core hook. Agent/Task launches without a lease marker are refused in that
controlled context. Before consuming a lease, the hook checks the real
subagent_type, absence of a per-call model override, and actual parent session
against the queued role and observed native parent. An unregistered external
host session retains the separately documented out-of-band limitation.


## Observed delivery validation and subsequent repair

The single user-authorized 180-second Sonnet 4.6 invocation on candidate d25dddd
loaded the real package/Slash and observed the expected parent identity. It
failed before any Agent call because queue accepted empty generic-plan selection
placeholders instead of inheriting the available parent selection. The deadline
stopped the real controller and process group with zero active leases, but the
then-current CLI incorrectly treated RELEASED as success and left its unstarted
child queued. That failed trace is preserved unchanged.

The subsequent local repair makes inheritance an explicit Core-owned input,
rejects meaningful conflicts atomically, and binds queued work to the exact
controller lease. Stopped controllers cancel their associated unstarted children
with recorded reasons; task/run outcome is distinct from release success.
Failure, cancellation or missing required acceptance returns nonzero. Repeating
execution with an existing controller run does not start another parent implicitly.
A separately authorized live run on 9da6fe1 subsequently passed inherited selection
and real Agent dispatch, producing the artifact. It reached the 180-second deadline
before independent Hacker acceptance, released both leases and returned nonzero.
Its trace exposed slow full-base64 copying, a global tool pool that disabled
Implementer Write, a model-reconstructed receipt and an invalid result CLI flag.
The short request, per-role tool pool and raw receipt changes above address those
specific observations. Their full live acceptance remains pending; reduced
startup overhead is a hypothesis until independently measured.

### Follow-up from the a506fda real run

The short reference reached prepare in 4.378 seconds (previous run 133.328),
and the native receipt exactly matched the completed host-event line. Actual
Agent output and candidate freeze succeeded. Hacker queueing failed twice because
scope was empty and writesProduct was omitted; the run reached its deadline
without independent acceptance. Write was available but denied under dontAsk,
so default tool availability alone did not prove working edit permission.
The next candidate normalizes verification queue policy and uses bounded native
acceptEdits as described above. These follow-up changes still need independent
interface checks and live confirmation; no acceptance is inferred from them.
