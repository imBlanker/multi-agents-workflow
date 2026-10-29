import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { guard, acquire, release, report } from "../src/cost.js";
import { createRun, addTask, markLaunchFailed, runtimeStatus } from "../src/runtime.js";
import * as ccswitch from "../src/ccswitch.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

// v1: the old top-level guard/acquire/release are compatibility views over the
// fenced runtime ledger (docs/V1_RUNTIME.md "Old top-level acquire/release/
// guard use the same ledger"; commit a1e9ac0). Admission needs explicit run
// and task identity, release needs the exact lease id + fencing token, and the
// ledger "covers registered jobs only and does not impose global machine/API
// billing limits" — so the per-agent/total USD-per-minute caps are no longer
// admission inputs. They remain a `report()` observation.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-cost-"));
const dbPath = path.join(tmp, "cc-switch.db");

test.before(() => makeFixtureDb(dbPath, { withLogs: true }));

const cfg = { perAgentLimitUsdPerMin: 1.0, totalLimitUsdPerMin: 10.0, maxConcurrency: 4, windowSeconds: 120, dbPath };

/** A registered run with `count` queued non-model local-process tasks. */
async function registeredRun(t, count = 2, runOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-cost-run-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows handle */ } });
  const project = path.join(dir, "proj");
  fs.mkdirSync(project, { recursive: true });
  const stateRoot = path.join(dir, "runtime");
  const created = await createRun({ project, stateRoot, runId: "r1", ...runOpts });
  assert.equal(created.ok, true);
  const taskIds = [];
  for (let i = 0; i < count; i++) {
    const taskId = `t${i + 1}`;
    // local-process is the explicit non-model backend: no model price gate, so
    // this exercises concurrency admission alone.
    assert.equal(addTask({ project, stateRoot, runId: "r1", taskId, adapter: "local-process", command: [process.execPath, "-v"] }).ok, true);
    taskIds.push(taskId);
  }
  return { project, stateRoot, runId: "r1", taskIds, base: { ...cfg, project, runId: "r1" } };
}

test("guard allows spawn when capacity remains under the project and run caps", async (t) => {
  const fx = await registeredRun(t, 1);
  const g = guard(fx.stateRoot, { ...fx.base, taskId: "t1" });
  assert.equal(g.allowed, true);
  assert.ok(g.activeCount < g.projectCap, `activeCount ${g.activeCount} < projectCap ${g.projectCap}`);
  assert.ok(g.activeCount < g.runCap, `activeCount ${g.activeCount} < runCap ${g.runCap}`);
  // guard is a query, never a reservation (docs/V1_RUNTIME.md)
  assert.equal(g.admission, false);
  assert.equal(runtimeStatus({ project: fx.project, stateRoot: fx.stateRoot }).activeCount, 0);
});

test("an unbound guard query cannot authorize anything", async (t) => {
  const fx = await registeredRun(t, 1);
  const g = guard(fx.stateRoot, { project: fx.project });
  assert.equal(g.allowed, false);
  assert.equal(g.reasonCode, "TASK_CONTEXT_REQUIRED");
});

test("acquire then release tracks concurrency", async (t) => {
  const fx = await registeredRun(t, 2);
  const a1 = acquire(fx.stateRoot, fx.base, { taskId: "t1", launchKey: "k1" });
  assert.equal(a1.allowed, true);
  assert.equal(a1.action, "start");
  const a2 = acquire(fx.stateRoot, fx.base, { taskId: "t2", launchKey: "k2" });
  assert.equal(a2.allowed, true);
  assert.equal(runtimeStatus({ project: fx.project, stateRoot: fx.stateRoot }).activeCount, 2);

  // v1: releasing requires the exact lease id and fencing token; a bare agent
  // id cannot release another identity's reservation.
  const bare = release(fx.stateRoot, { agentId: "t1" });
  assert.equal(bare.released, false);
  assert.equal(bare.reasonCode, "LEASE_TOKEN_REQUIRED");

  // The slot is freed by the Core adapter's confirmed-not-started fact
  // (docs/V1_RUNTIME.md "A failed spawn releases only with the Core adapter's
  // confirmed-not-started fact"), which releases the lease in the ledger.
  const settled = markLaunchFailed({ project: fx.project, stateRoot: fx.stateRoot, leaseId: a1.leaseId, token: a1.fencingToken, error: { code: "SPAWN_FAILED" } });
  assert.equal(settled.ok, true);
  assert.equal(settled.lease.status, "released");
  assert.equal(runtimeStatus({ project: fx.project, stateRoot: fx.stateRoot }).activeCount, 1);

  // a stale release of that same lease is refused, never double-counted
  const stale = release(fx.stateRoot, { leaseId: a1.leaseId, token: a1.fencingToken });
  assert.equal(stale.released, false);
  assert.equal(stale.alreadyReleased, true);
  assert.equal(runtimeStatus({ project: fx.project, stateRoot: fx.stateRoot }).activeCount, 1);
});

test("guard DENIES at max concurrency", async (t) => {
  const fx = await registeredRun(t, 5, { maxConcurrency: 4 });
  for (let i = 0; i < 4; i++) {
    const r = acquire(fx.stateRoot, fx.base, { taskId: `t${i + 1}`, launchKey: `b${i}` });
    assert.equal(r.allowed, true, `acquire ${i}: ${r.reasonCode}`);
  }
  const g = guard(fx.stateRoot, { ...fx.base, taskId: "t5" });
  assert.equal(g.allowed, false);
  assert.equal(g.reasonCode, "CONCURRENCY_LIMIT");
  assert.equal(g.runCap, 4);
  // acquiring anyway is refused by the same cap, with the same code
  const denied = acquire(fx.stateRoot, fx.base, { taskId: "t5", launchKey: "b5" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasonCode, "CONCURRENCY_LIMIT");
});

test("acquire DENIES an unidentified legacy admission", async (t) => {
  const fx = await registeredRun(t, 1);
  // v0.8 denied this call for exceeding a per-agent USD/min rate. v1 has no
  // USD/min admission limit at all (docs/V1_RUNTIME.md: the ledger "does not
  // impose global machine/API billing limits"); instead an admission without
  // run identity is refused outright, so a legacy agent id can never create a
  // separate, unaccounted ledger.
  const r = acquire(fx.stateRoot, { ...cfg, project: fx.project }, { agentId: "deny1", role: "implementer" });
  assert.equal(r.allowed, false);
  assert.equal(r.reasonCode, "TASK_CONTEXT_REQUIRED");
  assert.match(r.reason, /runId|ledger/i);
  assert.equal(runtimeStatus({ project: fx.project, stateRoot: fx.stateRoot }).activeCount, 0);
});

test("report shows used percentage vs total only when usage is selected", async (t) => {
  const fx = await registeredRun(t, 1);
  const base = { ...cfg, project: fx.project, stateRoot: fx.stateRoot };

  // v1 reports unselected cost coverage as unknown, never as 0.
  const unselected = report(base);
  assert.equal(unselected.impl, "usage-unavailable");
  assert.equal(unselected.total.ratePerMin, null);
  assert.equal(unselected.total.usedPct, null, "unknown coverage stays unknown, it does not become 0%");
  assert.equal(unselected.basis, "unknown");

  // with cc-switch.usage explicitly selected the rate and percentage resolve
  const r = report({ ...base, usageEnabled: true, usageProvider: ccswitch });
  assert.equal(r.impl === "node:sqlite" || r.impl === "sqlite3-cli", true, r.impl);
  assert.ok(r.total.usedPct >= 0);
  assert.equal(r.total.limitUsdPerMin, cfg.totalLimitUsdPerMin);
  assert.equal(r.basis, "estimated");
  // cc-switch amounts are token-price-derived estimates, never payment proof
  assert.equal(r.coverage.complete, false);
  assert.ok(r.caveats.some((c) => /token-price-derived estimates/.test(c)));
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
