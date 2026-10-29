# Native Windows execution

Windows local-process and native Claude controllers use creation-time identities
and Job Objects. Each child is created suspended, assigned to a non-breakaway
kill-on-close job, and only then resumed. The supervisor waits for every descendant,
not just the first process. Cancellation terminates the named job after checking
the supervisor's exact creation identity. A deadline or loss of the controller
also terminates the job; an empty job is required before releasing the lease.

## Native Claude boundary

Claude's built-in Bash sandbox does not support native Windows. MAWF therefore
supplies two explicit MCP tools, without WSL:

- `mcp__mawf_windows__core` accepts an argv array for the same named management
  operations as the Linux exemption list. Project, state root and run are fixed
  to the registered controller. Shell interpretation is never used here.
- `mcp__mawf_windows__shell` runs PowerShell inside a fresh AppContainer with no
  network capabilities. Workspace and per-run temporary files are writable;
  the ledger, package, Node interpreter, `.claude` and existing `.git` directories
  are read-only. Paths with spaces and Unicode are passed as arguments.

Native Bash/PowerShell/Monitor and built-in file/web tools are absent from the
Windows host's tool pool; subagents use the same broker. PowerShell mounts the
authorized workspace as `mawf:`. Use relative paths with file cmdlets, or
`(Get-Location).ProviderPath` with .NET file APIs. OS-provided AppContainer storage
is also available. Access to arbitrary installed developer tools is not implied.

The helper uses inbox 64-bit .NET Framework's C# compiler and Windows PowerShell.
Failure to compile, establish identity, create an AppContainer, apply ACLs, or
assign a job fails the operation; it never retries without isolation. Shell
environments contain only required Windows directory variables and explicit
workspace paths, not inherited model credentials.

AppContainer package checks do not enforce a DENY ACE as a restrictive-token
check would. Protected subtrees instead cut inherited grants and retain read
access only. ACL transactions are serialized per Windows user, with original
descriptors journalled outside the writable workspace surface before mutation.
Normal shutdown restores them; controller/deadline cleanup recovers journals
after forced helper termination. Existing user/managed host hooks and extensions
remain trusted host code outside this boundary, as on Linux. Role/file ownership
is still policy_only; all workers share the run workspace.

## Verification and limits

Real Windows tests exercise argument fidelity, fast exits, detached grandchildren,
deadlines, local task completion/release, protected and outside writes, denied TCP,
PowerShell file operations, and exact ACL restoration after killing the helper.
The controller/MCP integration test uses a fake Claude CLI and real Windows jobs;
it makes no model call and is not a Windows live acceptance claim. See
V1_RELEASE_STATUS.md for final CI and any live evidence.

External Pi/Codex background companions and Pi Autoresearch still lack their own
Windows Job Object transport and refuse before launching. Their pricing and
billing policy is unchanged. OAuth is not evidence of quota or payment.
