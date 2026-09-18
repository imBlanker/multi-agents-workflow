# Notes Board vendored asset — provenance

- Source: imBlanker/write-notes-like-deepseek @ 2aef219faf608285f987a85d3f5f1109d6699725
  (assets/agent-notes-board.html, byte-identical copy as board.html)
- Upstream author: czm15053 (czm15053/write-notes-like-deepseek)
- License: README declares MIT (badge + footer) but **no LICENSE file is
  committed upstream** — PUBLIC REDISTRIBUTION BLOCKED pending license text
  or author consent (task ID-6). Local/private use inside the user's own
  machines is unaffected.
- Adaptations planned (tracked in task 09-17-mawf-four-tool-integration P5):
  workspace datasource (bridge-backed, replacing directory-picker for remote),
  multi-workspace IndexedDB keying, host/workspace header badge.
  Injection anchors preserved: `window.__INLINE_DATA__ = null;` and
  `id="brand-project-title"`.
- build-board.ts.orig kept for reference only; MAWF ships the built asset,
  not the TS toolchain.
