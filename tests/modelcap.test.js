import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModel, capabilityScore, selectModelForRole, candidatesForAppType, providerModels, baseRole, ROLE_REQUIREMENTS } from "../src/modelcap.js";

// --- classification: models differ WITHIN a leaderboard -------------------

test("classifyModel: claude-opus is agentic AND multimodal (vision input)", () => {
  const c = classifyModel("claude-opus-5");
  assert.equal(c.estimated, true);
  assert.equal(c.caps.agentic, true);
  assert.equal(c.caps.reasoning, true);
  assert.equal(c.caps.coding, true);
  assert.equal(c.caps.visionIn, true);
});

test("classifyModel: deepseek-r1 is agentic but text-only (no vision)", () => {
  const c = classifyModel("deepseek-r1");
  assert.equal(c.caps.agentic, true);
  assert.equal(c.caps.reasoning, true);
  assert.equal(c.caps.visionIn, false);
});

test("classifyModel: imagen is multimodal but NOT suited to agentic work", () => {
  const c = classifyModel("imagen-4");
  assert.equal(c.caps.imageOut, true);
  assert.equal(c.caps.agentic, false);
  assert.match(c.notes.join(" "), /NOT suited to agentic work/);
});

test("classifyModel: unknown model gets conservative unknown caps", () => {
  const c = classifyModel("mystery-9000-ultra");
  assert.equal(c.family, "unknown");
  assert.equal(c.caps.agentic, "unknown");
});

// --- capability scoring vs role requirements -------------------------------

test("capabilityScore: image-gen model is disqualified for an implementer role", () => {
  const img = classifyModel("imagen-4");
  assert.equal(capabilityScore(img.caps, ROLE_REQUIREMENTS.implementer), 0);
});

test("capabilityScore: full-multimodal agentic model scores 100 for orchestrator", () => {
  const opus = classifyModel("claude-opus-5");
  assert.equal(capabilityScore(opus.caps, ROLE_REQUIREMENTS.orchestrator), 100);
});

test("capabilityScore: text-only agentic model scores less for vision-preferring roles", () => {
  const r1 = classifyModel("deepseek-r1");
  const s = capabilityScore(r1.caps, ROLE_REQUIREMENTS.orchestrator);
  assert.ok(s > 0 && s < 100, `expected partial score, got ${s}`);
});

test("baseRole strips the -N suffix", () => {
  assert.equal(baseRole("implementer-2"), "implementer");
  assert.equal(baseRole("orchestrator"), "orchestrator");
});

// --- selection: capability fit → remaining quota → cost rate ---------------

const cc = {
  allProviders: [
    { id: "pv1", app_type: "claude", name: "VisionProv", is_current: 0, cost_multiplier: "1", settingsConfig: { env: { ANTHROPIC_MODEL: "claude-opus-5" } } },
    { id: "pv2", app_type: "claude", name: "TextProv", is_current: 1, cost_multiplier: "1", settingsConfig: { env: { ANTHROPIC_MODEL: "deepseek-r1" } } },
    { id: "pv3", app_type: "claude", name: "ImgProv", is_current: 0, cost_multiplier: "1", settingsConfig: { env: { ANTHROPIC_MODEL: "imagen-4" } } },
  ],
  modelPricing: {
    "claude-opus-5": { input_per_m: 5, output_per_m: 25, source: "cc-switch" },
    "deepseek-r1": { input_per_m: 1, output_per_m: 4, source: "cc-switch" },
    "imagen-4": { input_per_m: 0, output_per_m: 0, source: "cc-switch" },
  },
};
const quota = { providers: { pv1: { remainingTodayUsd: 3, ratePerMin: 0.01 }, pv2: { remainingTodayUsd: 50, ratePerMin: 0.02 } } };

test("candidatesForAppType enumerates every provider × model", () => {
  const cands = candidatesForAppType(cc, "claude");
  assert.equal(cands.length, 3);
  assert.deepEqual(cands.map((c) => c.model).sort(), ["claude-opus-5", "deepseek-r1", "imagen-4"]);
});

test("orchestrator picks the vision-capable multimodal model even with less quota", () => {
  const sel = selectModelForRole({ role: "orchestrator", appType: "claude", cc, quota });
  assert.ok(sel);
  assert.equal(sel.model, "claude-opus-5");
  assert.equal(sel.providerName, "VisionProv");
  assert.equal(sel.capabilityScore, 100);
  assert.equal(sel.estimated, true);
  assert.ok(sel.reasons.join(" ").includes("remaining quota"));
});

test("implementer selection EXCLUDES the image-generation model (not agentic)", () => {
  const sel = selectModelForRole({ role: "implementer", appType: "claude", cc, quota });
  assert.ok(sel);
  assert.equal(sel.considered, 2, "imagen-4 must be filtered out");
  assert.ok(["claude-opus-5", "deepseek-r1"].includes(sel.model));
  assert.notEqual(sel.model, "imagen-4");
});

test("when capability ties, larger remaining quota + lower cost wins", () => {
  const sel = selectModelForRole({ role: "implementer", appType: "claude", cc, quota });
  // both candidates fit 100; deepseek-r1 has more remaining quota (50 vs 3) and is cheaper
  assert.equal(sel.model, "deepseek-r1");
  assert.equal(sel.alternates[0].model, "claude-opus-5");
});

test("returns null when there are no candidates (caller falls back)", () => {
  assert.equal(selectModelForRole({ role: "orchestrator", appType: "codex", cc: {} }), null);
});

test("providerModels extracts claude env models incl. subagent/default variants", () => {
  const models = providerModels({ env: { ANTHROPIC_MODEL: "claude-opus-5", CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5" } }, "claude");
  assert.deepEqual(models, ["claude-opus-5", "claude-haiku-4-5"]);
});

test("providerModels parses the codex TOML config string (model = \"...\")", () => {
  const models = providerModels({ auth: { OPENAI_API_KEY: "sk-x" }, config: 'model_provider = "custom"\nmodel = "gpt-5.5"\n\n[model_providers]\n' }, "codex");
  assert.deepEqual(models, ["gpt-5.5"]);
});

test("providerModels extracts the pi provider model list via _piModels", () => {
  const models = providerModels({ model: "deepseek-v4-flash", _piModels: ["deepseek-v4-flash", "glm-5.2"] }, "pi");
  assert.deepEqual(models.sort(), ["deepseek-v4-flash", "glm-5.2"]);
});

test("classifyModel: deepseek vision variants are multimodal, generic deepseek-v stays text-only (pi 0.84.4 / dsh 0.1.1-rc.1)", () => {
  for (const id of ["deepseek-v4-flash-vision-exp", "DeepSeek-V4-Flash-Vision-Exp"]) {
    const c = classifyModel(id);
    assert.equal(c.family, "multimodal-generalist", id);
    assert.equal(c.caps.visionIn, true, id);
  }
  const t = classifyModel("deepseek-v4-pro-0813");
  assert.equal(t.family, "agentic-text-only");
  assert.equal(t.caps.visionIn, false);
});
