import { fileURLToPath } from "node:url";
import "./fixtures/test-env.mjs";
// @ts-check
// Grill-brainstorm swap (task 08-21-grill-brainstorm-swap).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyGrillSwap, grillSwapStatus, grillAssetsRoot } from "../src/grillswap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function workspaceWithStockTrellis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-grill-"));
  const skills = path.join(dir, ".agents", "skills", "trellis-brainstorm");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "SKILL.md"), "---\nname: trellis-brainstorm\ndescription: stock upstream brainstorm\n---\n\n# Trellis Brainstorm\n\nasks one question at a time...\n");
  return dir;
}

test("assets exist in the repo: wrapper + 3 vendored skills + LICENSE", () => {
  const root = grillAssetsRoot(ROOT);
  assert.ok(fs.existsSync(path.join(root, "skills", "mawf-grill", "SKILL.md")));
  for (const n of ["grilling", "grill-with-docs", "domain-modeling"]) {
    assert.ok(fs.existsSync(path.join(root, "skills", "vendor", n, "SKILL.md")), n);
  }
  assert.ok(fs.existsSync(path.join(root, "skills", "vendor", "domain-modeling", "ADR-FORMAT.md")));
  assert.ok(fs.existsSync(path.join(root, "skills", "vendor", "domain-modeling", "CONTEXT-FORMAT.md")));
  assert.match(fs.readFileSync(path.join(root, "skills", "vendor", "LICENSE"), "utf8"), /MIT License.*Matt Pocock/s);
});

test("wrapper structure: grilling methodology + full trellis contract + harness-neutral invocation", () => {
  const s = fs.readFileSync(path.join(ROOT, "skills", "mawf-grill", "SKILL.md"), "utf8");
  // trellis contract clauses
  assert.match(s, /Task-creation consent is also not implementation approval/);
  assert.match(s, /task\.py create/);
  assert.match(s, /task\.py start/);
  assert.match(s, /final planning summary/);
  assert.match(s, /design\.md.*implement\.md|implement\.md.*design\.md/);
  // grilling methodology mapped
  assert.match(s, /grilling/);
  assert.match(s, /domain-modeling/);
  assert.match(s, /CONTEXT\.md/);
  assert.match(s, /ADR/);
  assert.match(s, /frontier/);
  // format amendments propagated
  assert.match(s, /Recommended: \(a\)/);
  assert.match(s, /list items, one per line/);
  // harness-neutral explicit invocation (no bare "/grilling")
  assert.match(s, /Call the Skill tool/);
  assert.doesNotMatch(s, /\/grilling\b/);
  // escape hatch documented
  assert.match(s, /trellis-brainstorm\.orig\.md/);
});

test("vendored grilling carries both mawf amendments", () => {
  const s = fs.readFileSync(path.join(ROOT, "skills", "vendor", "grilling", "SKILL.md"), "utf8");
  assert.match(s, /format violation/);
  assert.match(s, /one per line/);
});

test("applyGrillSwap: swaps, backs up, vendors — idempotent; clobber detected + repaired", () => {
  const dir = workspaceWithStockTrellis();
  const r1 = applyGrillSwap(dir, { pkgRoot: ROOT });
  assert.equal(r1.applied, true);
  const wrapper = fs.readFileSync(path.join(dir, ".agents", "skills", "trellis-brainstorm", "SKILL.md"), "utf8");
  assert.match(wrapper, /grill edition \(mawf\)/);
  assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "trellis-brainstorm.orig.md")), "stock backed up");
  for (const n of ["grilling", "grill-with-docs", "domain-modeling"]) {
    assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", n, "SKILL.md")), `vendored ${n}`);
  }
  assert.ok(fs.existsSync(path.join(dir, ".agents", "skills", "VENDOR-SKILLS-LICENSE.md")));
  const st1 = grillSwapStatus(dir, { pkgRoot: ROOT });
  assert.equal(st1.wrapperCurrent, true);
  assert.deepEqual(st1.missing, []);

  // idempotent
  const r2 = applyGrillSwap(dir, { pkgRoot: ROOT });
  assert.equal(r2.applied, false, "second run writes nothing");

  // simulate `trellis update` clobbering the wrapper back to stock
  fs.writeFileSync(path.join(dir, ".agents", "skills", "trellis-brainstorm", "SKILL.md"), "---\nname: trellis-brainstorm\ndescription: stock again\n---\n# stock\n");
  const st2 = grillSwapStatus(dir, { pkgRoot: ROOT });
  assert.equal(st2.wrapperInstalled, false, "clobber detected");
  const r3 = applyGrillSwap(dir, { pkgRoot: ROOT });
  assert.equal(r3.applied, true, "repair works");
  // backup NOT overwritten by repair (still the pristine stock file)
  assert.match(fs.readFileSync(path.join(dir, ".agents", "skills", "trellis-brainstorm.orig.md"), "utf8"), /stock upstream brainstorm/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyGrillSwap: no trellis → graceful no-op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-grill2-"));
  const r = applyGrillSwap(dir, { pkgRoot: ROOT });
  assert.equal(r.applied, false);
  assert.match(r.reason, /trellis init not run/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyGrillSwap: patches .claude/skills root too (claude-only trellis layouts)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-grill3-"));
  const skills = path.join(dir, ".claude", "skills", "trellis-brainstorm");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "SKILL.md"), "---\nname: trellis-brainstorm\ndescription: stock\n---\n# stock\n");
  const r = applyGrillSwap(dir, { pkgRoot: ROOT });
  assert.equal(r.applied, true);
  const st = grillSwapStatus(dir, { pkgRoot: ROOT });
  assert.deepEqual(st.roots, [path.join(".claude", "skills")]);
  assert.equal(st.wrapperCurrent, true);
  assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "grilling", "SKILL.md")));
  fs.rmSync(dir, { recursive: true, force: true });
});
