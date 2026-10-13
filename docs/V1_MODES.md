# v1 modes and generated configuration

`mawf mode dynamic`, `mawf mode fixed-1`, and `mawf mode status --json`
manage the default for new top-level runs. Existing and queued runs, including
later children, retain the run's immutable mode, revision, role policy and
scheduler snapshot. Status includes the real runtime run records and active
lease count. A mode change does not launch a model or reset the ledger.

`fixed-1` has a separate role/phase generator. It requires Claude Code as the
primary host, at least one independent Hacker (or the larger configured count),
a real user path, an implementer who does not write tests, delegation-only
orchestration, continuous refill, and a facts report after two same-cause
failures. Prompts are in `plugin/agents/fixed-1/`. These are policy-only promises
until a host adapter demonstrates enforcement. Pi/Codex fallbacks are proposed,
with null actual actor/adapter/model until execution supplies evidence. An
unavailable Claude host is reported honestly; users can select dynamic.

User configuration lives in `.mawf/settings.json`: global `roleOverrides`,
mode-specific `modeOverrides[modeId].roleOverrides`, custom agents and disabled
roles. `add-agent` and `remove-agent` persist these mode-scoped settings. Fixed
orchestrator/implementer/Hacker roles cannot be removed by disabling them.
Dynamic retains the existing architecture planner and templates.

Planning writes immutable directories under `.mawf/generated/generations/`.
The atomic `current.json` pointer selects the authoritative generation. Generated
workflow readers validate its workflow hash. Compatibility `.mawf` files and
selected Pi files are replaced or removed only when previous ownership hashes
match; user-modified/unowned files are retained and reported. The pointer is
committed after compatibility projection. A crash can leave partial views but
cannot select an incomplete new canonical generation. Settings and run snapshots
are not generated files. `plan --out DIR` writes only DIR, with no migration or
Pi/default output; other commands reject `--out`.

`mawf migrate --dry-run` previews legacy import; `mawf migrate` and ordinary
first planning import legacy YAML models/concurrency, agent JSON model/tools/task,
and Markdown Task sections. Existing settings overrides win. Legacy approved
flags are historical records, never current permission. The migration backs up
all legacy config, agent files, marker/settings, and symbolic links before
changing settings. Runtime/evidence remain outside migration scope.

`mawf migrate rollback` restores that backup and deselects the generated pointer;
changed settings require explicit `--force`. Migration is idempotent. After
rollback, automatic migration waits for another explicit migrate command. Backup
paths and hashes are recorded in `.mawf/migrations/`.
