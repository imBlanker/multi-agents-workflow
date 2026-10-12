// Provider-aware pricing. Unknown values remain null; only explicit numbers
// are prices. Legacy snake_case aliases are views of the same resolved record.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { stateError } from './atomic-state.js';

export const PRICE_UNIT = 'USD/1M tokens';
export const priceNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const keys = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'];
const oldKeys = ['input_per_m', 'output_per_m', 'cache_read_per_m', 'cache_creation_per_m'];
let builtin;
function offline() {
  if (!builtin) {
    const raw = fs.readFileSync(new URL('../defaults/pricing.fallback.json', import.meta.url), 'utf8');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    builtin = Object.entries(JSON.parse(raw).models).map(([modelId, value]) => normalizePriceRecord({ ...value, modelId, providerId: null,
      sourceId: 'builtin-offline', sourceVersion: hash, sourceHash: hash, estimated: true,
      applicability: { providerScope: 'unverified', serviceMode: 'standard' }, notes: ['Bundled estimate; supplier billing applicability is unverified'] }));
  }
  return builtin;
}
export function normalizePriceRecord(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw stateError('INVALID_PRICE', 'Price record must be an object');
  const record = { ...defaults, ...raw };
  const modelId = record.modelId ?? record.model_id;
  if (typeof modelId !== 'string' || !modelId.trim()) throw stateError('INVALID_PRICE', 'Price modelId is required');
  if (record.providerId !== undefined && record.providerId !== null && typeof record.providerId !== 'string') throw stateError('INVALID_PRICE', 'providerId must be a string or null');
  if (record.currency && record.currency !== 'USD') throw stateError('UNSUPPORTED_CURRENCY', 'Only USD prices are supported');
  if (record.unit && record.unit !== PRICE_UNIT) throw stateError('UNSUPPORTED_PRICE_UNIT', `Expected ${PRICE_UNIT}`);
  const result = { sourceId: record.sourceId || record.source || 'unknown', sourceVersion: record.sourceVersion ?? record.sourceRef ?? null,
    sourceHash: record.sourceHash ?? null, retrievedAt: record.retrievedAt ?? null, currency: 'USD', unit: PRICE_UNIT,
    providerId: record.providerId ?? null, modelId, estimated: record.estimated !== false, stale: !!record.stale,
    applicability: record.applicability ?? { serviceMode: 'standard' }, notes: [...(record.notes ?? [])], multiplierApplied: record.multiplierApplied ?? 1 };
  for (let i = 0; i < keys.length; i++) {
    const value = record[keys[i]] !== undefined ? record[keys[i]] : record[oldKeys[i]];
    if (value !== undefined && value !== null && priceNumber(value) === null) throw stateError('INVALID_PRICE', `Invalid ${keys[i]} for ${modelId}`);
    result[keys[i]] = value === undefined || value === null ? null : value;
  }
  result.tiers = [];
  for (const tier of record.tiers ?? []) {
    const size = tier.contextTokens ?? tier.tier?.size;
    if ((tier.tier?.type && tier.tier.type !== 'context') || !Number.isSafeInteger(size) || size < 0 || result.tiers.some(item => item.contextTokens === size)) throw stateError('INVALID_PRICE_TIER', `Invalid or duplicate context tier for ${modelId}`);
    const values = normalizePriceRecord({ ...result, ...tier, tiers: [], modelId, inputPerMillion: tier.inputPerMillion ?? tier.input, outputPerMillion: tier.outputPerMillion ?? tier.output,
      cacheReadPerMillion: tier.cacheReadPerMillion ?? tier.cache_read ?? null, cacheWritePerMillion: tier.cacheWritePerMillion ?? tier.cache_write ?? null });
    result.tiers.push({ contextTokens: size, ...Object.fromEntries(keys.map(key => [key, values[key]])) });
  }
  result.tiers.sort((a, b) => a.contextTokens - b.contextTokens);
  return result;
}
function aliases(record) {
  return { ...record, model_id: record.modelId, source: record.sourceId, multiplier: record.multiplierApplied,
    ...Object.fromEntries(oldKeys.map((key, index) => [key, record[keys[index]]])) };
}
function applicable(record, providerId, serviceMode) {
  if ((record.applicability?.serviceMode ?? 'standard') !== serviceMode) return false;
  return record.providerId === providerId || record.providerId === null;
}
export function resolvePrice(modelId, ctx = {}) {
  if (!modelId) return null;
  const settings = ctx.settings ?? {};
  const providerId = ctx.providerId ?? null;
  const model = settings.pricing?.aliases?.[providerId ?? '']?.[modelId] ?? modelId;
  const serviceMode = ctx.serviceMode ?? 'standard';
  const multiplier = ctx.costMultiplier ?? 1;
  if (priceNumber(multiplier) === null) throw stateError('INVALID_MULTIPLIER', 'Cost multiplier must be a finite nonnegative number');
  const overrides = settings.pricing?.overrides ?? ctx.overrides ?? {};
  const override = overrides[`${providerId}/${model}`] ?? overrides[providerId]?.[model] ?? overrides[model];
  const choices = [];
  if (override && (override.providerId !== undefined && override.providerId !== providerId || override.modelId !== undefined && override.modelId !== model)) throw stateError('PRICE_IDENTITY_MISMATCH', 'Project override identity does not match its provider/model key');
  if (override) choices.push(normalizePriceRecord(override, { modelId: model, providerId, sourceId: 'project-override', sourceVersion: `project:${crypto.createHash('sha256').update(JSON.stringify(override)).digest('hex')}`, estimated: false }));
  const local = ctx.modelPricing?.[`${providerId}/${model}`] ?? ctx.modelPricing?.[model];
  if (local) choices.push(normalizePriceRecord(local, { modelId: model, providerId: null, sourceId: local.source || 'selected-local', estimated: !local.providerId }));
  for (const raw of ctx.priceRecords ?? []) if ((raw.modelId ?? raw.model_id) === model) choices.push(normalizePriceRecord(raw));
  choices.push(...offline().filter(record => record.modelId === model));
  let chosen = choices.find(record => record.modelId === model && applicable(record, providerId, serviceMode) && (record.sourceId === 'project-override' || record.inputPerMillion !== null && record.outputPerMillion !== null));
  if (!chosen) return null;
  chosen = structuredClone(chosen);
  if (chosen.applicability.tierThresholdUnknown && ctx.contextTokens > 200000) return null;
  chosen.requestedProviderId = providerId;
  if (chosen.providerId !== providerId || chosen.providerId === null) {
    chosen.estimated = true; chosen.notes.push('Provider-specific billing applicability is unverified; estimate only');
  }
  if (chosen.tiers.length) {
    if (!Number.isSafeInteger(ctx.contextTokens) || ctx.contextTokens < 0) { chosen.estimated = true; chosen.notes.push('Context size unavailable; base tier estimate'); }
    else for (const tier of chosen.tiers) if (ctx.contextTokens > tier.contextTokens) for (const key of keys) chosen[key] = tier[key];
  }
  if (chosen.multiplierApplied !== 1 && chosen.multiplierApplied !== multiplier) throw stateError('MULTIPLIER_CONFLICT', 'A differently multiplied price cannot be multiplied again');
  if (chosen.multiplierApplied === 1) {
    for (const key of keys) if (chosen[key] !== null) {
      chosen[key] *= multiplier;
      if (!Number.isFinite(chosen[key])) throw stateError("PRICE_OVERFLOW", "Resolved price exceeds the finite numeric range");
    }
    chosen.multiplierApplied = multiplier;
  }
  chosen.priceVersion = crypto.createHash('sha256').update(JSON.stringify([chosen.sourceId, chosen.sourceVersion, providerId, model, serviceMode, chosen.multiplierApplied, ...keys.map(key => chosen[key])])).digest('hex');
  return aliases(chosen);
}
export function estimateCost(price, tokens = {}) {
  if (!price) return { amountUsd: null, basis: 'unknown', complete: false, missing: ['price'] };
  const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite'];
  let amount = 0; const missing = [];
  for (let i = 0; i < keys.length; i++) {
    const count = tokens[usageKeys[i]];
    if (count === undefined || count === null) { missing.push(`tokens.${usageKeys[i]}`); continue; }
    if (!Number.isSafeInteger(count) || count < 0) throw stateError('INVALID_USAGE', `Invalid ${usageKeys[i]} token count`);
    const value = price[keys[i]] !== undefined ? price[keys[i]] : price[oldKeys[i]];
    if (count && priceNumber(value) === null) missing.push(keys[i]);
    else if (count) amount += count * value / 1e6;
  }
  return { amountUsd: missing.length ? null : Math.round(amount * 1e12) / 1e12, basis: missing.length ? 'unknown' : 'estimated', complete: !missing.length, missing, sourceId: price.sourceId || price.source };
}
export function projectRate(price, throughput = {}) {
  const input = throughput.inputTokensPerMin, output = throughput.outputTokensPerMin;
  const specified = input !== undefined && input !== null && output !== undefined && output !== null;
  const result = specified ? estimateCost(price, { input, output, cacheRead: 0, cacheWrite: 0 }) : { amountUsd: null, basis: 'unknown' };
  return { ratePerMin: result.amountUsd, estimated: true, basis: result.basis, source: price?.sourceId ?? price?.source ?? 'unknown',
    inputTokensPerMin: input ?? null, outputTokensPerMin: output ?? null, assumptions: specified ? ['Explicit fresh-input/output throughput; no cache traffic modeled'] : ['Throughput not supplied; no zero-cost assumption made'] };
}
