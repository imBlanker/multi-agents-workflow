// @ts-check
// Cost-rate limiting for the workflow. The authoritative rate is the *actual*
// inference spend measured from cc-switch proxy_request_logs (USD/min), not a
// token estimate. We also track live concurrency via a small state file so the
// runner can enforce both per-agent and total limits + max concurrency.
import path from "node:path";
import { readJson, writeJson, ensureDir, nowSec, round } from "./util.js";

/**
 * @param {string} stateDir  the .mawf/runtime/ dir
 */
function stateFile(stateDir) {
  return path.join(stateDir, "concurrency.json");
}

/**
 * @typedef {{
 *   perAgentLimitUsdPerMin: number,
 *   totalLimitUsdPerMin: number,
 *   maxConcurrency: number,
 *   windowSeconds: number,
 *   dbPath?: string,
 * }} CostConfig
 */

/**
 * Read current concurrency state.
 * @param {string} stateDir
 */
export function readState(stateDir) {
  const s = readJson(stateFile(stateDir), { running: {}, history: [] });
  if (!s.running || typeof s.running !== "object") s.running = {};
  if (!Array.isArray(s.history)) s.history = [];
  return /** @type {{ running: Record<string, { agent: string, role: string, since: number }>, history: any[] }} */ (s);
}

/**
 * Persist concurrency state.
 * @param {string} stateDir
 * @param {{ running: Record<string, any>, history: any[] }} s
 */
export function writeState(stateDir, s) {
  ensureDir(stateDir);
  writeJson(stateFile(stateDir), s);
}

/**
 * Acquire a slot for an agent run. Refuses if the cost-rate budget or the
 * concurrency cap would be exceeded.
 * @param {string} stateDir
 * @param {CostConfig} cfg
 * @param {{ agentId: string, role: string, appType?: string }} who
 * @returns {{ allowed: boolean, reason: string, running: number, ratePerMin: number, remainingConcurrency: number }}
 */
export function acquire(stateDir, cfg, who) {
  const s = readState(stateDir);
  // purge stale entries older than 30 min
  const cutoff = nowSec() - 1800;
  for (const [id, v] of Object.entries(s.running)) {
    if (v.since < cutoff) delete s.running[id];
  }

  // 1. cost-rate check (authoritative: real spend from cc-switch logs)
  const total = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.costRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { ratePerMin: 0, totalUsd: null, requestCount: 0, impl: "usage-unavailable", basis: "unknown" };
  if (total.ratePerMin >= cfg.totalLimitUsdPerMin) {
    return { allowed: false, reason: `total cost-rate ${total.ratePerMin} USD/min >= limit ${cfg.totalLimitUsdPerMin}`, running: Object.keys(s.running).length, ratePerMin: total.ratePerMin, remainingConcurrency: Math.max(0, cfg.maxConcurrency - Object.keys(s.running).length) };
  }
  // per-session rate as a proxy for per-agent rate
  const per = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.perSessionRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { sessions: [] };
  for (const sess of per.sessions) {
    if (sess.ratePerMin >= cfg.perAgentLimitUsdPerMin) {
      return { allowed: false, reason: `agent/session ${sess.sessionId} at ${sess.ratePerMin} USD/min >= per-agent limit ${cfg.perAgentLimitUsdPerMin}`, running: Object.keys(s.running).length, ratePerMin: sess.ratePerMin, remainingConcurrency: Math.max(0, cfg.maxConcurrency - Object.keys(s.running).length) };
    }
  }

  // 2. concurrency check
  const running = Object.keys(s.running).length;
  if (running >= cfg.maxConcurrency) {
    return { allowed: false, reason: `max concurrency ${cfg.maxConcurrency} reached`, running, ratePerMin: total.ratePerMin, remainingConcurrency: 0 };
  }

  // 3. acquire
  s.running[who.agentId] = { agent: who.agent, role: who.role, since: nowSec() };
  writeState(stateDir, s);
  return { allowed: true, reason: "ok", running: running + 1, ratePerMin: total.ratePerMin, remainingConcurrency: cfg.maxConcurrency - running - 1 };
}

/**
 * Release a slot.
 * @param {string} stateDir
 * @param {{ agentId: string }} who
 */
export function release(stateDir, who) {
  const s = readState(stateDir);
  const entry = s.running[who.agentId];
  if (entry) {
    s.history.push({ ...entry, ended: nowSec() });
    if (s.history.length > 200) s.history = s.history.slice(-200);
    delete s.running[who.agentId];
    writeState(stateDir, s);
    return { released: true };
  }
  return { released: false };
}

/**
 * Decide whether a planned spawn is allowed under the current budget, without
 * actually acquiring a slot. The main agent calls this before delegating.
 * @param {string} stateDir
 * @param {CostConfig} cfg
 */
export function guard(stateDir, cfg) {
  const s = readState(stateDir);
  const cutoff = nowSec() - 1800;
  for (const [id, v] of Object.entries(s.running)) if (v.since < cutoff) delete s.running[id];
  const total = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.costRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { ratePerMin: 0, totalUsd: null, requestCount: 0, impl: "usage-unavailable", basis: "unknown" };
  const per = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.perSessionRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { sessions: [] };
  let perAgentOk = true;
  let perAgentReason = "";
  for (const sess of per.sessions) {
    if (sess.ratePerMin >= cfg.perAgentLimitUsdPerMin) {
      perAgentOk = false;
      perAgentReason = `session ${String(sess.sessionId).slice(0,12)} at ${sess.ratePerMin} USD/min >= per-agent limit ${cfg.perAgentLimitUsdPerMin}`;
      break;
    }
  }
  const running = Object.keys(s.running).length;
  const remainingConcurrency = Math.max(0, cfg.maxConcurrency - running);
  const totalOk = total.ratePerMin < cfg.totalLimitUsdPerMin;
  const allowed = totalOk && perAgentOk && remainingConcurrency > 0;
  const reason = !totalOk ? "total cost-rate limit reached"
    : !perAgentOk ? perAgentReason
    : remainingConcurrency === 0 ? "max concurrency reached"
    : "ok";
  return {
    allowed,
    totalRatePerMin: round(total.ratePerMin, 4),
    totalLimitUsdPerMin: cfg.totalLimitUsdPerMin,
    perAgentLimitUsdPerMin: cfg.perAgentLimitUsdPerMin,
    running,
    maxConcurrency: cfg.maxConcurrency,
    remainingConcurrency,
    impl: total.impl,
    windowSeconds: cfg.windowSeconds,
    reason,
  };
}

/**
 * Human-readable cost report.
 * `caveats` carries upstream accounting limits whenever the aggregates
 * include pi rows (a pi session may mix Anthropic- and OpenAI-API providers →
 * cache-write accounting may be incomplete — cc-switch upstream caveat).
 * @param {CostConfig} cfg
 */
export function report(cfg) {
  const total = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.costRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { ratePerMin: 0, totalUsd: null, requestCount: 0, impl: "usage-unavailable", basis: "unknown" };
  const per = cfg.usageEnabled === true && cfg.usageProvider ? cfg.usageProvider.perSessionRate({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds }) : { sessions: [] };
  const top = per.sessions.slice(0, 8);
  const caveats = [];
  if (cfg.usageEnabled === true && cfg.usageProvider && cfg.usageProvider.piSessionUsagePresent({ dbPath: cfg.dbPath, windowSeconds: cfg.windowSeconds })) {
    caveats.push("pi spend via cc-switch Pi (Session) import: cache-write accounting may be incomplete");
  }
  return {
    windowSeconds: cfg.windowSeconds,
    impl: total.impl,
    caveats,
    total: { ratePerMin: total.ratePerMin, limitUsdPerMin: cfg.totalLimitUsdPerMin, usedPct: pct(total.ratePerMin, cfg.totalLimitUsdPerMin), totalUsd: total.totalUsd, requestCount: total.requestCount },
    perAgentLimitUsdPerMin: cfg.perAgentLimitUsdPerMin,
    maxConcurrency: cfg.maxConcurrency,
    topSessions: top,
  };
}

/** @param {number} a @param {number} b */
function pct(a, b) { return b <= 0 ? 0 : round((a / b) * 100, 1); }
