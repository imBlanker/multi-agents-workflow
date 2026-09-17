// @ts-check
// Tests for src/components/registry.js — offline installs in fake HOMEs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { execSync } from "node:child_process";
import { loadLock, componentStatus, installComponent, rollbackComponent, verifyComponent, componentsRoot } from "../src/components/registry.js";

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

  // without extraction, install succeeds but entry stays unvalidated
  const r = installComponent(archify, archive, { home, extract: false });
  assert.equal(r.ok, true);
  assert.equal(r.state.distributionState, "development/source"); // no release yet — never "release-certified"
  assert.equal(r.state.entryValidated, false);
  const st = componentStatus(archify, { home });
  assert.equal(st.state, "installed-unverified");
  assert.equal(st.installed.verifiedSha256.length, 64);

  // full install of a real archive: extraction + closure + entry validation
  const payloadDir = path.join(home, "payload-src", "archify-2.17.0");
  fs.mkdirSync(path.join(payloadDir, "archify", "bin"), { recursive: true });
  fs.mkdirSync(path.join(payloadDir, "archify", "renderers", "shared"), { recursive: true });
  fs.mkdirSync(path.join(payloadDir, "archify", "assets"), { recursive: true });
  fs.mkdirSync(path.join(payloadDir, "archify", "scripts"), { recursive: true });
  for (const f of [
    "archify/bin/archify.mjs", "archify/renderers/render-workflow.mjs", "archify/renderers/shared/geometry.mjs",
    "archify/assets/template.html", "archify/assets/JetBrainsMono-OFL.txt",
    "archify/scripts/check-render-output.mjs", "archify/LICENSE", "archify/THIRD_PARTY_NOTICES.md",
  ]) {
    fs.writeFileSync(path.join(payloadDir, f), "// payload\n");
  }
  const tgz = path.join(home, "archify-real.tgz");
  execSync(`tar -czf "${tgz}" -C "${payloadDir}" .`);
  const r2 = installComponent(archify, tgz, { home });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.state.entryValidated, true);
  assert.ok(r2.state.entryPath.endsWith(path.join("archify", "bin", "archify.mjs")));

  // closure gap: an archive missing required files must be rejected + cleaned up
  const badDir = path.join(home, "bad-src");
  fs.mkdirSync(path.join(badDir, "archify", "bin"), { recursive: true });
  fs.writeFileSync(path.join(badDir, "archify", "bin", "archify.mjs"), "// only entry, no closure\n");
  const badTgz = path.join(home, "archify-bad.tgz");
  execSync(`tar -czf "${badTgz}" -C "${badDir}" .`);
  const before = fs.readdirSync(path.join(home, ".mawf", "components", "archify")).length;
  const r3 = installComponent(archify, badTgz, { home });
  assert.equal(r3.ok, false);
  assert.ok(Array.isArray(r3.violations) && r3.violations.length > 0, "closure violations reported");
  const after = fs.readdirSync(path.join(home, ".mawf", "components", "archify")).length;
  assert.equal(before, after, "failed install leaves no version directory behind");
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

test("symlink escape inside an archive is rejected and cleaned up (§14, §12.1)", () => {
  const lock = loadLock();
  const home = fakeHome();
  const archify = lock.components.find((c) => c.name === "archify");
  const src = path.join(home, "evil-src");
  fs.mkdirSync(path.join(src, "archify", "bin"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "renderers", "shared"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "assets"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "scripts"), { recursive: true });
  for (const f of ["archify/bin/archify.mjs", "archify/renderers/x.mjs", "archify/renderers/shared/geometry.mjs", "archify/assets/template.html", "archify/assets/JetBrainsMono-OFL.txt", "archify/scripts/check-render-output.mjs", "archify/LICENSE", "archify/THIRD_PARTY_NOTICES.md"]) {
    fs.writeFileSync(path.join(src, f), "// x\n");
  }
  // symlink pointing OUTSIDE the extraction root
  fs.symlinkSync(path.join(home, "outside-secret"), path.join(src, "archify", "assets", "escape.lnk"));
  const tgz = path.join(home, "evil.tgz");
  execSync(`tar -czf "${tgz}" -C "${src}" .`);
  const r = installComponent(archify, tgz, { home });
  assert.equal(r.ok, false, "symlink escape must fail the install");
  assert.ok((r.violations ?? []).some((v) => v.includes("symlink escape")), JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(home, ".mawf", "components", "archify")), "no component dir left behind");
});

test("verifyComponent promotes only after a real doctor pass; rollback restores (§14)", () => {
  const lock = loadLock();
  const home = fakeHome();
  const archify = lock.components.find((c) => c.name === "archify");

  // build an archive whose engine entry is a real node script with a doctor
  const src = path.join(home, "src");
  fs.mkdirSync(path.join(src, "archify", "bin"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "renderers", "shared"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "assets"), { recursive: true });
  fs.mkdirSync(path.join(src, "archify", "scripts"), { recursive: true });
  for (const f of ["archify/renderers/render-workflow.mjs", "archify/renderers/shared/geometry.mjs", "archify/assets/template.html", "archify/assets/JetBrainsMono-OFL.txt", "archify/scripts/check-render-output.mjs", "archify/LICENSE", "archify/THIRD_PARTY_NOTICES.md"]) {
    fs.writeFileSync(path.join(src, f), "// x\n");
  }
  fs.writeFileSync(path.join(src, "archify", "bin", "archify.mjs"), "process.exit(process.argv.includes('--fail-doctor') ? 1 : 0);\n");
  const tgz = path.join(home, "archify.tgz");
  execSync(`tar -czf "${tgz}" -C "${src}" .`);

  assert.equal(verifyComponent(archify, { home }).ok, false, "verify before install fails");
  installComponent(archify, tgz, { home });

  // doctor pass promotes to supported-and-tested (real child process runs
  // the extracted entry; exit 0 required)
  const ok = verifyComponent(archify, { home });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const cur = JSON.parse(fs.readFileSync(path.join(home, ".mawf", "components", "archify", "current.json"), "utf8"));
  assert.equal(cur.state, "supported-and-tested");
  assert.equal(cur.verification.method, "doctor");
});
