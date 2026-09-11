import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readCcSwitch, resolveModel, costRate, perSessionRate, findDb } from "../src/ccswitch.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cc-"));
const dbPath = path.join(tmp, "cc-switch.db");

test.before(() => makeFixtureDb(dbPath, { withLogs: true }));

test("readCcSwitch returns current providers per app_type", () => {
  const cc = readCcSwitch({ dbPath });
  assert.equal(cc.impl === "node:sqlite" || cc.impl === "sqlite3-cli", true);
  assert.ok(cc.currentProviders.claude);
  assert.ok(cc.currentProviders.codex);
  assert.equal(cc.currentProviders.claude.name, "Test Claude");
  assert.ok(Object.keys(cc.modelPricing).length >= 3);
});

test("readCcSwitch parses settings_config env (Claude) and top-level model (Codex)", () => {
  const cc = readCcSwitch({ dbPath });
  const claude = resolveModel(cc.currentProviders, "claude");
  assert.equal(claude.model, "claude-opus-5");
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8081");
  const codex = resolveModel(cc.currentProviders, "codex");
  assert.equal(codex.model, "gpt-5.2-codex");
});

test("costRate computes real USD/min from proxy logs", () => {
  const r = costRate({ dbPath, windowSeconds: 120 });
  assert.ok(r.totalUsd > 0);
  // 3 requests totaling $1.50 over 120s => rate = 1.5 / (120/60) = 0.75 USD/min
  assert.ok(r.ratePerMin >= 0.7 && r.ratePerMin <= 0.8, `rate was ${r.ratePerMin}`);
  assert.equal(r.requestCount, 3);
});

test("perSessionRate breaks down by session", () => {
  const r = perSessionRate({ dbPath, windowSeconds: 120 });
  assert.ok(r.sessions.length >= 1);
  const a = r.sessions.find((s) => s.sessionId === "sess-A");
  assert.ok(a);
  assert.equal(a.requestCount, 3);
});

test("findDb prefers an explicit CC_SWITCH_DB path when it exists", () => {
  process.env.CC_SWITCH_DB = dbPath;
  assert.equal(findDb(), dbPath);
  process.env.CC_SWITCH_DB = "";
});

// cleanup
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
