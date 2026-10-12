import { normalizePriceRecord, priceNumber } from './pricing.js';
import fs from 'node:fs';
import path from 'node:path';
import { withLock, readStrict, writeAtomic, stateError } from './atomic-state.js';
import { getMode } from './modes.js';
import { INTEGRATIONS, getIntegration } from './integrations.js';

export function settingsPath(project) {
  const resolved = path.resolve(project);
  // Canonicalize the user-selected project, but never follow links inside it.
  const canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  return path.join(canonical, '.mawf', 'settings.json');
}
export function defaultSettings() {
  return { schemaVersion: 1, configRevision: 0, mode: { id: 'dynamic', version: 1 },
    integrations: Object.fromEntries(INTEGRATIONS.map(item => [item.id, { enabled: false, options: {} }])),
    scheduler: { targetConcurrency: 3, maxConcurrency: 6 }, pricing: { unknownPricePolicy: 'pause', overrides: {} },
    cost: { enforcement: 'best_effort' }, verification: { minIndependentHackers: 1, requireRealUserPath: true }, roleOverrides: {} };
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('INVALID_SETTINGS', `${label} must be an object`);
}
function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw stateError('INVALID_SETTINGS', `${label} must be a safe integer >= ${minimum}`);
}
function safeValues(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw stateError('INVALID_SETTINGS', 'Non-finite configuration number');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw stateError('INVALID_SETTINGS', `Unsafe configuration key: ${key}`);
    safeValues(child);
  }
}
export function validateSettings(value) {
  object(value, 'settings'); safeValues(value);
  if (value.schemaVersion !== 1) throw stateError('INVALID_SETTINGS', 'Unsupported settings schemaVersion');
  if ('revision' in value) throw stateError('INVALID_SETTINGS', 'Use configRevision, not revision');
  integer(value.configRevision, 'configRevision', 0);
  object(value.mode, 'mode'); const mode = getMode(value.mode.id);
  if (value.mode.id !== mode.id || value.mode.version !== mode.version) throw stateError('INVALID_SETTINGS', 'Mode must use its canonical ID and supported version');
  object(value.integrations, 'integrations');
  for (const [id, selection] of Object.entries(value.integrations)) {
    getIntegration(id); object(selection, `integrations.${id}`);
    if (typeof selection.enabled !== 'boolean') throw stateError('INVALID_SETTINGS', `${id}.enabled must be boolean`);
    object(selection.options, `${id}.options`);
  }
  object(value.scheduler, 'scheduler');
  integer(value.scheduler.targetConcurrency, 'targetConcurrency'); integer(value.scheduler.maxConcurrency, 'maxConcurrency');
  if (value.scheduler.targetConcurrency > value.scheduler.maxConcurrency) throw stateError('INVALID_SETTINGS', 'targetConcurrency cannot exceed maxConcurrency');
  object(value.pricing, 'pricing'); object(value.pricing.overrides, 'pricing.overrides');
  if (!['pause', 'bounded'].includes(value.pricing.unknownPricePolicy)) throw stateError('INVALID_SETTINGS', 'unknownPricePolicy must be pause or bounded');
  if (value.pricing.thresholds !== undefined && (priceNumber(value.pricing.thresholds.inputPerM) === null || priceNumber(value.pricing.thresholds.outputPerM) === null)) throw stateError('INVALID_SETTINGS', 'Price thresholds must be finite nonnegative numbers');
  for (const [key, override] of Object.entries(value.pricing.overrides)) {
    object(override, `pricing.overrides.${key}`);
    const direct = ['inputPerMillion', 'outputPerMillion', 'input_per_m', 'output_per_m', 'modelId'].some(field => Object.hasOwn(override, field));
    if (direct) normalizePriceRecord(override, { modelId: key.includes('/') ? key.slice(key.indexOf('/') + 1) : key });
    else for (const [modelId, record] of Object.entries(override)) normalizePriceRecord(record, { modelId, providerId: key });
  }

  object(value.cost, 'cost');
  if (!['best_effort', 'strict_measured'].includes(value.cost.enforcement)) throw stateError('INVALID_SETTINGS', 'Unknown cost enforcement');
  object(value.verification, 'verification'); integer(value.verification.minIndependentHackers, 'minIndependentHackers', mode.id === 'fixed-1' ? 1 : 0);
  if (typeof value.verification.requireRealUserPath !== 'boolean' || (mode.id === 'fixed-1' && !value.verification.requireRealUserPath)) throw stateError('INVALID_SETTINGS', 'fixed-1 requires a real user path');
  if (value.implementation !== undefined) {
    object(value.implementation, 'implementation');
    if (mode.id === 'fixed-1' && value.implementation.writesTests !== false) throw stateError('INVALID_SETTINGS', 'Fixed implementation policy writesTests must be false');
  }
  object(value.roleOverrides, 'roleOverrides');
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) throw stateError('INVALID_SETTINGS', 'models must be an array');
    for (const model of value.models) if (!model || typeof model.modelId !== 'string' || typeof model.providerId !== 'string' || typeof model.adapter !== 'string' || model.billingMode !== undefined && !['api', 'subscription', 'local-free', 'unknown'].includes(model.billingMode)) throw stateError('INVALID_SETTINGS', 'Declared models require modelId/providerId/adapter');
  }
  if (value.approvals !== undefined && !Array.isArray(value.approvals)) throw stateError('INVALID_SETTINGS', 'approvals must be an array');
  if (value.pricing.unknownPricePolicy === 'bounded') {
    const bounds = value.pricing.bounds;
    if (!bounds || !Number.isSafeInteger(bounds.maxConcurrency) || bounds.maxConcurrency < 1 || bounds.maxConcurrency > value.scheduler.maxConcurrency ||
      !((Number.isSafeInteger(bounds.maxDurationMs) && bounds.maxDurationMs > 0) || (Number.isSafeInteger(bounds.maxIterations) && bounds.maxIterations > 0))) throw stateError('INVALID_SETTINGS', 'bounded pricing requires maxConcurrency and a positive maxDurationMs or maxIterations');
  }
  return value;
}
export function readSettings(project) { return validateSettings(readStrict(settingsPath(project), defaultSettings)); }
export function updateSettings(project, mutate, opts = {}) {
  const file = settingsPath(project);
  return withLock(path.dirname(file), 'settings', () => {
    const current = readSettings(project);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.configRevision) throw stateError('REVISION_CONFLICT', `Expected revision ${opts.expectedRevision}, found ${current.configRevision}`);
    const draft = structuredClone(current);
    const next = mutate(draft) ?? draft;
    if (next && typeof next.then === 'function') throw stateError('ASYNC_SETTINGS_MUTATION', 'Settings mutation must be synchronous');
    next.configRevision = current.configRevision + 1;
    validateSettings(next);
    return writeAtomic(file, next);
  });
}
