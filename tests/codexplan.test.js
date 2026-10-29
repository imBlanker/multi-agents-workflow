import { fileURLToPath } from "node:url";
import { fixtureEnv } from "./fixtures/test-env.mjs";
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
import { defaultSettings } from "../src/settings.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-codexplan-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "a.js"), "console.log(1)\n");
const dbPath = path.join(tmp, "cc-switch.db");
makeFixtureDb(dbPath, { withLogs: true });

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mawf.js");

/** @param {string[]} args @param {object} [opts] */
function run(args, opts = {}) {
  const { env: envOver, ...rest } = opts;
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: project,
    encoding: "utf8",
    env: fixtureEnv(tmp, { CC_SWITCH_DB: dbPath, DSH_HOME: path.join(tmp, "no-dsh"), MAW_WATCHDOG_REGISTRY: path.join(tmp, "projects.json"), ...(envOver ?? {}) }),
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

test("checkPriceGate: a ChatGPT plan login does NOT exempt an expensive model", () => {
  // v0.8 treated `coveredByPlan` as a flat-rate exemption. v1 removed that
  // route: docs/V1_PRICING.md "A subscription or local-free label is not proof
  // of billing coverage. No current adapter in this slice supplies a verified
  // live payment/subscription/quota observation, so those claims are not
  // exempted." `covered` now needs a current adapter payment observation
  // (src/cost-policy.js subscriptionCovered via isCurrentPaymentTelemetry).
  const price = { input_per_m: 5, output_per_m: 30, source: "cc-switch" };
  const c = checkPriceGate("gpt-5.6-sol", price, { coveredByPlan: "prolite", providerId: "openai" });
  assert.equal(c.blocked, true, "a plan label can never silently bypass the gate");
  assert.equal(c.covered, false);
  assert.equal(c.plan, null);
  assert.equal(c.reasonCode, "EXPENSIVE_MODEL");

  // declaring the billing mode as a subscription does not help either: a
  // self-stamped record is not a current adapter observation
  const declared = checkPriceGate("gpt-5.6-sol", price, {
    providerId: "openai", billingMode: "subscription",
    subscription: { verified: true, sourceId: "codex-login", reference: "prolite", providerId: "openai", modelId: "gpt-5.6-sol", validUntil: new Date(Date.now() + 864e5).toISOString(), quota: { remaining: 100 } },
  });
  assert.equal(declared.blocked, true);
  assert.equal(declared.covered, false);
  assert.equal(declared.reasonCode, "SUBSCRIPTION_UNVERIFIED");
  assert.equal(declared.quota, "unknown");

  // and without any provider identity the gate pauses even earlier
  assert.equal(checkPriceGate("gpt-5.6-sol", price).blocked, true);
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

test("planner: reviewer on codex with a Pro-Lite login → gpt-5.6-sol @ low, selected but still gated", () => {
  const p = planWorkflow(signals, { host, ccSwitch: cc, codexPlan: readCodexPlan({ codexDir: writeCodexAuth(path.join(tmp, "codex-plan-yes"), "prolite") }) });
  const rev = p.agents.find((a) => a.role === "reviewer");
  assert.ok(rev, "reviewer agent present (codex plugin installed)");
  // the login still drives model SELECTION (machine policy is unchanged)
  assert.equal(rev.model, "gpt-5.6-sol");
  assert.equal(rev.modelReasoningEffort, "low");
  assert.ok(rev.modelChoice.reasons.some((r) => /machine policy/.test(r)));
  // but v1 no longer turns the login into a price-gate exemption, so the
  // expensive selection pauses and is reported to the human
  assert.equal(rev.priceGateBlocked, true);
  assert.equal(rev.modelChoice.priceGate.blocked, true);
  assert.equal(rev.modelChoice.priceGate.covered, false);
  assert.ok((p.priceGate.blockedRoles ?? []).some((b) => b.role === "reviewer"));
  // the plan must not claim coverage it cannot prove
  assert.ok(!rev.modelChoice.reasons.some((r) => /subscription-covered/.test(r)));
  assert.ok(rev.modelChoice.reasons.some((r) => /not proof of payment coverage/.test(r)));
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
// v1 split the v0.8 `models --app A --role R` human line (which rendered the
// role's selection AND its gate verdict, with a "price gate exempt" note for a
// pro login) into two structured commands: `models --json` exposes identifiers
// and configuration status only, and `pricing gate --role R` returns the
// verdict (docs/V1_PRICING.md "`models --json` exposes only model/provider
// identifiers, adapter, billing mode, configuration status and capability
// evidence ... they do not prove the actual backend, authentication,
// subscription coverage or an actual executed model", plus the documented
// `mawf pricing gate --project P --provider A --model M --role implementer
// --billing api --json` invocation).

/**
 * Run a CLI command that may legitimately exit nonzero and return its parsed
 * stdout frame plus the exit code. v1 exits nonzero on a denial
 * (docs/V1_RUNTIME.md "Admission denials exit nonzero").
 */
function runJson(args, opts = {}) {
  try {
    return { code: 0, frame: JSON.parse(run(args, opts)) };
  } catch (error) {
    if (typeof error.stdout !== "string" || !error.stdout.trim()) throw error;
    return { code: error.status, frame: JSON.parse(error.stdout) };
  }
}

/** A project whose settings declare an exact price for one provider/model. */
function pricedProject(name, overrides) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, ".mawf"), { recursive: true });
  const settings = defaultSettings();
  settings.pricing.overrides = overrides;
  fs.writeFileSync(path.join(dir, ".mawf", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  return dir;
}

test("mawf models reports identifiers only and never claims authentication", () => {
  const out = JSON.parse(run(["models", "--json"], { env: { CODEX_HOME: writeCodexAuth(path.join(tmp, "codex-cli-yes"), "prolite") } }));
  assert.equal(out.ok, true);
  // nothing is inferred from an unselected host: a Pro-Lite codex login on
  // this machine is not a model list and not an authentication result
  assert.deepEqual(out.models, []);
  assert.equal(out.providerCount, 0);
  assert.equal(out.host, "unknown");
  assert.equal(out.authenticated, "unknown");
});

test("mawf pricing gate pauses the reviewer's expensive model under a Pro-Lite login", () => {
  const dir = pricedProject("gate-prolite", { "openai/gpt-5.6-sol": { inputPerMillion: 5, outputPerMillion: 30 } });
  const { code, frame: out } = runJson(["pricing", "gate", "--project", dir, "--provider", "openai", "--model", "gpt-5.6-sol", "--role", "reviewer", "--billing", "api", "--json"], {
    cwd: dir, env: { CODEX_HOME: writeCodexAuth(path.join(tmp, "codex-cli-yes2"), "prolite") },
  });
  assert.notEqual(code, 0, "a paused selection exits nonzero");
  assert.equal(out.allowed, false);
  assert.equal(out.reasonCode, "EXPENSIVE_MODEL");
  assert.equal(out.covered, false, "a ChatGPT plan login is not payment coverage");
  assert.equal(out.identity.role, "reviewer");
  assert.equal(out.identity.providerId, "openai");
  assert.equal(out.thresholdIn, 2);
  assert.equal(out.thresholdOut, 10);
});

test("mawf pricing gate allows the reviewer's normal cheap selection", () => {
  const dir = pricedProject("gate-plus", { "openai/gpt-5.2-codex": { inputPerMillion: 1.75, outputPerMillion: 9 } });
  const out = JSON.parse(run(["pricing", "gate", "--project", dir, "--provider", "openai", "--model", "gpt-5.2-codex", "--role", "reviewer", "--billing", "api", "--json"], {
    cwd: dir, env: { CODEX_HOME: writeCodexAuth(path.join(tmp, "codex-cli-plus"), "plus") },
  }));
  assert.equal(out.allowed, true);
  assert.equal(out.reasonCode, "ALLOWED");
  assert.equal(out.priceKnown, true);
  // and the mandated thresholds still bite one cent over the output limit
  const over = pricedProject("gate-over", { "openai/gpt-5.2-codex": { inputPerMillion: 1.75, outputPerMillion: 10.01 } });
  const blocked = runJson(["pricing", "gate", "--project", over, "--provider", "openai", "--model", "gpt-5.2-codex", "--role", "reviewer", "--billing", "api", "--json"], { cwd: over });
  assert.notEqual(blocked.code, 0);
  assert.equal(blocked.frame.allowed, false);
  assert.equal(blocked.frame.reasonCode, "EXPENSIVE_MODEL");
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
