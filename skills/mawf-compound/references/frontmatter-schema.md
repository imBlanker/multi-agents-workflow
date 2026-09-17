# Solution Frontmatter Schema

Adapted from EveryInc compound-engineering-plugin (MIT), © Every — see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root. Enums mirrored in `src/knowledge/schema.js`; enforced by `mawf knowledge verify`.

## Fields

| Field | Required | Type / enum |
| --- | --- | --- |
| `module` | yes | free string |
| `date` | yes | `YYYY-MM-DD` (canonical creation date) |
| `problem_type` | yes | closed enum, 17 values (below) |
| `component` | yes | open vocabulary — prefer corpus spelling |
| `severity` | yes | `critical \| high \| medium \| low` |
| `symptoms` | no | array, 1–5 items (required in spirit for bug-track verified docs) |
| `root_cause` | no | open vocabulary — prefer corpus spelling |
| `resolution_type` | no | closed enum, 10 values (below) |
| `tags` | no | array ≤8, lowercase hyphen-separated |
| `last_updated` | no | `YYYY-MM-DD`; update-only — set ONLY on in-place updates (High overlap) |

`applies_when` (≤5), `related_components`, `framework_version` are tolerated as optional extras; anything MAWF-specific (stable ID, provenance, `last_verified`, relations) belongs in the `<name>.mawf.json` sidecar, not the shared frontmatter.

## `problem_type` (closed, 17)

- Bug track (9): `build_error, test_failure, runtime_error, performance_issue, database_issue, security_issue, ui_bug, integration_issue, logic_error`
- Knowledge track (8): `best_practice, documentation_gap, workflow_issue, developer_experience, architecture_pattern, design_pattern, tooling_decision, convention`

Prefer the narrowest applicable value; `best_practice` is the fallback.

## `resolution_type` (closed, 10)

`code_fix, migration, config_change, test_fix, dependency_update, environment_setup, workflow_improvement, documentation_update, tooling_addition, seed_data_update`

## Status line (body, not frontmatter)

`Status: candidate` | `Status: verified` | `Status: superseded` — exactly one, strict shape. Candidates lack complete evidence and must never be presented as verified.

## Corpus-first vocabulary rule

Before classifying, sample existing docs' frontmatter and directory names. Match `component` by area and `root_cause` by the cause itself; reuse corpus values AS SPELLED — never coin a near-synonym. Use suggested defaults only when no existing doc covers the area/cause; pick an existing category directory when one fits, else a new descriptive one. `problem_type`, `severity`, `resolution_type` stay closed enums regardless of corpus.

## YAML safety rules (silent-corruption prevention)

- Quote any array item or scalar starting with: `` ` `` `[` `*` `&` `!` `|` `>` `%` `@` `?`
- Quote anything containing `": "`.
- Frontmatter scalars must avoid unquoted `#` and `:` — both corrupt silently; quote instead.
- Prefer single-quoted YAML strings for free text; escape embedded single quotes by doubling.
