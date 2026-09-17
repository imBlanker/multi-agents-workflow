---
name: mawf-compound
description: "Capture a solved-and-verified problem as a durable solution doc in the MAWF knowledge store. Use only after verified work produced non-obvious reasoning absent from final code, tests, and existing docs."
---

# MAWF Solution Capture

Adapted from EveryInc compound-engineering-plugin (MIT), © Every — see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root. Storage, retrieval, and validation run through the `mawf knowledge` CLI.

## 1. Hard gate

Document only a problem that is **solved and verified**. Then apply the durable bar, judged by this counterfactual: if the learning document disappeared, would a future engineer reading the final implementation still be likely to repeat the mistake or redo substantial investigation? A learning earns its place only when it is:

- **non-obvious** — not readily recoverable from the final code, tests, types, comments, or existing docs;
- **durable** — project reasoning that persists;
- **material** — losing it would plausibly cause recurrence, material risk, or substantial rediscovery.

All three must hold. Additional rules:

- **One learning per run.** A session that produced several gets several sequential runs, never one batched run.
- Completion phrases ("that worked", "it's fixed", "problem solved") identify the checkpoint but do NOT establish eligibility.
- Effort, diff size, and "it's done" never qualify a capture.
- If the counterfactual fails: write nothing and report why, judged from the session rather than by asking.

## 2. Dedup before creating

Search first: `mawf knowledge search <keywords>` (and `mawf knowledge context` for injection). Score overlap across five dimensions: problem statement, root cause, solution approach, referenced files, prevention rules.

| Overlap | Action |
| --- | --- |
| High (4–5 dimensions) | **Update the existing doc in place**: keep its path and structure; add `last_updated: YYYY-MM-DD` to the frontmatter; do not retitle unless the framing shifted |
| Moderate (2–3) | Create a new doc AND flag both docs for consolidation review |
| Low / none (0–1) | Create normally |

An existing learning that became materially inaccurate or incomplete qualifies for capture — update that learning instead of creating a duplicate that leaves the stale one misleading.

## 3. Document format

Path: `docs/knowledge/solutions/<category>/yyyy-mm-dd-<slug>.md` (the date prefix is MAWF convention; the category comes from the existing taxonomy when one fits).

Frontmatter is CE-compatible YAML — required: `module`, `date`, `problem_type`, `component`, `severity`; optional: `symptoms`, `root_cause`, `resolution_type`, `tags` (≤8), `last_updated` (update-only). Body: `# Solution: <title>` header plus one `Status:` line — `Status: candidate` until evidence is complete, `Status: verified` after, `Status: superseded` when replaced.

Evidence-chain sections (canonical English headings): Problem / Symptom / Root cause / Failed attempts / Fix / Why it works / Prevention / Scope / Evidence / Alternatives considered. Which sections are machine-required per status is enforced by `mawf knowledge verify` (candidates need at minimum Problem, Symptom, Fix, Alternatives). Field enums, corpus-first vocabulary, and YAML safety rules: [references/frontmatter-schema.md](references/frontmatter-schema.md).

## 4. Evidence rules

- Ground code-behavior claims in source, not conversation memory: read the defining line at the CURRENT tree and cite `file:line` alongside the claim.
- Merge-state claims cite PR numbers rather than bare commit SHAs; unmerged fixes are phrased as pending.
- A claim that cannot be verified against the tree is softened or attributed ("per this session's conclusion…") — never stated as fact. Never present unverified as verified.
- Candidates without complete evidence stay `Status: candidate`. A lightweight or low-budget run does not remove the evidence requirement; it only bounds how much investigation you may do.

## 5. Write boundary

Only the task's coordinator (or an explicitly named writer) writes the durable store; subagents write their own scratch only. Scratch never becomes durable content without passing through the coordinator. Concurrent updates go through the store's locking/atomic-write path — never blind last-write-wins.

## 6. Before finishing

```bash
mawf knowledge verify
```

Claim flags from validation are adjudicated by you — fix, annotate, or confirm intentional; never an automatic rewrite or an automatic pass. Adjudication semantics: [references/grounding-validation.md](references/grounding-validation.md).
