# NOTICE — MAWF Integrated Skills

Attribution, license status, and namespace rules for MAWF-managed skills adapted from upstream projects (four-tool integration, P3). Locked commits are audited in the Trellis task `research/baseline-*.md` files.

## Upstream sources and locked commits

| Upstream | Locked commit | Used by |
| --- | --- | --- |
| imBlanker/write-notes-like-deepseek | `2aef219` (2026-09-14) | `mawf-decision/` (note semantics, header contract, lifecycle) |
| EveryInc/compound-engineering-plugin | `082c83e` (2026-09-15) | `mawf-compound/` (capture gate, dedup, grounding) |
| imBlanker/archify (engine) | `c3e15cc` (2.17.0-dev.1, 2026-09-16) | `mawf-archify/` (wraps the locked engine as an MAWF component; no engine code vendored here) |
| imBlanker/trellis-card | `4e24d42` (v0.2.5) | NOT vendored under skills/ — Card integration lives in src/workspace + components (P4/P6) |

## License status

- **write-notes-like-deepseek** — README declares MIT (badge link), but **no LICENSE file is committed** upstream. Derived skill content is usable locally/privately; PUBLIC REDISTRIBUTION of adapted files is blocked until the author adds a LICENSE or grants authorization. Adapted files carry: `Adapted from write-notes-like-deepseek (license pending — see NOTICE)`.
- **compound-engineering-plugin** — MIT, complete ("Copyright (c) 2025 Every"). Adapted files carry: `Adapted from EveryInc compound-engineering-plugin (MIT), © Every`. Attribution preserved per license.
- **archify** — MIT, complete; distributions must retain Cocoon AI's exact MIT copyright notice (v2.0 forked Cocoon-AI/architecture-diagram-generator). Third-party notices (incl. one CC-BY-NC-SA-4.0 icon set) must accompany redistribution; NC-branded icons are NOT enabled in MAWF-produced artifacts by default.
- **trellis-card** — NO license file in the entire history. Card is therefore NOT vendored in skills/; no Card-derived content appears here.

## Namespace rule

MAWF-managed skills live exclusively in the `mawf-*` namespace (`mawf-decision`, `mawf-compound`, `mawf-knowledge`, `mawf-archify`). This namespace is distinct **by design**:

- MAWF install/update must NEVER overwrite user-installed original skills named `archify`, `ce-compound`, or `write-notes` (or any other non-`mawf-*` skill), regardless of rank or manifest state.
- Upstream originals stay owned by their installers; MAWF adapts semantics, not files.
- Uninstall removes only `mawf-*` entries recorded in the MAWF manifest.
