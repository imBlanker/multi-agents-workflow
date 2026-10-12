const normalizedSummaries = new WeakSet();
// Usage imports are allowlisted records, not copies of host authentication/logs.
import { priceNumber } from './pricing.js';
import { stateError } from './atomic-state.js';
export function normalizeUsageEvent(raw, trustedSources = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw stateError('INVALID_USAGE', 'Usage event must be an object');
  const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId : 'unknown';
  const actual = ['measured', 'reported'].includes(raw.basis) && trustedSources.includes(sourceId) && raw.evidence?.sourceVerified === true && typeof raw.evidence.reference === 'string';
  const tokens = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => { const value = raw.tokens?.[key]; if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw stateError('INVALID_USAGE', `Invalid ${key} token count`); return [key, value ?? null]; }));
  const basis = sourceId.startsWith('cc-switch') ? 'estimated' : actual ? raw.basis : raw.basis === 'estimated' ? 'estimated' : 'unknown';
  return { sourceId, eventId: typeof raw.eventId === 'string' ? raw.eventId : null, requestId: typeof raw.requestId === 'string' ? raw.requestId : null,
    providerId: typeof raw.providerId === 'string' ? raw.providerId : null, modelId: typeof raw.modelId === 'string' ? raw.modelId : null,
    runId: typeof raw.runId === 'string' ? raw.runId : null, taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null, amountUsd: basis === 'unknown' ? null : priceNumber(raw.amountUsd), basis,
    tokens,
    observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : null,
    coverage: { complete: raw.coverage?.complete === true, taskIds: Array.isArray(raw.coverage?.taskIds) ? raw.coverage.taskIds.filter(value => typeof value === 'string') : [], limitations: Array.isArray(raw.coverage?.limitations) ? raw.coverage.limitations.map(String) : [] },
    evidence: actual ? { sourceVerified: true, reference: raw.evidence.reference } : null };
}
export function summarizeUsage(input, opts = {}) {
  if (!Array.isArray(input)) throw stateError('INVALID_USAGE', 'Usage input must be an array of events');
  const chosen = new Map(); let uncorrelated = 0, duplicates = 0;
  const rank = { unknown: 0, estimated: 1, reported: 2, measured: 3 };
  for (const raw of input) {
    const event = normalizeUsageEvent(raw, opts.trustedSources ?? []);
    if (opts.runId && event.runId !== opts.runId || opts.taskId && event.taskId !== opts.taskId) { uncorrelated++; continue; }
    const key = event.requestId ? `request:${event.providerId}:${event.requestId}` : event.eventId ? `event:${event.sourceId}:${event.eventId}` : null;
    if (!key) { uncorrelated++; continue; }
    if (chosen.has(key)) { duplicates++; if (rank[event.basis] <= rank[chosen.get(key).basis]) continue; }
    chosen.set(key, event);
  }
  const events = [...chosen.values()];
  const complete = events.length > 0 && events.every(event => event.coverage.complete && event.amountUsd !== null);
  const measured = complete && events.every(event => ['measured', 'reported'].includes(event.basis));
  const summary = { kind: 'historical_import', observedAt: new Date().toISOString(), amountUsd: complete ? events.reduce((sum, event) => sum + event.amountUsd, 0) : null,
    basis: measured ? events.every(event => event.basis === 'measured') ? 'measured' : 'reported' : complete ? 'estimated' : 'unknown',
    coverage: { complete, runId: opts.runId ?? null, taskId: opts.taskId ?? null, taskIds: [...new Set(events.flatMap(event => [event.taskId, ...event.coverage.taskIds]).filter(Boolean))], uncorrelatedEvents: uncorrelated, limitations: ['Only imported correlated events are covered; out-of-band sessions are not controlled'] },
    eventCount: events.length, duplicateCount: duplicates, sourceIds: [...new Set(events.map(event => event.sourceId))], events };
  normalizedSummaries.add(summary);
  return summary;
}

// Imported receipts (even explicitly trusted ones) are historical source claims.
// No current adapter supplies a live verified payment stream. Keeping the
// opaque origin check prevents serialized/self-stamped JSON from becoming one.
export function isCurrentPaymentTelemetry(summary, selection) {
  if (!normalizedSummaries.has(summary) || summary.kind !== 'live_payment_snapshot') return false;
  const age = Date.now() - Date.parse(summary.observedAt);
  return age >= 0 && age <= 30000 && summary.coverage?.complete === true &&
    ['measured', 'reported'].includes(summary.basis) && summary.coverage.taskId === selection.taskId &&
    summary.coverage.runId === selection.runId && summary.providerId === selection.providerId;
}
