import { runtimeStatus, acquireTask, releaseLease, queryAdmission } from './runtime.js';
import { stateError } from './atomic-state.js';
// @ts-check
// Cost-rate limiting for controlled workflow registrations. cc-switch amounts
// are token-price-derived estimates, not verified payment telemetry. We also track live concurrency via a small state file so the
// runner can enforce both per-agent and total limits + max concurrency.
import path from "node:path";
import { readJson, writeJson, ensureDir, nowSec, round } from "./util.js";

// Compatibility view/admission now uses the same fenced runtime ledger.
export function readState(stateDir) {
  const runtime = runtimeStatus({ stateRoot: stateDir });
  return { running: Object.fromEntries(runtime.leases.filter(lease => lease.status !== 'released').map(lease => [lease.leaseId, lease])), history: runtime.leases.filter(lease => lease.status === 'released'), legacyActiveCount: runtime.legacyActiveCount };
}
export function writeState() { throw stateError('DIRECT_RUNTIME_WRITE_UNSUPPORTED', 'Use the fenced task lifecycle; direct concurrency.json mutation is retired'); }
export function acquire(stateDir, cfg, who) {
  if (!cfg.runId || !(who.taskId || who.agentId)) return { schemaVersion: 1, ok: false, allowed: false, action: 'deny', reasonCode: 'TASK_CONTEXT_REQUIRED', reason: 'Supply runId and an existing taskId; legacy agent IDs cannot create a separate ledger' };
  return acquireTask({ stateRoot: stateDir, project: cfg.project, runId: cfg.runId, taskId: who.taskId || who.agentId, attempt: who.attempt, launchKey: who.launchKey, actorId: who.actorId, controllerProcess: who.controllerProcess });
}
export function release(stateDir, who) {
  if (!who.leaseId || !(who.token || who.fencingToken)) return { schemaVersion: 1, ok: false, released: false, reasonCode: 'LEASE_TOKEN_REQUIRED', reason: 'Release requires the exact lease ID and fencing token' };
  return releaseLease({ stateRoot: stateDir, leaseId: who.leaseId, token: who.token || who.fencingToken });
}
export function guard(stateDir, cfg = {}) { return queryAdmission({ stateRoot: stateDir, project: cfg.project, runId: cfg.runId, taskId: cfg.taskId }); }

/**
 * Human-readable cost report.
 * `caveats` carries upstream accounting limits whenever the aggregates
 * include pi rows (a pi session may mix Anthropic- and OpenAI-API providers →
 * cache-write accounting may be incomplete — cc-switch upstream caveat).
 * @param {CostConfig} cfg
 */
export function report(cfg) {
  const total = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.costRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { ratePerMin: null, totalUsd: null, requestCount: 0, impl: "usage-unavailable", basis: "unknown" };
  const per = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.perSessionRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { sessions: [] };
  const top = per.sessions.slice(0, 8);
  const caveats = [];
  if (cfg.usageEnabled === true && cfg.usageProvider && cfg.usageProvider.piSessionUsagePresent({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds })) {
    caveats.push("pi spend via cc-switch Pi (Session) import: cache-write accounting may be incomplete");
  }
  const runtime = runtimeStatus({ project: cfg.project, stateRoot: cfg.stateRoot });
  return {
    runtime, activeCount: runtime.activeCount, legacyActiveCount: runtime.legacyActiveCount,
    windowSeconds: cfg.windowSeconds,
    impl: total.impl,
    caveats: [...caveats, "Imported cc-switch amounts are token-price-derived estimates; out-of-band/unlogged work is not covered"],
    basis: total.ratePerMin === null ? "unknown" : "estimated",
    coverage: { complete: false, source: cfg.usageEnabled ? "cc-switch.usage" : "none", limitations: ["Only selected logged sessions; no strict cumulative payment guarantee"] },
    enforcementLevel: cfg.enforcement ?? "best_effort",
    total: { ratePerMin: total.ratePerMin, limitUsdPerMin: cfg.totalLimitUsdPerMin, usedPct: pct(total.ratePerMin, cfg.totalLimitUsdPerMin), totalUsd: total.totalUsd, requestCount: total.requestCount },
    perAgentLimitUsdPerMin: cfg.perAgentLimitUsdPerMin,
    maxConcurrency: cfg.maxConcurrency,
    topSessions: top,
  };
}

/** @param {number} a @param {number} b */
function pct(a, b) { return a === null ? null : b <= 0 ? 0 : round((a / b) * 100, 1); }
