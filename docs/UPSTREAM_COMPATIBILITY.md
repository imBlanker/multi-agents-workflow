# Upstream compatibility for mawf 0.8.0

This source update audits changes after the mawf 0.7.3 release on September 5, 2026 and repairs older integration gaps found by that audit. It keeps one shared core and the existing Linux/Windows adapters. Version 0.8.0 remains unreleased.

## Audited contracts

| Integration | Evidence target | mawf response |
| --- | --- | --- |
| Pi | 0.85.1 | Canonical agent directory, valid skill and Agent role metadata, static package/MCP discovery with provenance and trust states |
| pi-mcp-adapter | 2.33.0 | Six documented configuration layers, same-name overrides, disabled state and secret-safe metadata |
| kickstart Pi runner | pi-subagents-lite | `Agent` guidance, array tool lists, provider/model frontmatter, no nested child spawns; external Codex roles remain external |
| DeepSeek Harness | 0.1.5-rc.1 and rc.2 | Saved selection before composed fallback, versioned credential reference names, direct DeepSeek adapter evidence and current default alias |
| dsh-web | 0.3.20 | Component-local disabled state, conservative skill discovery and separate staged preset library |
| Claude Code | 2.1.268 and current hooks reference | Guard intercepts current `Agent` and legacy `Task`; unrelated tools are excluded |
| Codex | 0.154.0 | Existing exec/resume and external MCP-client integration retained; no dependency on removed `codex mcp-server` |
| cc-switch | 3.20.3 / schema 18 | Additive byte-cursor fixture verified; schemas 16/17 and future-version diagnostics retained; no user database migration |
| Trellis | 0.6.16 | Published before the cutoff; existing initialization contract retained |

The missing skill descriptions, canonical Pi directory variable, dsh versioned credential/saved-selection readers, Claude hook matcher and schema 18 declaration are older gaps uncovered here. They are not all new upstream breaking changes after September 5.

## Shared skill repair

The five shipped skills `mawf-cost-guard`, `mawf-graph`, `mawf-loop`, `mawf-orchestration`, and `mawf-planner` now declare YAML `name` and `description` fields. Installer and update fixtures verify the same source assets reach Pi unchanged on either OS. Existing installed copies receive the fix during an explicit template refresh; editing this checkout alone does not alter a user's home directory. The separate Trellis brainstorm wrapper keeps its intentional name.

## Configuration and discovery

Pi home precedence is an explicit caller directory, `PI_CODING_AGENT_DIR`, the legacy mawf `PI_AGENT_DIR` alias, then `~/.pi/agent`. A configured or discovered package is not proof that an extension is loaded. Project resources require Pi trust; testing a disposable project may explicitly approve that project, without setting global trust to always.

Package discovery reads metadata without executing extension code. It covers normal npm, Git and local sources, scoped packages, resource manifests and supported filters. Git URL credentials/query strings are removed from inventory. Static discovery is deliberately incomplete: full ignore-file semantics, advanced brace/class globs, custom MCP paths, foreign-host imports, and live trust decisions require further host evidence. The inventory reports this limitation instead of claiming live readiness.

DSH credential reports expose reference names only, retaining legacy compatibility. Saved model selection wins over composition; an unresolved explicitly selected provider remains unresolved instead of silently switching providers. `deepseek-flash` has only evidenced capability metadata, with unknown pricing unless an exact configured price source exists. DSH spend-rate measurement remains unavailable.

DSH skill rows expose precedence and shadowing for documented default filesystem roots. Custom composed roots and enabled-preset discovery are not inferred. Entries under the preset library are staged, not active agents. JS-tagged dump configuration is never evaluated; component `disabled` metadata is distinguished from nested configuration fields.

## Validation and rollout

Source tests cover skill copies, actual guard matcher dispatch, override precedence, generated roles, package/MCP metadata, credential sentinel redaction, model selection, schema 18 costs/read-only behavior, and Windows/Linux command quoting. Full Windows and Linux regressions are required before committing the source update. Existing Node 20 compatibility belongs to mawf; newer Pi/Claude hosts can require Node 22 or 24.

Real plugin loading, MCP connectivity, authentication, host tool use and current dsh composed dumps are validated after the requested host installations. These source-derived fixtures do not certify those live integrations. No host installation, global configuration change, API call or publication is part of this source-only stage.

## Primary references

- [Pi 0.85.1 documentation](https://github.com/earendil-works/pi/tree/v0.85.1/packages/coding-agent/docs) and [package manager](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/package-manager.ts)
- [Kickstart installation](https://github.com/orionpax1997/kickstart.pi/blob/main/docs/installation.md) and [MCP adapter](https://github.com/nicobailon/pi-mcp-adapter)
- [DSH 0.1.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) and [dsh-web 0.3.20](https://github.com/zhu1090093659/dsh-web/releases/tag/v0.3.20)
- [Claude hook reference](https://code.claude.com/docs/en/hooks) and [Claude changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Official Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [cc-switch schema 18 DDL](https://github.com/farion1231/cc-switch/blob/v3.20.3/src-tauri/src/database/schema.rs)
