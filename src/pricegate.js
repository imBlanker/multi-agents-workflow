// @ts-check
// Model price gate (HITL): whenever MAW is about to assign a model whose unit
// price is HIGH (Input price > $2/1M Tokens OR Output price > $10/1M Tokens),
// the work is PAUSED and reported to a human first. A human must either pick a
// cheaper model or explicitly approve the assignment (`mawf approve-model`)
// before guard/acquire let the role run.
//
// Policy (user-mandated 2026-08-12): thresholds are hard constants below —
// single source of truth for every enforcement point (planner / configgen /
// CLI / guard / acquire).
export const PRICE_GATE_THRESHOLDS = Object.freeze({
  inputPerM: 2,   // $ per 1M input tokens — blocked when input > 2
  outputPerM: 10, // $ per 1M output tokens — blocked when output > 10
});

/**
 * Check a resolved price against the gate.
 * @param {string} model model id
 * @param {{ input_per_m?: number, output_per_m?: number, estimated?: boolean, source?: string } | null} price resolved price (null = unknown)
 * @param {{ coveredByPlan?: string }} [opts] `coveredByPlan`: a ChatGPT plan id (e.g. "prolite")
 *   that makes this assignment flat-rate subscription-covered — codex usage on a
 *   Pro/Pro-Lite ChatGPT login is NOT billed per token, so there is no per-token
 *   spend for the gate to pause. Still reported (never silent): `covered:true` +
 *   an explicit reason naming the plan.
 * @returns {{ model: string, blocked: boolean, covered: boolean, plan: string|null, priceKnown: boolean, inputPerM: number|null, outputPerM: number|null,
 *   thresholdIn: number, thresholdOut: number, estimated: boolean, source: string|null,
 *   reason: string }}
 */
export function checkPriceGate(model, price, opts = {}) {
  const t = PRICE_GATE_THRESHOLDS;
  const inP = price && Number.isFinite(Number(price.input_per_m)) ? Number(price.input_per_m) : null;
  const outP = price && Number.isFinite(Number(price.output_per_m)) ? Number(price.output_per_m) : null;
  const priceKnown = inP != null || outP != null;
  const covered = !!opts.coveredByPlan;
  const blocked = !covered && priceKnown && ((inP != null && inP > t.inputPerM) || (outP != null && outP > t.outputPerM));
  const parts = [];
  if (inP != null) parts.push(`input $${inP}/1M (threshold $${t.inputPerM})`);
  if (outP != null) parts.push(`output $${outP}/1M (threshold $${t.outputPerM})`);
  const reason = covered
    ? `subscription-covered by ChatGPT plan "${opts.coveredByPlan}" (local codex login; flat rate — no per-token spend to gate)${priceKnown ? `; listed price ${parts.join(", ")} is NOT billed for codex usage` : ""}`
    : !priceKnown
      ? `price unknown — not blocked by the price gate (verify on Artificial Analysis/OpenRouter)`
      : blocked
        ? `EXPENSIVE model: ${parts.join(", ")} exceeds the gate (blocked until a human approves or a cheaper model is configured)`
        : `within price gate (${parts.join(", ")})`;
  return {
    model: String(model || ""),
    blocked,
    covered,
    plan: covered ? String(opts.coveredByPlan) : null,
    priceKnown,
    inputPerM: inP,
    outputPerM: outP,
    thresholdIn: t.inputPerM,
    thresholdOut: t.outputPerM,
    estimated: !!price?.estimated,
    source: price?.source ?? null,
    reason,
  };
}

/**
 * Render the human report for one or more blocked assignments. This is the
 * "pause and report to a human first" surface.
 * @param {{ role: string, model: string, provider?: string|null, check: ReturnType<typeof checkPriceGate> }[]} blocks
 * @returns {string}
 */
export function priceGateReport(blocks) {
  const lines = [];
  lines.push(`⚠ PRICE GATE — ${blocks.length} model assignment(s) are expensive and PAUSED for human review`);
  lines.push(`  thresholds: Input > $${PRICE_GATE_THRESHOLDS.inputPerM}/1M Tokens OR Output > $${PRICE_GATE_THRESHOLDS.outputPerM}/1M Tokens`);
  for (const b of blocks) {
    lines.push(`  - role "${b.role}" → ${b.provider ? `${b.provider} / ` : ""}\`${b.model}\``);
    lines.push(`      ${b.check.reason}${b.check.estimated ? " (estimated price)" : ""}${b.check.source ? ` [source: ${b.check.source}]` : ""}`);
  }
  lines.push(`  to continue: (a) edit .mawf/agents/<role>.json and set a cheaper model, then re-run \`mawf plan\`;`);
  lines.push(`                (b) explicitly approve: \`mawf approve-model --role <role> --yes\`;`);
  lines.push(`                (c) override for one run: re-run with \`--allow-pricey\`.`);
  return lines.join("\n");
}
