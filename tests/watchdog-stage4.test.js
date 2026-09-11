import "./fixtures/test-env.mjs";
// @ts-check
// Watchdog Stage 4: knowledge base, budget attribution, snapshot reconcile.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { keyTokens, signature, writeCase, findCase, appendCase, precedentText } from "../src/watchdog/knowledge.js";
import { reconcileSnapshot } from "../src/watchdog/snapshot.js";
import { openIncident, loadIncident, applyEvent, saveIncident } from "../src/watchdog/incidents.js";
import { dispatchIncident } from "../src/watchdog/dispatch.js";
import { scanOnce } from "../src/watchdog/scan.js";
import { spendSince } from "../src/ccswitch.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const now = 1787300000;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-s4-"));
  fs.mkdirSync(path.join(dir, ".mawf"), { recursive: true });
  return dir;
}

// --- knowledge ----------------------------------------------------------------

test("keyTokens/signature: deterministic, volatility-insensitive", () => {
  const a = signature({ host: "pi", finding: { signal: "a", reason: "3 consecutive errors", evidence: "ECONNREFUSED 127.0.0.1:8081 x3 at /tmp/proj/app.js" } });
  const b = signature({ host: "pi", finding: { signal: "a", reason: "5 consecutive errors", evidence: "ECONNREFUSED 127.0.0.1:8081 x5 at /var/www/app.js" } });
  assert.equal(a, b, "counts/paths stripped → same problem, same signature");
  const c = signature({ host: "claude-code", finding: { signal: "a", reason: "3 consecutive errors", evidence: "ECONNREFUSED 127.0.0.1:8081" } });
  assert.notEqual(a, c, "different host → different signature");
  const d1 = signature({ host: "pi", finding: { signal: "c", reason: "provider 429 rate limit" } });
  const d2 = signature({ host: "pi", finding: { signal: "c", reason: "provider 429 rate limit" } });
  assert.equal(d1, d2);
  assert.deepEqual(keyTokens("MCP server foo-bar pending approval (2 of 3)"), ["approval", "bar", "foo", "mcp", "pending", "server"]);
});

test("knowledge round-trip: write → find (success) → failed append → routing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-kb-"));
  const sig = signature({ host: "pi", finding: { signal: "a", reason: "provider 429 rate limit", evidence: "" } });
  writeCase(dir, { sig, host: "pi", symptom: "provider 429", fix: "switch provider via config", outcome: "failed" });
  let hit = findCase(dir, sig);
  assert.equal(hit.any, true);
  assert.equal(hit.best, null, "no success yet");
  assert.deepEqual(hit.failedFixes, ["switch provider via config"]);
  appendCase(dir, { sig, host: "pi", symptom: "provider 429", fix: "wait backoff then retry", outcome: "success" });
  hit = findCase(dir, sig);
  assert.ok(hit.best);
  assert.equal(hit.best.fix, "wait backoff then retry");
  assert.deepEqual(hit.failedFixes, ["switch provider via config"], "failure history preserved");
  const prec = precedentText(hit);
  assert.match(prec, /Previously fixed by: wait backoff then retry/);
  assert.match(prec, /\(do NOT retry as-is\): switch provider via config/);
  // unknown signature
  const miss = findCase(dir, "ffffffffffffffff");
  assert.equal(miss.any, false);
  assert.equal(precedentText(miss), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- budget attribution ---------------------------------------------------------

const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "maw-s4db-"));
const dbPath = path.join(tmpDb, "cc-switch.db");
makeFixtureDb(dbPath, { v17: true, withLogs: true });

test("spendSince: windowed, app-typed", () => {
  const total = spendSince({ dbPath, sinceSec: now - 3600 });
  assert.ok(total > 0); // fixture rows carry real wall-clock times — window from real now
  const claude = spendSince({ dbPath, sinceSec: Math.floor(Date.now() / 1000) - 3600, appTypes: ["claude"] });
  const pi = spendSince({ dbPath, sinceSec: Math.floor(Date.now() / 1000) - 3600, appTypes: ["pi"] });
  assert.ok(Math.abs(total - (claude + pi)) < 1e-9, "app filter partitions the spend");
  assert.equal(spendSince({ dbPath: "/nope.db", sinceSec: now }), 0);
});

test("dispatchIncident: spend attributed to phase + budget-stop when cap reached", async () => {
  const dir = tmpProject();
  const inc = openIncident({ projectDir: dir, host: "pi", sessionId: "s1", file: "f", finding: { signal: "a", reason: "boom", evidence: "x", at: now }, budgetCapUsd: 0.001, nowSec: now });
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  // runner "fails"; the fixture db has $1.80 in the last hour — attribution
  // window covers [phaseStart, phaseEnd] which includes those rows (real now)
  const run = () => ({ status: 1, stdout: "FIX: nothing\nRESCUE-DONE outcome=failed\n", timedOut: false });
  const r = dispatchIncident({ incident: inc, cc, run, workspace: path.join(dir, "ws"), nowSec: Math.floor(Date.now() / 1000) - 60, available: ["claude", "pi"], dbPath });
  assert.equal(r.reason, "budget-stop");
  assert.equal(loadIncident(dir, inc.id).state, "budget-stop");
  const reloaded = loadIncident(dir, inc.id);
  const ph = reloaded.phases[0];
  assert.ok(ph.spendUsd > 0, "spend attributed");
  assert.ok(reloaded.budgetUsd >= reloaded.budgetCapUsd);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispatchIncident: resolved verdict writes a SUCCESS case back", async () => {
  const dir = tmpProject();
  const ws = path.join(dir, "ws");
  const inc = openIncident({ projectDir: dir, host: "pi", sessionId: "s1", file: "f", finding: { signal: "a", reason: "provider 429 rate limit", evidence: "", at: now }, budgetCapUsd: 10, nowSec: now });
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  const run = () => ({ status: 0, stdout: "FIX: waited backoff\nRESCUE-DONE outcome=resolved\n", timedOut: false });
  dispatchIncident({ incident: inc, cc, run, workspace: ws, nowSec: now, available: ["pi", "claude"], dbPath: "/nope.db" });
  const sig = signature({ host: "pi", finding: { signal: "a", reason: "provider 429 rate limit", evidence: "" } });
  const hit = findCase(path.join(ws, "knowledge"), sig);
  assert.ok(hit.best, "success case written back");
  assert.equal(hit.best.fix, "waited backoff");
  // second incident, same signature: precedent is injected into the prompt
  const inc2 = openIncident({ projectDir: dir, host: "pi", sessionId: "s2", file: "f", finding: { signal: "a", reason: "provider 429 rate limit", evidence: "", at: now }, budgetCapUsd: 10, nowSec: now });
  const seen = [];
  const run2 = (bin, args) => { seen.push(args.join(" ")); return { status: 0, stdout: "FIX: x\nRESCUE-DONE outcome=resolved\n", timedOut: false }; };
  dispatchIncident({ incident: inc2, cc, run: run2, workspace: ws, nowSec: now, available: ["pi", "claude"], dbPath: "/nope.db" });
  assert.match(seen[0], /Previously fixed by: waited backoff/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- snapshot reconcile -----------------------------------------------------------

test("reconcileSnapshot: divergence summary, never auto-merges (fake git)", () => {
  const dir = tmpProject();
  const fake = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { status: 0, stdout: "true\n" };
    if (args[0] === "diff") return { status: 0, stdout: " src/a.js | 2 +-\n src/b.js | 10 +++++++---\n" };
    if (args[0] === "status") return { status: 0, stdout: " M src/a.js\n?? c.txt\n" };
    return { status: 0, stdout: "" };
  };
  const rec = reconcileSnapshot(dir, "inc-1", { run: fake });
  assert.equal(rec.ok, true);
  assert.match(rec.diffSummary, /src\/a\.js/);
  assert.match(rec.guidance, /auto-merge is intentionally NOT performed/);
  const nonGit = reconcileSnapshot(dir, "inc-2", { run: () => ({ status: 1, stdout: "" }) });
  assert.equal(nonGit.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- scan re-entry parity -----------------------------------------------------------

test("scanOnce re-entry: aged phase gets late spend attribution + budget-stop", async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-s4h-"));
  const inc = openIncident({ projectDir: dir, host: "pi", sessionId: "gone", file: "f", finding: { signal: "a", reason: "boom", evidence: "", at: now }, budgetCapUsd: 0.001, nowSec: now });
  applyEvent(inc, { type: "dispatch-a", nowSec: now });
  inc.phases.push({ phase: "a", host: "claude", startedAt: Math.floor(Date.now() / 1000) - 16 * 60 });
  saveIncident(inc);
  const r = await scanOnce({ projectDir: dir, nowSec: Math.floor(Date.now() / 1000), home, isProcessAlive: () => false, dbPath });
  const re = loadIncident(dir, inc.id);
  assert.equal(re.state, "budget-stop");
  assert.ok(re.phases[0].spendUsd > 0, "late attribution recorded");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// --- webhook (R9) ------------------------------------------------------------------

test("postWebhook: POSTs JSON, never throws; scan wiring fires on incidents", async () => {
  const { postWebhook } = await import("../src/watchdog/scan.js");
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const r = await postWebhook("http://example.invalid/hook", { a: 1 }, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).a, 1);
  assert.deepEqual(await postWebhook("", {}, fakeFetch), { ok: false, reason: "no url" });
  const r2 = await postWebhook("http://x", {}, async () => { throw new Error("net down"); });
  assert.equal(r2.ok, false);

  // scan wiring: incident opened -> webhook called with the summary
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mawf", "config.yaml"), "watchdog:\n  webhookUrl: http://example.invalid/hook\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-s4w-"));
  const claudeSlug = process.platform === "win32" ? dir.replace(/[^a-zA-Z0-9]/g, "-") : "-" + dir.replace(/\//g, "-").replace(/^-+/, "");
  const claudeSess = path.join(home, ".claude", "projects", claudeSlug);
  fs.mkdirSync(claudeSess, { recursive: true });
  fs.writeFileSync(path.join(claudeSess, "b1.jsonl"), [1, 2, 3].map((i) => JSON.stringify({ type: "tool_result", is_error: true, content: `boom ${i}`, sessionId: "b1", timestamp: new Date((Date.now() / 1000 - 60 * i) * 1000).toISOString() })).join("\n"));
  await scanOnce({ projectDir: dir, nowSec: Math.floor(Date.now() / 1000), home, isProcessAlive: () => true, dbPath: "/nope.db", fetch: fakeFetch });
  assert.ok(calls.length >= 2, "scan fired the webhook");
  assert.equal(JSON.parse(calls[calls.length - 1].init.body).source, "mawf-watchdog");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
