# 1.0.0 local release-candidate status

Updated 2026-10-29 during release preparation. This remains an unpublished
candidate. PRs #44 and #45 were merged into the PR #42 feature branch; PR #42 is
still open against main. The local `chore/v1-release-prep` branch adds the retained
suite migration, approved fixes, sandbox enforcement and review repairs. Local
results below do not establish GitHub CI success or authorize merge/publication.

## Independently observed scopes

- Configuration/mode registry and Linux atomic state: concurrent writers and
  interrupted writes, disabled-by-default integrations and explicit selection.
- Selected install boundaries, Core/offline behavior, public pricing refresh,
  normalization/unknowns and identity-bound approvals. A late approval reads the
  old run's frozen source selection and does not leak to another run.
- Registered Linux local processes: actual 1920-second heartbeat, caps, replay,
  fencing, controller/process recovery and confirmed tree cancellation. No
  arbitrary age expiry. Windows and external billing are not covered by this.
- Mode snapshots/children, global and per-mode overrides, owned projections,
  output-directory isolation, reversible migration and dynamic planner choices.
- Pi companion: pinned Kagandi source, real canonical model job with nonempty
  literal result, status and confirmed cleanup. Old alias/qualified-string
  ambiguity is rejected by no-prompt identity observation. Unexposed per-turn
  actual model/provider/session stay null.
- Pi Autoresearch: actual baseline and one implementation experiment, keep commit,
  independent correctness/measurement, protected inputs, stop and resource
  release. Exact interrupted-loop resume is explicitly unsupported.
- W09 ordinary mode-control handoff: an actual separate author and independent
  worker produced two evidence kinds and accepted that exact scoped candidate.
  This is not full-product acceptance or a completed adversarial matrix.
- Claude plugin metadata: exact run/mode/integrations command discovery, ten role
  definitions and strict manifest validation. Native billing policy and parent
  inheritance have separate no-model/simulated interface checks; those do not
  alone establish a real Claude Agent execution. The later 9da6fe1 live run
  separately reached a real Implementer Agent and created the requested artifact;
  it did not reach independent Hacker acceptance before its deadline.

## Native-chain validation and review

The earlier `e1ef9c5` serial live run completed Implementer, candidate freeze,
independent native Hacker, two unmodified evidence registrations and acceptance
with `ACCEPTANCE_REQUIREMENTS_MET`, CLI exit 0 and no active leases. This predates
the sandbox. Earlier failed traces remain preserved and are not relabelled passes.

At `ef6a09a`, a real Linux Claude Code 2.1.303 probe confirmed refused Bash writes
to the state root and package, a refused Write tool there, refused network access,
an ineffective unsandboxed retry request, a successful ordinary workspace write,
and successful Core prepare. A separate 180-second native run reached candidate
freeze but timed out before an independent Hacker; its controller lease was
released and CLI returned nonzero. It did not establish sandboxed acceptance.

The subsequent independent review found and repaired four paths:

- Broad Core exemptions allowed local-process dispatch outside the sandbox.
  Exemptions now name only the management subcommands required by `/mawf:run`.
- Native children could choose a manual receipt. They now require Core-captured
  completion events and reject manual/omitted receipts before mutation.
- A bare `node` exemption depended on PATH. Exemptions and initial/subsequent
  command instructions now pin the resolved interpreter; its directory is sealed.
- Candidate Git diff could run external diff/textconv callbacks. Both are disabled
  and actual fixture callbacks verify capture/revalidation do not execute them.

No-model regressions cover these repairs, including real shell quoting and
unchanged raw completion bytes. Live host matching of the final command prefix,
a fresh packed full-chain acceptance run, and the remaining trusted-host
configuration boundary still need verification. Consult `V1_EXECUTION.md` for
that boundary; sandboxing does not automatically constrain every process Core,
Claude hooks or other host extensions can start.

## Retained automated checks

The historical 124 common failures under the v1 rewrite were triaged against
explicit selection, frozen policies, the v1 CLI and removed v0.8 behavior.
The retained suite now selects the optional features its fixtures exercise and
checks the v1 contracts. Approved product fixes restore watchdog provider/policy
propagation, overlay error target/code, and accurate planner coverage wording.
Profile sync keeps its environment-plus-selection double gate. Pre-0.6 `.maw`
automatic renaming remains removed.

The 2026-10-29 final local suite contains 66 test files / 589 tests:

| Native environment | Pass | Fail | Skip | TODO |
| --- | ---: | ---: | ---: | ---: |
| Windows 11 / PowerShell / Node 24.16.0 | 580 | 0 | 8 | 1 |
| Windows 11 / PowerShell / Node 22.18.0 | 580 | 0 | 8 | 1 |
| WSL2 Arch Linux / Node 25.0.0 | 573 | 0 | 15 | 1 |

The single TODO is the explicitly deferred MAWF-only option isolation at the
legacy Trellis runner boundary. It is not a passed assertion. Windows Node22
initially crashed in the hook fixture's native directory-copy implementation
(exit `0xC0000005`); keeping that fixture on the JavaScript copy path preserves
Unicode coverage and all hook assertions while avoiding that crash.

Windows runs use isolated HOME/USERPROFILE, temporary configuration/cache paths,
credential-stripped environments and a PATH without real agent CLIs. The harness
records no external writes, no remaining related processes, no canary calls and
unchanged real-home npm files. Linux uses a fresh clone, isolated HOME/USERPROFILE,
and rejecting stubs for real hosts and external installers. Node25 Linux results
are not Ubuntu Node22/24 CI evidence. The final four GitHub CI jobs remain pending.

The A20 packed-install gate was migrated to assert rejection of unselected
knowledge, then explicitly select knowledge and archify before exercising them.
The final Windows Node24 gate passed, auditing 249 files; Linux results are
recorded with the package verification evidence;
the earlier failure under the old implicit-selection assumption remains historical.

## Remaining release gates and limits

- Verify the final native sandbox command prefix and complete one bounded packed
  Implementer -> candidate -> independent Hacker -> evidence -> acceptance run.
  The Claude session exhausted quota before that run; a prior unsandboxed pass
  does not satisfy this gate.
- **Unresolved sandbox integrity blocker:** Git `core.fsmonitor` and
  `filter.<name>.clean/process` callbacks can still execute through candidate
  capture/revalidation. A helper in a session-writable location can run outside
  Bash isolation. Caller-selected nested/temporary repositories add an unverified
  configuration path. Sandbox Git itself or pin a controlled immutable execution
  environment; preflight alone leaves a race. Do not treat this as accepted.
- Push/PR/CI actions, PR #42 body refresh and a green Ubuntu/Windows Node22/24
  matrix remain separate maintainer steps. Main merge, tag and npm publish have
  not been performed. Existing oversized modules remain a documented review item.
- Windows continues to refuse local-process and companion admission without a
  verified PID start identity. Native controlled execution remains Linux-only.
- The installed Codex custom provider lacks applicable pricing/billing evidence;
  its real companion path stays blocked. Claude OAuth does not prove quota or
  payment. Strict current measured payment telemetry is not verified.
- Ordinary already-open Slash sessions lack registered parent-model binding.
  Role ownership/file scope remains policy_only. User/managed sandbox arrays can
  widen host permissions; hooks and other host processes run outside Bash isolation.
- Earlier W09 negative checks stopped by automatic content review remain unverified;
  no absent evidence was transferred or self-accepted to fill those gaps.
