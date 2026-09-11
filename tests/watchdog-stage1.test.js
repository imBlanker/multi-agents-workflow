import "./fixtures/test-env.mjs";
// @ts-check
// Watchdog Stage 1: signal classifiers (pure) + registry merge.
// Fixture transcripts mirror real host formats (verified 2026-08-21, see
// src/watchdog/signals.js header).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseTail, classifyTail, detectStall, evaluateSignals, discoverSessionFiles, DEFAULT_THRESHOLDS } from "../src/watchdog/signals.js";
import { readRegistry, writeRegistry, registerProject, resolveWatchList, registryPath } from "../src/watchdog/registry.js";

const now = 1787300000; // fixed clock for determinism

// --- fixtures per host -------------------------------------------------------

const claudeBlocked = [
  JSON.stringify({ type: "user", message: "run the suite", sessionId: "s1", timestamp: new Date((now - 700) * 1000).toISOString() }),
  JSON.stringify({ type: "assistant", isSidechain: false, sessionId: "s1" }),
  JSON.stringify({ type: "tool_result", is_error: true, content: "ECONNREFUSED 127.0.0.1:8081", sessionId: "s1", timestamp: new Date((now - 300) * 1000).toISOString() }),
  JSON.stringify({ type: "tool_result", is_error: true, content: "ECONNREFUSED 127.0.0.1:8081", sessionId: "s1", timestamp: new Date((now - 240) * 1000).toISOString() }),
  JSON.stringify({ type: "tool_result", is_error: true, content: "ECONNREFUSED 127.0.0.1:8081", sessionId: "s1", timestamp: new Date((now - 180) * 1000).toISOString() }),
].join("\n");

const claudeHealthy = [
  JSON.stringify({ type: "user", message: "go", sessionId: "s2" }),
  JSON.stringify({ type: "tool_result", is_error: false, content: "ok", sessionId: "s2", timestamp: new Date((now - 60) * 1000).toISOString() }),
  JSON.stringify({ type: "assistant", content: "done", sessionId: "s2", timestamp: new Date((now - 30) * 1000).toISOString() }),
].join("\n");

const piBlocked = [
  JSON.stringify({ type: "message", timestamp: new Date((now - 500) * 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: "deploy" }] } }),
  JSON.stringify({ type: "message", timestamp: new Date((now - 200) * 1000).toISOString(), message: { role: "assistant", content: [{ type: "tool_result", is_error: true, error: { message: "provider 429" } }] } }),
  JSON.stringify({ type: "message", timestamp: new Date((now - 100) * 1000).toISOString(), message: { role: "assistant", content: [{ type: "tool_result", is_error: true, error: { message: "provider 429" } }] } }),
  JSON.stringify({ type: "message", timestamp: new Date((now - 90) * 1000).toISOString(), message: { role: "assistant", content: [{ type: "tool_result", is_error: true, error: { message: "provider 429" } }] } }),
].join("\n");

const codexBlocked = [
  JSON.stringify({ type: "event_msg", payload: { type: "message", content: [{ type: "input_text", text: "Fix-gate round 6" }] }, timestamp: new Date((now - 600) * 1000).toISOString() }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "error: build failed exit 2" }, timestamp: new Date((now - 400) * 1000).toISOString() }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "error: build failed exit 2" }, timestamp: new Date((now - 300) * 1000).toISOString() }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "error: build failed exit 2" }, timestamp: new Date((now - 200) * 1000).toISOString() }),
].join("\n");

const permPending = [
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "requires approval: rm -rf build" }] }, timestamp: new Date((now - 1200) * 1000).toISOString() }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "waiting" }] }, timestamp: new Date((now - 900) * 1000).toISOString() }),
].join("\n");

const garbage = "not json\n{\"type\":\n" + JSON.stringify({ type: "unrelated" });

// --- signals -----------------------------------------------------------------

test("parseTail: tolerant — malformed lines skipped, timestamps extracted", () => {
  const e = parseTail(claudeHealthy + "\n" + garbage);
  assert.ok(e.length >= 3);
  assert.ok(e.every((x) => x.obj && typeof x.obj === "object"));
  assert.ok(e.some((x) => x.ts > 0));
  assert.deepEqual(parseTail(""), []);
});

test("classifyTail: counts consecutive errors per host format (a-input)", () => {
  assert.equal(classifyTail(parseTail(claudeBlocked)).consecutiveErrors, 3);
  assert.equal(classifyTail(parseTail(piBlocked)).consecutiveErrors, 3);
  assert.equal(classifyTail(parseTail(codexBlocked)).consecutiveErrors >= 3, true);
  assert.equal(classifyTail(parseTail(claudeHealthy)).consecutiveErrors, 0);
});

test("classifyTail: permission-pending detected (b-input)", () => {
  const r = classifyTail(parseTail(permPending));
  assert.ok(r.permissionPendingSince > 0);
});

test("detectStall: fires only when process alive + growth older than threshold", () => {
  assert.equal(detectStall({ lastGrowthSec: now - 700, processAlive: true, nowSec: now }), true);
  assert.equal(detectStall({ lastGrowthSec: now - 700, processAlive: false, nowSec: now }), false);
  assert.equal(detectStall({ lastGrowthSec: now - 60, processAlive: true, nowSec: now }), false);
  assert.equal(detectStall({ lastGrowthSec: now - 700, processAlive: true, nowSec: now, thresholds: { stallMin: 20 } }), false);
});

test("evaluateSignals: priority d > c > a > b (first firing wins)", () => {
  const tail = parseTail(claudeBlocked);
  const tailB = parseTail(permPending);
  // everything fires → d wins
  const d = evaluateSignals({ errorCount: 5, lastGrowthSec: now - 700, processAlive: true, tailEntries: tail, nowSec: now, host: "claude-code" });
  assert.equal(d.signal, "d");
  // c + a fire → c wins
  const c = evaluateSignals({ errorCount: 0, lastGrowthSec: now - 700, processAlive: true, tailEntries: tail, nowSec: now });
  assert.equal(c.signal, "c");
  // only a fires
  const a = evaluateSignals({ errorCount: 0, lastGrowthSec: now - 60, processAlive: true, tailEntries: tail, nowSec: now, host: "claude-code" });
  assert.equal(a.signal, "a");
  assert.match(a.evidence, /claude-code/);
  // only b fires (permission pending > 15 min)
  const b = evaluateSignals({ errorCount: 0, lastGrowthSec: now - 60, processAlive: true, tailEntries: tailB, nowSec: now });
  assert.equal(b.signal, "b");
  // nothing fires
  assert.equal(evaluateSignals({ errorCount: 0, lastGrowthSec: now - 30, processAlive: true, tailEntries: parseTail(claudeHealthy), nowSec: now }), null);
  // threshold override: 2 errors with threshold 3 → no a
  const two = claudeBlocked.split("\n").slice(0, 4).join("\n");
  assert.equal(evaluateSignals({ tailEntries: parseTail(two), nowSec: now, thresholds: { consecutiveErrors: 3 } }), null);
});

test("evaluateSignals honors errorCountWindow (d threshold)", () => {
  const r = evaluateSignals({ errorCount: DEFAULT_THRESHOLDS.errorCountWindow, nowSec: now });
  assert.equal(r && r.signal, "d");
  assert.equal(evaluateSignals({ errorCount: DEFAULT_THRESHOLDS.errorCountWindow - 1, nowSec: now }), null);
});

// --- session discovery --------------------------------------------------------

test("discoverSessionFiles: claude + pi slugs from cwd; codex walk; dsh none", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-disc-"));
  const proj = path.join(tmp, "work", "myproj");
  fs.mkdirSync(proj, { recursive: true });
  const claudeSlug = process.platform === "win32" ? proj.replace(/[^a-zA-Z0-9]/g, "-") : "-" + proj.replace(/\//g, "-").replace(/^-+/, "");
  fs.mkdirSync(path.join(tmp, "claude", "projects", claudeSlug), { recursive: true });
  fs.writeFileSync(path.join(tmp, "claude", "projects", claudeSlug, "abc-123.jsonl"), "{}\n");
  const piSlug = "--" + proj.replace(/[:/\\]/g, "-").replace(/^-+/, "").replace(/-+$/, "") + "--";
  const piSess = path.join(tmp, "pi", "sessions", piSlug);
  fs.mkdirSync(piSess, { recursive: true });
  fs.writeFileSync(path.join(piSess, "2026-08-21T10-00-00_uuid-1.jsonl"), "{}\n");
  const codexDay = path.join(tmp, "codex", "sessions", "2026", "08", "21");
  fs.mkdirSync(codexDay, { recursive: true });
  fs.writeFileSync(path.join(codexDay, "rollout-2026-08-21T10-00-00-11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");

  const found = discoverSessionFiles({
    projectDir: proj,
    claudeDir: path.join(tmp, "claude", "projects"),
    piDir: path.join(tmp, "pi", "sessions"),
    codexDir: path.join(tmp, "codex", "sessions"),
  });
  const hosts = found.map((f) => f.host).sort();
  assert.deepEqual(hosts, ["claude-code", "codex", "pi"]);
  const claude = found.find((f) => f.host === "claude-code");
  assert.equal(claude.sessionId, "abc-123");
  const pi = found.find((f) => f.host === "pi");
  assert.equal(pi.sessionId, "uuid-1");
  const codex = found.find((f) => f.host === "codex");
  assert.equal(codex.sessionId, "11111111-2222-3333-4444-555555555555");
  // missing dirs → []
  assert.deepEqual(discoverSessionFiles({ projectDir: proj, claudeDir: path.join(tmp, "no"), piDir: path.join(tmp, "no"), codexDir: path.join(tmp, "no") }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- registry -----------------------------------------------------------------

const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), "maw-reg-"));
const regFile = path.join(tmpR, "projects.json");
const projA = path.join(tmpR, "projA");
const projB = path.join(tmpR, "projB");
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

test("registerProject: idempotent, excluded flag toggles, persists", () => {
  const r1 = registerProject(projA, { registryFile: regFile, now: () => "2026-08-21T00:00:00Z" });
  assert.equal(r1.added, true);
  const r2 = registerProject(projA, { registryFile: regFile });
  assert.equal(r2.added, false);
  assert.equal(readRegistry(regFile).projects.length, 1);
  registerProject(projA, { registryFile: regFile, excluded: true });
  assert.equal(readRegistry(regFile).projects[0].excluded, true);
  registerProject(projA, { registryFile: regFile }); // re-register clears
  assert.equal(readRegistry(regFile).projects[0].excluded, undefined);
  registerProject(projB, { registryFile: regFile });
  assert.equal(readRegistry(regFile).projects.length, 2);
});

test("resolveWatchList: registry ∪ extra − exclusions; nonexistent flagged", () => {
  const reg = readRegistry(regFile);
  const list = resolveWatchList(reg, { extra: [path.join(tmpR, "extraC")] }, { exists: (p) => p === projA || p === projB });
  const dirs = list.map((x) => x.dir);
  assert.deepEqual(dirs.sort(), [projA, projB, path.join(tmpR, "extraC")].sort());
  assert.equal(list.find((x) => x.dir === path.join(tmpR, "extraC")).exists, false);
  // exclusion via config wins over extra
  const list2 = resolveWatchList(reg, { extra: [path.join(tmpR, "extraC")], exclude: [path.join(tmpR, "extraC")] }, { exists: () => true });
  assert.equal(list2.some((x) => x.dir === path.join(tmpR, "extraC")), false);
  // exclusion via registry flag
  registerProject(projB, { registryFile: regFile, excluded: true });
  const list3 = resolveWatchList(readRegistry(regFile), {}, { exists: () => true });
  assert.equal(list3.some((x) => x.dir === projB), false);
  assert.equal(list3.some((x) => x.dir === projA), true);
});

test.after(() => { try { fs.rmSync(tmpR, { recursive: true, force: true }); } catch {} });
