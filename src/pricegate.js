import { evaluateSelection, PRICE_GATE_THRESHOLDS } from './cost-policy.js';
export { PRICE_GATE_THRESHOLDS } from './cost-policy.js';
export function checkPriceGate(model, price, opts = {}) {
  const decision = evaluateSelection({ ...opts, modelId: model, price, billingMode: opts.billingMode ?? 'api' }, opts.settings ?? {});
  return { ...decision, model: String(model || ''), blocked: !decision.allowed, plan: decision.covered ? opts.subscription?.sourceId : null,
    estimated: price?.estimated ?? true, source: price?.sourceId ?? price?.source ?? null };
}
export function priceGateReport(blocks) {
  return ['PRICE GATE — execution paused for the following assignments',
    `Thresholds: input > $${PRICE_GATE_THRESHOLDS.inputPerM}/1M; output > $${PRICE_GATE_THRESHOLDS.outputPerM}/1M`,
    ...blocks.flatMap(block => [`- ${block.role}: ${block.provider || ''} / ${block.model}`, `  ${block.check.reason}`]),
    'Approve an exact known-price selection with mawf approve-model --role ROLE --provider PROVIDER --model MODEL --billing api --yes.',
    'Unknown pricing needs a valid source or explicit bounded policy; expensive-price approval never overrides unknown pricing.'].join('\n');
}
