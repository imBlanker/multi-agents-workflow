import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { makeFixtureDb } from "./fixtures/make-db.mjs";
import { readCodexPlan, reviewerPlanOverride, PLAN_REVIEWER_DEFAULTS, PRO_COVERED_PLANS } from "../src/codexplan.js";
import { checkPriceGate } from "../src/pricegate.js";
import { planWorkflow } from "../src/planner.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-codexplan-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "a.js"), "console.log(1)\n");
const dbPath = path.join(tmp, "cc-switch.db");
makeFixtureDb(dbPath, { withLogs: true });

const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "mawf.js");

/** @param {string[]} args @param {object} [opts] */
function run(args, opts = {}) {
  const { env: envOver, ...rest } = opts;
  return execFileSync("node", [BIN, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CC_SWITCH_DB: dbPath, HOME: os.homedir(), DSH_HOME: path.join(tmp, "no-dsh"), MAW_WATCHDOG_REGISTRY: path.join(tmp, "projects.json"), ...(envOver ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
    ...rest,
  });
}

/** Craft a codex auth.json. planType null => api-key mode (no chatgpt login). */
function writeCodexAuth(dir, planType, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ns = { "https://api.openai.com/auth": { ...(planType ? { chatgpt_plan_type: planType } : {}), ...(opts.subUntil ? { chatgpt_subscription_active_until: opts.subUntil } : {}) } };
  const idToken = `x.${Buffer.from(JSON.stringify({ ...ns, iss: "https://auth.openai.com" })).toString("base64url")}.y`;
  const chatgpt = planType != null || opts.chatgpt === true;
  const auth = {
    ...(chatgpt ? { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: "a", refresh_token: "r", account_id: "acc-1" } } : { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    last_refresh: "2026-08-20T00:00:00Z",
  };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
}

// --- readCodexPlan ---

test("readCodexPlan detects a Pro-Lite chatgpt login (subscription-covered)", () => {
  const dir = writeCodexAuth(path.join(tmp, "codex-prolite"), "prolite");
  const p = readCodexPlan({ codexDir: dir });
  assert.equal(p.available, true);
  assert.equal(p.chatgptLogin, true);
  assert.equal(p.planType, "prolite");
  assert.equal(p.planLabel, "Pro-Lite");
  assert.equal(p.proCovered, true);
});

test("readCodexPlan detects a Pro chatgpt login; normalizes pro-lite/pro_lite spellings", () => {
  assert.equal(readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-pro"), "pro") }).proCovered, true);
  assert.equal(readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-prosp"), "pro lite") }).proCovered, true);
  assert.equal(readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-prou"), "pro_lite") }).proCovered, true);
});

test("readCodexPlan: plus/team/free chatgpt logins and api-key logins are NOT covered", () => {
  for (const t of ["plus", "team", "free", "business"]) {
    const p = readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, `codex-${t}`), t) });
    assert.equal(p.chatgptLogin, true, t);
    assert.equal(p.proCovered, false, t);
    assert.equal(reviewerPlanOverride(p), null, t);
  }
  const api = readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-apikey"), null) });
  assert.equal(api.chatgptLogin, false);
  assert.equal(api.proCovered, false);
});

test("readCodexPlan degrades gracefully on missing/unreadable auth.json", () => {
  const p = readCodexPlan({ codexDir: path.join(tmp, "codex-missing") });
  assert.equal(p.available, false);
  assert.equal(p.proCovered, false);
  fs.mkdirSync(path.join(tmp, "codex-broken"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "codex-broken", "auth.json"), "{not json");
  const b = readCodexPlan({ codexDir: path.join(tmp, "codex-broken") });
  assert.equal(b.available, false);
  assert.equal(b.proCovered, false);
});

test("machine default policy constants are frozen and as mandated", () => {
  assert.equal(PLAN_REVIEWER_DEFAULTS.model, "gpt-5.6-sol");
  assert.equal(PLAN_REVIEWER_DEFAULTS.reasoningEffort, "low");
  assert.deepEqual([...PRO_COVERED_PLANS], ["pro", "prolite"]);
});

// --- price gate: subscription coverage ---

test("checkPriceGate: a covered expensive model is NOT blocked, is reported as covered", () => {
  const c = checkPriceGate("gpt-5.6-sol", { input_per_m: 5, output_per_m: 30, source: "cc-switch" }, { coveredByPlan: "prolite" });
  assert.equal(c.blocked, false);
  assert.equal(c.covered, true);
  assert.equal(c.plan, "prolite");
  assert.match(c.reason, /subscription-covered/);
  assert.match(c.reason, /prolite/);
  // without coverage the same price must still block (no silent bypass)
  assert.equal(checkPriceGate("gpt-5.6-sol", { input_per_m: 5, output_per_m: 30 }).blocked, true);
});

// --- planner integration ---

const host = { app: "claude-code", hasSubagents: true, hasMultiAgent: true, hasDynamicWorkflow: true, codexPluginInstalled: true, codexBinary: "/x/codex" };
const cc = {
  allProviders: [{ id: "p2", app_type: "codex", name: "Test Codex", settings_config: { model: "gpt-5.2-codex" }, is_current: true, cost_multiplier: 1 }],
  currentProviders: {
    claude: { name: "Test Claude", cost_multiplier: 1, settings_config: { env: { ANTHROPIC_MODEL: "claude-sonnet-5" } } },
    codex: { name: "Test Codex", cost_multiplier: 1, settings_config: { model: "gpt-5.2-codex" } },
  },
  modelPricing: {
    "claude-sonnet-5": { input_per_m: 3, output_per_m: 15 },
    "gpt-5.2-codex": { input_per_m: 1.75, output_per_m: 14 },
    "gpt-5.6-sol": { input_per_m: 5, output_per_m: 30 },
  },
};
const signals = { files: 60, parallelizableSubtasks: 6, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "research" };

test("planner: reviewer on codex with a Pro-Lite login → gpt-5.6-sol @ low, covered, NOT blocked", () => {
  const p = planWorkflow(signals, { host, ccSwitch: cc, codexPlan: readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-plan-yes"), "prolite") }) });
  const rev = p.agents.find((a) => a.role === "reviewer");
  assert.ok(rev, "reviewer agent present (codex plugin installed)");
  assert.equal(rev.model, "gpt-5.6-sol");
  assert.equal(rev.modelReasoningEffort, "low");
  assert.equal(rev.priceGateBlocked, undefined);
  assert.equal(rev.modelChoice.priceGate.blocked, false);
  assert.equal(rev.modelChoice.priceGate.covered, true);
  assert.match(rev.modelChoice.priceGate.reason, /subscription-covered/);
  assert.ok(rev.modelChoice.reasons.some((r) => /machine policy/.test(r)));
  // reviewer must NOT appear in the plan's blocked roles
  assert.ok(!(p.priceGate.blockedRoles ?? []).some((b) => b.role === "reviewer"));
});

test("planner: no codexPlan (or non-pro plan) → normal selection + gate still applies to reviewer", () => {
  for (const codexPlan of [null, readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-plan-plus"), "plus") })]) {
    const p = planWorkflow(signals, { host, ccSwitch: cc, codexPlan });
    const rev = p.agents.find((a) => a.role === "reviewer");
    assert.equal(rev.model, "gpt-5.2-codex", "fixture codex provider model");
    assert.equal(rev.modelReasoningEffort, undefined);
    // $1.75/$14: output over $10 → blocked exactly as before this feature
    assert.equal(rev.modelChoice.priceGate.blocked, true);
    assert.ok((p.priceGate.blockedRoles ?? []).some((b) => b.role === "reviewer"));
  }
});

// --- CLI ---

test("mawf models --app codex --role reviewer shows the machine default under a Pro-Lite login", () => {
  const out = run(["models", "--app", "codex", "--role", "reviewer"], { env: { CODEX_HOME: writeCodexAuth(path.join(tmp, "codex-cli-yes"), "prolite") } });
  assert.match(out, /reviewer → ChatGPT Pro-Lite login \(local codex\) \/ gpt-5\.6-sol/);
  assert.match(out, /machine default, reasoning low/);
  assert.match(out, /subscription-covered — price gate exempt/);
});

test("mawf models --app codex --role reviewer keeps normal selection (with gate) without a pro plan", () => {
  const out = run(["models", "--app", "codex", "--role", "reviewer"], { env: { CODEX_HOME: writeCodexAuth(path.join(tmp, "codex-cli-plus"), "plus") } });
  assert.match(out, /reviewer → Test Codex \/ gpt-5\.2-codex/);
  assert.match(out, /PRICE GATE/);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
