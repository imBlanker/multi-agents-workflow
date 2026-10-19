import { recordRunApproval } from './runtime.js';
import { isCurrentPaymentTelemetry } from './usage.js';
import crypto from 'node:crypto';
import { priceNumber } from './pricing.js';
import { updateSettings } from './settings.js';
import { stateError } from './atomic-state.js';
export const PRICE_GATE_THRESHOLDS = Object.freeze({ inputPerM: 2, outputPerM: 10 });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function selectionIdentity(selection) {
  return { role: selection.role ?? 'worker', providerId: selection.providerId ?? null, modelId: selection.modelId ?? selection.model ?? '', billingMode: selection.billingMode ?? 'api', priceVersion: selection.price?.priceVersion ?? null };
}
export function approvalIdentity(selection) { return digest(selectionIdentity(selection)); }
export function boundedPolicy(settings) {
  const bounds = settings.pricing?.bounds;
  return !!bounds && Number.isSafeInteger(bounds.maxConcurrency) && bounds.maxConcurrency > 0 && bounds.maxConcurrency <= settings.scheduler.maxConcurrency &&
    ((Number.isSafeInteger(bounds.maxDurationMs) && bounds.maxDurationMs > 0) || (Number.isSafeInteger(bounds.maxIterations) && bounds.maxIterations > 0));
}
function subscriptionCovered(selection) {
  const evidence = selection.subscription;
  // Subscription/account claims must originate in a supported current adapter
  // observation; neither a login flag nor imported JSON provides that origin.
  if (!isCurrentPaymentTelemetry(evidence, selection)) return false;
  return selection.billingMode === 'subscription' && evidence?.verified === true && typeof evidence.sourceId === 'string' &&
    typeof evidence.reference === 'string' && evidence.providerId === selection.providerId && (evidence.modelId === selection.modelId || evidence.modelIds?.includes(selection.modelId)) &&
    Date.parse(evidence.validUntil) > Date.now() && evidence.quota && (priceNumber(evidence.quota.remaining) !== null && evidence.quota.remaining > 0);
}
export function evaluateSelection(selection, settings = {}) {
  const billing = selection.billingMode ?? 'api';
  if (!['api', 'subscription', 'local-free', 'unknown'].includes(billing)) throw stateError('INVALID_BILLING_MODE', 'billingMode must be api, subscription, local-free or unknown');
  const identity = selectionIdentity(selection);
  const price = selection.price;
  const input = priceNumber(price && Object.hasOwn(price, 'inputPerMillion') ? price.inputPerMillion : price?.input_per_m);
  const output = priceNumber(price && Object.hasOwn(price, 'outputPerMillion') ? price.outputPerMillion : price?.output_per_m);
  const known = input !== null && output !== null;
  const covered = subscriptionCovered(selection);
  const billingObservation = selection.billingEvidence;
  const knownSubscriptionIdentity = billingObservation?.source === 'claude-auth-status' && billingObservation.authenticated === true && billingObservation.providerId === identity.providerId && ['claude.ai', 'oauth'].includes(billingObservation.authMethod);
  const boundedSubscription = billing === 'subscription' && !covered && knownSubscriptionIdentity && settings.pricing?.unknownCoveragePolicy === 'bounded' && boundedPolicy(settings);
  const requiresBounds = boundedSubscription || !covered && settings.pricing?.unknownPricePolicy === 'bounded' && (!known || !identity.providerId || billing === 'unknown');
  const thresholds = settings.pricing?.thresholds ?? PRICE_GATE_THRESHOLDS;
  const expensive = known && (input > thresholds.inputPerM || output > thresholds.outputPerM);
  const matching = (settings.approvals ?? []).find(item => item.identityHash === approvalIdentity(selection) && item.decision === 'approved' &&
    (item.scope === 'persistent' || item.scope === 'run' && item.runId === selection.runId));
  let allowed = true, reasonCode = 'ALLOWED', reason = 'Within known price policy; monetary enforcement remains best effort';
  if (!known && !covered) {
    const bounded = settings.pricing?.unknownPricePolicy === 'bounded' && boundedPolicy(settings);
    allowed = bounded; reasonCode = bounded ? 'BOUNDED_UNKNOWN_PRICE' : 'UNKNOWN_PRICE';
    reason = bounded ? 'Unknown price explicitly accepted under recorded concurrency and duration/iteration bounds' : 'Price unknown; pause until a valid price or explicitly bounded policy is configured';
  }
  if (allowed && !identity.providerId && !(settings.pricing?.unknownPricePolicy === 'bounded' && boundedPolicy(settings))) { allowed = false; reasonCode = 'UNKNOWN_PROVIDER'; reason = 'Actual provider identity is unknown; an estimate is not provider authorization'; }
  if (allowed && ['subscription', 'local-free'].includes(billing) && !covered && !boundedSubscription) { allowed = false; reasonCode = billing === 'subscription' ? 'SUBSCRIPTION_UNVERIFIED' : 'LOCAL_ADAPTER_UNVERIFIED'; reason = 'No supported current adapter proof establishes this billing mode; a CLI label cannot exempt payment policy'; }
  if (allowed && boundedSubscription) { reasonCode = 'BOUNDED_UNVERIFIED_SUBSCRIPTION'; reason = 'Explicit unknown-coverage risk policy permits this observed subscription identity only within recorded concurrency and duration bounds; quota and payment remain unknown'; }
  if (allowed && selection.billingMode === 'unknown' && !(settings.pricing?.unknownPricePolicy === 'bounded' && boundedPolicy(settings))) { allowed = false; reasonCode = 'UNKNOWN_BILLING'; reason = 'Billing mode is unverified; declare API/local billing or provide verified subscription coverage'; }
  if (allowed && expensive && !covered && !matching && !boundedSubscription) { allowed = false; reasonCode = 'EXPENSIVE_MODEL'; reason = 'Price exceeds the input/output threshold; approval must match role, provider, model, billing mode and price version'; }
  if (allowed && settings.cost?.enforcement === 'strict_measured' && !covered && selection.billingMode !== 'local-free') {
    const usage = selection.usage;
    const targetCovered = !!selection.taskId && usage?.coverage?.taskIds?.includes(selection.taskId) || !!selection.runId && usage?.coverage?.runId === selection.runId;
    if (!isCurrentPaymentTelemetry(usage, selection) || !targetCovered) {
      allowed = false; reasonCode = 'MEASURED_COVERAGE_REQUIRED'; reason = 'Strict measured policy requires verified, complete payment telemetry for this target; token-price estimates do not qualify';
    }
  }
  return { schemaVersion: 1, ok: allowed, allowed, reasonCode, reason, identity, identityHash: approvalIdentity(selection), priceKnown: known, covered, requiresBounds, quota: billing === 'subscription' && !covered ? 'unknown' : null,
    approved: !!matching, expensive, inputPerM: input, outputPerM: output, thresholdIn: thresholds.inputPerM, thresholdOut: thresholds.outputPerM,
    basis: billing === 'subscription' && !covered ? 'unknown' : covered ? 'subscription' : known ? 'estimated' : 'unknown', amountUsd: null, enforcementLevel: settings.cost?.enforcement ?? 'best_effort',
    coverage: selection.usage?.coverage ?? { complete: false, limitations: ['No target payment telemetry; out-of-band work is not covered'] }, bounds: requiresBounds && allowed ? settings.pricing.bounds : null };
}
export function approveSelection(project, selection, options = {}) {
  if (!selection.providerId || !['api', 'subscription', 'local-free'].includes(selection.billingMode)) throw stateError('UNRESOLVED_APPROVAL_IDENTITY', 'A durable approval requires a known provider and explicit valid billing mode');
  if (selection.billingMode !== 'api') throw stateError('BILLING_EVIDENCE_REQUIRED', 'Non-API approvals require verified adapter billing evidence before they can be issued');
  if (!selection.price || priceNumber(selection.price.inputPerMillion) === null || priceNumber(selection.price.outputPerMillion) === null) throw stateError('UNKNOWN_PRICE', 'An expensive-price approval cannot authorize unknown pricing');
  const scope = options.scope ?? 'persistent';
  if (!['persistent', 'run'].includes(scope) || scope === 'run' && !options.runId) throw stateError('INVALID_APPROVAL_SCOPE', 'Run approval requires an explicit runId');
  const record = { identity: selectionIdentity(selection), identityHash: approvalIdentity(selection), scope, runId: scope === 'run' ? options.runId : null,
    decision: 'approved', approvedAt: new Date().toISOString(), price: { inputPerMillion: selection.price.inputPerMillion, outputPerMillion: selection.price.outputPerMillion }, source: 'explicit_cli_confirmation' };
  const settings = updateSettings(project, draft => {
    draft.approvals = [...(draft.approvals ?? []).filter(item => !(item.identityHash === record.identityHash && item.scope === scope && item.runId === record.runId)), record];
  });
  const runtimeAuthorization = scope === 'run' ? recordRunApproval({ project, stateRoot: options.stateRoot }, record) : null;
  return { approval: record, configRevision: settings.configRevision, runtimeAuthorization };
}
