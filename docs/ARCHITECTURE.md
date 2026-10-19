# MAWF 1.0.0 architecture

Core works with all optional integrations disabled. The public entrypoint uses
inert registry/selection metadata; selected backends load lazily. Configuration,
planning, execution observations and independent acceptance are separate layers.

| Module | Responsibility |
| --- | --- |
| settings / atomic-state | Validated revisioned settings; strict reads; atomic writes; process-identity locks |
| integrations / modes | Explicit capability selection and extensible dynamic/fixed mode registry |
| planner / fixed-plan / role-overrides | Existing architecture scoring or fixed roles, with persistent user overrides |
| legacy-migration / generated | Reversible import; immutable generated versions and an atomic pointer; owned compatibility views |
| model-provider / pricing / pricing-sources | Selected discovery, canonical price records, bounded source refresh and last-good data |
| usage / cost-policy | Historical estimates versus genuine payment evidence, bound approvals, unknown coverage and explicit risk bounds |
| runtime | One canonical shared ledger, run snapshots, tasks/attempts, fenced leases, author identities and candidate transitions |
| local-runtime / adapters / native-host | Real process or selected companion lifecycle, observed identity, cancellation and stop verification |
| native-deadline / run-cli | Independent deadline keeper, dependency-ready queue and native controlled child inheritance |
| autoresearch | Exact persistent Pi extension session, dedicated worktree, metric/oracle protection and real keep/discard |
| verification | Content/config identity, independent instances, raw evidence hashes, scope/policy acceptance and drift detection |

Dynamic keeps loop, orchestrator-workers, multi-agent, graph, dynamic and ultracode
selection. Fixed-1 never uses scoring to delete mandatory independence or role
boundaries. New runs snapshot mode/version/config/selection/roles/acceptance policy;
children inherit. A new default or disabled integration does not rewrite old runs.

State lives under the canonical project's `.mawf/runtime`, including when callers
use Git worktrees. Runtime/evidence are excluded from candidate product hashing;
user effective settings are represented by the immutable run hash. Candidate
identity includes committed, dirty, untracked and requested build content. A
successful child result is produced; only matching independent evidence permits
accepted. The validator verifies reference consistency, not semantic truth or a
person's identity beyond recorded execution instances.

The budget boundary is honest: known unit prices and historical imports do not
prove current charges; default unknown policies pause. Explicit bounded unknown
subscription coverage requires a real native account observation and a registered
parent process with an enforceable deadline. Native child selection inherits its
observed parent; actual per-job metadata is not invented from caller requests.
strict_measured still requires supported current payment telemetry.

The process boundary is Linux-verified PID/start/process-group identity. No lease
expires just because it is old. A missing heartbeat triggers reconciliation;
unknown backend termination retains occupancy. Native Agent completion is a
host_managed return receipt, scoped to that job; it does not prove arbitrary
external processes stopped. Worktrees and role prompts are not OS sandboxes.

Source, permissions and capability evidence are recorded separately from installed
status. Pi/Codex resume is unsupported where exact session recovery is not proven.
A proposed fallback is not an executed actor. Details: V1_RUNTIME.md,
V1_EXECUTION.md, V1_ADAPTERS.md, V1_VERIFICATION.md, V1_PRICING.md and V1_MODES.md.
Historical v0.8 architecture explanations remain in docs/history/v0.8-reference;
their implicit discovery/real-spend claims are superseded here.
