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

The subsequent independent review found and repaired these paths:

- Broad Core exemptions allowed local-process dispatch outside the sandbox.
  Exemptions now name only the management subcommands required by `/mawf:run`.
- Native children could choose a manual receipt. They now require Core-captured
  completion events and reject manual/omitted receipts before mutation.
- A bare `node` exemption depended on PATH. Exemptions and initial/subsequent
  command instructions now pin the resolved interpreter; its directory is sealed.
  A live probe then showed that the review's quoted prefix never matched in
  Claude Code 2.1.303, which would have kept every Core call sandboxed. The
  prefix is now unquoted, and Node/package paths that would need quoting are
  refused (`NATIVE_SANDBOX_PATH_UNSUPPORTED`).
- Candidate capture diffed through the worktree, where repository-configured Git
  callbacks (external diff, textconv, clean/process filters, fsmonitor) ran
  outside the sandbox. Capture now asks Git only for the HEAD commit; fixtures
  confirm a plain diff runs each callback and capture/revalidation never do.

No-model regressions cover these repairs, including real shell quoting and
unchanged raw completion bytes. At `304ae89` a live probe confirmed the final
prefix matching, and one serial packed full-chain run (Claude Code 2.1.303,
Sonnet 4.6 subscription, fixed-1) reached `ACCEPTANCE_REQUIREMENTS_MET` under the
sandbox with CLI exit 0 in 456.8 seconds; `V1_EXECUTION.md` records its details
and the two model errors Core rejected on the way. Git and
the `claude` CLI are found through PATH and remain trusted host tools; consult
`V1_EXECUTION.md` for that boundary. Sandboxing does not constrain Claude
hooks or other host extensions.

## Retained automated checks

The historical 124 common failures under the v1 rewrite were triaged against
explicit selection, frozen policies, the v1 CLI and removed v0.8 behavior.
The retained suite now selects the optional features its fixtures exercise and
checks the v1 contracts. Approved product fixes restore watchdog provider/policy
propagation, overlay error target/code, and accurate planner coverage wording.
Profile sync keeps its environment-plus-selection double gate. Pre-0.6 `.maw`
automatic renaming remains removed.

At `db7e4cc` the final local suite contains 66 test files / 593 tests:

| Native environment | Pass | Fail | Skip | TODO |
| --- | ---: | ---: | ---: | ---: |
| Windows 11 / PowerShell / Node 24.16.0 | 584 | 0 | 8 | 1 |
| Windows 11 / PowerShell / Node 22.18.0 | 584 | 0 | 8 | 1 |
| WSL2 Arch Linux / Node 25.0.0 | 577 | 0 | 15 | 1 |
| Arch Linux (wsz05-1, bwrap 0.13.1) / Node 24.17.0 | 577 | 0 | 15 | 1 |

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
At `db7e4cc` the Windows Node24 and Linux Node25 gates both passed, each auditing
249 files and completing isolated installation and selected-feature checks;
the earlier failure under the old implicit-selection assumption remains historical.

## Remaining release gates and limits

- The sandboxed full chain has one live sample, on one Linux host and Claude Code
  2.1.303, in a project without commits. Another Claude Code version may match
  exemptions differently; a mismatch fails closed, with Core calls returning
  EROFS rather than running outside the sandbox.
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
