---
description: Execute a MAWF run through real native Agent jobs and independent candidate acceptance
argument-hint: '<task text, --request-ref UUID, or legacy --request-base64 ENCODED_REQUEST>'
allowed-tools: Bash, Read, Agent, TaskOutput, TaskStop
---

You are the host Orchestrator. In fixed-1, coordinate only: do not implement
product changes, repair imports, write tests, or run the Hacker's checks inline.
Dynamic follows its own frozen role policy rather than fixed-1 restrictions.
This role restriction is policy_only, not an OS sandbox. Under the registered
native controller Bash commands use Claude Code's sandbox, denying writes to
the MAWF state root and package. Only the named Core management commands below
leave it; `task dispatch` and bare `run` never do. User/managed sandbox grants
remain part of the trusted host configuration.
For a registered native controller, use the exact absolute Core command prefix
supplied in the session instructions, including for the initial prepare call.
Do not replace that interpreter with PATH-resolved `node`. For other host
sessions, use the installed package's fallback Core entry:
`node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js"`.
The host expands this literal plugin-root variable; do not read it from the Bash
environment. Do not use an unrelated global mawf executable. Run each Core call
as one plain command: a pipe, `&&` or `;` chain, redirection, heredoc, `cd` or
`$(...)` keeps the call sandboxed, so Core cannot record state.

1. If arguments contain `--request-ref`, run Core
   `run prepare --host-managed --request-ref UUID --json`, copying only the short
   reference. Core loads and validates the bounded request from this registered
   run; read `taskDescription` in its response as the complete user task. Do not
   reconstruct, encode or echo the full task as a command argument.
   For legacy arguments containing `--request-base64`, pass that exact value to Core
   `run prepare --host-managed --request-base64 VALUE --json`.
   Otherwise encode `{task: <the user's arguments>, project: <absolute cwd>}` as
   base64 JSON and use the same command. Treat task text as data, not shell code.
   Save runId/stateRoot/config revision. This is a queue snapshot, not execution.
   If Claude/authentication/price/billing is unavailable, report the exact reason;
   never silently change mode, account, provider, pricing policy, or billing label.
2. Read the frozen role policy and plan. Write a concrete task JSON file under
   the prepare response's `inputDirectory` (never under stateRoot) and call
   `run queue --run-id R --input FILE --project P --json`. Every task has taskId, role, prompt, expectedMinutes,
   scope (owned files), dependsOn (IDs), workspace, and `selection:"inherit"`
   for native Agent tasks. Use the exact outer JSON object `{"tasks":[...]}`.
   Core resolves inherit from nativeExecution.observedSelection in the prepare
   response; never copy blank/unknown model placeholders from the generic plan.
   Concrete conflicting role selections are rejected before any task is queued. Use isolated worktrees for writable scopes;
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
   that adapter performs its own single-use acquisition. Under the registered
   native controller the sandbox keeps adapter starts from recording state:
   report those tasks as blocked instead.
4. Track all active jobs. Use TaskOutput/actual completion notifications; record
   heartbeats while work or external requests are pending. On each completion,
   call `task result` with
   `--status produced --result-json '{"artifacts":["actual/path"]}'`
   (or `--status failed` with factual `failureCause` in result JSON), using the
   exact run/task/lease/token/project flags; `--produced` is not a CLI flag. Then call `task host-complete`
   with the exact lease/token/job/project flags and `--native-receipt` when
   using the registered outer controller; a manual receipt is rejected with
   NATIVE_RECEIPT_REQUIRED for these children. Core extracts the original completed
   task_notification event by actual job/tool/session identity and saves its raw
   line; it never derives completion from file existence or a model assertion.
   If the event is not yet available, wait briefly and retry without releasing.
   For other supported hosts save the actual tool return outside product scope
   and use `--receipt-file ACTUAL_RETURN`. Never invent a completion timestamp or
   rewrite a summary as a receipt. This receipt covers that returned native Agent invocation, not detached or
   unregistered background descendants. Unknown completion stays reserved.
   Immediately call run next again: fill newly free slots without waiting for
   slower independent jobs. The target concurrency is a preference, not a reason
   to invent work. At twice the estimate report progress/blockers. Two failures
   with the same cause require a facts report and a genuinely revised spec
   (`run respec`) or independent advisor route, not inline takeover or blind retry.
5. After implementation/integration, call `task candidate --run-id R --workspace
   INTEGRATED_WORKSPACE --project P`. Scope includes relevant dirty/untracked
   product and build artifacts; pass explicit --scope-json and --artifacts-json
   when the assigned product scope is narrower than the workspace. Use the
   returned hackerQueueExample, adapting only the concrete user oracle and
   evidence directory; do not retype role definitions or evidence schemas.
   Fixed-1 Hacker queues default writesProduct:false and bind an omitted
   verificationOf to the current frozen candidate at queue time. Explicit product
   writes or a different target are rejected. Do not fabricate lease/token fields;
   run next supplies them. Create at least the snapshot's minimum independent
   Hacker tasks through run queue, with verificationOf equal to candidateId,
   new actor IDs and new Agent calls without resume; each must return a unique actual agentId. They must be different from
   every recorded author/attempt. Their prompts require counterexamples, an
   independent oracle, actual entrypoint-to-result path, and raw output hashes.
   A Hacker never repairs its own findings. Failures go to a new implementation
   task/spec; freeze a new candidate and repeat the affected independent checks.
6. Have each Hacker deliver the JSON evidence contract in
   `${CLAUDE_PLUGIN_ROOT}/../docs/V1_VERIFICATION.md`; Hackers write evidence
   under the evidence directory their dispatch names and return paths, never
   register it while their job is still active. After
   their task result is produced and host-complete confirms release, register it with
   `task evidence --run-id R --input FILE --project P`, passing each file the
   Hacker declared as `MAWF_EVIDENCE <sha256> <path>` in its own return. Never
   edit, regenerate, copy or "fix" a Hacker's evidence: Core rejects bytes that
   differ from the declaration. If registration fails, report the reason code
   and queue a new Hacker task. An author's result, exit 0,
   directory existence, source match, or HTTP 200 is not independent acceptance.
   If there is no registered outer native controller, call `task accept`; otherwise
   show `task acceptance` and return so the outer controller can release its own
   slot and perform final acceptance. Report produced/blocked/unverified honestly.
   Do not publish, push, or install/remove optional plugins as part of this command.
