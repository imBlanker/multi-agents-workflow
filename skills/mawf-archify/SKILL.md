---
name: mawf-archify
description: "Render, validate, and deliver architecture diagrams through the MAWF-locked Archify engine. Use for authored-IR diagram work with evidence-bound validation; only small IR summaries enter agent context."
---

# MAWF Archify

Thin skill over the Archify engine locked as an MAWF component (engine commit + digest pinned in the component manifest; MIT — retains the Cocoon AI copyright notice, see `NOTICE-MAWF-INTEGRATIONS.md` at the skills root).

## Availability gate

The engine is a managed component, NOT the npm `archify` package (that name is an unrelated 2022 package). Check before use:

```bash
mawf components status archify   # once the components CLI ships
mawf archify doctor
```

If the component is missing, stop at the gate and tell the user: **requires `mawf components install archify --from-file <archive>`**. Do not improvise with an untracked engine copy, and do not substitute the DSH-specific bundle (different version, higher Node floor, different snapshot). During development, a locked engine checkout can be used via `MAWF_ARCHIFY_SRC=<checkout> mawf archify <cmd> ...` — record engine version and digest with the artifact.

## Invocation — exact locked-engine CLI (raw pass-through)

`mawf archify` forwards argv **verbatim** to the locked engine — it is not a redesigned CLI. Flags, values and order are preserved; use the engine's real grammar (excerpt from the locked commit's own usage; consult `--help` of the resolved engine for full detail):

```bash
mawf archify render    <type> <input.json> [output.html] [--quality standard|showcase] [--repo-root <path>]
mawf archify validate  <type> <input.json> [--json] [--layout-json] [--quality standard|showcase] [--repo-root <path>]
mawf archify deliver   <type> <input.json> [output.html] [--json] [--open] [--quality ...] [--repo-root <path>]
mawf archify preview   <type> <input.json> [output.html] [--no-open] [--quality ...]
mawf archify compare architecture <base.json> <head.json> [out.html] [--receipt <path>] [--json]
mawf archify check <output.html>          # artifact integrity check
mawf archify visual-check <output.html> [--json]   # requires Chrome; exit 2 = skipped
mawf archify migrate workflow <old.json> <new.json> --to-schema 2 [--json]
mawf archify inspect <type> <input.json>  # architecture/workflow layout dump
mawf archify doctor
```

`<type>` ∈ `architecture | workflow | sequence | dataflow | lifecycle` — the engine **requires** the diagram type as the first argument of render/validate/deliver/preview. JSON receipts (`--json`) are the machine-readable contract; agent-facing summaries must derive from receipts, not from memory.

Forwarded commands (allowlist): `render, validate, deliver, preview, compare, check, inspect, migrate, guide, examples, doctor, demo, visual-check`. `brands` is deliberately NOT forwarded (brand marks include NC-licensed icons).

## Five diagram types

`architecture` (components/boundaries/connections) · `workflow` (lanes/nodes/edges) · `sequence` (participants/messages) · `dataflow` (stages/nodes/flows) · `lifecycle` (lanes/states/transitions). Every IR needs `schema_version`, `diagram_type`, and `meta.title` plus the type-specific arrays. Minimal authoring loop and IR sketch: [references/authoring-cheatsheet.md](references/authoring-cheatsheet.md).

## Evidence binding — architecture only

Only the `architecture` type supports repo evidence validation (`--repo-root` at a pinned revision). The other four types have NO equivalent evidence guarantee — never claim verification for them. Evidence checks must run where the Git checkout/objects live; reading a copied working tree does not validate a pinned revision, and dirty-working-tree checks must never be presented as revision checks. Source links must distinguish pinned revision from current working-tree content — show path/line honestly rather than faking a clickable link.

## Three verification tiers — report separately, never conflate

1. **validate/deliver receipt** — deterministic structure/geometry/evidence checks. A receipt is not a visual check.
2. **browser visual check** — real browser at a named viewport. A visual check is not human review.
3. **human / image review** — readability, visual quality, information organization.

Missing Chrome/Chromium, image review, or a specific environment is reported honestly; a server without a browser still allows render/deliver plus client-side viewing — stating WHERE each check ran. On generation failure the last-good artifact stays visible WITH the failure reason; never present last-good as verified against current inputs.

## Context budget

Only small IR summaries, component IDs, source references, and knowledge pointers enter agent context. Never paste full HTML, embedded assets, or a diagram's DOM into a prompt.
