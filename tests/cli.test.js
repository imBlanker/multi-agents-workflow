import { fileURLToPath } from "node:url";
import { fixtureEnv } from "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { makeFixtureDb } from "./fixtures/make-db.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cli-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(project, { recursive: true });
// seed a few code files so probe has something
fs.writeFileSync(path.join(project, "a.js"), "console.log(1)\n");
fs.writeFileSync(path.join(project, "b.js"), "console.log(2)\n");
fs.writeFileSync(path.join(project, "c.py"), "print(1)\n");
const dbPath = path.join(tmp, "cc-switch.db");
makeFixtureDb(dbPath, { withLogs: true });

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mawf.js");

/** @param {string[]} args @param {object} [opts] */
function run(args, opts = {}) {
  const { env: envOver, ...rest } = opts;
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: project,
    encoding: "utf8",
    // DSH_HOME points at a nonexistent dir so tests never depend on a real
    // ~/.dsh (the dsh-specific tests override it with a fixture)
    env: fixtureEnv(tmp, { CC_SWITCH_DB: dbPath, DSH_HOME: path.join(tmp, "no-dsh"), MAW_WATCHDOG_REGISTRY: path.join(tmp, "projects.json"), ...(envOver ?? {}) }),
    maxBuffer: 8 * 1024 * 1024,
    ...rest,
  });
}

test("mawf version", () => {
  const out = run(["version"]);
  assert.match(out, /^mawf /);
});

test("mawf doctor runs and reports checks", () => {
  const out = run(["doctor"]);
  assert.match(out, /mawf doctor/);
  assert.match(out, /cc-switch database/);
});

test("mawf plan probes the project and writes .mawf/ (price gate approved via --allow-pricey)", () => {
  const out = run(["plan", "--project", project, "--risk", "high", "--parallel", "4", "--allow-pricey"]);
  assert.match(out, /plan:/);
  assert.match(out, /agents:/);
  assert.match(out, /price gate: .*approved via --allow-pricey/);
  assert.ok(fs.existsSync(path.join(project, ".mawf", "workflow.json")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "config.yaml")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "plan.md")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "agents", "reviewer.json")));
});

test("mawf plan PAUSES (exit 3) with a human report when an expensive model is assigned", () => {
  const proj2 = path.join(tmp, "proj-gated");
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(path.join(proj2, "a.js"), "console.log(1)\n");
  let out = "", err = "";
  try {
    out = run(["plan", "--project", proj2, "--risk", "high", "--parallel", "4"]);
  } catch (e) {
    out = e.stdout || "";
    err = e.stderr || "";
    assert.equal(e.status, 3, "price gate must pause with exit code 3");
  }
  assert.match(out + err, /PRICE GATE/);
  assert.match(out + err, /PAUSED by the price gate/);
  // files are still written so the human can inspect the assignments
  assert.ok(fs.existsSync(path.join(proj2, ".mawf", "agents", "orchestrator.json")));
  const oj = JSON.parse(fs.readFileSync(path.join(proj2, ".mawf", "agents", "orchestrator.json"), "utf8"));
  assert.equal(oj.price_gate.blocked, true);
  assert.equal(oj.price_gate.approved, false);
});

test("approve-model records the human decision; acquire then allows the role", () => {
  const proj3 = path.join(tmp, "proj-approve");
  fs.mkdirSync(proj3, { recursive: true });
  fs.writeFileSync(path.join(proj3, "a.js"), "console.log(1)\n");
  try {
    run(["plan", "--project", proj3, "--risk", "high", "--parallel", "4"]);
  } catch { /* expected: paused */ }
  // acquire is denied while paused
  let denied = "";
  try {
    denied = run(["acquire", "--project", proj3, "--role", "implementer", "--id", "x1", "--per-agent", "100", "--total", "100"]);
  } catch (e) {
    denied = e.stdout || "";
    assert.equal(e.status, 3);
  }
  assert.match(denied, /PRICE GATE/);
  assert.match(denied, /"allowed":false/);
  // approve WITHOUT --yes must refuse (human confirmation required)
  let noYesErr = null;
  try { run(["approve-model", "--project", proj3, "--role", "implementer"]); } catch (e) { noYesErr = e; }
  assert.ok(noYesErr, "approve-model without --yes must refuse");
  assert.match(String(noYesErr.stdout || ""), /requires --yes/);
  // approve with --yes
  const appr = run(["approve-model", "--project", proj3, "--role", "implementer", "--yes"]);
  assert.match(appr, /approved: role "implementer"/);
  const j = JSON.parse(fs.readFileSync(path.join(proj3, ".mawf", "agents", "implementer.json"), "utf8"));
  assert.equal(j.price_gate.approved, true);
  // acquire now allows the role
  const ok = run(["acquire", "--project", proj3, "--role", "implementer", "--id", "x2", "--per-agent", "100", "--total", "100"]);
  assert.match(ok, /"allowed":true/);
  // approval is sticky across a re-plan
  run(["plan", "--project", proj3, "--risk", "high", "--parallel", "4", "--allow-pricey"]);
  const j2 = JSON.parse(fs.readFileSync(path.join(proj3, ".mawf", "agents", "implementer.json"), "utf8"));
  assert.equal(j2.price_gate.approved, true);
});

test("mawf cost reports real rate from fixture logs", () => {
  const out = run(["cost", "--window", "120"]);
  assert.match(out, /Cost rate/);
  assert.match(out, /USD\/min/);
});

test("mawf guard allows then denies at the per-agent limit", () => {
  const allow = run(["guard", "--project", project, "--per-agent", "0.5", "--window", "120"]);
  // fixture sess-A at ~$0.75/min over 120s => over $0.5/min per-agent => DENY
  assert.match(allow, /DENY/);
  const big = run(["guard", "--project", project, "--per-agent", "100", "--total", "100", "--concurrency", "4", "--window", "120"]);
  assert.match(big, /ALLOW/);
});

test("mawf add-agent / remove-agent mutate the plan", () => {
  run(["add-agent", "--project", project, "--role", "static-analyzer", "--model", "claude-sonnet-5", "--app", "claude", "--task", "Static analysis pass.", "--allow-pricey"]);
  assert.ok(fs.existsSync(path.join(project, ".mawf", "agents", "static-analyzer.json")));
  run(["remove-agent", "--project", project, "--role", "static-analyzer"]);
  assert.ok(!fs.existsSync(path.join(project, ".mawf", "agents", "static-analyzer.json")));
});

test("mawf run emits batched execution guidance", () => {
  const out = run(["run", "--project", project]);
  assert.match(out, /Batch 1/);
  assert.match(out, /mawf guard/);
});

test("mawf graph reports nodes/edges and batches", () => {
  const out = run(["graph", "--project", project]);
  const j = JSON.parse(out);
  assert.ok(j.nodes > 0);
  assert.ok(j.batches > 0);
});

test("mawf init --no-trellis -u <user> creates .mawf + a cc-switch project when MAW_CC_PROJECT_SYNC=1 (never 默认)", () => {
  const out = run(["init", "--project", project, "-u", "alice", "--no-trellis", "--allow-pricey"], { env: { MAW_CC_PROJECT_SYNC: "1" } });
  assert.match(out, /Initialized .mawf\//);
  assert.match(out, /cc-switch project: created/);
  assert.match(out, /protected 默认 profiles: Claude Code 默认, Codex 默认|protected 默认 profiles: Codex 默认, Claude Code 默认/);
  // trellis skipped note present
  assert.match(out, /trellis init: skipped/);
  // routing violation surfaced (fixture has claude OFF)
  assert.match(out, /routing policy: NOT compliant|routing applied/);
});

test("mawf init is DECOUPLED from cc-switch projects by default and PAUSES on expensive models", () => {
  const proj4 = path.join(tmp, "proj-init-decoupled");
  fs.mkdirSync(proj4, { recursive: true });
  let out = "", err = "";
  try {
    out = run(["init", "--project", proj4, "-u", "bob", "--no-trellis"]);
  } catch (e) {
    out = e.stdout || "";
    err = e.stderr || "";
    assert.equal(e.status, 3, "init must pause on the price gate");
  }
  const all = out + err;
  assert.match(all, /cc-switch project: DECOUPLED/);
  assert.match(all, /PRICE GATE/);
  assert.match(all, /mawf init PAUSED by the price gate/);
  // paused before touching cc-switch/trellis: no routing line, no trellis line
  assert.doesNotMatch(all, /routing policy:/);
  assert.doesNotMatch(all, /trellis init:/);
});

test("mawf routing reports violations; --fix applies the carve-out", () => {
  const out = run(["routing"]);
  assert.match(out, /cc-switch routing policy/);
  // fixture starts non-compliant (or already fixed by the init test above)
  const fixed = run(["routing", "--fix"]);
  assert.match(fixed, /applied:|status: compliant/);
});

test("mawf models --app dsh lists fixture settings.yaml models with the not-managed note", () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cli-dsh-"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), [
    "llm-pi-ai:",
    "  providers:",
    "    fixture-gw:",
    "      baseURL: https://gw.example/v1",
    "      apiKeyEnv: FIXTURE_GW_KEY",
    "      models:",
    "        - id: glm-5.2",
    "          name: GLM-5.2",
    "        - id: fixture-only-model",
  ].join("\n"));
  const out = run(["models", "--app", "dsh"], { env: { DSH_HOME: dshHome } });
  assert.match(out, /note: dsh models come from \$DSH_HOME\/settings\.yaml/);
  assert.match(out, /Available dsh provider models \(2\)/);
  assert.match(out, /fixture-gw \(current\): glm-5\.2/);
  assert.match(out, /fixture-gw \(current\): fixture-only-model/);
});

test("mawf routing on a dsh host prints N/A and writes nothing", () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cli-dsh2-"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  const out = run(["routing"], { env: { MAW_HOST: "dsh", DSH_HOME: dshHome } });
  assert.match(out, /N\/A — dsh is not cc-switch-managed/);
});

test("mawf help lists dsh in the routing policy line", () => {
  const out = run(["help"]);
  assert.match(out, /pi\/dsh N\/A/);
});


test("mawf --version flag prints the version (not help)", () => {
  const out = run(["--version"]);
  assert.match(out, /^mawf \d+/);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
