import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrice, projectRate } from "../src/pricing.js";

// v1 is provider-aware: a record whose providerId does not match the requested
// provider (or is null) is an estimate whose supplier applicability is
// unverified — docs/V1_PRICING.md "Generic upstream seeds/bundled estimates
// have providerId=null and disclose unverified supplier applicability; they
// never become verified supplier prices" (commit b7bf698).
const PROVIDER = "anthropic";
const ccPricing = {
  "claude-opus-5": { model_id: "claude-opus-5", providerId: PROVIDER, display_name: "Claude Opus 5", input_per_m: 5, output_per_m: 25, cache_read_per_m: 0.5, cache_creation_per_m: 6.25, source: "cc-switch" },
};

test("resolvePrice uses cc-switch exact price", () => {
  const p = resolvePrice("claude-opus-5", { providerId: PROVIDER, modelPricing: ccPricing });
  assert.ok(p);
  assert.equal(p.input_per_m, 5);
  assert.equal(p.output_per_m, 25);
  assert.equal(p.source, "cc-switch");
  assert.equal(p.estimated, false);
  assert.equal(p.providerId, PROVIDER);
});

test("resolvePrice marks a provider-less record as an unverified estimate", () => {
  const generic = { "claude-opus-5": { model_id: "claude-opus-5", input_per_m: 5, output_per_m: 25, source: "cc-switch" } };
  const p = resolvePrice("claude-opus-5", { providerId: PROVIDER, modelPricing: generic });
  assert.equal(p.input_per_m, 5);
  assert.equal(p.estimated, true, "a seed without provider identity never becomes a verified supplier price");
  assert.ok(p.notes.some((n) => /applicability is unverified/i.test(n)));
});

test("resolvePrice applies provider cost multiplier", () => {
  const p = resolvePrice("claude-opus-5", { providerId: PROVIDER, modelPricing: ccPricing, costMultiplier: 2 });
  assert.equal(p.input_per_m, 10);
  assert.equal(p.output_per_m, 50);
  // v1 keeps the source identity stable and discloses the multiplier
  // separately, applied exactly once (docs/V1_PRICING.md "Cost multipliers are
  // applied once; a conflicting pre-multiplied record is rejected").
  assert.equal(p.source, "cc-switch");
  assert.equal(p.multiplier, 2);
});

test("resolvePrice falls back to the bundled offline estimate and tags it", () => {
  const p = resolvePrice("gpt-5.2-codex", { providerId: "openai", modelPricing: ccPricing });
  assert.ok(p);
  // v1 names the actual source of the fallback instead of a generic label
  assert.equal(p.source, "builtin-offline");
  assert.equal(p.estimated, true);
  assert.equal(p.providerId, null);
});

test("resolvePrice returns null for truly unknown models (never faked)", () => {
  const p = resolvePrice("some-unreleased-model-xyz", { providerId: PROVIDER, modelPricing: ccPricing });
  assert.equal(p, null);
});

test("projectRate computes a per-min projection", () => {
  const p = resolvePrice("claude-opus-5", { providerId: PROVIDER, modelPricing: ccPricing });
  const r = projectRate(p, { inputTokensPerMin: 1_000_000, outputTokensPerMin: 100_000 });
  // 5/M * 1M + 25/M * 100k = 5 + 2.5 = 7.5
  assert.equal(r.ratePerMin, 7.5);
  // v1: token arithmetic is never measured payment, so a projection is always
  // flagged estimated (docs/V1_PRICING.md "Neither token arithmetic nor
  // projection is measured payment").
  assert.equal(r.estimated, true);
  assert.equal(r.basis, "estimated");
  assert.deepEqual(r.assumptions, ["Explicit fresh-input/output throughput; no cache traffic modeled"]);
});

test("projectRate makes no zero-cost assumption without throughput", () => {
  const p = resolvePrice("claude-opus-5", { providerId: PROVIDER, modelPricing: ccPricing });
  const r = projectRate(p, {});
  assert.equal(r.ratePerMin, null, "missing throughput stays unknown, it does not become 0");
  assert.equal(r.basis, "unknown");
});
