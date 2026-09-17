# Grounding & Claim Validation (condensed adjudication semantics)

Adapted from EveryInc compound-engineering-plugin (MIT), © Every — see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root.

## The two passes

1. **Mechanical pass** — script checks on the written doc: cited path existence in the tree, SHA resolvability, relative-link resolution, drafting-scaffold leftovers (`mawf knowledge verify` covers the store-wide contract; per-doc claim checks are your job when the tooling lacks them).
2. **Semantic pass** — one read-only review of the doc's claims by an agent or careful self-review, checking three claim kinds:
   - **Code-behavior** claims — verify against the local working tree (`file:line` is where the reasoning lives).
   - **Merge-state** claims — verify against remote truth (PR view / git reachability); cite PR numbers, not bare SHAs; unmerged fixes are phrased as pending.
   - **Internal completeness** — sections coherent, no promised-but-missing evidence.

Offline or unavailable remote: qualify the claim "as of this writing" and mark the report `degraded`.

## Adjudication — never automatic

**Neither pass is a hard stop. You judge every flag.** Exactly three resolutions:

- **fix** — the doc is wrong; correct it and re-verify.
- **annotate** — the claim is uncertain by nature; soften or attribute it in place ("per this session's conclusion…").
- **confirm intentional** — the flag is a false positive; leave as is.

There is no automatic rewrite and no automatic pass. A flag you silence without a reason is a future misleading document.

## Standing evidence rules

- Cite `file:line` against the CURRENT tree; a claim you cannot re-verify against the tree gets softened or attributed — never stated as fact.
- Git-revision verification must not be presented as dirty-working-tree verification (and vice versa); record which one happened.
- `last_verified` changes only on real re-verification — never on file mtime, reads, or UI refresh.
- Missing evidence keeps the doc at `Status: candidate`; promotion to `verified` requires the evidence chain to be checkable.
