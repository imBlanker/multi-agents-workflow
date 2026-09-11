import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readProviderQuota } from "../src/ccswitch.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-quota-"));
const dbPath = path.join(tmp, "cc-switch.db");

test.before(() => makeFixtureDb(dbPath, { withLogs: true }));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("readProviderQuota computes remaining quota = limit - rollup spend", () => {
  const q = readProviderQuota({ dbPath });
  assert.equal(q.tableMissing, false);
  const p1 = q.providers.p1;
  assert.ok(p1, "p1 present");
  assert.equal(p1.limitDailyUsd, 10);
  assert.equal(p1.limitMonthlyUsd, 50);
  assert.equal(p1.spendTodayUsd, 2);
  assert.equal(p1.remainingTodayUsd, 8, "10 limit - 2 spent today");
  assert.equal(p1.remainingMonthUsd, 48, "50 limit - 2 spent this month");
  assert.equal(p1.quotaKnown, true);
});

test("readProviderQuota: provider without limits has UNKNOWN (null) remaining", () => {
  const q = readProviderQuota({ dbPath });
  const p2 = q.providers.p2;
  assert.ok(p2, "p2 present");
  assert.equal(p2.limitDailyUsd, null);
  assert.equal(p2.remainingTodayUsd, null, "null = unknown, not infinite");
  assert.equal(p2.spendTodayUsd, 0, "no rollup rows for p2 → 0 spend");
  assert.equal(p2.quotaKnown, false);
});

test("readProviderQuota exposes the real per-provider spend rate (USD/min)", () => {
  const q = readProviderQuota({ dbPath });
  // 3 requests × $0.50 in the last hour → 1.5 / 60 = 0.025 USD/min for p1
  assert.ok(Math.abs(q.providers.p1.ratePerMin - 0.025) < 0.001, `rate was ${q.providers.p1.ratePerMin}`);
});

test("readProviderQuota degrades gracefully without a db", () => {
  const q = readProviderQuota({ dbPath: path.join(tmp, "missing.db") });
  assert.deepEqual(q.providers, {});
});
