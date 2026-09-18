# Archify Authoring Cheatsheet

Engine: Archify (locked component, MIT — retains the Cocoon AI copyright notice; see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root). Cheat pinned to engine 2.17.0-dev.1 (`c3e15cc`).

## The five types and their structural arrays

| type | required structural arrays |
| --- | --- |
| `architecture` | `components` · `boundaries` · `connections` |
| `workflow` | `lanes` · `nodes` · `edges` (+ optional `phases`/`groups`/`mainPath`; schema v1 or v2) |
| `sequence` | `participants` · `messages` (+ optional `segments`/`activations`) |
| `dataflow` | `stages` · `nodes` · `flows` |
| `lifecycle` | `lanes` · `states` · `transitions` |

Every IR requires `schema_version`, `diagram_type`, `meta` (with `title`). `additionalProperties: false` everywhere — extra keys fail validation.

## Minimal authoring loop

1. **Author IR** in the task-local area (task drafts) or `docs/architecture/` (long-lived; the IR is the versioned source).
2. **Validate**: `mawf archify validate <type> <input.json> [--quality standard|showcase] [--json] [--repo-root <path>]` — structure, geometry, and (architecture only) repo evidence at the pinned revision. There is no `--rev` flag: the revision comes from `meta.repository` inside the IR (full 40-char commit), verified by the engine against `--repo-root`.
3. **Render**: `mawf archify render <type> <input.json> [output.html] [--quality ...]` — HTML artifact + deterministic receipt. Rendering never requires a browser on the generating host.
4. **Visual check (optional, honest)** — real browser at a named viewport, client or CI side; report where it ran.
5. **Deliver**: `mawf archify deliver <type> <input.json> [output.html] [--json]` — delivery receipt (spec + artifact SHA-256); human review happens on the artifact, not the receipt.

## Receipt discipline

- Keep artifact ID, workspace/worktree, related task, IR/HTML/receipt paths, engine version/digest, source revision/digest, and last-good status in the artifact registry (rebuildable, never the only copy of semantics).
- Failed regeneration keeps the last-good artifact visible with the failure reason; last-good ≠ current-input-verified.
- Temp render caches belong under `.mawf/runtime/`; nothing durable should live only there.

## Context rules

- Only small IR summaries, component IDs, source references, and knowledge pointers enter agent context.
- Full HTML, embedded assets, and diagram DOM stay on disk; agents read them via tools, not by inlining.
