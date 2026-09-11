import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPriceGate, priceGateReport, PRICE_GATE_THRESHOLDS } from "../src/pricegate.js";

test("thresholds are the mandated policy ($2/1M in, $10/1M out)", () => {
  assert.equal(PRICE_GATE_THRESHOLDS.inputPerM, 2);
  assert.equal(PRICE_GATE_THRESHOLDS.outputPerM, 10);
});

test("expensive input (> $2/1M) blocks", () => {
  const c = checkPriceGate("claude-opus-5", { input_per_m: 5, output_per_m: 25, estimated: false, source: "cc-switch" });
  assert.equal(c.blocked, true);
  assert.match(c.reason, /EXPENSIVE/i);
});

test("expensive output (> $10/1M) blocks even when input is cheap", () => {
  const c = checkPriceGate("gpt-5.2-codex", { input_per_m: 1.75, output_per_m: 14 });
  assert.equal(c.blocked, true);
});

test("exactly at threshold is NOT blocked (strictly greater than)", () => {
  assert.equal(checkPriceGate("m-in-2", { input_per_m: 2, output_per_m: 1 }).blocked, false);
  assert.equal(checkPriceGate("m-out-10", { input_per_m: 0.5, output_per_m: 10 }).blocked, false);
});

test("cheap model is not blocked", () => {
  const c = checkPriceGate("deepseek-v4-flash", { input_per_m: 0.3, output_per_m: 0.9 });
  assert.equal(c.blocked, false);
  assert.match(c.reason, /within price gate/i);
});

test("unknown price is never blocked (cannot prove expensiveness) and is flagged", () => {
  const c = checkPriceGate("mystery-model", null);
  assert.equal(c.blocked, false);
  assert.equal(c.priceKnown, false);
  assert.match(c.reason, /price unknown/i);
});

test("report lists roles, models, prices and remediation steps", () => {
  const c = checkPriceGate("claude-opus-5", { input_per_m: 5, output_per_m: 25, estimated: true, source: "fallback:estimate" });
  const rep = priceGateReport([{ role: "orchestrator", model: "claude-opus-5", provider: "Claude Official", check: c }]);
  assert.match(rep, /PRICE GATE/);
  assert.match(rep, /orchestrator/);
  assert.match(rep, /claude-opus-5/);
  assert.match(rep, /Claude Official/);
  assert.match(rep, /approve-model --role <role> --yes/);
  assert.match(rep, /--allow-pricey/);
  assert.match(rep, /estimated price/);
});
