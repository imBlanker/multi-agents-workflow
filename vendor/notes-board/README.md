# Notes Board — vendored asset (adapted upstream, license-pending)

`board.html` is a byte-exact copy of `assets/agent-notes-board.html` from
imBlanker/write-notes-like-deepseek @ `2aef219faf608285f987a85d3f5f1109d6699725`
(upstream author czm15053). The repository owner authorized its use pending an
upstream LICENSE (README declares MIT with a dangling link). Provenance and
this notice ship with the asset; when upstream lands a LICENSE, record its
text here.

## Adaptation plan (MAWF integration)

The Board consumes a 13-field note object
(`{ id, slug, lifecycle, cls, date, title, status, problem, decision,
alternatives, consequences, outLinks[], rawBody }`) via two injection anchors:
`window.__INLINE_DATA__ = <JSON array>;` (`<` escaped as `\u003c`) and
`id="brand-project-title">…</`. The MAWF WorkspaceRpcDataSource (P5) assembles
these objects from `mawf knowledge list/search` — remote workspaces get the
same UI through the bridge instead of the local directory picker.

## MAWF companion additions (not upstream)

`workspace-datasource.js` is MAWF-original (P5.1, task
09-17-mawf-four-tool-integration): the serve-time companion bootstrap in
`src/companion/serve.js` fetches it with the session token in a request
HEADER and evaluates it before the board renders, feeding the board's
13-field note contract from the token-authed `/rpc` endpoint. `board.html`
itself is never modified at rest — injection happens in memory at serve time.
