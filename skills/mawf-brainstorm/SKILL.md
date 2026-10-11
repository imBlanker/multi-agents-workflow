---
name: mawf-brainstorm
description: Clarify requirements and maintain native MAWF plans, engineering contracts, glossary and ADRs without a task-framework runtime.
---

# MAWF brainstorm

Use in native MAWF workspaces (`.mawf/workspace.json` has `version: 1`,
`backend: mawf`, `trellis: false`). Read the workspace AGENTS.md and applicable
`docs/engineering/specs/` contracts before design or implementation.

Reuse the existing task under `docs/plans/<id>/` when continuing work. Preserve
its task ID, PRD, design, research, and context references. Create a new plan only
when needed and authorized; no framework command is required. Completed task
history lives under `docs/history/tasks/`.

Use the vendored grilling / grill-with-docs interview method to clarify unresolved
requirements. Inspect repository facts yourself. Record terminology in CONTEXT.md,
architectural decisions in docs/adr/, and requirements/acceptance criteria in the
plan's prd.md. Use design.md and implement.md when they improve reviewability.
Follow the user's existing authorization; do not add repetitive consent gates.

Implementation reads the plan and applicable engineering contracts. Verification
uses the repository's normal tests and packaging gates. Record results and any
limitations in the plan, then report changed files and evidence. Preserve source
attribution and the vendored skill licenses in skills/vendor/.
