// @ts-check
// Tests for the rebuildable Archify artifact registry (contract §10.2) and
// the preview state sidecar reader (contract §10.4 minimal fallback).
// All file I/O happens in tmpdirs; no engine spawn, no network. Digests are
// REAL sha256 over real files.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  entryId,
  listArtifacts,
  readRegistryEntries,
  recordArtifact,
  registryPath,
  runArchifyRegistry,
} from "../src/archify-registry.js";
import { previewStatePath, readPreviewState, runArchify, runPreviewState } from "../src/archify.js";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** tmp project dir with an authored IR + rendered HTML. */
function makeProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-archreg-"));
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  const ir = path.join(project, "docs", "workflow.json");
  const html = path.join(project, ".mawf", "runtime", "archify", "workflow.html");
  fs.mkdirSync(path.dirname(html), { recursive: true });
  fs.writeFileSync(ir, '{"diagram":"workflow","nodes":[]}\n');
  fs.writeFileSync(html, "<!doctype html><title>wf</title>\n");
  return { project, ir, html };
}

test("record/list round-trip with real sha256 digests", () => {
  const { project, ir, html } = makeProject();
  const r = recordArtifact({ ir, html, project });
  assert.equal(r.ok, true);
  const entry = r.entry;
  assert.equal(entry.irPath, path.resolve(ir));
  assert.equal(entry.htmlPath, path.resolve(html));
  assert.equal(entry.irSha256, sha256(fs.readFileSync(ir)));
  assert.equal(entry.artifactSha256, sha256(fs.readFileSync(html)));
  assert.equal(entry.diagramType, "unknown", "no receipt → honest unknown, never invented");
  assert.ok(entry.engineCommit, "engine commit falls back to the locked component commit");
  assert.equal(entry.lastGood.sha256, entry.artifactSha256);
  assert.deepEqual(entry.lastAttempt, { at: entry.lastGood.at, ok: true });
  // id = resolved irPath + diagramType
  assert.equal(entry.id, entryId(ir, "unknown"));

  // persisted shape on disk
  const onDisk = JSON.parse(fs.readFileSync(registryPath(project), "utf8"));
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.entries.length, 1);

  // list reports NOT stale for untouched inputs
  const rows = listArtifacts(project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stale, false);
  assert.equal(rows[0].staleReason, null);
  assert.equal(rows[0].irCurrentSha256, rows[0].irSha256);
  assert.equal(rows[0].htmlPath, path.resolve(html));
});

test("staleness is detected after an IR edit — WITHOUT re-rendering the HTML", () => {
  const { project, ir, html } = makeProject();
  recordArtifact({ ir, html, project });
  const htmlBefore = fs.readFileSync(html, "utf8");
  const htmlStatBefore = fs.statSync(html).mtimeMs;
  fs.appendFileSync(ir, '{"node":"added"}\n'); // author edits the IR

  const rows = listArtifacts(project);
  assert.equal(rows[0].stale, true);
  assert.equal(rows[0].staleReason, "ir-changed");
  assert.notEqual(rows[0].irCurrentSha256, rows[0].irSha256);
  // the recorded HTML is untouched — list never re-renders
  assert.equal(fs.readFileSync(html, "utf8"), htmlBefore);
  assert.equal(fs.statSync(html).mtimeMs, htmlStatBefore);
  // lastGood still points at the recorded artifact (the LAST GOOD one)
  assert.match(rows[0].artifactSha256, /^[0-9a-f]{64}$/);

  // a MISSING ir is stale too, with its own reason
  const rows2 = listArtifacts(project);
  assert.equal(rows2[0].stale, true);
  fs.rmSync(ir);
  const rows3 = listArtifacts(project);
  assert.equal(rows3[0].stale, true);
  assert.equal(rows3[0].staleReason, "ir-missing");
  assert.equal(rows3[0].irCurrentSha256, null);
});

test("upsert: same ir+diagramType replaces the entry; different type coexists", () => {
  const { project, ir, html } = makeProject();
  recordArtifact({ ir, html, project });
  const html2 = path.join(project, "v2.html");
  fs.writeFileSync(html2, "<!doctype html><title>wf v2</title>\n");
  const r2 = recordArtifact({ ir, html: html2, project, now: "2026-09-17T00:00:00.000Z" });
  assert.equal(r2.ok, true);
  const rows = listArtifacts(project);
  assert.equal(rows.length, 1, "same id upserts — no duplicate rows");
  assert.equal(rows[0].artifactSha256, sha256(fs.readFileSync(html2)));
  assert.equal(rows[0].lastGood.at, "2026-09-17T00:00:00.000Z");
  assert.equal(rows[0].lastGood.sha256, sha256(fs.readFileSync(html2)));

  // a receipt with a different diagramType creates a distinct id
  const receipt = path.join(project, "seq-receipt.json");
  fs.writeFileSync(receipt, JSON.stringify({ diagramType: "sequence", engineCommit: "c3e15cc60c9a" }));
  recordArtifact({ ir, html, receipt, project });
  assert.equal(listArtifacts(project).length, 2);
  const seq = listArtifacts(project).find((e) => e.diagramType === "sequence");
  assert.equal(seq.engineCommit, "c3e15cc60c9a", "receipt commit wins over the lock fallback");
  assert.equal(seq.receiptPath, path.resolve(receipt));
});

test("atomic write: no tmp leftovers in the registry directory", () => {
  const { project, ir, html } = makeProject();
  for (let i = 0; i < 5; i++) recordArtifact({ ir, html, project });
  const dir = path.dirname(registryPath(project));
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "tmp+rename leaves nothing behind");
  // and the registry still parses
  assert.equal(readRegistryEntries(project).length, 1);
});

test("registry is a rebuildable cache: deletion loses nothing and re-record restores", () => {
  const { project, ir, html } = makeProject();
  recordArtifact({ ir, html, project });
  fs.rmSync(registryPath(project)); // the documented contract: safe to delete
  assert.deepEqual(listArtifacts(project), [], "absent registry reads as empty");
  assert.equal(recordArtifact({ ir, html, project }).ok, true, "re-record repopulates it");
  assert.equal(listArtifacts(project).length, 1);
});

test("CLI exit codes: record 0/1/2, list 0, unknown subcommand 2", () => {
  const { project, ir, html } = makeProject();
  const out = [];
  const err = [];

  assert.equal(runArchifyRegistry(["record", ir, html], { project }, { out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
  assert.match(out.join(""), /recorded /);
  assert.match(out.join(""), /rebuildable cache/);

  err.length = 0;
  assert.equal(
    runArchifyRegistry(["record", ir, path.join(project, "nope.html")], { project }, { err: (s) => err.push(s) }),
    1,
  );
  assert.match(err.join(""), /html file not found/);

  err.length = 0;
  assert.equal(runArchifyRegistry(["record", ir], {}, { err: (s) => err.push(s) }), 2);
  assert.match(err.join(""), /usage/);

  assert.equal(runArchifyRegistry(["bogus"], {}, { err: (s) => err.push(s) }), 2);

  const out2 = [];
  assert.equal(runArchifyRegistry(["list"], { json: true, project }, { out: (s) => out2.push(s) }), 0);
  const parsed = JSON.parse(out2.join(""));
  assert.equal(parsed.registryPath, registryPath(project));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].stale, false);

  // human list marks STALE after an ir edit
  fs.appendFileSync(ir, "x");
  const out3 = [];
  assert.equal(runArchifyRegistry(["list"], { project }, { out: (s) => out3.push(s) }), 0);
  assert.match(out3.join(""), /STALE/);
  assert.match(out3.join(""), /ir-changed/);
  assert.match(out3.join(""), /LAST GOOD/);
  // empty project list is informational exit 0
  assert.equal(
    runArchifyRegistry(["list"], { project: fs.mkdtempSync(path.join(os.tmpdir(), "mawf-empty-")) }, { out: () => {} }),
    0,
  );
});

test("preview-state sidecar: present, absent, malformed, and --json machine output", () => {
  const { project, ir } = makeProject();
  const out = [];

  // absent: informational status "none"
  assert.equal(runPreviewState([ir, "--json"], { out: (s) => out.push(s) }), 0);
  const absent = JSON.parse(out.join(""));
  assert.equal(absent.status, "none");
  assert.equal(absent.present, false);
  assert.equal(absent.sidecar, previewStatePath(ir));
  assert.equal(absent.ir, path.resolve(ir));

  // a preview session wrote the sidecar (contract §10.4 shape)
  const sidecar = { status: "verified", revision: 7, artifactSha256: "d".repeat(64), at: "2026-09-17T01:02:03.000Z" };
  fs.writeFileSync(previewStatePath(ir), JSON.stringify(sidecar));
  assert.deepEqual(readPreviewState(ir), sidecar);
  out.length = 0;
  assert.equal(runPreviewState([ir, "--json"], { out: (s) => out.push(s) }), 0);
  const present = JSON.parse(out.join(""));
  assert.equal(present.status, "verified");
  assert.equal(present.revision, 7);
  assert.equal(present.artifactSha256, "d".repeat(64));
  assert.equal(present.at, sidecar.at);
  assert.equal(present.present, true);

  // human summary line mentions status + revision
  out.length = 0;
  assert.equal(runPreviewState([ir], { out: (s) => out.push(s) }), 0);
  assert.match(out.join(""), /preview-state: verified revision=7/);

  // other documented statuses pass through untouched
  for (const status of ["checking", "needs-fix"]) {
    fs.writeFileSync(previewStatePath(ir), JSON.stringify({ ...sidecar, status }));
    out.length = 0;
    assert.equal(runPreviewState([ir, "--json"], { out: (s) => out.push(s) }), 0);
    assert.equal(JSON.parse(out.join("")).status, status);
  }

  // malformed sidecar: reported as absent with a stderr note, exit 0
  fs.writeFileSync(previewStatePath(ir), "{not json");
  out.length = 0;
  const warn = [];
  assert.equal(runPreviewState([ir, "--json"], { out: (s) => out.push(s), err: (s) => warn.push(s) }), 0);
  assert.equal(JSON.parse(out.join("")).status, "none");
  assert.match(warn.join(""), /malformed/);
});

test("preview-state is intercepted in `mawf archify` — never forwarded to the engine", () => {
  const { project, ir } = makeProject();
  const out = [];
  let spawned = 0;
  const spawnFn = () => {
    spawned += 1;
    return { status: 0 };
  };
  const code = runArchify(["preview-state", ir, "--json"], { env: {}, spawnFn, out: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.equal(spawned, 0, "the sidecar reader never spawns the engine");
  assert.equal(JSON.parse(out.join("")).status, "none");
  // usage error still exit 2 and still no engine spawn
  assert.equal(runArchify(["preview-state"], { env: {}, spawnFn }), 2);
  assert.equal(spawned, 0);
});
