# MAWF 1.0.0 installation and migration

Package identity is `multi-agents-workflow`, CLI `mawf`, repository
https://github.com/imBlanker/multi-agents-workflow. Do not install the unrelated
singular npm name. Before registry publication, use source or a verified tarball.
After publication, install `multi-agents-workflow@1.0.0` explicitly. Core Node >=20.17; optional Pi Autoresearch >=22.

## Explicit selection

Start with `node bin/mawf.js init --project PROJECT --json`. A new project has
all optional integrations disabled and a native workspace marker. Run
`integrations list`; select only the requested host/capabilities using
`integrations enable ID`. Presence of global plugins, credentials, Trellis,
cc-switch databases or host executables never enables them. `install` then copies
only selected surfaces; it does not log in, install upstream plugins or run models.

`mawf install --project PROJECT` uses the existing host locations and `.mawf`
installation manifest. User-specified paths take precedence, then the existing
manifest's paths, then the host defaults. `update` preserves the multi-host union;
disabling a project's selection does not remove another installation's assets.
`uninstall` removes exact recorded ownership and retains project data/native
markers/unrecorded files. Do not equate a matching filename prefix with ownership.

For an isolated package/lifecycle check, pass **both** an isolated manifest root
and the selected host root; no HOME or account environment override is needed:

```sh
node /PACKAGE/bin/mawf.js integrations enable host.claude-code --project /TMP/PROJECT
node /PACKAGE/bin/mawf.js install --project /TMP/PROJECT --install-state-dir /TMP/INSTALL_STATE --claude-dir /TMP/CLAUDE
node /PACKAGE/bin/mawf.js update --project /TMP/PROJECT --install-state-dir /TMP/INSTALL_STATE --claude-dir /TMP/CLAUDE --mawf-only
node /PACKAGE/bin/mawf.js uninstall --project /TMP/PROJECT --install-state-dir /TMP/INSTALL_STATE
```

Equivalent programmatic options are installStateDir, claudeDir, codexDir, piDir,
dshHome. `MAWF_INSTALL_STATE_DIR` is also supported for the installer-owned state.
Without an explicit override, the normal user installation is intentionally used.

## Full package versus command copies

Canonical namespaced commands come from the full package plugin:
`claude --plugin-dir /PACKAGE/plugin` exposes `/mawf:mode`, `/mawf:integrations`,
`/mawf:run`, with ten role definitions. The adjacent bin/src/docs must remain
present. Standalone command copies use the host's own filename/namespace rules;
materialization embeds the owning package's absolute Core path. Never assume a
plugin-only marketplace cache contains its sibling runtime.

Use `run --guide` for informational output. Actual default CLI execution launches
a managed Claude process and applies account/provider/model/cost gates. An
unregistered existing host session cannot assert a parent model by CLI labels;
see V1_EXECUTION.md for HOST_MODEL_UNVERIFIED and the explicitly optional bounded
unknown-subscription policy. No such risk option is enabled automatically.

## v0.8.x project migration

`mawf migrate --dry-run --project PROJECT` previews import without writes.
Explicit `migrate` or ordinary first plan/import captures `.mawf/config.yaml`,
workflow/plan/graph, all agent files, prior settings and workspace marker under
`.mawf/migrations/legacy-v1-<timestamp>-<id>/files`, with a hash manifest.
Symbolic links are preserved as links, not followed for importing external content.
Runtime snapshots, output/evidence and external account configuration are untouched.

YAML role/model/concurrency overrides, agent JSON model/tools/task and Markdown
Task sections migrate into settings. Existing authoritative settings win.
Only explicit recognized legacy `integrations.<id>.enabled` declarations can
migrate selection; generated host guesses and installed directories cannot.
Old approved flags are historical unbound records, never new payment permission.
Repeated migration is a no-op and plan preserves settings plus edited/unowned views.

`mawf migrate rollback --project PROJECT` reports and restores the actual backup,
validates file hashes before restoration, and deselects the generated pointer.
Changed post-migration settings produce ROLLBACK_CONFLICT; only an explicit
`--force` requests replacement with the backup. Preserve/merge new user settings
first. After rollback, automatic migration stays off until a new explicit migrate.
Do not restore old runtime pointers or reactivate the retired task framework.

## Local release checks

Run `npm test` and `node scripts/test-packed-install.mjs`. Preserve failures and
classify obsolete assumptions separately from real defects and environment limits.
Do not remove tests, relax prepublishOnly or claim readiness from file presence.
A local package is a reviewable artifact; publication still needs explicit user
authorization and the project's provenance/release gates.
