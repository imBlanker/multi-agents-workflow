# Native MAWF workspaces

A workspace opts out of Trellis lifecycle execution with `.mawf/workspace.json`:

```json
{"version":1,"backend":"mawf","trellis":false}
```

A missing marker retains the existing Trellis adapter. Malformed or unsupported
markers fail closed before init/update/upgrade performs work. Native storage
paths are fixed; symlinks in those paths are rejected. The marker wins even while
old `.trellis` assets await archival. Native init/update/upgrade never invokes
Trellis or downloads it with npx. Doctor and grill-overlay repair honor the same
choice. This does not uninstall machine-wide software or remove another project.

| Asset | Native path |
| --- | --- |
| Active tasks (unchanged IDs and task.json schema) | docs/plans/<id>/ |
| Engineering specifications | docs/engineering/specs/ |
| Completed-task artifacts | docs/history/tasks/ |
| Runtime session records | .mawf/runtime/sessions/<session-id>.json |
| Architecture artifacts | docs/architecture/ |

Bridge protocol v1 and existing task/session fields remain compatible. Native
project.list adds backend=mawf and hasWorkspace=true, with hasTrellis=false.
Legacy responses remain unchanged. Native runtime records add status and endedAt
in snapshots/events. Card clients must use hasWorkspace/backend when offering
native workspace navigation; the Trellis component registry and legacy adapter
remain available. Historical tasks are artifacts, not active tasks.

## Session hooks

Host lifecycle hooks call the installed CLI with the host's real stable ID:

```sh
mawf session start --project /path/to/project --id HOST_SESSION_ID --platform codex
mawf session heartbeat --project /path/to/project --id HOST_SESSION_ID --task TASK_ID
mawf session stop --project /path/to/project --id HOST_SESSION_ID
```

For JSON hooks, use `mawf session hook --stdin --platform HOST` and send
hook_event_name (SessionStart=start, SessionEnd=stop; UserPromptSubmit, PostToolUse,
and Stop=heartbeat). A Claude Stop event ends a turn, not the session. Unknown
events are errors. Alternatively use an explicit action with `--stdin`. Send session_id (or sessionId), cwd, platform,
and optionally current_task. Explicit flags take precedence. No stdin read occurs
without --stdin. Successful commands are silent unless --json is requested.
Records are atomically replaced. stop preserves the record with status=stopped
and ended_at; a later heartbeat cannot resurrect it, but start can explicitly
resume. Hosts lacking an end hook must invoke stop from their launcher exit
callback. Abruptly killed hosts cannot guarantee an end event; last_seen_at is
the freshness evidence, not proof that a process remains alive. Existing
historical records without status display unknown.

## Migration and verification

Copy and verify assets before removing their old paths; preserve task IDs and
metadata, rewrite relocated JSONL file references, and retain immutable backups
outside the active workspace and npm package. Use mawf-brainstorm for native
planning; the old grill wrapper is only for legacy Trellis workspaces.

Run npm test and node scripts/test-packed-install.mjs in isolated environments,
then exercise native and legacy bridge clients and session start/heartbeat/stop.
Release requires Linux and Windows with Node 22/24 as documented in CONTRIBUTING.
No npm publish is performed by this migration. Archival backups, host transcripts,
and workspace runtime state must never enter the npm tarball.

Session state transitions use a per-session cross-process directory lock with a
bounded wait. A writer killed while holding a lock leaves an explicit busy-lock
error; inspect that writer before removing its stale lock. Locks are never
stolen from an unknown process. Native task/context leaf symlinks are rejected,
including links introduced after provider creation. Native project.specs also
returns a `files` array (root-relative Markdown artifact entries) for clients
that need to enumerate and fetch complete specification documents.

The companion source revision is pinned in defaults/components.lock.json. Native
workspaces require the matching Card adapter; old desktop builds that discover
only .trellis/tasks must be upgraded from the pinned source before use.
