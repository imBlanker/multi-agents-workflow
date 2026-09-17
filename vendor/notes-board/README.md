# Notes Board — vendored asset placeholder (license-gated)

The adapted Notes Board asset is NOT distributed in this public repository yet.

## Why

Upstream `czm15053/write-notes-like-deepseek` (local lock: `2aef219`) declares
MIT in its README (badge + board footer) but has **no LICENSE file committed**
in its entire history. Under the project's redistribution gate (task
`09-17-mawf-four-tool-integration`, decision ID-6) the copied board bytes were
removed from the public branch; "README badge says MIT" is not a redistribution
authorization.

## What stays

- The integration seam and data contract (see below) — no upstream bytes.
- Provenance metadata (this file + `skills/NOTICE-MAWF-INTEGRATIONS.md`).
- Knowledge/Board-facing code in `src/knowledge/` (MAWF-original).

## Integration contract (stable, upstream-independent)

The Board consumes a 13-field note object:
`{ id, slug, lifecycle, cls, date, title, status, problem, decision,
alternatives, consequences, outLinks[], rawBody }` via two injection anchors:

1. `window.__INLINE_DATA__ = <JSON array>;` (`<` escaped as `\u003c`)
2. `id="brand-project-title">…</` for the workspace-titled brand

The MAWF WorkspaceRpcDataSource assembles these objects from
`mawf knowledge list/search` output — the datasource does not depend on any
upstream implementation detail beyond this documented contract.

## Restoring the asset (after the license gate clears)

Any of: upstream commits a LICENSE; the author grants written permission;
or MAWF ships an independent compatible implementation. Then re-add
`board.html` (byte-exact from the locked commit + recorded modifications),
run `node scripts/test-packed-install.mjs`, and update this file.
