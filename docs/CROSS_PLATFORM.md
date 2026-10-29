# Cross-platform development

Starting with **0.8.0**, mawf maintains Linux and native Windows in one source tree and one coordinated package/plugin version.


## v1.0.0 verified scope

Package and plugin metadata are synchronized at 1.0.0. Core remains portable
JavaScript, but portability is not execution evidence. Linux registered local
processes have independently exercised PID/start identity, process-group stop,
concurrency races, recovery, and a real 32-minute heartbeat. Native controlled
Claude execution and its inherited child bounds use this Linux process boundary.
The native runner explicitly rejects unsupported process-control platforms.

A Windows 11 host check of d6be4d0 (2026-10-28; Node 20, 22 and 24 from
PowerShell and Git Bash, compared test by test with Linux) found the retained
suite identical to Linux apart from fixtures tracked separately (console code
page, GNU tar under Git Bash). Windows exposes no PID start identity, so
local-process dispatch, companion adapters and Pi autoresearch are refused at
admission with `OWNER_IDENTITY_UNVERIFIED` before any child starts, and native
controlled Claude execution returns `NATIVE_PROCESS_CONTROL_UNSUPPORTED`. Windows
process-tree cancellation, companion/native model execution and live payment
telemetry therefore remain unsupported, not passed; report them that way rather
than from a CI matrix definition. Configuration/plan source compatibility and
prior platform tests are different scopes. Authentication, host installation and
real request success remain separate on every platform. Role prompts/worktrees
are not an OS sandbox.

The v1 core reaches Windows conventions only through the platform facade.
`realpath` and `comparablePath` give one on-disk, case-folded spelling of a path
(drive-letter and segment case, 8.3 names) for state roots and evidence checks.
`checkoutVariants` lets a pinned LF file match the CRLF checkout that Git for
Windows makes by default. `retryTransient` retries the brief EPERM/EACCES/EBUSY
that Windows reports while another process holds a state file. On POSIX these are
identity or single-attempt operations.

## Structure

| Location | Responsibility |
| --- | --- |
| `bin/mawf.js` | Shared CLI entry point |
| `src/` | Shared planning, configuration, policy, host integration, and upgrade logic |
| `src/platform/index.js` | Select the native adapter and expose platform operations |
| `src/platform/linux.js` | POSIX command lookup, execution, and process/port inspection |
| `src/platform/windows.js` | Windows executable lookup, command shims, archive tool choice, and native process/port inspection |
| `tests/` | Shared regressions and platform contract fixtures |

Shared consumers use the platform facade. Platform-specific fixes belong in their adapter; fixes to planning or policy apply to both environments. `win32` selects Windows; Linux uses the POSIX adapter. Other POSIX environments retain a fallback but are outside the Linux/Windows validation matrix.

## Prerequisites and source usage

Use an existing Node.js installation (minimum 20.17; CI uses 22 and 24). Database features use built-in `node:sqlite` where available; older Node runtimes need the external `sqlite3` executable. Git is needed for repository and upgrade operations. Windows inspection uses PowerShell/native tools; mawf-owned functionality does not require WSL or Git Bash. External hosts retain their own prerequisites and must be verified separately.

From the repository directory, these commands work in PowerShell and a Linux shell:

```text
node --version
node bin/mawf.js version
node scripts/run-tests.mjs
```

No dependency installation or mawf installation is needed to develop from source. Use native absolute filesystem paths, quote paths containing spaces, and use `fileURLToPath` when converting module URLs. Pass executable arguments as arrays; shell syntax belongs inside the platform adapter. Never interpolate project paths into executable PowerShell scripts.

### Windows command wrappers

Recognized npm Node command shims run their JavaScript entry point directly with the current Node executable, preserving argument values including embedded quotes and multiline prompts. Generic `.cmd`/`.bat` wrappers use the Windows command processor and reject arguments containing embedded double quotes or newlines with `EINVAL`; use a native executable or a recognized npm Node shim for such arguments. This restriction prevents shell reinterpretation and is material when using custom batch wrappers for hosts.

### Windows archive tool

Archive work (component installs, cc-switch backups and snapshot restores) runs the tar returned by the facade's `tarCommand()`. On Windows that is the system bsdtar, `%SystemRoot%\System32\tar.exe`, regardless of PATH order: Git Bash puts MSYS GNU tar first, which cannot read zip and treats the `C:` of an archive path as a remote host. Without the system tar, the first `tar` on PATH is used, except that extraction refuses GNU tar, which writes a symlink to an existing file as a copy of that file and would bypass the symlink-escape check. Linux keeps `tar` from PATH.

## Adding an environment

Add a platform module implementing the facade's existing operations, explicitly select it in the facade, and add native CI coverage. Keep public result shapes and failure behavior consistent. Cover command discovery, argument fidelity (including spaces, Unicode, and metacharacters), missing commands, nonzero exits, timeouts, process/port probes, and guard failure behavior. Do not duplicate the application core or introduce a separate OS version number.

## Validation and synchronized releases

CI runs Ubuntu and Windows with Node 22 and 24, directly from source without an install step. Tests that write host configuration must isolate `HOME`, `USERPROFILE`, and host directories in temporary fixtures. Stub external installs, upgrades, and agent launches. Guard verification must cover both bundled and installer-copied layouts.

Before a release:

1. Run all four native CI jobs and review any failures. Local adapter fixtures alone cannot certify another OS.
2. Verify required external-host workflows separately on each OS; report untested integrations explicitly.
3. Update `package.json` and `plugin/.claude-plugin/plugin.json` together, along with any active marketplace metadata.
4. Add matching English, Simplified Chinese, and Traditional Chinese release notes; retain historical versions.
5. Preserve configuration formats, upgrade protections, price gates, and cc-switch write restrictions.

The presence of the CI matrix is not evidence that its jobs have passed. Release validation must record actual native results and remaining gaps; publishing and tagging are separate actions.
