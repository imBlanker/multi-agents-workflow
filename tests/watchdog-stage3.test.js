import "./fixtures/test-env.mjs";
// @ts-check
// Watchdog Stage 3: dispatch — host rotation, price valve, prompts, verdicts,
// workspace bootstrap, snapshot gate, scan wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { selectRescueHosts, pickRescueModel, buildPhaseAPrompt, buildPhaseBPrompt, hostCommand, parseVerdict, bootstrapWorkspace, dispatchIncident, workspaceDefault } from "../src/watchdog/dispatch.js";
import { ensureSnapshot, isGitProject } from "../src/watchdog/snapshot.js";
import { openIncident, loadIncident } from "../src/watchdog/incidents.js";
import { scanOnce } from "../src/watchdog/scan.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const now = 1787300000;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-dis-"));
  fs.mkdirSync(path.join(dir, ".mawf"), { recursive: true });
  return dir;
}

// --- pure: rotation ----------------------------------------------------------

test("selectRescueHosts: fixed order, skip stalled/tried/unavailable", () => {
  assert.deepEqual(selectRescueHosts({ stalled: "pi" }), ["claude", "dsh", "codex"]);
  assert.deepEqual(selectRescueHosts({ stalled: "claude" }), ["pi", "dsh", "codex"]);
  assert.deepEqual(selectRescueHosts({ stalled: "pi", tried: ["claude"] }), ["dsh", "codex"]);
  assert.deepEqual(selectRescueHosts({ stalled: "pi", available: ["claude", "pi"] }), ["claude"]);
  assert.deepEqual(selectRescueHosts({ stalled: "pi", tried: ["claude", "dsh", "codex"] }), []);
  assert.deepEqual(selectRescueHosts({ stalled: "codex", order: ["claude", "pi", "dsh", "codex"] }), ["claude", "pi", "dsh"]);
});

// --- pure: price valve -------------------------------------------------------

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-dis-db-"));
const dbPath = path.join(dbDir, "cc-switch.db");
makeFixtureDb(dbPath, { v17: true });

test("pickRescueModel: blocked model skipped; unknown-price fallback only when nothing known-within-gate", async () => {
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  // claude candidates: opus-5 (5/25 — BLOCKED) then openmodel-x (price unknown —
  // gate policy: not blocked, but only a FALLBACK). Fixture's claude provider
  // carries no sonnet-5 candidate, so the fallback legitimately wins here.
  const pick = pickRescueModel(cc, "claude");
  assert.ok(pick);
  assert.notEqual(pick.model, "claude-opus-5", "blocked model never picked");
  assert.equal(pick.model, "openmodel-x");
  // a known within-gate price must beat the unknown-price fallback:
  const cc2 = readCcSwitch({ dbPath });
  // (fixture db still carries pre-refresh sonnet 3/15 — put it inside the gate
  // for this check, as the real cc-switch v3.20 catalog now does: 2/10)
  cc2.modelPricing["claude-sonnet-5"] = { ...cc2.modelPricing["claude-sonnet-5"], input_per_m: 2, output_per_m: 10 };
  cc2.allProviders = cc2.allProviders.map((p) =>
    p.app_type === "claude" && p.settingsConfig?.env
      ? { ...p, settingsConfig: { ...p.settingsConfig, env: { ...p.settingsConfig.env, ANTHROPIC_MODEL: "claude-sonnet-5" } } }
      : p);
  const pick2 = pickRescueModel(cc2, "claude");
  assert.equal(pick2.model, "claude-sonnet-5");
  // pi (fixture db row 'Pi Official' gpt-5.5): candidates exist
  const piPick = pickRescueModel(cc, "pi");
  assert.ok(piPick);
  // unknown host → null
  assert.equal(pickRescueModel(cc, "nope"), null);
});

// --- pure: prompts -----------------------------------------------------------

test("buildPhaseAPrompt: lossless contract, absolute paths, verdict footer", () => {
  const inc = { host: "pi", sessionId: "sess-abc123", projectDir: "/tmp/proj", file: "/tmp/proj/x.jsonl", finding: { signal: "a", reason: "3 consecutive errors", evidence: "run=3" }, id: "inc-1" };
  const p = buildPhaseAPrompt({ incident: inc, precedent: "restart the foo MCP server" });
  assert.match(p, /Phase A: unblock only/);
  assert.match(p, /READ-ONLY \+ LOSSLESS/);
  assert.match(p, /NEVER write, modify, or delete files inside the target project/);
  assert.match(p, /\/tmp\/proj/);
  assert.match(p, /restart the foo MCP server/);
  assert.match(p, /RESCUE-DONE outcome=resolved/);
});

test("buildPhaseBPrompt: transcript handoff, trellis discipline when present, snapshot ref", () => {
  const inc = { host: "claude", sessionId: "s", projectDir: "/tmp/proj", file: "/tmp/proj/t.jsonl", finding: { reason: "stalled" }, id: "inc-9" };
  const plain = buildPhaseBPrompt({ incident: inc });
  assert.match(plain, /Phase B: takeover/);
  assert.match(plain, /read it, summarize the recent state/);
  assert.doesNotMatch(plain, /trellis/);
  const tr = buildPhaseBPrompt({ incident: inc, trellis: true, snapshotRef: "refs/rescue/inc-9" });
  assert.match(tr, /task\.py\' \'current\'/);
  assert.match(tr, /never implement before the task is started/);
  assert.match(tr, /refs\/rescue\/inc-9/);
});

// --- pure: commands & verdicts ------------------------------------------------

test("hostCommand: headless invocations per host; codex native resume/fork", () => {
  const ws = "/tmp/ws";
  assert.deepEqual(hostCommand({ host: "claude", prompt: "hi", model: "m1", workspace: ws }), { bin: "claude", args: ["-p", "--model", "m1", "hi"], cwd: ws });
  assert.deepEqual(hostCommand({ host: "pi", prompt: "hi", workspace: ws }), { bin: "pi", args: ["-p", "hi"], cwd: ws });
  assert.deepEqual(hostCommand({ host: "dsh", prompt: "hi", workspace: ws }), { bin: "dsh", args: ["--profile", "headless", "hi"], cwd: ws });
  assert.deepEqual(hostCommand({ host: "codex", prompt: "hi", model: "m2", workspace: ws }), { bin: "codex", args: ["exec", "-m", "m2", "hi"], cwd: ws });
  assert.deepEqual(hostCommand({ host: "codex", prompt: "hi", workspace: ws, native: "resume", sessionId: "S1" }), { bin: "codex", args: ["exec", "resume", "S1", "--", "hi"], cwd: ws });
  assert.equal(hostCommand({ host: "nope", prompt: "x", workspace: ws }), null);
});

test("parseVerdict: footer contract", () => {
  assert.deepEqual(parseVerdict("work work\nRESCUE-DONE outcome=resolved\n"), { outcome: "resolved" });
  assert.deepEqual(parseVerdict("RESCUE-DONE outcome=blocked"), { outcome: "blocked" });
  assert.equal(parseVerdict("no footer"), null);
});

// --- workspace & snapshot ------------------------------------------------------

test("bootstrapWorkspace: idempotent dirs + config, env-overridable", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "maw-ws-"));
  process.env.MAW_WATCHDOG_WORKSPACE = ws;
  try {
    bootstrapWorkspace();
    assert.ok(fs.existsSync(path.join(ws, "knowledge")));
    assert.ok(fs.existsSync(path.join(ws, ".mawf", "config.yaml")));
    const before = fs.readFileSync(path.join(ws, ".mawf", "config.yaml"), "utf8");
    bootstrapWorkspace(); // idempotent
    assert.equal(fs.readFileSync(path.join(ws, ".mawf", "config.yaml"), "utf8"), before);
    assert.equal(workspaceDefault(), ws);
  } finally { delete process.env.MAW_WATCHDOG_WORKSPACE; }
  fs.rmSync(ws, { recursive: true, force: true });
});

test("ensureSnapshot: non-git degrades; git project snapshots via injectable runner", () => {
  const dir = tmpProject();
  assert.equal(isGitProject(dir, { run: () => ({ status: 1, stdout: "" }) }), false);
  const nonGit = ensureSnapshot(dir, "inc-1", { run: () => ({ status: 1, stdout: "" }) });
  assert.equal(nonGit.ok, false);
  assert.equal(nonGit.nonGit, true);
  // fake git runner: stash create yields a sha
  const calls = [];
  const fake = (args, cwd) => {
    calls.push(args.join(" "));
    if (args[0] === "stash" && args[1] === "create") return { status: 0, stdout: "abc123\n" };
    if (args[0] === "rev-parse") return { status: 0, stdout: "true\n" };
    return { status: 0, stdout: "" };
  };
  const snap = ensureSnapshot(dir, "inc-2", { run: fake });
  assert.equal(snap.ok, true);
  assert.equal(snap.ref, "refs/rescue/inc-2");
  assert.ok(calls.includes("stash create mawf-rescue inc-2"));
  // clean tree → HEAD snapshot
  const fake2 = (args) => (args[0] === "stash" ? { status: 0, stdout: "\n" } : args[0] === "rev-parse" ? { status: 0, stdout: "HEADSHA\n" } : { status: 0, stdout: "" });
  const snap2 = ensureSnapshot(dir, "inc-3", { run: fake2 });
  assert.equal(snap2.ok, true);
  assert.match(snap2.reason, /clean tree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- dispatch orchestration ----------------------------------------------------

/** fake runner factory */
function runner(outcomeByHost, opts = {}) {
  const seen = [];
  const run = (bin, args, cwd, timeout) => {
    const host = bin === "claude" ? "claude" : bin === "pi" ? "pi" : bin === "dsh" ? "dsh" : "codex";
    seen.push({ bin, args, cwd, timeout });
    const outcome = outcomeByHost[host] ?? "failed";
    if (outcome === "timeout") return { status: 1, stdout: "", timedOut: true };
    return { status: 0, stdout: `did things\nRESCUE-DONE outcome=${outcome}\n`, timedOut: false };
  };
  run.seen = seen;
  return run;
}

function mkIncident(dir, host = "pi") {
  return openIncident({ projectDir: dir, host, sessionId: "sess-1", file: "/tmp/t.jsonl", finding: { signal: "a", reason: "3 errors", evidence: "run=3", at: now }, budgetCapUsd: 10, nowSec: now });
}

test("dispatchIncident: Phase A resolved → incident resolved, host not stalled-host", async () => {
  const dir = tmpProject();
  const inc = mkIncident(dir, "pi");
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  const run = runner({ claude: "resolved" });
  const r = dispatchIncident({ incident: inc, cc, run, workspace: path.join(dir, "ws"), nowSec: now, available: ["claude", "pi", "dsh", "codex"] });
  assert.equal(r.dispatched, true);
  assert.equal(r.host, "claude"); // first in rotation, stalled pi skipped
  assert.equal(r.phase, "a");
  assert.equal(loadIncident(dir, inc.id).state, "resolved");
  // runner got a claude -p command rooted in the workspace
  assert.equal(run.seen[0].bin, "claude");
  assert.ok(run.seen[0].args.includes("-p"));
  assert.ok(run.seen[0].cwd.startsWith(path.join(dir, "ws")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispatchIncident: Phase A fail → open; next cycle Phase B requires snapshot; non-git → diagnose-only", async () => {
  const dir = tmpProject();
  const inc = mkIncident(dir, "pi");
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  const run = runner({}); // everything fails
  const r1 = dispatchIncident({ incident: inc, cc, run, workspace: path.join(dir, "ws"), nowSec: now, available: ["claude"] });
  assert.equal(r1.phase, "a");
  assert.equal(r1.reason, "failed");
  assert.equal(loadIncident(dir, inc.id).state, "open");
  // second cycle: Phase A done+failed → Phase B; non-git → diagnose-only (R8)
  const inc2 = loadIncident(dir, inc.id);
  const r2 = dispatchIncident({ incident: inc2, cc, run, workspace: path.join(dir, "ws"), nowSec: now + 60, available: ["claude"], ensureSnap: () => ({ ok: false, nonGit: true, reason: "not a git repository" }) });
  assert.equal(r2.reason, "diagnose-only (non-git)");
  assert.equal(loadIncident(dir, inc.id).state, "diagnose-only");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispatchIncident: rotation across cycles; exhaustion → human-alert", async () => {
  const dir = tmpProject();
  const inc = mkIncident(dir, "pi");
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  const run = runner({});
  const snap = () => ({ ok: true, ref: "refs/rescue/x" });
  const avail = ["claude", "dsh", "codex"]; // pi stalled, pi unavailable anyway
  // bring gpt-5.2-codex inside the price valve for this test (fixture price
  // $14/1M output would correctly skip codex; rotation coverage needs it in)
  cc.modelPricing["gpt-5.2-codex"] = { ...cc.modelPricing["gpt-5.2-codex"], output_per_m: 4 };
  // cycle 1: Phase A on claude (first in rotation)
  const r1 = dispatchIncident({ incident: inc, cc, run, workspace: path.join(dir, "ws"), nowSec: now, available: avail, ensureSnap: snap });
  assert.deepEqual([r1.host, r1.phase], ["claude", "a"]);
  // cycle 2: Phase B must be a DIFFERENT host (PRD: switch to another agent software)
  const r2 = dispatchIncident({ incident: loadIncident(dir, inc.id), cc, run, workspace: path.join(dir, "ws"), nowSec: now + 60, available: avail, ensureSnap: snap });
  assert.deepEqual([r2.host, r2.phase], ["dsh", "b"]);
  // cycle 3: codex phase b — its failure path exhausts the rotation → human-alert
  const r3 = dispatchIncident({ incident: loadIncident(dir, inc.id), cc, run, workspace: path.join(dir, "ws"), nowSec: now + 120, available: avail, ensureSnap: snap });
  assert.deepEqual([r3.host, r3.phase], ["codex", "b"]);
  assert.equal(loadIncident(dir, inc.id).state, "human-alert");
  // any further cycle: nothing to do (terminal)
  const r4 = dispatchIncident({ incident: loadIncident(dir, inc.id), cc, run, workspace: path.join(dir, "ws"), nowSec: now + 180, available: avail, ensureSnap: snap });
  assert.equal(r4.dispatched, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispatchIncident: budget pre-check stops dispatch", async () => {
  const dir = tmpProject();
  const inc = mkIncident(dir, "pi");
  inc.budgetUsd = 10; inc.budgetCapUsd = 10;
  const { saveIncident } = await import("../src/watchdog/incidents.js");
  saveIncident(inc);
  const run = runner({ claude: "resolved" });
  const r = dispatchIncident({ incident: loadIncident(dir, inc.id), cc: {}, run, workspace: path.join(dir, "ws"), nowSec: now });
  assert.equal(r.reason, "budget-stop");
  assert.equal(loadIncident(dir, inc.id).state, "budget-stop");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dispatchIncident: dry-run prints prompt, spawns nothing", async () => {
  const dir = tmpProject();
  const inc = mkIncident(dir, "pi");
  const { readCcSwitch } = await import("../src/ccswitch.js");
  const cc = readCcSwitch({ dbPath });
  const run = runner({ claude: "resolved" });
  const logs = [];
  const r = dispatchIncident({ incident: inc, cc, run, dryRun: true, workspace: path.join(dir, "ws"), nowSec: now, log: (l) => logs.push(l) });
  assert.equal(r.dryRun, true);
  assert.equal(run.seen.length, 0, "nothing spawned");
  assert.match(logs.join("\n"), /RESCUE-DONE outcome=resolved/);
  assert.match(logs.join("\n"), /Phase A/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- scan wiring ----------------------------------------------------------------

test("scanOnce dispatch:true resolves an incident end-to-end (fixture tree, fake runner)", async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-home3-"));
  // home must expose available hosts (dirs) + claude blocked transcript
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(home, ".dsh"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const claudeSlug = process.platform === "win32" ? dir.replace(/[^a-zA-Z0-9]/g, "-") : "-" + dir.replace(/\//g, "-").replace(/^-+/, "");
  const claudeSess = path.join(home, ".claude", "projects", claudeSlug);
  fs.mkdirSync(claudeSess, { recursive: true });
  const blocked = [1, 2, 3].map((i) => JSON.stringify({ type: "tool_result", is_error: true, content: `boom ${i}`, sessionId: "b1", timestamp: new Date((now - 100 * i) * 1000).toISOString() })).join("\n");
  fs.writeFileSync(path.join(claudeSess, "b1.jsonl"), blocked);
  const run = runner({ pi: "resolved" }); // claude stalled → pi rescues
  const r = await scanOnce({ projectDir: dir, nowSec: now, home, isProcessAlive: () => true, dbPath, dispatch: true, run, workspace: path.join(home, "ws") });
  assert.equal(r.projects[0].dispatched.length, 1);
  assert.equal(r.projects[0].dispatched[0].host, "pi");
  assert.equal(r.projects[0].dispatched[0].reason, "resolved");
  const incId = r.projects[0].dispatched[0].id;
  assert.equal(loadIncident(dir, incId).state, "resolved");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("scanOnce dispatch default OFF (classify+record only; library-safe)", async () => {
  const dir = tmpProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-home4-"));
  const r = await scanOnce({ projectDir: dir, nowSec: now, home, isProcessAlive: () => true, dbPath: "/nonexistent.db" });
  assert.deepEqual(r.projects[0].dispatched, []); // field present, nothing dispatched
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
