import "./fixtures/test-env.mjs";
// @ts-check
// Watchdog Stage 2: incident state machine + scanOnce orchestration.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { transition, applyEvent, openIncident, loadIncident, listIncidents, reconcilePhaseTimeout, appendAlert, alertsFile, watchdogDir, saveIncident } from "../src/watchdog/incidents.js";
import { scanOnce, readWatchdogConfig } from "../src/watchdog/scan.js";
import { writeRegistry } from "../src/watchdog/registry.js";

const now = 1787300000;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-inc-"));
  fs.mkdirSync(path.join(dir, ".mawf"), { recursive: true });
  return dir;
}

const ev = (type, extra = {}) => ({ type, nowSec: now, ...extra });

test("transition: valid/invalid matrix", () => {
  const mk = () => ({ id: "x", state: "open", phases: [], hostsTried: [], projectDir: "/tmp", signalsSeen: [], budgetUsd: 0, budgetCapUsd: 10 });
  assert.equal(transition(mk(), ev("dispatch-a")), "rescuing-a");
  assert.equal(transition({ ...mk(), state: "rescuing-a" }, ev("phase-a-timeout")), "open");
  assert.equal(transition(mk(), ev("dispatch-b")), "rescuing-b");
  assert.equal(transition({ ...mk(), state: "rescuing-a" }, ev("resolved")), "resolved");
  assert.equal(transition({ ...mk(), state: "rescuing-b" }, ev("resolved")), "resolved");
  assert.equal(transition({ ...mk(), state: "rescuing-b" }, ev("original-recovered")), "original-recovered");
  assert.equal(transition({ ...mk(), state: "open" }, ev("budget-stop")), "budget-stop");
  assert.equal(transition({ ...mk(), state: "open" }, ev("hosts-exhausted")), "human-alert");
  assert.equal(transition({ ...mk(), state: "open" }, ev("diagnose-only")), "diagnose-only");
  // invalid
  assert.equal(transition(mk(), ev("resolved")), null); // must be rescuing
  assert.equal(transition({ ...mk(), state: "resolved" }, ev("dispatch-a")), null); // terminal
  assert.equal(transition({ ...mk(), state: "human-alert" }, ev("original-recovered")), null);
});

test("openIncident persists; applyEvent writes alerts on terminal states", () => {
  const dir = tmpProject();
  const inc = openIncident({ projectDir: dir, host: "claude-code", sessionId: "sess-1", file: "/tmp/x.jsonl", finding: { signal: "a", reason: "3 errors", evidence: "run=3", at: now }, budgetCapUsd: 10, nowSec: now });
  assert.ok(fs.existsSync(path.join(watchdogDir(dir), "incidents", `${inc.id}.json`)));
  applyEvent(inc, ev("budget-stop", { reason: "cap hit" }));
  assert.equal(loadIncident(dir, inc.id).state, "budget-stop");
  const alerts = fs.readFileSync(alertsFile(dir), "utf8");
  assert.match(alerts, /budget-stop/);
  assert.match(alerts, /cap hit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reconcilePhaseTimeout: aged Phase A rolls back to open; unaged does not", () => {
  const dir = tmpProject();
  const inc = openIncident({ projectDir: dir, host: "pi", sessionId: "s", file: "f", finding: null, budgetCapUsd: 10, nowSec: now });
  applyEvent(inc, ev("dispatch-a"));
  inc.phases.push({ phase: "a", host: "claude", startedAt: now - 14 * 60 }); // 14 min: not yet
  saveIncident(inc);
  assert.equal(reconcilePhaseTimeout(loadIncident(dir, inc.id), { nowSec: now, windowSec: 15 * 60 }), false);
  const reloaded = loadIncident(dir, inc.id);
  reloaded.phases[0].startedAt = now - 16 * 60; // aged out
  saveIncident(reloaded);
  assert.equal(reconcilePhaseTimeout(loadIncident(dir, inc.id), { nowSec: now, windowSec: 15 * 60 }), true);
  assert.equal(loadIncident(dir, inc.id).state, "open");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readWatchdogConfig: defaults + YAML subset parse", () => {
  const dir = tmpProject();
  assert.equal(readWatchdogConfig(dir).hostOrder.join(","), "claude,pi,dsh,codex");
  assert.equal(readWatchdogConfig(dir).incidentBudgetUsd, 10);
  fs.writeFileSync(path.join(dir, ".mawf", "config.yaml"), [
    "# mawf config",
    "watchdog:",
    "  intervalMin: 5",
    "  incidentBudgetUsd: 25",
    "",
  ].join("\n"));
  const cfg = readWatchdogConfig(dir);
  assert.equal(cfg.intervalMin, 5);
  assert.equal(cfg.incidentBudgetUsd, 25);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanOnce: blocked session opens an incident; recovery closes it (fixture tree)", async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-home-"));
  // claude transcript with 3 consecutive errors
  const claudeSlug = process.platform === "win32" ? dir.replace(/[^a-zA-Z0-9]/g, "-") : "-" + dir.replace(/\//g, "-").replace(/^-+/, "");
  const claudeSess = path.join(home, ".claude", "projects", claudeSlug);
  fs.mkdirSync(claudeSess, { recursive: true });
  const blocked = [
    JSON.stringify({ type: "user", message: "go", sessionId: "b1", timestamp: new Date((now - 600) * 1000).toISOString() }),
    JSON.stringify({ type: "tool_result", is_error: true, content: "boom 1", sessionId: "b1", timestamp: new Date((now - 300) * 1000).toISOString() }),
    JSON.stringify({ type: "tool_result", is_error: true, content: "boom 2", sessionId: "b1", timestamp: new Date((now - 240) * 1000).toISOString() }),
    JSON.stringify({ type: "tool_result", is_error: true, content: "boom 3", sessionId: "b1", timestamp: new Date((now - 180) * 1000).toISOString() }),
  ].join("\n");
  fs.writeFileSync(path.join(claudeSess, "b1.jsonl"), blocked);

  const r1 = await scanOnce({ projectDir: dir, nowSec: now, home, isProcessAlive: () => true, dbPath: "/nonexistent.db" });
  assert.equal(r1.blockedTotal, 1);
  assert.equal(r1.projects[0].incidentsOpened, 1);
  const incId = r1.projects[0].activeIncidents[0].id;
  assert.equal(r1.projects[0].activeIncidents[0].state, "open");
  // state.json tracks growth
  assert.ok(fs.existsSync(path.join(watchdogDir(dir), "state.json")));

  // second scan: still blocked → no duplicate incident
  const r2 = await scanOnce({ projectDir: dir, nowSec: now + 60, home, isProcessAlive: () => true, dbPath: "/nonexistent.db" });
  assert.equal(r2.projects[0].incidentsOpened, 0);
  assert.equal(r2.projects[0].activeIncidents.length, 1);

  // recovery: healthy tail → original-recovered
  fs.writeFileSync(path.join(claudeSess, "b1.jsonl"), blocked + "\n" + JSON.stringify({ type: "tool_result", is_error: false, content: "recovered", sessionId: "b1", timestamp: new Date((now + 120) * 1000).toISOString() }) + "\n" + JSON.stringify({ type: "tool_result", is_error: false, content: "still fine", sessionId: "b1", timestamp: new Date((now + 130) * 1000).toISOString() }));
  const r3 = await scanOnce({ projectDir: dir, nowSec: now + 200, home, isProcessAlive: () => true, dbPath: "/nonexistent.db" });
  assert.equal(r3.blockedTotal, 0);
  assert.equal(loadIncident(dir, incId).state, "original-recovered");

  // registry-driven watch list also works (extra config path)
  const regFile = path.join(home, "projects.json");
  writeRegistry({ projects: [{ path: dir, addedAt: "" }] }, regFile);
  const r4 = await scanOnce({ registryFile: regFile, nowSec: now + 300, home, isProcessAlive: () => false, dbPath: "/nonexistent.db" });
  assert.equal(r4.projects.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("scanOnce: clean project → zero blocked, exit-safe", async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-home2-"));
  const r = await scanOnce({ projectDir: dir, nowSec: now, home, isProcessAlive: () => true, dbPath: "/nonexistent.db" });
  assert.equal(r.blockedTotal, 0);
  assert.equal(r.projects[0].sessionsScanned, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
