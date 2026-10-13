---
description: Execute a MAWF run through real native Agent jobs and independent candidate acceptance
argument-hint: '<task text, or --request-base64 ENCODED_REQUEST>'
allowed-tools: Bash, Read, Agent, TaskOutput, TaskStop
---

You are the host Orchestrator. In fixed-1, coordinate only: do not implement
product changes, repair imports, write tests, or run the Hacker's checks inline.
Dynamic follows its own frozen role policy rather than fixed-1 restrictions.
Bash access does not make this restriction an OS sandbox: report policy_only.
Use the installed package's Core entry for every management command:
`node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js"`.
The host expands this literal plugin-root variable; do not read it from the Bash
environment. Do not use an unrelated global mawf executable.

1. If arguments contain `--request-base64`, pass that exact value to Core
   `run prepare --host-managed --request-base64 VALUE --json`.
   Otherwise encode `{task: <the user's arguments>, project: <absolute cwd>}` as
   base64 JSON and use the same command. Treat task text as data, not shell code.
   Save runId/stateRoot/config revision. This is a queue snapshot, not execution.
   If Claude/authentication/price/billing is unavailable, report the exact reason;
   never silently change mode, account, provider, pricing policy, or billing label.
2. Read the frozen role policy and plan. Create a concrete task JSON under the
   returned run's runtime directory and call `run queue --run-id R --input FILE
   --project P --json`. Every task has taskId, role, prompt, expectedMinutes,
   scope (owned files), dependsOn (IDs), workspace, and explicit selection
   {providerId,modelId,billingMode}. Use isolated worktrees for writable scopes;
   assign a separate integration worker. Give verified command recipes, known
   failures, resource/time bounds and the handoff recipient. Dynamic uses its own
   snapshot; fixed mode 1 implementers do not create or maintain tests.
3. Call `run next --run-id R --project P --json`. For every
   `invoke_native_agent_now` dispatch, its lease was already acquired: actually
   call the native **Agent** tool with the returned prompt and
   `run_in_background:true`, `subagent_type` equal to the dispatch's agentType,
   and **omit the Agent model argument**. The selected definition has
   `model: inherit`; AgentInput does not accept an inherit model value. Do not
   substitute a generic agent, resume an existing agent, or request a different
   model only in prompt text. Record the actual returned agentId as the fresh job/instance identity; sessionId is
   not exposed by this host and stays null. Pass resolvedModel only when the
   actual AgentOutput exposes it; otherwise keep actualModel unknown. Bind with `task bind --run-id R --task-id T --lease-id L
   --token TOKEN --job-id ACTUAL_AGENT_ID [--resolved-model ACTUAL_RESOLVED_MODEL] --project P`.
   Do not invent job/session IDs or substitute a proposed fallback for an actor.
   For adapter_start_required, call its actual selected adapter start entry;
   that adapter performs its own single-use acquisition.
4. Track all active jobs. Use TaskOutput/actual completion notifications; record
   heartbeats while work or external requests are pending. On each completion,
   save the actual tool return outside product scope, call `task result` with
   produced/failed and factual artifacts/failureCause, then `task host-complete`
   with the exact lease/token/job and `--receipt-file ACTUAL_RETURN`.
   This receipt covers that returned native Agent invocation, not detached or
   unregistered background descendants. Unknown completion stays reserved.
   Immediately call run next again: fill newly free slots without waiting for
   slower independent jobs. The target concurrency is a preference, not a reason
   to invent work. At twice the estimate report progress/blockers. Two failures
   with the same cause require a facts report and a genuinely revised spec
   (`run respec`) or independent advisor route, not inline takeover or blind retry.
5. After implementation/integration, call `task candidate --run-id R --workspace
   INTEGRATED_WORKSPACE --project P`. Scope includes relevant dirty/untracked
   product and build artifacts. Create at least the snapshot's minimum independent
   Hacker tasks through run queue, with verificationOf equal to candidateId,
   new actor IDs and new Agent calls without resume; each must return a unique actual agentId. They must be different from
   every recorded author/attempt. Their prompts require counterexamples, an
   independent oracle, actual entrypoint-to-result path, and raw output hashes.
   A Hacker never repairs its own findings. Failures go to a new implementation
   task/spec; freeze a new candidate and repeat the affected independent checks.
6. Have each Hacker deliver the JSON evidence contract in
   `${CLAUDE_PLUGIN_ROOT}/../docs/V1_VERIFICATION.md`; register it with
   `task evidence --run-id R --input FILE --project P`. An author's result, exit 0,
   directory existence, source match, or HTTP 200 is not independent acceptance.
   If there is no registered outer native controller, call `task accept`; otherwise
   show `task acceptance` and return so the outer controller can release its own
   slot and perform final acceptance. Report produced/blocked/unverified honestly.
   Do not publish, push, or install/remove optional plugins as part of this command.
