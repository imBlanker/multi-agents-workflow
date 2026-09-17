// @ts-check
// Tests for src/components/registry.js — offline installs in fake HOMEs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadLock, componentStatus, installComponent, rollbackComponent, componentsRoot } from "../src/components/registry.js";

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-components-"));
}

test("loadLock pins the four integration components with exact commits", () => {
  const lock = loadLock();
  const names = lock.components.map((c) => c.name);
  for (const n of ["archify", "notes-board", "trellis-card", "compound-references"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const archify = lock.components.find((c) => c.name === "archify");
  assert.equal(archify.upstream.commit, "c3e15cc60c9a027a6f35a272cab5ea9a7fc5c486");
  assert.ok(archify.upstream.npmWarning.includes("UNRELATED"));
});

test("status reports honest states: not-installed, release/license gates (A21, §11.7)", () => {
  const lock = loadLock();
  const home = fakeHome();
  const card = componentStatus(lock.components.find((c) => c.name === "trellis-card"), { home });
  assert.equal(card.state, "not-installed");
  assert.equal(card.licenseBlocked, true); // no upstream LICENSE
  assert.equal(card.releaseBlocked, true); // no release yet
  assert.equal(card.distributionState, "development/source");

  const compound = componentStatus(lock.components.find((c) => c.name === "compound-references"), { home });
  assert.equal(compound.licenseBlocked, false); // MIT ok
  assert.equal(compound.bundled, true);
});

test("install verifies digest, records state, marks development/source honestly (A21)", () => {
  const lock = loadLock();
  const home = fakeHome();
  const archify = lock.components.find((c) => c.name === "archify");
  const archive = path.join(home, "archify.zip");
  fs.writeFileSync(archive, "PK\x03\x04 fake zip payload");

  // dry-run does not touch disk
  const dry = installComponent(archify, archive, { home, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(componentStatus(archify, { home }).state, "not-installed");

  // digest mismatch refused
  const bad = installComponent(archify, archive, { home, expectedSha256: "deadbeef".repeat(8) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /digest mismatch/);

  const r = installComponent(archify, archive, { home });
  assert.equal(r.ok, true);
  assert.equal(r.state.distributionState, "development/source"); // no release yet — never "release-certified"
  const st = componentStatus(archify, { home });
  assert.equal(st.state, "installed-unverified");
  assert.equal(st.installed.verifiedSha256.length, 64);
});

test("install refuses missing archive; rollback restores previous pointer (A21)", () => {
  const lock = loadLock();
  const home = fakeHome();
  const compound = lock.components.find((c) => c.name === "compound-references");
  assert.equal(installComponent(compound, path.join(home, "nope.zip"), { home }).ok, false);

  const a1 = path.join(home, "v1.zip");
  const a2 = path.join(home, "v2.zip");
  fs.writeFileSync(a1, "payload v1");
  fs.writeFileSync(a2, "payload v2 different content");
  const lockV1 = JSON.parse(JSON.stringify(compound));
  lockV1.upstream.version = "1.0.0";
  const lockV2 = JSON.parse(JSON.stringify(compound));
  lockV2.upstream.version = "1.1.0";
  installComponent(lockV1, a1, { home });
  installComponent(lockV2, a2, { home });
  const cur = componentStatus(lockV2, { home });
  assert.equal(cur.installed.version, "1.1.0");

  const rb = rollbackComponent("compound-references", { home });
  assert.equal(rb.ok, true);
  assert.equal(componentStatus(lockV2, { home }).installed.version, "1.0.0");

  // rolling back with no previous fails cleanly
  assert.equal(rollbackComponent("compound-references", { home }).ok, false);
});
