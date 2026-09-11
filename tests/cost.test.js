import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { guard, acquire, release, report } from "../src/cost.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-cost-"));
const dbPath = path.join(tmp, "cc-switch.db");
const stateDir = path.join(tmp, "runtime");

test.before(() => makeFixtureDb(dbPath, { withLogs: true }));

const cfg = { perAgentLimitUsdPerMin: 1.0, totalLimitUsdPerMin: 10.0, maxConcurrency: 4, windowSeconds: 120, dbPath };

test("guard allows spawn when under both limits", () => {
  const g = guard(stateDir, cfg);
  assert.equal(g.allowed, true);
  assert.ok(g.remainingConcurrency > 0);
});

test("acquire then release tracks concurrency", () => {
  const r1 = acquire(stateDir, cfg, { agentId: "a1", role: "implementer" });
  assert.equal(r1.allowed, true);
  const r2 = acquire(stateDir, cfg, { agentId: "a2", role: "researcher" });
  assert.equal(r2.allowed, true);
  const rel = release(stateDir, { agentId: "a1" });
  assert.equal(rel.released, true);
});

test("guard DENIES at max concurrency", () => {
  // fresh state dir
  const sd = path.join(tmp, "runtime2");
  for (let i = 0; i < 4; i++) acquire(sd, { ...cfg, perAgentLimitUsdPerMin: 1000, totalLimitUsdPerMin: 1000 }, { agentId: `b${i}`, role: "r" });
  const g = guard(sd, { ...cfg, perAgentLimitUsdPerMin: 1000, totalLimitUsdPerMin: 1000 });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "max concurrency reached");
});

test("acquire DENIES when an existing session exceeds the per-agent limit", () => {
  // fixture: sess-A spent $1.50 in 120s => $0.75/min; per-agent limit 0.5 => DENY
  const r = acquire(stateDir, { ...cfg, perAgentLimitUsdPerMin: 0.5 }, { agentId: "deny1", role: "implementer" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /per-agent|session/i);
});

test("report shows used percentage vs total", () => {
  const r = report(cfg);
  assert.equal(r.impl === "node:sqlite" || r.impl === "sqlite3-cli", true);
  assert.ok(r.total.usedPct >= 0);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
