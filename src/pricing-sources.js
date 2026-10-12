import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEnabled } from './integrations.js';
import { readStrict, writeAtomic, withLock, stateError } from './atomic-state.js';
import { normalizePriceRecord, PRICE_UNIT } from './pricing.js';
const SOURCES = ['pricing.models-dev', 'pricing.cc-switch-upstream'];
const sourceId = value => value === 'models-dev' ? 'pricing.models-dev' : value === 'cc-switch-upstream' ? 'pricing.cc-switch-upstream' : value;
const root = project => path.join(path.resolve(project), '.mawf', 'cache', 'pricing');
const cacheFile = (project, source) => path.join(root(project), `${source}.json`);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function normalizeModelsDev(document, meta = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Object.keys(document).length) throw stateError('INVALID_PRICING_SOURCE', 'models.dev catalog must be a provider map');
  const records = [];
  for (const [providerId, provider] of Object.entries(document)) {
    if (!provider || provider.id !== providerId || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) throw stateError('INVALID_PRICING_SOURCE', 'Provider identity/model map mismatch');
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || model.id !== modelId) throw stateError('INVALID_PRICING_SOURCE', 'Model identity mismatch');
      const add = (cost, serviceMode) => {
        if (cost === undefined) return;
        if (!cost || typeof cost !== 'object' || Array.isArray(cost) || typeof cost.input !== 'number' || typeof cost.output !== 'number') throw stateError('INVALID_PRICING_SOURCE', `Missing numeric input/output cost: ${providerId}/${modelId}`);
        const tiers = cost.tiers ?? [];
        // context_over_200k alone does not prove the actual context threshold.
        const notes = cost.context_over_200k && !tiers.length ? ['Legacy context_over_200k threshold unverified; tier pricing unsupported'] : [];
        const record = normalizePriceRecord({ ...meta, sourceId: 'pricing.models-dev', providerId, modelId, currency: 'USD', unit: PRICE_UNIT,
          inputPerMillion: cost.input, outputPerMillion: cost.output, cacheReadPerMillion: cost.cache_read ?? null, cacheWritePerMillion: cost.cache_write ?? null,
          tiers, applicability: { providerScope: 'exact', serviceMode, ...(notes.length ? { tierThresholdUnknown: true } : {}) }, estimated: false, notes });
        records.push(record);
      };
      add(model.cost, 'standard');
      for (const [mode, definition] of Object.entries(model.experimental?.modes ?? {})) add(definition.cost, mode);
    }
  }
  if (!records.length) throw stateError('INVALID_PRICING_SOURCE', 'Source contains no usable prices; last valid snapshot is retained');
  return records;
}
function snapshot(source, document) {
  if (document?.schemaVersion !== 1 || document.sourceId !== source || !Array.isArray(document.records)) throw stateError('INVALID_PRICING_CACHE', `Invalid cached source ${source}`);
  return { ...document, records: document.records.map(record => normalizePriceRecord(record)) };
}
export function loadPriceRecords(project, settings) {
  const records = [];
  for (const source of SOURCES) {
    if (!isEnabled(settings, source)) continue;
    let data = readStrict(cacheFile(project, source), null);
    if (!data && source === 'pricing.cc-switch-upstream') data = JSON.parse(fs.readFileSync(new URL('../defaults/pricing.cc-switch-upstream.json', import.meta.url), 'utf8'));
    if (data) {
      const parsed = snapshot(source, data);
      const stale = Date.now() - Date.parse(parsed.retrievedAt) > (settings.integrations[source].options.maxAgeMs ?? 7 * 86400000);
      records.push(...parsed.records.map(record => ({ ...record, stale: record.stale || stale })));
    }
  }
  return records;
}
export function pricingStatus(project, settings) {
  return SOURCES.map(source => {
    const document = isEnabled(settings, source) ? readStrict(cacheFile(project, source), null) : null;
    return { sourceId: source, selected: isEnabled(settings, source), cached: !!document, recordCount: document?.records?.length ?? 0, sourceVersion: document?.sourceVersion ?? null,
      retrievedAt: document?.retrievedAt ?? null, lastRefresh: readStrict(path.join(root(project), `${source}.status.json`), null),
      bundledSnapshotAvailable: source === 'pricing.cc-switch-upstream' };
  });
}
export async function refreshPrices(project, requestedSource, settings, opts = {}) {
  const source = sourceId(requestedSource);
  if (!SOURCES.includes(source)) throw stateError('UNKNOWN_PRICING_SOURCE', `Supported sources: ${SOURCES.join(', ')}`);
  if (!isEnabled(settings, source)) throw stateError('INTEGRATION_DISABLED', `${source} must be explicitly enabled before refresh`);
  const options = { ...settings.integrations[source].options, ...opts };
  const started = new Date().toISOString();
  try {
    let data;
    if (source === 'pricing.cc-switch-upstream') {
      data = snapshot(source, JSON.parse(fs.readFileSync(new URL('../defaults/pricing.cc-switch-upstream.json', import.meta.url), 'utf8')));
      data = { ...data, refreshedAt: started, delivery: 'pinned_bundled_upstream_export' };
    } else {
      const url = options.url || 'https://models.dev/api.json';
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw stateError('INVALID_PRICING_URL', 'Pricing URL must use HTTP(S)');
      const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
      const timeoutMs = options.timeoutMs ?? 10000;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw stateError('INVALID_REFRESH_BOUNDS', 'Invalid refresh size/time bounds');
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw stateError('PRICING_HTTP_ERROR', `Pricing source returned HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw stateError('PRICING_RESPONSE_TOO_LARGE', 'Pricing response exceeds configured size bound'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks); const digest = hash(raw);
      const metadata = { sourceVersion: `sha256:${digest}`, sourceHash: digest, retrievedAt: started };
      data = { schemaVersion: 1, sourceId: source, ...metadata, sourceUrl: response.url || url, records: normalizeModelsDev(JSON.parse(raw.toString('utf8')), metadata) };
    }
    withLock(root(project), source, () => {
      writeAtomic(cacheFile(project, source), data);
      writeAtomic(path.join(root(project), `${source}.status.json`), { ok: true, at: started, sourceVersion: data.sourceVersion });
    });
    return { ok: true, sourceId: source, sourceVersion: data.sourceVersion, records: data.records.length, retrievedAt: data.retrievedAt, delivery: data.delivery ?? 'explicit_remote_refresh' };
  } catch (error) {
    withLock(root(project), source, () => writeAtomic(path.join(root(project), `${source}.status.json`), { ok: false, at: started, reasonCode: error.code || 'REFRESH_FAILED', reason: error.message }));
    return { ok: false, reasonCode: error.code || 'REFRESH_FAILED', sourceId: source, reason: error.message, lastGoodRetained: fs.existsSync(cacheFile(project, source)) };
  }
}
