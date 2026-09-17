// @ts-check
// A15: observer hooks fail open, stay bounded, and respect ownership.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installObserver, uninstallObserver, emitEvent, spoolPath, SPOOL_MAX_LINES, OBSERVER_MARKER } from "../src/observer.js";

function fakeHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "maw-obs-")); }
function proj() { return fs.mkdtempSync(path.join(os.tmpdir(), "maw-obs-proj-")); }

test("install/uninstall touch ONLY mawf-tagged entries; foreign hooks and unknown fields survive", () => {
  const home = fakeHome();
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    unknownTopLevel: { keep: true },
    hooks: {
      SessionStart: [{ matcher: "x", hooks: [{ type: "command", command: "foreign-tool" }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "mawf guard" }] }],
    },
  }, null, 2));
  const r = installObserver({ projectDir: proj(), home });
  assert.equal(r.changed, true);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(after.unknownTopLevel, { keep: true });
  assert.equal(after.hooks.SessionStart.length, 2); // foreign + ours
  assert.equal(after.hooks.PreToolUse.length, 1); // cost/permission guard untouched
  assert.ok(JSON.stringify(after.hooks.SessionStart[1]).includes(OBSERVER_MARKER));
  // idempotent
  assert.equal(installObserver({ projectDir: proj(), home }).changed, false);
  // uninstall removes only ours
  const u = uninstallObserver({ home });
  assert.equal(u.changed, true);
  const restored = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(restored.hooks.SessionStart.length, 1);
  assert.equal(restored.hooks.PreToolUse.length, 1);
  assert.deepEqual(restored.unknownTopLevel, { keep: true });
  assert.equal(uninstallObserver({ home }).changed, false);
});

test("emitEvent: garbage stdin fails open; valid events append; A15 never blocks", () => {
  const p = proj();
  assert.equal(emitEvent("not json at all {{{", { projectDir: p }).ok, true);
  assert.equal(emitEvent(JSON.stringify({ session_id: "s1", tool: "Bash" }), { projectDir: p }).written, true);
  const raw = fs.readFileSync(spoolPath(p), "utf8").trim().split("\n");
  assert.equal(raw.length, 2);
  assert.ok(JSON.parse(raw[1]).event.session_id === "s1");
});

test("spool is bounded: drops oldest beyond line cap (A15 bounded failure)", () => {
  const p = proj();
  for (let i = 0; i < SPOOL_MAX_LINES + 50; i++) {
    emitEvent(JSON.stringify({ i }), { projectDir: p, now: () => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` });
  }
  const lines = fs.readFileSync(spoolPath(p), "utf8").trim().split("\n");
  assert.ok(lines.length <= SPOOL_MAX_LINES, `spool grew to ${lines.length}`);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event.i, SPOOL_MAX_LINES + 49, "newest retained, oldest dropped");
});
