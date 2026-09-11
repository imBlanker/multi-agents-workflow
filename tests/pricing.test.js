import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrice, projectRate } from "../src/pricing.js";

const ccPricing = {
  "claude-opus-5": { model_id: "claude-opus-5", display_name: "Claude Opus 5", input_per_m: 5, output_per_m: 25, cache_read_per_m: 0.5, cache_creation_per_m: 6.25, source: "cc-switch" },
};

test("resolvePrice uses cc-switch exact price", () => {
  const p = resolvePrice("claude-opus-5", { modelPricing: ccPricing });
  assert.ok(p);
  assert.equal(p.input_per_m, 5);
  assert.equal(p.output_per_m, 25);
  assert.equal(p.source, "cc-switch");
  assert.equal(p.estimated, false);
});

test("resolvePrice applies provider cost multiplier", () => {
  const p = resolvePrice("claude-opus-5", { modelPricing: ccPricing, costMultiplier: 2 });
  assert.equal(p.input_per_m, 10);
  assert.equal(p.output_per_m, 50);
  assert.equal(p.source, "cc-switch:multiplier");
});

test("resolvePrice falls back to estimate and tags it", () => {
  const p = resolvePrice("gpt-5.2-codex", { modelPricing: ccPricing });
  assert.ok(p);
  assert.equal(p.source, "fallback:estimate");
  assert.equal(p.estimated, true);
});

test("resolvePrice returns null for truly unknown models (never faked)", () => {
  const p = resolvePrice("some-unreleased-model-xyz", { modelPricing: ccPricing });
  assert.equal(p, null);
});

test("projectRate computes a per-min projection", () => {
  const p = resolvePrice("claude-opus-5", { modelPricing: ccPricing });
  const r = projectRate(p, { inputTokensPerMin: 1_000_000, outputTokensPerMin: 100_000 });
  // 5/M * 1M + 25/M * 100k = 5 + 2.5 = 7.5
  assert.equal(r.ratePerMin, 7.5);
  assert.equal(r.estimated, false);
});
