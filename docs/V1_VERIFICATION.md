# Candidate identity and independent evidence

Run creation freezes `acceptancePolicy`: configured minimum independent actors,
real-user-path requirement, required capability names, and the fixed-1
counterexample requirement. Dynamic consumes its own configured policy and does
not acquire fixed-1 role restrictions. `task create --required-capabilities A,B`
can freeze task-specific required capability scopes.

After author jobs have produced results and released resources:

```
mawf task candidate --run-id R --project P [--task-id T] [--workspace W]
  [--scope-json '["."]'] [--artifacts-json '["dist/output.js"]']
```

The candidate binds commit, dirty diff, content inventory (including relevant
untracked/ignored build files), scope, explicit artifacts, effective run config,
and all recorded author actors across all attempts. Default inventory includes
all files except Git internals, runtime/generated/evidence state and dependency
caches. Symlink contents are hashed as link identities; external targets are not
read. Explicit dependency/runtime scopes are rejected. Scope must include every
relevant product/build artifact; an evidence assertion cannot expand it later.
Freeze an integrated run without `--task-id` before accepting multiple author
tasks. `.mawf/settings.json` is represented by the run's immutable effective
configuration, not by a subsequently changed default for another run.

For native fixed-1 queues, task candidate also returns hackerQueueExample.
`run queue` defaults fixed Hacker tasks to writesProduct:false and freezes the
current candidate ID into verificationOf when omitted. It rejects explicit
product writes, a different target, missing candidate and author identities.
Explicit verificationOf queues in other modes get the same verification policy;
dynamic custom role names alone do not. Normalized values remain visible in the
queued task's dispatchSpec. The target does not follow future candidate changes.
Hacker prompts supply the concrete independent oracle and evidence directory;
Core adds actual lease identity at dispatch. Never include invented lease tokens.
The Hacker returns evidence file paths; only after produced and released does
the coordinator call task evidence. Acceptance policy remains unchanged.

Register a distinct verification job using ordinary `task add` plus
`--verification-of CANDIDATE_ID --actor-id HACKER`. This status is established
before execution, not inferred from a role name. A prior author cannot become
independent by changing their role/model. Run it through the normal backend;
only a produced, released job can supply evidence. For local processes, its
recorded process job identity is the session; hosted jobs use the actual bound session when exposed, otherwise the real native
agentId/job instance. A parent session is correlation metadata, not a fabricated
independent child session. Reusing an author or another task's session is rejected.

`task evidence --run-id R --input FILE` validates this JSON contract:

- requirementId, scenarioId, runId; hackerTaskId and its attempt;
- modeId, modeVersion, configRevision;
- candidateId, commitSha (nullable for a non-Git project), diffHash,
  effectiveConfigHash, scope, implementerActorIds copied from the frozen candidate;
- hackerActorId, sessionId, model (actual if observed; otherwise the recorded
  request, or `not_applicable` for a local non-model job), adapter. Stored records
  explicitly label modelBasis observed/requested/not_applicable and retain
  requestedModel separately from observedModel (null plus a reason when unknown);
- kind: `counterexamples` or `real_user_path`; verdict: `passed`, `failed`,
  `blocked`, or `unverified`; capabilities: nonempty array of covered names;
- oracleSource: {kind, reference}, where kind is user_requirement,
  external_protocol, independent_calculation, real_observation or real_payment;
  oracleVersion, expectedBehavior, observedBehavior;
- entrypoint, exactSteps (nonempty string array), controlledInputs, environment
  (real paths cannot set simulated:true), counterexamples (nonempty for that kind);
- rawOutputs: [{path, sha256}], each nonempty file outside the product scope;
- timestamps: {startedAt, finishedAt}, after candidate freeze;
- scopeLimitations, degradations (arrays), costCoverage, enforcementLevel.

A Hacker may submit both evidence kinds. The minimum counts distinct actors,
not records; actual session reuse is rejected. Existence probes, exit code,
HTTP status, or source matching cannot be named as independent oracle kinds.
The validator checks identities, coverage, independence claims and raw file
hashes; it cannot determine the semantic truth of a written report or prove the
human identity behind a declared actor. Host-managed identity limits are shown
with the execution evidence.

`task acceptance --run-id R` reports missing evidence and drift.
`task accept --run-id R` changes status only after all frozen policy requirements
are met, with no active jobs or unfinished author tasks. Failed/blocked/unverified
records block their candidate; fixes require a new candidate and matching new
verification. Product/configuration/raw evidence changes invalidate acceptance;
status reports blocked rather than presenting an old accepted state as current.
Authors produce candidates; they do not submit their own acceptance evidence.
