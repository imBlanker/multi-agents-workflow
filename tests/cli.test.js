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

/**
 * v1 defaults every integration off, including detected hosts
 * (docs/V1_CORE.md "All integrations default disabled"), so each fixture
 * selects exactly the capability its assertions exercise. Core commands emit
 * one JSON object (README "Start with Core"; `--json` only drops the
 * indentation), so the former human lines are read out of that object.
 */
function enableIn(projectDir, ...ids) {
  for (const id of ids) run(["integrations", "enable", id, "--project", projectDir, "--json"]);
}
/** @param {string[]} args @param {object} [opts] */
function runJson(args, opts = {}) {
  try { return JSON.parse(run(args, opts)); }
  catch (error) { return JSON.parse(String(error.stdout ?? "") || JSON.stringify({ ok: false, exitError: String(error.message), status: error.status })); }
}
// The pre-v1 fixture read cc-switch implicitly; under v1 the shared project
// selects the same two read-only capabilities explicitly.
enableIn(project, "cc-switch.models", "cc-switch.pricing");

test("mawf version", () => {
  const out = run(["version"]);
  assert.match(out, /^mawf /);
});

test("mawf doctor runs and reports checks", () => {
  const report = runJson(["doctor"]);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.name === "Node.js" && check.status === "ok"));
  const db = report.capabilities.find((capability) => capability.id === "cc-switch.models");
  assert.equal(db.selected, true);
  assert.equal(db.installed, true, "the selected cc-switch database was located and read");
  assert.equal(db.compatible, true, "its schema version is supported");
});

test("mawf plan probes the project and writes .mawf/ (price gate state reported per role)", () => {
  const out = runJson(["plan", "--project", project, "--risk", "high", "--parallel", "4"]);
  assert.equal(out.ok, true);
  assert.match(out.plan.name, /-proj$/);
  assert.ok(out.plan.agents.length > 0);
  // v1 retires the blanket --allow-pricey approval (docs/V1_PRICING.md: approval
  // is identity-bound), so plan reports each role's gate decision instead.
  assert.ok(out.generated.warnings.some((warning) => /^PRICE GATE: role /.test(warning)));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "workflow.json")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "config.yaml")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "plan.md")));
  assert.ok(fs.existsSync(path.join(project, ".mawf", "agents", "reviewer.json")));
});

test("mawf plan reports a blocked price gate and still writes the human report", () => {
  const proj2 = path.join(tmp, "proj-gated");
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(path.join(proj2, "a.js"), "console.log(1)\n");
  const out = runJson(["plan", "--project", proj2, "--risk", "high", "--parallel", "4"]);
  assert.ok(out.generated.warnings.some((warning) => /PRICE GATE/.test(warning)));
  assert.ok(out.generated.warnings.some((warning) => /PAUSED until the policy prerequisites are satisfied/.test(warning)));
  // files are still written so the human can inspect the assignments
  assert.ok(fs.existsSync(path.join(proj2, ".mawf", "agents", "orchestrator.json")));
  const oj = JSON.parse(fs.readFileSync(path.join(proj2, ".mawf", "agents", "orchestrator.json"), "utf8"));
  assert.equal(oj.price_gate.blocked, true);
  assert.equal(oj.price_gate.approved, false);
});

test("approve-model records the identity-bound human decision; the gate then allows it", () => {
  const proj3 = path.join(tmp, "proj-approve");
  fs.mkdirSync(proj3, { recursive: true });
  fs.writeFileSync(path.join(proj3, "a.js"), "console.log(1)\n");
  enableIn(proj3, "cc-switch.models", "cc-switch.pricing");
  // An exact project price override is the documented first resolution source.
  run(["config", "settings", "--project", proj3, "--json", "--set",
    JSON.stringify({ pricing: { overrides: { "p1/claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 } } } })]);
  run(["plan", "--project", proj3, "--risk", "high", "--parallel", "4"]);
  const gate = () => runJson(["pricing", "gate", "--project", proj3, "--provider", "p1", "--model", "claude-sonnet-5", "--role", "implementer", "--billing", "api"]);
  // the expensive selection is paused before any human decision
  const before = gate();
  assert.equal(before.allowed, false);
  assert.equal(before.reasonCode, "EXPENSIVE_MODEL");
  // approve WITHOUT --yes must refuse (human confirmation required)
  let noYesErr = null;
  try { run(["approve-model", "--project", proj3, "--provider", "p1", "--model", "claude-sonnet-5", "--role", "implementer", "--billing", "api"]); } catch (e) { noYesErr = e; }
  assert.ok(noYesErr, "approve-model without --yes must refuse");
  assert.match(String(noYesErr.stdout || "") + String(noYesErr.stderr || ""), /Approval requires explicit --yes/);
  // approve with --yes
  const appr = runJson(["approve-model", "--project", proj3, "--provider", "p1", "--model", "claude-sonnet-5", "--role", "implementer", "--billing", "api", "--yes"]);
  assert.equal(appr.approval.decision, "approved");
  assert.equal(appr.approval.scope, "persistent");
  assert.equal(appr.approval.identity.role, "implementer");
  // the gate now allows that exact identity
  const after = gate();
  assert.equal(after.allowed, true);
  assert.equal(after.approved, true);
  // a different model under the same role is NOT covered by that approval
  const other = runJson(["pricing", "gate", "--project", proj3, "--provider", "p1", "--model", "claude-opus-5", "--role", "implementer", "--billing", "api"]);
  assert.equal(other.approved, false);
  // approval is sticky across a re-plan
  run(["plan", "--project", proj3, "--risk", "high", "--parallel", "4"]);
  assert.equal(gate().allowed, true);
});

test("mawf cost reports real rate from fixture logs", () => {
  const out = run(["cost", "--window", "120"]);
  assert.match(out, /Cost rate/);
  assert.match(out, /USD\/min/);
});

test("mawf guard is a bound admission query and never authorizes an unbound launch", () => {
  // v1 replaces the v0.8 measured USD/min reservation with an identity-bound
  // admission query; an unbound query can never authorize a model.
  const unbound = run(["guard", "--project", project]);
  assert.match(unbound, /^DENY query: (RUNTIME_NOT_FOUND|TASK_CONTEXT_REQUIRED); this is not a reservation, acquire is required$/m);
  const structured = runJson(["guard", "--project", project, "--json"]);
  assert.equal(structured.allowed, false);
  assert.equal(structured.admission, false);
  assert.match(structured.reasonCode, /RUNTIME_NOT_FOUND|TASK_CONTEXT_REQUIRED/);
});

test("mawf add-agent / remove-agent mutate the plan", () => {
  run(["add-agent", "--project", project, "--role", "static-analyzer", "--model", "claude-sonnet-5", "--app", "claude", "--task", "Static analysis pass.", "--allow-pricey"]);
  assert.ok(fs.existsSync(path.join(project, ".mawf", "agents", "static-analyzer.json")));
  run(["remove-agent", "--project", project, "--role", "static-analyzer"]);
  assert.ok(!fs.existsSync(path.join(project, ".mawf", "agents", "static-analyzer.json")));
});

test("mawf run refuses to prepare real execution without a selected host", () => {
  // v1 `run` is real execution preparation (docs/V1_EXECUTION.md), not the
  // v0.8 batch-guidance renderer; batches stay in `mawf graph` below.
  const out = runJson(["run", "--project", project]);
  assert.equal(out.ok, false);
  assert.equal(out.reasonCode, "HOST_NOT_SELECTED");
  assert.match(out.alternative, /explicitly selected Claude host/);
  assert.match(out.alternative, /no mode switch was performed/);
});

test("mawf graph reports nodes/edges and batches", () => {
  const out = run(["graph", "--project", project]);
  const j = JSON.parse(out);
  assert.ok(j.nodes > 0);
  assert.ok(j.batches > 0);
});

test("mawf init creates .mawf + a cc-switch project only when profile-sync is selected and MAW_CC_PROJECT_SYNC=1 (never 默认)", () => {
  enableIn(project, "cc-switch.profile-sync", "cc-switch.routing");
  // The cc-switch project feature stays decoupled: selecting the integration is
  // not enough on its own; the MAW_CC_PROJECT_SYNC opt-in must also be set.
  const refused = runJson(["init", "--project", project, "-u", "alice", "--no-trellis"]);
  assert.equal(refused.ok, false);
  const gated = refused.stages.find((stage) => stage.integration === "cc-switch.profile-sync");
  assert.equal(gated.ok, false);
  assert.equal(gated.disabled, true);
  assert.match(gated.error, /MAW_CC_PROJECT_SYNC=1/);
  const out = runJson(["init", "--project", project, "-u", "alice", "--no-trellis"], { env: { MAW_CC_PROJECT_SYNC: "1" } });
  assert.equal(out.project, project);
  assert.ok(fs.existsSync(path.join(project, ".mawf", "workspace.json")), "native workspace marker written");
  const sync = out.stages.find((stage) => stage.integration === "cc-switch.profile-sync");
  assert.ok(sync, "the selected cc-switch profile sync ran");
  assert.equal(sync.ok, true);
  assert.deepEqual([...sync.protectedDefaults].sort(), ["Claude Code 默认", "Codex 默认"]);
  assert.doesNotMatch(String(sync.name), /默认/, "the created project profile is never a 默认 profile");
  // trellis stays unselected, so no trellis stage runs at all
  assert.ok(!out.stages.some((stage) => stage.integration === "trellis"));
  // routing violation surfaced (fixture has claude OFF)
  const routing = out.stages.find((stage) => stage.integration === "cc-switch.routing");
  assert.equal(routing.compliant, false);
  assert.ok(routing.violations.some((violation) => violation.app === "claude"));
});

test("mawf init is DECOUPLED from cc-switch projects by default and reports the blocked price gate", () => {
  const proj4 = path.join(tmp, "proj-init-decoupled");
  fs.mkdirSync(proj4, { recursive: true });
  const out = runJson(["init", "--project", proj4, "-u", "bob", "--no-trellis"]);
  // decoupled: nothing cc-switch-shaped runs unless that integration is selected
  assert.ok(!out.stages.some((stage) => String(stage.integration).startsWith("cc-switch")));
  assert.ok(out.generated.warnings.some((warning) => /PRICE GATE/.test(warning)));
  // nothing touched trellis either
  assert.ok(!out.stages.some((stage) => stage.integration === "trellis"));
});

test("mawf routing reports violations; --fix applies the carve-out", () => {
  enableIn(project, "cc-switch.routing");
  const out = runJson(["routing"]);
  assert.equal(typeof out.compliant, "boolean");
  assert.ok(Array.isArray(out.violations));
  // fixture starts non-compliant (or was already fixed by the init test above)
  const fixed = runJson(["routing", "--fix"]);
  assert.equal(fixed.ok, true);
  assert.ok(fixed.applied.some((entry) => /claude: local routing ON/.test(entry)));
});

test("mawf models lists the selected dsh settings.yaml models", () => {
  const dshProject = path.join(tmp, "proj-dsh-models");
  fs.mkdirSync(dshProject, { recursive: true });
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
  // v1 drops `--app`: the host comes from the explicit selection.
  enableIn(dshProject, "host.dsh");
  const out = runJson(["models", "--project", dshProject], { env: { DSH_HOME: dshHome, PATH: path.join(tmp, "no-bin") } });
  assert.equal(out.host, "dsh");
  assert.equal(out.providerCount, 1);
  const dshModels = out.models.filter((model) => model.adapter === "dsh");
  assert.deepEqual(dshModels.map((model) => model.modelId).sort(), ["fixture-only-model", "glm-5.2"]);
  assert.ok(dshModels.every((model) => model.providerId === "fixture-gw"));
  // selection is not authentication or readiness evidence
  assert.ok(dshModels.every((model) => model.authenticated === "unknown" && model.ready === "unknown"));
});

test("mawf routing reports dsh as not cc-switch-managed", () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cli-dsh2-"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  enableIn(project, "cc-switch.routing");
  const out = runJson(["routing"], { env: { MAW_HOST: "dsh", DSH_HOME: dshHome } });
  assert.match(out.dsh, /^N\/A \(not cc-switch-managed/);
  assert.match(out.dsh, /\$DSH_HOME\/settings\.yaml/);
});

test("mawf help lists the optional commands and the explicit-selection rule", () => {
  // v1 help is a command index; the per-host routing semantics moved into the
  // routing report itself (asserted by the dsh/pi routing tests above/below).
  const out = run(["help"]);
  assert.match(out, /^Optional: .*\brouting\b/m);
  assert.match(out, /Enable integrations explicitly; no automatic upstream download/);
});


test("mawf --version flag prints the version (not help)", () => {
  const out = run(["--version"]);
  assert.match(out, /^mawf \d+/);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("long boolean flags do not consume following short flags", () => {
  const shortOrderProject = path.join(tmp, "proj-short-order");
  fs.mkdirSync(shortOrderProject, { recursive: true });
  let output = "";
  try {
    output = run(["init", "--no-trellis", "-u", "short-order", "--project", shortOrderProject]);
  } catch (error) {
    output = String(error.stdout || "") + String(error.stderr || "");
    assert.notEqual(error.status, 1, output);
    throw error;
  }
  // --no-trellis did not swallow -u, so --project still reached the parser
  const report = JSON.parse(output);
  assert.equal(report.project, shortOrderProject);
  assert.ok(fs.existsSync(path.join(shortOrderProject, ".mawf", "workspace.json")));
  assert.ok(!report.stages.some((stage) => stage.integration === "trellis"));
});

test("mawf routing reports pi as not cc-switch-managed and claims nothing for dsh", () => {
  fs.mkdirSync(path.join(tmp, ".pi", "agent"), { recursive: true });
  enableIn(project, "cc-switch.routing");
  const out = runJson(["routing"], { env: { MAW_HOST: "pi", CC_SWITCH_DB: path.join(tmp, "missing-pi-routing.db") } });
  assert.match(out.pi, /^N\/A \(not cc-switch-managed/);
  assert.match(out.pi, /~\/\.pi\/agent/);
  // the report is host-independent in v1, but dsh is never claimed as managed
  assert.match(out.dsh, /^N\/A \(not cc-switch-managed/);
});
