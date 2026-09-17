# Decision Note Format (exact header contract)

Adapted from write-notes-like-deepseek (license pending — see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root). Machine-checked by `mawf knowledge verify` via `src/knowledge/schema.js`.

## Header lines

- **L1**: `# Agent Note: <title>` — title must be non-empty.
- **L2**: blank (enforced).
- **L3**: `Status: proposed` | `Status: implemented` | `Status: rejected — <reason>` — MUST match the lifecycle folder. `rejected` requires the reason.
- **L4**: blank (enforced).
- Archived files: L3 `Status: implemented`, then L4 `Archived: YYYY-MM-DD` **immediately below** (no blank line), then L5 blank.
- The Status line appears exactly once in prose (code fences and HTML comments are masked before scanning). Solution docs use `# Solution:` headers — this contract is decisions only.

## Path grammar

`{lifecycle}/{class}/yyyy-mm-dd-topic.md`

- lifecycle: closed set `proposed | implemented | rejected` (+ `archived`).
- class: closed set of 6 — `feature, bug-fix, simplification, architecture, process, testing`. `refactor` is deliberately absent (behavior unchanged → simplification; changed → matching class). Adding a 7th class requires a schema bump, not a new folder.
- filename date = first-proposal date; never changed on transition.
- No `INDEX.md` at the store root (hard error). `AGENTS.md`/`CLAUDE.md` directly under a lifecycle folder are allowed and skipped.

## Required body sections (aliases accepted)

| Lifecycle | Required sections |
| --- | --- |
| proposed | `## Problem` · `## Proposal` · `## Acceptance criteria` · `## Risks` · `## Alternatives considered` |
| implemented | `## Problem` · `## Decision` · `## Consequences` · `## Alternatives considered` |
| rejected | `## Problem` · `## Proposal` (frozen proposal form) · `## Alternatives considered` |
| archived | same as implemented |

- Chinese aliases accepted: Problem/问题; Proposal/提议/方案/提案; Acceptance criteria/验收标准/验收条件/接受标准; Decision/决定/决策; Consequences/后果/影响/结果; Alternatives considered/替代方案/备选方案.
- `## Alternatives considered` is required in EVERY lifecycle. Real options only, strongest argument first.
- Implemented notes must NOT contain `## Proposal`, `## Plan`, `## Migration plan`, or `## Acceptance criteria` (or zh aliases) — the proposal folded into `## Decision` at the proposed→implemented transition.
- Free sections (schema/wire contracts etc.) go between Decision and Alternatives; optional `## Testing`/`## Verification` stay present-tense.
- `## Consequences` states benefit AND cost, with a revisit trigger.

## Links, seals, sidecars

- Relative `.md` links between notes must resolve inside the store root (boundary-aware; no sibling-prefix matches).
- Archived docs get a `Archived: YYYY-MM-DD` line and a SHA-256 entry in `archived/manifest.json` (append-only). Archived content is sealed and immutable; supersede info goes into the SUCCESSOR note, never into the archived file.
- Optional sidecar `<name>.mawf.json` next to the note carries MAWF-only metadata without touching the upstream format: stable ID, source task/commit, verification method/result, `last_verified`, relations. `last_verified` never auto-updates from mtime, reads, or UI refresh.
