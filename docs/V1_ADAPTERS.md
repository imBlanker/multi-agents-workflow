# Selected companion and experiment adapters

All model tasks use the same run snapshot, price policy, cap, lease and fencing
identity. Discovery loads no model backend when the integration is disabled.
Installed/discovered, compatible, authenticated and ready are separate fields.
No actual provider/model is invented from the requested values.

Supported companion protocols are pinned to:

- Kagandi/pi-plugin-cc a8c4db32fbd5b3b3a028b1dcb95cbba60c4cc07e,
  plugin 1.2.0, explicit `task --background --fresh --model model` with a mandatory no-prompt get_state identity preflight.
- imBlanker/codex-plugin-cc d6a979b35741f3654c6f0f64cea0642104e9105b,
  plugin 0.2.0, explicit `task --background --fresh --model model`.

`adapter discover|probe --adapter ID [--path DIR]` reports metadata only. Lookup
uses explicit path, host installation metadata, configured compatiblePaths,
then bounded marketplace directories. Paths/options persist under the selected
integration's `options`. Origin, ref, version and companion digest are retained.
Another revision is unverified, never silently compatible. The marketplace name
openai-codex is not evidence of the fork's source.

Create a run and `task add --adapter ID --provider P --model M --billing api
--actor-id ACTOR --workspace WORKTREE --max-duration-ms N`. Then use
`adapter start --run-id R --task-id T --prompt-file SPEC [--path DIR]
[--effort low] [--write]`. A background supervisor claims the single permitted
launch, obtains the real upstream job, binds the Linux PID/start/process group,
maintains heartbeat/deadline, and collects nonempty results. Replayed starts do
not launch again. `adapter status|result|cancel` use the run/task mapping; optional
lease/token reject stale attempts. Cancellation asks upstream and independently
checks the recorded process tree. An unbound/unknown process keeps its slot.

Codex performs an app-server provider preflight; a provider mismatch is rejected
because the companion cannot override it. Raw account/config responses are not
logged. The requested model is explicit, but the pinned companion does not expose
resolved model or reroutes, so those remain unknown. Pi receives the explicit bare model ID and a fresh non-persistent one-shot session.
Before acquisition and immediately before launch, the same Pi model/effort argv
is resolved with get_state without sending a prompt. Any provider/model mismatch
is rejected. A qualified provider/model string can match another provider’s exact
model ID and is never treated as provider binding. This preflight is a separate
observation; the pinned companion still does not expose per-turn resolved identity. Pi companion does not enforce
read-only access, so researcher/advisor roles are rejected there. Codex requests
its real upstream sandbox; metadata alone does not claim permission verification.
Legacy review now requires runtime run/task/prompt identity and uses this path.

Companion resume-last is not exact task/session recovery: `adapter resume`
returns unsupported. Existing status/result and Core recovery preserve the
original job and never relaunch it. A controller death or lost start response can
require manual reconciliation; no age-based release or guessed job lookup occurs.

## Bounded Pi Autoresearch

`autoresearch start --contract FILE --run-id R --task-id T` consumes an existing
`autoresearch.pi` task whose workspace is the contract's new dedicated worktree.
Contract fields: objective; metric{name,unit,direction}; measured baseline;
scope (relative filenames); oracle{path,sha256}; sourceRepo; worktree;
extensionPath; maxIterations (2..100); maxDurationMs (1s..1h); stopCondition;
keepRule. Missing reliable measurement returns not_applicable. Invalid identities
or bounds fail before model activation.

The implementation creates an exclusive branch/worktree from sourceRepo HEAD;
other checkouts and their changes are untouched. It loads explicit
pi-autoresearch 1.9.0 (Node >=22; Core's Node floor is unchanged), keeps RPC stdin
open, verifies get_commands against the exact extension and get_state against
the new persistent session. Observed provider/model is gated before activation.
The extension's actual run_experiment/log_experiment tools perform baseline,
measurement, keep commits and discard rollback. `agent_end` is not whole-loop
completion; the adapter observes agent_settled plus the log and idle state.

All non-scope tracked files, measure/checks/config/prompt, external oracle, and
extension entry are hashed before activation and checked periodically and after
completion. Drift fails the experiment. The contract iteration limit is checked
against extension config, and Core independently applies its deadline. Stopping
uses `/autoresearch off`, `clear_queue`, `abort`, idle observation, stdin EOF,
and recorded process-tree verification before release. Persistent session/logs
remain available. `autoresearch resume` honestly reports unsupported until exact
interrupted-loop recovery is independently demonstrated.

A produced experiment is not accepted: independent Hacker correctness and a real
user path are still required. Worktree/prompt restrictions are policy boundaries,
not an OS or credential sandbox. Periodic integrity checks cannot establish that
no transient edit occurred between observations. External backend payments and
Windows process-tree behavior remain unverified.

`examples/autoresearch-sum` supplies a real loop baseline and measurement only.
An independent Hacker must supply its external oracle and checks wrapper.
