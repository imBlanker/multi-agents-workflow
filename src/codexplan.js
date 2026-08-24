// @ts-check
// Codex ChatGPT-plan detection + the machine-level reviewer default policy.
//
// Machine policy (user-mandated 2026-08-24): when the local Codex CLI is
// logged in with an OpenAI account whose ChatGPT plan is "pro" or "prolite"
// (flat-rate subscription — codex usage on that login is NOT billed per
// token), the reviewer role defaults to `gpt-5.6-sol` at reasoning effort
// `low`, and the per-token price gate treats the assignment as
// subscription-covered (NOT blocked — there is no per-token spend to gate).
// On any other login state (API key, free/plus/team plan, not logged in, no
// auth.json), the normal capability-aware selection + price gate apply.
//
// Detection source: ~/.codex/auth.json (auth_mode "chatgpt" + the id_token
// JWT payload's `https://api.openai.com/auth.chatgpt_plan_type` claim). The
// JWT is decoded WITHOUT signature verification — this is local, read-only
// introspection of the user's own login state, not an auth decision.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson } from "./util.js";

/** ChatGPT plan types that make codex usage flat-rate (subscription-covered). */
export const PRO_COVERED_PLANS = Object.freeze(["pro", "prolite"]);

/**
 * Machine-level reviewer defaults when a Pro / Pro-Lite ChatGPT login is
 * active. `gpt-5.6-sol` @ `low` mirrors the local ~/.codex/config.toml
 * default on this machine.
 */
export const PLAN_REVIEWER_DEFAULTS = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
});

const AUTH_NS = "https://api.openai.com/auth";

/**
 * base64url-decode + JSON.parse a JWT payload. Returns null on any error.
 * No signature verification (local trust — see module comment).
 * @param {string} jwt
 */
function jwtPayload(jwt) {
  try {
    const part = String(jwt).split(".")[1];
    if (!part) return null;
    const buf = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/** @param {string|null|undefined} p @returns {string|null} normalized plan id ("prolite", "pro", ...) */
function normPlan(p) {
  const n = String(p ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return n.length ? n : null;
}

/**
 * The local codex login state (see readCodexPlan).
 * @typedef {ReturnType<typeof readCodexPlan>} CodexPlanInfo
 */

/**
 * Read the local Codex login state (~/.codex/auth.json, or $CODEX_HOME).
 * Never throws — every failure degrades to `available:false`.
 * @param {{ codexDir?: string }} [opts]
 * @returns {{
 *   available: boolean, authMode: string|null, chatgptLogin: boolean,
 *   planType: string|null, planLabel: string|null,
 *   subscriptionActiveUntil: string|null, lastRefresh: string|null,
 *   proCovered: boolean, dir: string, reason: string,
 * }}
 */
export function readCodexPlan(opts = {}) {
  const dir = opts.codexDir || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authPath = path.join(dir, "auth.json");
  /** @type {any} */
  let auth = null;
  try {
    auth = fs.existsSync(authPath) ? readJson(authPath, null) : null;
  } catch {
    auth = null;
  }
  if (!auth || typeof auth !== "object") {
    return {
      available: false, authMode: null, chatgptLogin: false, planType: null, planLabel: null,
      subscriptionActiveUntil: null, lastRefresh: null, proCovered: false, dir,
      reason: `no readable ${path.join(dir, "auth.json")}`,
    };
  }
  const authMode = typeof auth.auth_mode === "string" ? auth.auth_mode : null;
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const claims = jwtPayload(tokens.id_token) ?? {};
  const oa = claims[AUTH_NS] && typeof claims[AUTH_NS] === "object" ? claims[AUTH_NS] : {};
  const planType = normPlan(oa.chatgpt_plan_type);
  const chatgptLogin = authMode === "chatgpt" || !!tokens.id_token;
  const proCovered = chatgptLogin && planType != null && PRO_COVERED_PLANS.includes(planType);
  return {
    available: true,
    authMode,
    chatgptLogin,
    planType,
    planLabel: planType === "prolite" ? "Pro-Lite" : planType === "pro" ? "Pro" : planType,
    subscriptionActiveUntil: typeof oa.chatgpt_subscription_active_until === "string" ? oa.chatgpt_subscription_active_until : null,
    lastRefresh: typeof auth.last_refresh === "string" ? auth.last_refresh : null,
    proCovered,
    dir,
    reason: proCovered
      ? `chatgpt login with plan "${planType}" — subscription-covered`
      : chatgptLogin
        ? `chatgpt login with plan ${planType ?? "unknown"} — not pro/pro-lite, normal selection applies`
        : `auth_mode ${authMode ?? "unknown"} (no chatgpt login), normal selection applies`,
  };
}

/**
 * The reviewer-role model override for the current codex login state.
 * Non-null ONLY when a Pro / Pro-Lite ChatGPT login is active.
 * @param {ReturnType<typeof readCodexPlan> | null | undefined} codexPlan
 * @returns {{ model: string, reasoningEffort: string, providerLabel: string, planType: string, planLabel: string } | null}
 */
export function reviewerPlanOverride(codexPlan) {
  if (!codexPlan?.proCovered) return null;
  return {
    model: PLAN_REVIEWER_DEFAULTS.model,
    reasoningEffort: PLAN_REVIEWER_DEFAULTS.reasoningEffort,
    providerLabel: `ChatGPT ${codexPlan.planLabel} login (local codex)`,
    planType: /** @type {string} */ (codexPlan.planType),
    planLabel: /** @type {string} */ (codexPlan.planLabel),
  };
}
