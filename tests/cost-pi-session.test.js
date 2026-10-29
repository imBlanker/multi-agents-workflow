import "./fixtures/test-env.mjs";
// @ts-check
// Pi real-spend metering via cc-switch Pi (Session) import (schema v17).
// PRD R3: when pi-session rows exist, pi spend is real (not concurrency-only),
// aggregates carry the upstream cache-write caveat, error counts feed the
// watchdog signal-d. See task 08-21-ccswitch-v3.20-cli-v5.10.2-followup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { perSessionRate, piSessionUsagePresent, costRate } from "../src/ccswitch.js";
import * as ccswitch from "../src/ccswitch.js";
import { report } from "../src/cost.js";
import { readPiAsCc, piCostRateNote } from "../src/piprovider.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-pi-spend-"));
const dbV17 = path.join(tmp, "v17.db");
const dbV16 = path.join(tmp, "v16.db");
makeFixtureDb(dbV17, { v17: true, withLogs: true });
makeFixtureDb(dbV16, { withLogs: true });

const CFG = (dbPath) => ({ perAgentLimitUsdPerMin: 5, totalLimitUsdPerMin: 10, maxConcurrency: 16, windowSeconds: 300, dbPath });

test("piSessionUsagePresent: true on v17 fixture, false on v16 / no db", () => {
  assert.equal(piSessionUsagePresent({ dbPath: dbV17, windowSeconds: 300 }), true);
  assert.equal(piSessionUsagePresent({ dbPath: dbV16, windowSeconds: 300 }), false);
  assert.equal(piSessionUsagePresent({ dbPath: path.join(tmp, "nope.db"), windowSeconds: 300 }), false);
});

test("report includes pi spend in total and carries the cache-write caveat", () => {
  // v1 reads no usage telemetry unless cc-switch.usage is selected and its
  // provider is supplied (commit 188298f); without that the aggregate stays
  // null instead of silently reporting 0.
  const unselected = report(CFG(dbV17));
  assert.equal(unselected.impl, "usage-unavailable");
  assert.equal(unselected.total.totalUsd, null);

  const r = report({ ...CFG(dbV17), usageEnabled: true, usageProvider: ccswitch });
  const pi = costRate({ dbPath: dbV17, windowSeconds: 300, appType: "pi" });
  assert.ok(pi.totalUsd > 0);
  assert.ok(r.total.totalUsd >= pi.totalUsd, "pi spend part of the aggregate");
  assert.ok(r.caveats.some((c) => /cache-write accounting may be incomplete/.test(c)), "caveat present");
  const r16 = report({ ...CFG(dbV16), usageEnabled: true, usageProvider: ccswitch });
  assert.ok(!r16.caveats.some((c) => /cache-write accounting may be incomplete/.test(c)), "no pi caveat without pi rows");
  // v1 always discloses that imported cc-switch amounts are token-price-derived
  // estimates, never exact payment (docs/V1_PRICING.md).
  for (const caveats of [r.caveats, r16.caveats]) {
    assert.ok(caveats.some((c) => /token-price-derived estimates/.test(c)));
  }
});

test("perSessionRate errorCount feeds watchdog signal-d (errors/interrupted turns)", () => {
  const r = perSessionRate({ dbPath: dbV17, windowSeconds: 300 });
  const piSess = r.sessions.find((s) => s.sessionId === "pi-sess-1");
  assert.equal(piSess.errorCount, 1, "the 500 + error_message row counts once");
  const claude = r.sessions.find((s) => s.sessionId === "sess-A");
  assert.equal(claude.errorCount, 0);
});

test("piCostRateNote + readPiAsCc(piSpendMeasured) switch wording", () => {
  // v1 wording for the unmeasured case (commit b7bf698): the note names the
  // missing payment telemetry and limits the guarantee to registered
  // concurrency; the measured case still names the cc-switch import.
  // ...and the "measured" case is still only an estimate: v1 names the
  // cc-switch token-price log basis rather than claiming exact payment
  // (docs/V1_PRICING.md "cc-switch amounts are always token-price-derived
  // estimates, even when mislabeled by an importer").
  const unmeasured = /payment telemetry unavailable.*only registered concurrency/i;
  const fromLogs = /estimated from cc-switch token-price logs/i;
  assert.match(piCostRateNote(false), unmeasured);
  assert.match(piCostRateNote(true), fromLogs);
  assert.doesNotMatch(piCostRateNote(true), /\bmeasured\b/i);
  const piDir = path.join(tmp, "pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "m1" }] } } }));
  fs.writeFileSync(path.join(piDir, "settings.json"), "{}");
  assert.match(readPiAsCc({ piDir }).costNote, unmeasured);
  assert.match(readPiAsCc({ piDir, piSpendMeasured: true }).costNote, fromLogs);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
