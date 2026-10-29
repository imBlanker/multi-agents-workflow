import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPriceGate, priceGateReport, PRICE_GATE_THRESHOLDS } from "../src/pricegate.js";

// v1 keeps the mandated expensive-price gate unchanged, but the gate is now one
// clause of an identity-bound policy (docs/V1_PRICING.md "Unknown price/
// provider/billing defaults to pause"; commit b7bf698). A selection with no
// provider identity therefore pauses on UNKNOWN_PROVIDER before price is even
// considered, so every price-threshold case must name its provider.
const PROVIDER = "anthropic";
const gate = (model, price) => checkPriceGate(model, price, { providerId: PROVIDER });

test("thresholds are the mandated policy ($2/1M in, $10/1M out)", () => {
  assert.equal(PRICE_GATE_THRESHOLDS.inputPerM, 2);
  assert.equal(PRICE_GATE_THRESHOLDS.outputPerM, 10);
});

test("expensive input (> $2/1M) blocks", () => {
  const c = gate("claude-opus-5", { input_per_m: 5, output_per_m: 25, estimated: false, source: "cc-switch" });
  assert.equal(c.blocked, true);
  assert.equal(c.reasonCode, "EXPENSIVE_MODEL");
  assert.equal(c.expensive, true);
});

test("expensive output (> $10/1M) blocks even when input is cheap", () => {
  const c = gate("gpt-5.2-codex", { input_per_m: 1.75, output_per_m: 14 });
  assert.equal(c.blocked, true);
  assert.equal(c.reasonCode, "EXPENSIVE_MODEL");
});

test("a selection without provider identity pauses before the price gate", () => {
  // the gate never becomes an authorization for an unidentified supplier
  const c = checkPriceGate("claude-opus-5", { input_per_m: 0.3, output_per_m: 0.9 });
  assert.equal(c.blocked, true);
  assert.equal(c.reasonCode, "UNKNOWN_PROVIDER");
});

test("exactly at threshold is NOT blocked (strictly greater than)", () => {
  assert.equal(gate("m-in-2", { input_per_m: 2, output_per_m: 1 }).blocked, false);
  assert.equal(gate("m-out-10", { input_per_m: 0.5, output_per_m: 10 }).blocked, false);
});

test("cheap model is not blocked", () => {
  const c = gate("deepseek-v4-flash", { input_per_m: 0.3, output_per_m: 0.9 });
  assert.equal(c.blocked, false);
  assert.equal(c.reasonCode, "ALLOWED");
  assert.equal(c.expensive, false);
  assert.match(c.reason, /within known price policy/i);
});

test("unknown price PAUSES (it is not provably cheap) and is flagged", () => {
  // v0.8 let an unknown price through because expensiveness could not be
  // proven. v1 inverts that default: docs/V1_PRICING.md "Unknown price/
  // provider/billing defaults to pause" (and the brief's "unknown prices pause
  // instead of becoming 0"). Only an explicit bounded policy may admit it.
  const c = gate("mystery-model", null);
  assert.equal(c.blocked, true);
  assert.equal(c.reasonCode, "UNKNOWN_PRICE");
  assert.equal(c.priceKnown, false);
  assert.equal(c.expensive, false, "an unknown price is still never called expensive");
  assert.match(c.reason, /price unknown/i);
});

test("report lists roles, models, prices and remediation steps", () => {
  const c = gate("claude-opus-5", { input_per_m: 5, output_per_m: 25, estimated: true, source: "fallback:estimate" });
  const rep = priceGateReport([{ role: "orchestrator", model: "claude-opus-5", provider: "Claude Official", check: c }]);
  assert.match(rep, /PRICE GATE/);
  assert.match(rep, /orchestrator/);
  assert.match(rep, /claude-opus-5/);
  assert.match(rep, /Claude Official/);
  assert.match(rep, /input > \$2\/1M/);
  assert.match(rep, /output > \$10\/1M/);
  // v1 remediation: an identity-bound approval replaces the v0.8 per-role
  // `approve-model --role <role> --yes` and the `--allow-pricey` single-run
  // override (docs/V1_PRICING.md: "Changing provider/model/role/billing/price
  // invalidates matching. The old same-role `approved:true` is not authority").
  assert.match(rep, /approve-model --role ROLE --provider PROVIDER --model MODEL --billing api --yes/);
  assert.match(rep, /expensive-price approval never overrides unknown pricing/);
  // the estimated/source basis is still carried by the gate result itself
  assert.equal(c.estimated, true);
  assert.equal(c.source, "fallback:estimate");
});
