// @ts-check
// Read-only access to the cc-switch SQLite database.
//
// cc-switch stores, per "app_type" (claude / codex / gemini / opencode ...):
//   - providers: which provider is `is_current`, its cost_multiplier, provider_type
//   - model_pricing: per-model per-million-token USD prices
//   - proxy_request_logs: actual request spend + timestamps (for cost-rate)
//   - settings: misc key/value
//
// We read it with the built-in `node:sqlite` (Node >=22.5, no native deps).
// If that is unavailable we fall back to the `sqlite3` CLI in JSON mode.
// All access is read-only.
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { exists, round, isoNow } from "./util.js";

// Resolve the optional node:sqlite binding once at module load (top-level await
// is allowed in ESM). If absent, we use the sqlite3 CLI.
let NODE_SQLITE = null;
try { NODE_SQLITE = await import("node:sqlite"); } catch { NODE_SQLITE = null; }

/** @returns {string|null} path to the cc-switch db, or null if not found */
export function findDb() {
  const candidates = [
    process.env.CC_SWITCH_DB,
    path.join(os.homedir(), ".cc-switch", "cc-switch.db"),
    path.join(os.homedir(), ".config", "cc-switch", "cc-switch.db"),
  ];
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

/**
 * @typedef {{ all: (sql: string, ...params: any[]) => any[], impl: string, close: () => void }} Reader
 */

/**
 * Open a read-only sqlite reader.
 * @param {string} dbPath
 * @returns {Reader}
 */
function makeReader(dbPath) {
  if (NODE_SQLITE?.DatabaseSync) {
    try {
      const db = new NODE_SQLITE.DatabaseSync(dbPath, { readOnly: true });
      return {
        impl: "node:sqlite",
        all(sql, ...params) {
          try { return db.prepare(sql).all(...params); } catch { return []; }
        },
        close() { try { db.close(); } catch {} },
      };
    } catch { /* fall through to CLI */ }
  }
  return {
    impl: "sqlite3-cli",
    all(sql) {
      try {
        const out = execFileSync("sqlite3", ["-json", "-readonly", dbPath, sql], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        return out.trim() ? JSON.parse(out) : [];
      } catch { return []; }
    },
    close() {},
  };
}

/** @param {any} v @returns {number} */
function num(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {string} s */
function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Highest cc-switch db schema version MAW's read layer is verified against.
 *  v17 (cc-switch v3.20.0 / cli v5.10.2) adds the `session_usage_dedup`
 *  ledger + pi app management; v18 adds nullable session-log byte cursors.
 *  Both retain the provider/usage contracts read by MAW. */
export const SUPPORTED_CC_SCHEMA = 18;

/**
 * Read everything MAW needs from cc-switch in one shot.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 */
export function readCcSwitch(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) {
    return {
      dbPath: "", impl: "none", appTypes: [], currentProviders: {},
      allProviders: [], modelPricing: {}, settings: {},
      schemaVersion: 0, schemaSupported: true,
    };
  }
  const r = makeReader(dbPath);
  // Schema-version guard: MAW is read-only and additive upstream migrations
  // keep parsing, but a NEWER-than-supported schema means unverified semantics
  // — surface it (doctor) instead of failing silently or crashing.
  const vRow = (r.all("PRAGMA user_version") || [])[0];
  const schemaVersion = num(vRow ? vRow.user_version : 0);
  const schemaSupported = schemaVersion <= SUPPORTED_CC_SCHEMA;
  const allProviders = r.all(
    "SELECT id, app_type, name, is_current, provider_type, cost_multiplier, limit_daily_usd, limit_monthly_usd, website_url, category, sort_index, settings_config FROM providers ORDER BY app_type, is_current DESC, sort_index"
  );
  // Parse each provider's settings_config into `settingsConfig` so callers can
  // enumerate every candidate (provider × model) for capability-aware selection.
  for (const p of allProviders) {
    if (p.settings_config) {
      try { p.settingsConfig = JSON.parse(p.settings_config); } catch { p.settingsConfig = {}; }
      delete p.settings_config;
    }
  }
  const appTypes = [...new Set(allProviders.map((p) => p.app_type))];
  const currentProviders = {};
  for (const p of allProviders) if (p.is_current) currentProviders[p.app_type] = p;

  for (const at of Object.keys(currentProviders)) {
    const row = r.all(
      `SELECT settings_config FROM providers WHERE app_type=${sqlStr(at)} AND is_current=1 LIMIT 1`
    )[0];
    if (row?.settings_config) {
      try { currentProviders[at].settings_config = JSON.parse(row.settings_config); }
      catch { currentProviders[at].settings_config = { raw: String(row.settings_config) }; }
    }
  }

  const pricingRows = r.all(
    "SELECT model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing"
  );
  const modelPricing = {};
  for (const p of pricingRows) {
    modelPricing[p.model_id] = {
      model_id: p.model_id,
      display_name: p.display_name,
      input_per_m: num(p.input_cost_per_million),
      output_per_m: num(p.output_cost_per_million),
      cache_read_per_m: num(p.cache_read_cost_per_million),
      cache_creation_per_m: num(p.cache_creation_cost_per_million),
      source: "cc-switch",
    };
  }

  const settingsRows = r.all("SELECT key, value FROM settings");
  const settings = {};
  for (const s of settingsRows) settings[s.key] = s.value;

  r.close();
  return { dbPath, impl: r.impl, appTypes, currentProviders, allProviders, modelPricing, settings, schemaVersion, schemaSupported };
}

/**
 * Read-only windowed spend attribution for the watchdog budget layer: sum of
 * total_cost_usd for rows created since `sinceSec` (optionally filtered to
 * app_types). Conservative by construction — window-attribution may include
 * concurrent non-rescue sessions on the same host, which stops escalation
 * EARLIER, never later. pi/dsh sessions without cc-switch telemetry are not
 * represented (spend stays 0 — the default cost-guard layer still bounds them).
 * @param {{ dbPath?: string, sinceSec: number, untilSec?: number, appTypes?: string[] }} opts
 * @returns {number} USD
 */
export function spendSince(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath || !Number.isFinite(opts.sinceSec)) return 0;
  try {
    const r = makeReader(dbPath);
    let where = `created_at >= ${Math.floor(opts.sinceSec)}`;
    if (Number.isFinite(opts.untilSec)) where += ` AND created_at <= ${Math.floor(/** @type {number} */ (opts.untilSec))}`;
    if (Array.isArray(opts.appTypes) && opts.appTypes.length) {
      where += " AND app_type IN (" + opts.appTypes.map(sqlStr).join(",") + ")";
    }
    const rows = r.all(`SELECT COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) as t FROM proxy_request_logs WHERE ${where}`);
    r.close();
    return num(rows?.[0]?.t);
  } catch { return 0; }
}

/**
 * cc-switch (GUI v3.20+ / CLI v5.10+) repo-backed skills management: rows in
 * the `skills` table with name LIKE 'mawf-%' mean cc-switch can update those
 * installations (`cc-switch skills update`) — coexistence with mawf's own
 * installer. Read-only; feature-detected (older schemas lack the table → null).
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {{ rows: { name: string, directory: string, enabledApps: string[] }[] } | null}
 */
export function mawfSkillsUnderCcSwitch(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) return null;
  try {
    const r = makeReader(dbPath);
    // feature-detect the table (readers swallow SQL errors → empty arrays,
    // so try/catch alone cannot distinguish "no table" from "no rows")
    const has = r.all("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'");
    if (!has || !has.length) { r.close(); return null; }
    const rows = r.all(
      "SELECT name, directory, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, enabled_hermes, enabled_grokbuild FROM skills WHERE name LIKE 'mawf-%'"
    );
    r.close();
    return {
      rows: rows.map((row) => ({
        name: row.name,
        directory: row.directory,
        enabledApps: ["claude", "codex", "gemini", "opencode", "hermes", "grokbuild"].filter((a) => Number(row["enabled_" + a]) === 1),
      })),
    };
  } catch { return null; }
}

/**
 * cc-switch v3.20.0+ manages pi as its 9th app: providers rows with
 * app_type='pi' appear (schema v17) and cc-switch writes `~/.pi/agent/
 * models.json` additively. When this returns true, the cc-switch db is the
 * authoritative (exact) source for pi providers/pricing and MAW must NOT
 * layer models.json-derived pi info on top of it (no double counting).
 * Pure; read-only.
 * @param {{ schemaVersion?: number, allProviders?: any[] }} ccInfo result of readCcSwitch()
 * @returns {boolean}
 */
export function piManagedByCcSwitch(ccInfo) {
  if (!ccInfo || !ccInfo.dbPath) return false;
  if ((ccInfo.schemaVersion ?? 0) < 17) return false;
  return (ccInfo.allProviders || []).some((p) => p.app_type === "pi");
}

/**
 * Provider balance / remaining-quota + current spend rate per provider.
 *  - remaining quota: providers.limit_daily_usd / limit_monthly_usd MINUS the
 *    spend recorded in usage_daily_rollups for today / this month. When a
 *    provider has NO limit set, remaining is `null` (= unknown, not infinite).
 *  - spend rate: real USD/min over the last hour from proxy_request_logs.
 * Read-only. Degrades gracefully when usage_daily_rollups does not exist.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {number} [opts.windowSeconds] rate window (default 3600)
 */
export function readProviderQuota(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  const win = opts.windowSeconds ?? 3600;
  const out = { dbPath: dbPath ?? "", providers: /** @type {Record<string, any>} */ ({}), tableMissing: false, windowSeconds: win };
  if (!dbPath) return out;
  const r = makeReader(dbPath);
  const provs = r.all("SELECT id, app_type, name, is_current, cost_multiplier, limit_daily_usd, limit_monthly_usd FROM providers");
  const hasRollups = r.all("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_daily_rollups'").length > 0;
  out.tableMissing = !hasRollups;
  /** @type {Record<string, number>} */
  const todayMap = {}, monthMap = {}, rateMap = {};
  if (hasRollups) {
    for (const row of r.all("SELECT provider_id, SUM(CAST(total_cost_usd AS REAL)) AS t FROM usage_daily_rollups WHERE date=date('now') GROUP BY provider_id")) todayMap[row.provider_id] = num(row.t);
    for (const row of r.all("SELECT provider_id, SUM(CAST(total_cost_usd AS REAL)) AS t FROM usage_daily_rollups WHERE date>=date('now','start of month') GROUP BY provider_id")) monthMap[row.provider_id] = num(row.t);
  }
  const since = Math.floor(Date.now() / 1000) - win;
  for (const row of r.all(`SELECT provider_id, SUM(CAST(total_cost_usd AS REAL)) AS t FROM proxy_request_logs WHERE created_at >= ${since} GROUP BY provider_id`)) rateMap[row.provider_id] = num(row.t);
  r.close();
  const minutes = Math.max(win / 60, 1 / 60);
  for (const p of provs) {
    const limD = p.limit_daily_usd == null ? null : num(p.limit_daily_usd);
    const limM = p.limit_monthly_usd == null ? null : num(p.limit_monthly_usd);
    const spendT = hasRollups ? (todayMap[p.id] ?? 0) : null;
    const spendM = hasRollups ? (monthMap[p.id] ?? 0) : null;
    out.providers[p.id] = {
      providerId: p.id, name: p.name, appType: p.app_type, isCurrent: !!p.is_current,
      limitDailyUsd: limD, limitMonthlyUsd: limM,
      spendTodayUsd: spendT == null ? null : round(spendT, 4),
      spendMonthUsd: spendM == null ? null : round(spendM, 4),
      remainingTodayUsd: limD == null || spendT == null ? null : round(Math.max(limD - spendT, 0), 4),
      remainingMonthUsd: limM == null || spendM == null ? null : round(Math.max(limM - spendM, 0), 4),
      ratePerMin: round((rateMap[p.id] ?? 0) / minutes, 4),
      quotaKnown: limD != null || limM != null,
    };
  }
  return out;
}

/**
 * Resolve the "current model" for an app_type from the current provider's
 * settings_config env block (Claude Code style) or top-level config (Codex).
 * @param {Record<string, any>} currentProviders
 * @param {string} appType
 */
export function resolveModel(currentProviders, appType) {
  const p = currentProviders[appType];
  if (!p) return { model: null, env: {}, raw: null };
  const sc = p.settings_config ?? {};
  const env = {};
  if (sc.env && typeof sc.env === "object") {
    for (const [k, v] of Object.entries(sc.env)) env[k] = String(v);
  }
  let model = env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || sc.model || null;
  if (appType === "codex") model = sc.model || env.CODEX_MODEL || model;
  if (appType === "gemini") model = env.GEMINI_MODEL || sc.model || model;
  return { model, env, raw: sc };
}

/**
 * Sum actual spend from proxy_request_logs over the last `windowSeconds` and
 * divide by (windowSeconds/60) to get USD/min. This is the *real* inference
 * cost rate (not a token estimate), per the spec.
 * @param {object} opts
 * @param {string} [opts.dbPath]
 * @param {number} [opts.windowSeconds] default 3600 (1h)
 * @param {string} [opts.appType]
 * @param {string} [opts.sessionId]
 */
export function costRate(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  const win = opts.windowSeconds ?? 3600;
  if (!dbPath) return { ratePerMin: 0, totalUsd: 0, requestCount: 0, windowSeconds: win, impl: "none" };
  const r = makeReader(dbPath);
  const since = Math.floor(Date.now() / 1000) - win;
  let where = "created_at >= " + since;
  if (opts.appType) where += " AND app_type=" + sqlStr(opts.appType);
  if (opts.sessionId) where += " AND session_id=" + sqlStr(opts.sessionId);
  const rows = r.all(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) as total FROM proxy_request_logs WHERE ${where}`
  );
  const row = rows[0] || { cnt: 0, total: 0 };
  r.close();
  const totalUsd = num(row.total);
  const minutes = Math.max(win / 60, 1 / 60);
  return {
    ratePerMin: round(totalUsd / minutes, 4),
    totalUsd: round(totalUsd, 6),
    requestCount: num(row.cnt),
    windowSeconds: win,
    impl: r.impl,
  };
}

/**
 * Per-session (== per-agent run) spend breakdown.
 * `errorCount` counts requests with status_code >= 400 or a non-null
 * error_message in the window — the watchdog's signal-d source (errors /
 * interrupted turns, incl. cc-switch's Pi (Session) imported rows).
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {number} [opts.windowSeconds]
 */
export function perSessionRate(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  const win = opts.windowSeconds ?? 3600;
  if (!dbPath) return { sessions: [], windowSeconds: win };
  const r = makeReader(dbPath);
  const since = Math.floor(Date.now() / 1000) - win;
  const rows = r.all(
    `SELECT session_id, app_type, model, COUNT(*) as cnt, COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) as total, MAX(created_at) as last, SUM(CASE WHEN CAST(status_code AS INTEGER) >= 400 OR error_message IS NOT NULL AND error_message != '' THEN 1 ELSE 0 END) as errs FROM proxy_request_logs WHERE created_at >= ${since} AND session_id IS NOT NULL GROUP BY session_id, app_type ORDER BY total DESC LIMIT 200`
  );
  r.close();
  const minutes = Math.max(win / 60, 1 / 60);
  const sessions = rows.map((row) => ({
    sessionId: row.session_id, appType: row.app_type, model: row.model,
    totalUsd: round(num(row.total), 6),
    ratePerMin: round(num(row.total) / minutes, 4),
    requestCount: num(row.cnt), lastAt: num(row.last),
    errorCount: num(row.errs),
  }));
  return { sessions, windowSeconds: win };
}

/**
 * True when cc-switch's Pi (Session) importer has put pi spend rows in the db
 * within the window (data_source='pi-session', app_type='pi') — i.e. pi spend
 * is MEASURED (not concurrency-only). Feature-detected; any error → false.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {number} [opts.windowSeconds]
 * @returns {boolean}
 */
export function piSessionUsagePresent(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  const win = opts.windowSeconds ?? 3600;
  if (!dbPath) return false;
  try {
    const r = makeReader(dbPath);
    const since = Math.floor(Date.now() / 1000) - win;
    const rows = r.all(
      `SELECT COUNT(*) as n FROM proxy_request_logs WHERE created_at >= ${since} AND app_type='pi' AND data_source='pi-session'`
    );
    r.close();
    return num(rows?.[0]?.n) > 0;
  } catch { return false; }
}

// -----------------------------------------------------------------------------
// cc-switch "projects" (= the `profiles` table) + local-routing policy.
//
// cc-switch has no `projects` table; its per-project provisioning (providers,
// MCP, skills, prompts) lives in `profiles.payload`. The existing profiles are
// named "Claude Code 默认" / "Codex 默认" — they contain "默认" and are PROTECTED.
//
// DECOUPLING POLICY (2026-08-12): cc-switch's "project" feature (the `profiles`
// table) is incomplete and cc-switch-cli has not caught up, so MAW's project
// functionality is TEMPORARILY DECOUPLED from cc-switch: MAW no longer reads or
// writes profiles by default. MAW keeps full authority over project-level
// agent/subagent model configs (`.mawf/agents/*.json`) and only syncs provider
// config info (the high-value settings in each provider's config.toml /
// config.json, e.g. base_url / model / auth_mode / failover) READ-ONLY from
// cc-switch. The profile code modules below are KEPT (with tests) but disabled
// unless `MAW_CC_PROJECT_SYNC=1` is set (ops escape hatch, documented).
//
// Hard policy (enforced in guardSql / createProjectProfile):
//   - all existing cc-switch data is READ-ONLY
//   - MAW may only INSERT a new profile (its own project) and UPDATE that new
//     profile's own payload; it may NEVER UPDATE/DELETE any other row
//   - any profile whose name contains "默认" is never written, ever
//   - the only other allowed write is UPDATE proxy_config for app_type IN
//     ('claude','codex') — the explicit routing carve-out the user mandated
// -----------------------------------------------------------------------------

/**
 * Whether cc-switch project-profile sync is enabled. Default: DISABLED
 * (decoupled from cc-switch's incomplete "project" feature). Set
 * `MAW_CC_PROJECT_SYNC=1|true|yes` to temporarily re-enable the legacy
 * behavior (create/reuse a `profiles` row for this MAW project).
 * @returns {boolean}
 */
export function projectSyncEnabled() {
  const v = String(process.env.MAW_CC_PROJECT_SYNC || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Read all cc-switch profiles (projects), read-only.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 */
export function readProfiles(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) return { dbPath: "", profiles: [] };
  const r = makeReader(dbPath);
  const rows = r.all("SELECT id, name, payload, sort_order, created_at, updated_at FROM profiles ORDER BY sort_order, created_at");
  r.close();
  const profiles = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { payload = { raw: row.payload }; }
    return {
      id: row.id, name: row.name, payload, sortOrder: row.sort_order,
      createdAt: row.created_at, updatedAt: row.updated_at,
      isDefault: String(row.name).includes("默认"),
    };
  });
  return { dbPath, profiles };
}

/**
 * Read the local-routing + auto-failover state for claude/codex + detect codex
 * OpenAI-OAuth login (read-only).
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 */
export function readRouting(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  /** @type {any} */
  const out = { dbPath, claude: null, codex: null, codexOAuthInUse: false, claudeFailoverProviders: [], codexFailoverProviders: [], raw: {} };
  if (!dbPath) return out;
  const r = makeReader(dbPath);
  for (const row of r.all("SELECT app_type, proxy_enabled, enabled, auto_failover_enabled FROM proxy_config WHERE app_type IN ('claude','codex')")) {
    const o = { appType: row.app_type, proxyEnabled: num(row.proxy_enabled), enabled: num(row.enabled), autoFailoverEnabled: num(row.auto_failover_enabled) };
    out[row.app_type] = o; out.raw[row.app_type] = o;
  }
  out.claudeFailoverProviders = r.all("SELECT name FROM providers WHERE app_type='claude' AND in_failover_queue=1").map((p) => p.name);
  out.codexFailoverProviders = r.all("SELECT name FROM providers WHERE app_type='codex' AND in_failover_queue=1").map((p) => p.name);
  r.close();
  out.codexOAuthInUse = detectCodexOAuth(dbPath);
  return out;
}

/**
 * Detect whether codex is using an OpenAI OAuth (ChatGPT) login.
 * Signal 1: the current codex provider's settings_config.auth.auth_mode === "chatgpt".
 * Signal 2: a sibling codex_oauth_auth.json with a default account.
 * @param {string} dbPath
 */
function detectCodexOAuth(dbPath) {
  try {
    const r = makeReader(dbPath);
    const row = r.all("SELECT settings_config FROM providers WHERE app_type='codex' AND is_current=1 LIMIT 1")[0];
    r.close();
    if (row?.settings_config) {
      const sc = JSON.parse(row.settings_config);
      if (sc?.auth?.auth_mode === "chatgpt") return true;
    }
  } catch {}
  const oauthPath = path.join(path.dirname(dbPath), "codex_oauth_auth.json");
  if (exists(oauthPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
      if (d?.default_account_id && d?.accounts && Object.keys(d.accounts).length > 0) return true;
    } catch {}
  }
  return false;
}

/**
 * Compute the routing policy and the list of violations.
 *  - claude: local routing ON + auto-failover ON (always)
 *  - codex:  local routing OFF when OpenAI-OAuth login in use; ON otherwise
 * @param {ReturnType<typeof readRouting>} routing
 */
export function routingPolicy(routing) {
  /** @type {{app:string,field:string,expected:string,actual:string,reason?:string,fix:string}[]} */
  const violations = [];
  const c = routing.claude;
  if (!c || !(c.proxyEnabled && c.enabled)) violations.push({ app: "claude", field: "local_routing", expected: "on", actual: c ? (c.enabled ? "on" : "off") : "missing", fix: "UPDATE proxy_config SET proxy_enabled=1, enabled=1 WHERE app_type='claude'" });
  if (!c || !c.autoFailoverEnabled) violations.push({ app: "claude", field: "auto_failover", expected: "on", actual: c ? (c.autoFailoverEnabled ? "on" : "off") : "missing", fix: "UPDATE proxy_config SET auto_failover_enabled=1 WHERE app_type='claude'" });
  const cx = routing.codex;
  const codexShouldOn = !routing.codexOAuthInUse;
  if (codexShouldOn && (!cx || !cx.enabled)) violations.push({ app: "codex", field: "local_routing", expected: "on", actual: cx ? (cx.enabled ? "on" : "off") : "missing", reason: "codex is NOT using OpenAI-OAuth login → local routing must be ON", fix: "UPDATE proxy_config SET proxy_enabled=1, enabled=1 WHERE app_type='codex'" });
  if (!codexShouldOn && cx && cx.enabled) violations.push({ app: "codex", field: "local_routing", expected: "off", actual: "on", reason: "codex is using OpenAI-OAuth login → local routing must be OFF", fix: "UPDATE proxy_config SET enabled=0, proxy_enabled=0 WHERE app_type='codex'" });
  return { compliant: violations.length === 0, violations, codexOAuthInUse: routing.codexOAuthInUse, claudeFailoverProviders: routing.claudeFailoverProviders, codexFailoverProviders: routing.codexFailoverProviders, pi: "N/A (not cc-switch-managed; pi config lives in ~/.pi/agent/)", dsh: "N/A (not cc-switch-managed; dsh config lives in $DSH_HOME/settings.yaml)" };
}

/**
 * Hard guard for any write SQL. Refuses destructive statements and any
 * UPDATE/DELETE on protected tables (existing config is read-only). Allows:
 *   - INSERT INTO profiles        (a new MAW project)
 *   - UPDATE proxy_config           (the claude/codex routing carve-out)
 * @param {string} sql
 */
function guardSql(sql) {
  const s = String(sql).replace(/\s+/g, " ").toUpperCase();
  if (/\b(DROP|DELETE|TRUNCATE|VACUUM|ALTER|ATTACH|DETACH|PRAGMA)\b/.test(s)) return "destructive/system statement not allowed";
  if (/\bUPDATE\s+(PROFILES|PROVIDERS|SKILLS|MCP_SERVERS|PROMPTS|MODEL_PRICING|PROXY_REQUEST_LOGS|SETTINGS)\b/.test(s)) return "existing cc-switch config is read-only (UPDATE on protected table)";
  if (/\bINSERT\s+INTO\s+(PROVIDERS|SKILLS|MCP_SERVERS|PROMPTS|MODEL_PRICING|PROXY_REQUEST_LOGS|SETTINGS)\b/.test(s)) return "refused: cannot seed protected table";
  return null;
}

/** Open a read-write sqlite handle (busy-timeout aware). Falls back to CLI. */
function openWriter(dbPath) {
  if (NODE_SQLITE?.DatabaseSync) {
    const db = new NODE_SQLITE.DatabaseSync(dbPath);
    try { db.exec("PRAGMA busy_timeout=3000"); } catch {}
    return {
      impl: "node:sqlite",
      exec(sql) { db.exec(sql); },
      close() { try { db.close(); } catch {} },
    };
  }
  return {
    impl: "sqlite3-cli",
    exec(sql) { execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); },
    close() {},
  };
}

/** Run a guarded write statement (throws on policy violation). */
function runWrite(dbPath, sql) {
  const err = guardSql(sql);
  if (err) throw new Error("refused: " + err);
  const w = openWriter(dbPath);
  try { w.exec(sql); }
  finally { w.close(); }
}

/**
 * Create a NEW cc-switch project (profile) for an initialized MAW project.
 * The new profile references the CURRENT claude/codex providers and has EMPTY
 * mcp/skills/prompts — all provisioning is scoped to this new project only.
 * NEVER touches any profile whose name contains "默认". Idempotent (reuses an
 * existing same-named profile without modifying it).
 * @param {{ name: string, user?: string, hostApp?: string, dbPath?: string }} opts
 */
export function createProjectProfile(opts) {
  const name = opts.name;
  const user = opts.user || "";
  const dbPath = opts.dbPath ?? findDb();
  if (!name) return { ok: false, error: "project name required" };
  // DECOUPLED by default (2026-08-12): cc-switch's project feature is
  // incomplete; MAW manages project-level agent/subagent model configs itself
  // and only syncs provider configs read-only. Code kept for rollback.
  if (!projectSyncEnabled()) {
    return {
      ok: false, disabled: true, name,
      error: "cc-switch project-profile sync is decoupled (temporarily disabled); MAW manages project-level agent/subagent model configs in .mawf/ and only syncs provider configs read-only. Set MAW_CC_PROJECT_SYNC=1 to re-enable.",
    };
  }
  if (/默认/.test(name)) return { ok: false, error: "refused: project name contains '默认' (protected)", name };
  // pi/dsh are NOT cc-switch-managed: skip profile creation; providers/MCP/
  // skills live in the host's own files (~/.pi/agent/ for pi, $DSH_HOME for
  // dsh). The cc-switch snapshot still happens (read-only).
  if (opts.hostApp === "pi") return { ok: true, skipped: true, name, user, reason: "pi is not cc-switch-managed; providers/MCP/skills live in ~/.pi/agent/" };
  if (opts.hostApp === "dsh") return { ok: true, skipped: true, name, user, reason: "dsh is not cc-switch-managed; providers/MCP/skills live in $DSH_HOME (settings.yaml / patch layers)" };
  if (!dbPath) return { ok: false, error: "cc-switch database not found", name };
  const { profiles } = readProfiles({ dbPath });
  const protectedDefaults = profiles.filter((p) => p.isDefault).map((p) => p.name);
  const existing = profiles.find((p) => p.name === name);
  if (existing) {
    return { ok: true, reused: true, id: existing.id, name, user, protectedDefaults, note: "profile already exists; reused WITHOUT modification" };
  }
  const cc = readCcSwitch({ dbPath });
  const payload = {
    providers: { claude: cc.currentProviders.claude?.id || null, codex: cc.currentProviders.codex?.id || null },
    mcp: { claude: [], codex: [] },
    skills: { claude: [], codex: [] },
    prompts: { claude: null, codex: null },
    _maw: { createdFor: "maw", user, createdAt: isoNow() },
  };
  const id = `maw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    runWrite(dbPath, `INSERT INTO profiles (id, name, payload, sort_order, created_at, updated_at) VALUES ('${id}', ${sqlStr(name)}, ${sqlStr(JSON.stringify(payload))}, ${profiles.length || 0}, ${now}, ${now})`);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), name, user, protectedDefaults };
  }
  return { ok: true, created: true, id, name, user, protectedDefaults, payload };
}

/**
 * Apply the mandated routing policy by writing ONLY the proxy_config rows for
 * claude and codex (the explicit carve-out). No-op/dry-run unless opts.fix.
 * @param {{ dbPath?: string, fix?: boolean }} opts
 */
export function applyRouting(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) return { ok: false, error: "cc-switch database not found", applied: [] };
  const routing = readRouting({ dbPath });
  const policy = routingPolicy(routing);
  if (!opts.fix) return { ok: true, applied: [], policy, routing, note: "dry-run; pass fix:true to apply (writes ONLY proxy_config for claude/codex)" };
  /** @type {string[]} */
  const applied = [];
  try {
    runWrite(dbPath, "UPDATE proxy_config SET proxy_enabled=1, enabled=1, auto_failover_enabled=1, updated_at=datetime('now') WHERE app_type='claude'");
    applied.push("claude: local routing ON + auto-failover ON");
    if (routing.codexOAuthInUse) {
      runWrite(dbPath, "UPDATE proxy_config SET enabled=0, proxy_enabled=0, updated_at=datetime('now') WHERE app_type='codex'");
      applied.push("codex: local routing OFF (OpenAI-OAuth login in use)");
    } else {
      runWrite(dbPath, "UPDATE proxy_config SET proxy_enabled=1, enabled=1, updated_at=datetime('now') WHERE app_type='codex'");
      applied.push("codex: local routing ON (no OAuth login)");
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), applied, policy, routing };
  }
  return { ok: true, applied, policy, routing, note: "routing applied to proxy_config (claude/codex only); restart cc-switch GUI to reflect" };
}

/**
 * Restore cc-switch `proxy_config` (claude/codex rows) to the values captured
 * in a MAW pre-init snapshot (`~/.cc-switch/maw-backups/cc-switch-snapshot-*`,
 * written by `mawf init` BEFORE anything touches cc-switch). Opt-in uninstall
 * aid: ONLY proxy_config is touched (the same guardSql carve-out as
 * applyRouting); the rest of the snapshot stays available for manual restore.
 * Accepts a .tar.gz archive (extracted to a temp dir via the system tar) or a
 * snapshot directory (the no-tar fallback format), both containing cc-switch.db
 * at their root. opts.snapshot points at either; default = latest snapshot.
 * @param {{ dbPath?: string, backupsDir?: string, snapshot?: string }} [opts]
 * @returns {{ ok: boolean, applied: string[], error?: string, snapshot?: string }}
 */
export function restoreRoutingFromSnapshot(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) return { ok: false, applied: [], error: "cc-switch database not found" };
  const backupsDir = opts.backupsDir ?? path.join(path.dirname(dbPath), "maw-backups");
  let snapDir = opts.snapshot ? path.resolve(opts.snapshot) : "";
  let tmp = "";
  try {
    if (!snapDir) {
      if (!exists(backupsDir)) return { ok: false, applied: [], error: `no snapshots under ${backupsDir}` };
      const entries = fs.readdirSync(backupsDir).filter((f) => f.startsWith("cc-switch-snapshot-")).sort();
      if (!entries.length) return { ok: false, applied: [], error: `no snapshots under ${backupsDir}` };
      const latest = path.join(backupsDir, entries[entries.length - 1]);
      if (latest.endsWith(".tar.gz")) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-restore-"));
        execFileSync("tar", ["-xzf", latest, "-C", tmp], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
        snapDir = tmp;
      } else {
        snapDir = latest;
      }
    }
    const snapDb = path.join(snapDir, "cc-switch.db");
    if (!exists(snapDb)) return { ok: false, applied: [], error: `snapshot database not found: ${snapDb}` };
    const sr = makeReader(snapDb);
    const snapRows = sr.all("SELECT app_type, proxy_enabled, enabled, auto_failover_enabled FROM proxy_config WHERE app_type IN ('claude','codex')");
    sr.close();
    if (!snapRows.length) return { ok: false, applied: [], error: "snapshot has no claude/codex proxy_config rows" };

    const lr = makeReader(dbPath);
    const liveRows = {};
    for (const row of lr.all("SELECT app_type, proxy_enabled, enabled, auto_failover_enabled FROM proxy_config WHERE app_type IN ('claude','codex')")) liveRows[row.app_type] = row;
    lr.close();

    /** @type {string[]} */
    const applied = [];
    for (const s of snapRows) {
      const live = liveRows[s.app_type] ?? {};
      runWrite(dbPath, `UPDATE proxy_config SET proxy_enabled=${Number(s.proxy_enabled) || 0}, enabled=${Number(s.enabled) || 0}, auto_failover_enabled=${Number(s.auto_failover_enabled) || 0}, updated_at=datetime('now') WHERE app_type='${s.app_type}'`);
      applied.push(`${s.app_type}: enabled ${live.enabled ?? "?"}→${Number(s.enabled) || 0}, proxy ${live.proxy_enabled ?? "?"}→${Number(s.proxy_enabled) || 0}, failover ${live.auto_failover_enabled ?? "?"}→${Number(s.auto_failover_enabled) || 0}`);
    }
    return { ok: true, applied, snapshot: tmp ? `${opts.snapshot || "(latest archive)"} → extracted` : snapDir };
  } catch (e) {
    return { ok: false, applied: [], error: String(e?.message || e) };
  } finally {
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
