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
Bash can still write files: orchestration-only and file scope are policy_only.

`run prepare --host-managed --task TEXT` is the management handshake inside an
existing Claude session. It returns frozen policy/roles, but does not claim a
child was dispatched. The existing session is outside worker billing coverage.
`run queue --run-id R --input FILE` consumes `{tasks:[...]}`. Each entry requires
plain taskId, role, concrete prompt, expectedMinutes, owned scope array, dependsOn
array, and preferably explicit workspace/selection{providerId,modelId,billingMode}.
Optional fields include actorId, adapter (default host-managed), maxDurationMs,
writesProduct, verificationOf. Writable work needs a concrete nonempty scope.

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
failureCause. `task host-complete --job-id ACTUAL_AGENT_ID --receipt-file FILE` checks the exact fenced binding and retains the tool-return hash before
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
