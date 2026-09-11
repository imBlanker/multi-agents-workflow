import { setHome } from "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectTrellis, mawManagedFiles, snapshotFiles, detectConflicts, applyConflictChoice, trellisPlatformFlags } from "../src/trellis.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(path.join(project, ".mawf", "agents"), { recursive: true });
fs.mkdirSync(path.join(project, ".mawf", "runtime"), { recursive: true });
fs.writeFileSync(path.join(project, ".mawf", "plan.md"), "v1\n");
fs.writeFileSync(path.join(project, ".mawf", "agents", "orchestrator.md"), "v1\n");
fs.writeFileSync(path.join(project, ".mawf", "runtime", "state.json"), "{}"); // runtime excluded

test("detectTrellis returns a usable invocation", () => {
  const det = detectTrellis();
  assert.ok(["env", "path", "npx"].includes(det.via));
  if (det.via === "npx") assert.ok(det.args.includes("@mindfoldhq/trellis@latest"));
});

test("mawManagedFiles lists .mawf files but excludes runtime/logs", () => {
  const files = mawManagedFiles(project);
  assert.ok(files.some((f) => f.endsWith("plan.md")));
  assert.ok(files.some((f) => f.endsWith("orchestrator.md")));
  assert.ok(!files.some((f) => f.includes("runtime")));
});

test("snapshotFiles hashes MAW files", () => {
  const snap = snapshotFiles(project);
  assert.ok(snap[path.join(project, ".mawf", "plan.md")]);
  assert.equal(typeof snap[path.join(project, ".mawf", "plan.md")], "string");
});

test("detectConflicts: no change -> empty", () => {
  const before = snapshotFiles(project);
  const after = snapshotFiles(project);
  assert.equal(detectConflicts(before, after).length, 0);
});

test("detectConflicts: modified file detected", () => {
  const before = snapshotFiles(project);
  fs.writeFileSync(path.join(project, ".mawf", "plan.md"), "v2-changed-by-trellis\n");
  const after = snapshotFiles(project);
  const c = detectConflicts(before, after);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "modified");
  assert.ok(c[0].file.endsWith("plan.md"));
});

test("detectConflicts: removed file detected", () => {
  const f = path.join(project, ".mawf", "agents", "orchestrator.md");
  const before = snapshotFiles(project);
  fs.unlinkSync(f);
  const after = snapshotFiles(project);
  const c = detectConflicts(before, after);
  assert.ok(c.some((x) => x.kind === "removed" && x.file.endsWith("orchestrator.md")));
});

test("applyConflictChoice returns the chosen disposition", () => {
  assert.match(applyConflictChoice("maw").applied, /regenerate/i);
  assert.match(applyConflictChoice("trellis").applied, /kept/i);
  assert.match(applyConflictChoice("rerun").applied, /re-running/i);
});

test("trellisPlatformFlags: pi host -> --pi (empty home, no ~/.claude)", () => {
  const restoreHome = setHome(tmp); // tmp has no .claude
  try {
    assert.deepEqual(trellisPlatformFlags("pi"), ["--pi"]);
  } finally { restoreHome?.(); }
});

test("trellisPlatformFlags: pi host with ~/.claude present -> --pi --claude", () => {
  let restoreHome;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-pi-"));
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  try {
    restoreHome = setHome(d);
    assert.deepEqual(trellisPlatformFlags("pi"), ["--pi", "--claude"]);
  } finally { restoreHome?.(); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test("trellisPlatformFlags: dsh host -> --dsh (+ --claude when ~/.claude present)", () => {
  let restoreHome;
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-dsh-"));
  try {
    restoreHome = setHome(bare); // no .claude
    assert.deepEqual(trellisPlatformFlags("dsh"), ["--dsh"]);
    fs.mkdirSync(path.join(bare, ".claude"), { recursive: true });
    assert.deepEqual(trellisPlatformFlags("dsh"), ["--dsh", "--claude"]);
  } finally { restoreHome?.(); try { fs.rmSync(bare, { recursive: true, force: true }); } catch {} }
});

test("trellisPlatformFlags: claude/codex/unknown keep --claude --codex", () => {
  assert.deepEqual(trellisPlatformFlags("claude-code"), ["--claude", "--codex"]);
  assert.deepEqual(trellisPlatformFlags("codex"), ["--claude", "--codex"]);
  assert.deepEqual(trellisPlatformFlags(""), ["--claude", "--codex"]);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
