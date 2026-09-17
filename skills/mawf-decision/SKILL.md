---
name: mawf-decision
description: "Author and maintain long-lived decision notes in the MAWF knowledge store (write-notes semantics). Use only for non-trivial changes that deserve a durable decision record; never for mechanical edits or task-local design."
---

# MAWF Decision Notes

Authoring skill for the Decision store under `docs/knowledge/decisions/`. Semantics are adapted from write-notes; retrieval, validation, and status reporting run through the `mawf knowledge` CLI. Adapted from write-notes-like-deepseek (license pending — see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root).

## 1. Trigger gate (red line) — read before writing anything

Create a decision note ONLY for non-trivial changes:

- behavior or architecture
- cross-file contracts
- process + tooling
- testing strategy
- on-disk, wire, or config formats

Mechanical edits and routine work are FORBIDDEN from producing notes: formatting/styling, non-behavior dependency bumps, release tags, routine CRUD. Models have an urge to over-document; resist it.

Task-local design stays in the Trellis task's `design.md`. Promote to a long-lived decision only when it has:

- cross-task effect, or
- a non-obvious tradeoff, or
- a long-lived boundary, or
- high-recurrence risk.

When in doubt, save the draft as `proposed` while the decision is forming — do not wait until the session context is lost. A note must defend at least one direction: forward (new cross-module contracts), backward (compromises made for invisible constraints), or subtraction (narrowing/deletions).

## 2. Retrieval before writing

Run BEFORE creating any new note:

```bash
mawf knowledge search <keywords>   # ranked candidates with match reasons
mawf knowledge context <topic>     # bounded pointer block for your prompt
mawf knowledge status              # store layout + document counts
```

- High overlap → update the existing note in place (fact sync) or supersede it (decision reversal).
- Partial overlap → keep both notes and link them with relative `.md` links.
- Archived notes are excluded from search by default; check them explicitly when a constraint may still bind. Search yourself before asking the user.

## 3. Writing rules

- **Alternatives**: record only options you truly considered, strongest first — state the strongest argument for the alternative, then why it lost. Never invent alternatives to satisfy the template.
- **Lifecycle** (the folder IS the status):
  - `proposed` — idea stage, not landed.
  - `implemented` — landed; update the note in place with the code, in the same commit/PR.
  - `rejected` — deliberately declined; `Status: rejected — <reason>`; kept only while it prevents recurrence, else physically delete.
  - `archived` — former `implemented` with low future reference value; frozen, sealed, immutable. Archiving must not bury a constraint that still applies.
- **Fact sync**: paths, defaults, and symbol names may be updated in place. The decision text itself is never rewritten in place to mean the opposite.
- **Supersede**: reversal ⇒ write a NEW note that inherits the old reasoning and link both directions (supersedes / superseded-by). Partial supersede keeps both notes with mutual links. `proposed` is never archived — it converts to `rejected`.

Exact header contract, required sections, aliases, and link rules: [references/note-format.md](references/note-format.md).

## 4. Where files go

`docs/knowledge/decisions/{proposed,implemented,rejected}/<class>/yyyy-mm-dd-topic.md`

Exactly six closed classes: `feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`. A centralized `INDEX.md` at the store root is forbidden. The filename date is the first-proposal date and never changes on transition.

## 5. Interaction protocol (from upstream)

1. Split facts from decisions.
2. Ask all open questions in ONE numbered round, one `➡️ <recommendation>` per line.
3. Get confirmation before writing any file.
4. More than 5 open decisions ⇒ split into multiple notes.

## 6. Before finishing

```bash
mawf knowledge verify
```

The verifier checks format, status/folder consistency, IDs, links, and archive seals — it cannot check that your reasoning is real. Formal validity is not argument validity; that judgment stays with you and the reviewer.
