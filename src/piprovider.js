// @ts-check
// Pi Agent provider/model reader. cc-switch does NOT manage pi (no `pi`
// app_type; pi is not routed via its proxy). Pi keeps its own provider + model
// + pricing config in ~/.pi/agent/. This module reads those files and produces
// a cc-switch-shaped object so modelcap.js / configgen.js work unchanged.
//
// SECURITY: auth.json keys and models.json `apiKey` fields are NEVER returned.
// We only report auth/config presence so downstream can show "configured".
import path from "node:path";
import { exists, readJson, home } from "./util.js";

/**
 * Resolve the chosen Pi home, even before it exists (installer use).
 * @param {string} [piDir] explicit caller override
 * @returns {string}
 */
export function resolvePiAgentDir(piDir) {
  return piDir ?? (process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(home(), ".pi", "agent"));
}

/** @param {string} [piDir] @returns {string} chosen Pi home when present, else "" */
export function findPiAgentDir(piDir) {
  const dir = resolvePiAgentDir(piDir);
  return exists(dir) ? dir : "";
}

/**
 * Read raw pi config files. Does NOT exfiltrate keys: auth.json is presence-only
 * and models.json apiKey fields stay inside `models` (callers must not copy them
 * across — readPiAsCc deliberately omits them).
 * @param {string} [piDir]
 * @returns {{
 *   settings: any,
 *   models: any,
 *   modelsStore: any,
 *   mcp: any,
 *   authPresent: boolean,
 *   impl: "pi-files"
 * } | null}
 */
export function readPiConfig(piDir) {
  const dir = findPiAgentDir(piDir);
  if (!dir || !exists(dir)) return null;
  return {
    settings: readJson(path.join(dir, "settings.json"), {}),
    models: readJson(path.join(dir, "models.json"), { providers: {} }),
    modelsStore: readJson(path.join(dir, "models-store.json"), {}),
    mcp: readJson(path.join(dir, "mcp.json"), { mcpServers: {} }),
    authPresent: exists(path.join(dir, "auth.json")),
    impl: "pi-files",
  };
}

/**
 * Cost-rate note shown wherever a pi host has no cc-switch spend telemetry.
 * @param {boolean} [spendMeasured] true when cc-switch Pi (Session) import rows exist
 * @returns {string}
 */
export function piCostRateNote(spendMeasured) {
  return spendMeasured
    ? "pi spend measured via cc-switch Pi (Session) import — cache-write accounting may be incomplete"
    : "pi not routed via cc-switch proxy; spend not measured — concurrency-only enforcement";
}

/**
 * Map pi config into the cc-switch-shaped object consumed by modelcap/configgen.
 *
 * Provider rows carry app_type:"pi"; settings_config holds { model, _piModels }
 * (the full model id list for that provider) so `providerModels(sc, "pi")`
 * enumerates every model. Pricing comes from models.json `cost` fields
 * (per-M-token USD, same scale as cc-switch model_pricing). cc-switch pricing
 * is merged in when passed via opts.ccSwitch so shared model ids (gpt-5.5,
 * claude-*) keep their cc-switch entries. apiKey bytes are NEVER copied across.
 *
 * @param {object} [opts]
 * @param {string} [opts.piDir]
 * @param {{ modelPricing?: Record<string, any> }} [opts.ccSwitch] optional cc-switch data for pricing cross-ref
 * @param {boolean} [opts.piManaged] true when cc-switch v3.20+ (schema v17) manages pi:
 *   cc-switch model_pricing entries are EXACT and pi models.json `cost` fields
 *   only fill gaps instead of overwriting them (prevents double/conflicting pricing).
 * @param {boolean} [opts.piSpendMeasured] true when cc-switch Pi (Session) rows exist —
 *   switches the costNote to the measured wording (with the upstream caveat).
 * @returns {any | null}
 */
export function readPiAsCc(opts = {}) {
  const cfg = readPiConfig(opts.piDir);
  if (!cfg) return null;
  const settings = cfg.settings || {};
  const providersMap = (cfg.models && cfg.models.providers) || {};
  const defaultProvider = settings.defaultProvider || "";
  const defaultModel = settings.defaultModel || "";

  /** @type {any[]} */
  const allProviders = [];
  /** @type {Record<string, any>} */
  const modelPricing = { ...(opts.ccSwitch?.modelPricing || {}) };
  /** @type {Record<string, any>} */
  const currentProviders = {};

  for (const [name, prov] of Object.entries(providersMap)) {
    const models = Array.isArray(prov?.models) ? prov.models : [];
    const ids = models.map((m) => m?.id).filter(Boolean);
    const isCurrent = name === defaultProvider;
    const row = {
      id: name,
      name,
      app_type: "pi",
      is_current: isCurrent ? 1 : 0,
      provider_type: "pi",
      cost_multiplier: 1,
      // settings_config mirrors the cc-switch shape; _piModels is the
      // pi-specific model list consumed by providerModels(sc, "pi").
      // NO apiKey is copied across (presence-only telemetry below).
      settings_config: { model: isCurrent ? defaultModel : (ids[0] || ""), _piModels: ids },
    };
    allProviders.push(row);
    if (isCurrent) currentProviders.pi = row;
    // pricing: pi models.json cost is per-M-token USD, same scale as cc-switch.
    // piManaged: cc-switch db prices are exact and win; models.json only fills
    // gaps. Unmanaged: models.json cost is what pi actually pays on its direct
    // API keys and stays authoritative for pi-configured models.
    for (const m of models) {
      if (!m?.id || !m?.cost) continue;
      if (opts.piManaged && modelPricing[m.id]) continue;
      modelPricing[m.id] = {
        input_per_m: Number(m.cost.input ?? 0),
        output_per_m: Number(m.cost.output ?? 0),
        source: "pi-models.json",
        estimated: false,
      };
    }
  }

  // merge catalog providers from models-store.json — pi's cached remote
  // catalogs (subscription/built-in providers like openai-codex / deepseek /
  // zai-coding-cn, switchable via /model once auth is configured; docs:
  // providers.md + sdk.md). A catalog name already present in models.json
  // extends that provider's model list instead of duplicating it.
  const store = cfg.modelsStore && typeof cfg.modelsStore === "object" ? cfg.modelsStore : {};
  for (const [name, entry] of Object.entries(store)) {
    const raw = Array.isArray(entry?.models) ? entry.models : [];
    const ids = raw.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
    if (!ids.length) continue;
    const existing = allProviders.find((p) => p.id === name);
    if (existing) {
      const merged = [...new Set([...(existing.settings_config._piModels || []), ...ids])];
      existing.settings_config._piModels = merged;
      if (!existing.settings_config.model) existing.settings_config.model = merged[0];
    } else {
      allProviders.push({
        id: name,
        name,
        app_type: "pi",
        is_current: 0,
        provider_type: "pi-catalog",
        cost_multiplier: 1,
        settings_config: { model: ids[0], _piModels: ids, _piCatalog: true },
      });
    }
  }

  if (!currentProviders.pi && allProviders.length) {
    // defaultProvider not found among providers — fall back to the first one
    const fb = { ...allProviders[0], is_current: 1 };
    currentProviders.pi = fb;
    allProviders[0] = fb;
  }

  return {
    impl: "pi-files",
    dbPath: "", // signals "not cc-switch" to cost-rate paths
    settings,
    currentProviders,
    allProviders,
    modelPricing,
    // presence-only telemetry (no key bytes)
    authPresent: cfg.authPresent,
    mcpServers: Object.keys((cfg.mcp && cfg.mcp.mcpServers) || {}),
    packages: Array.isArray(settings.packages) ? settings.packages : [],
    costNote: piCostRateNote(opts.piSpendMeasured),
  };
}

/**
 * Managed-pi enrichment: cc-switch db rows (app_type='pi') are presence
 * records — the model LISTS live in ~/.pi/agent/models.json (which cc-switch
 * itself wrote). Join them back into the db rows BY PROVIDER NAME so
 * capability/model views are not sparse. Read-only; PRICING IS NOT TOUCHED
 * (db-exact prices keep priority; this only fills `_piModels`/`model` hints
 * when the db row carries none). Pure.
 * @param {any} cc cc-switch ctx from readCcSwitch() (mutated copy returned)
 * @param {string} [piDir]
 * @returns {any}
 */
export function enrichPiDbRowsWithModelsJson(cc, piDir) {
  if (!cc || !Array.isArray(cc.allProviders)) return cc;
  const cfg = readPiConfig(piDir);
  if (!cfg) return cc;
  const providersMap = (cfg.models && cfg.models.providers) || {};
  const store = cfg.modelsStore && typeof cfg.modelsStore === "object" ? cfg.modelsStore : {};
  const idsFor = (entry) => {
    const raw = Array.isArray(entry?.models) ? entry.models : [];
    return raw.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
  };
  for (const row of cc.allProviders) {
    if (row.app_type !== "pi") continue;
    const sc = row.settingsConfig || {};
    if (Array.isArray(sc._piModels) && sc._piModels.length) continue; // db row already carries models
    const ids = idsFor(providersMap[row.name] || store[row.name]);
    if (!ids.length) continue;
    sc._piModels = ids;
    if (!sc.model) sc.model = ids[0];
    row.settingsConfig = sc;
    if (row.settings_config) row.settings_config = sc; // keep raw mirror in sync
  }
  return cc;
}

/**
 * Merge a readPiAsCc() result into a cc-switch ctx (mirrors the dsh merge in
 * loadCtx). ONLY for pi NOT managed by cc-switch: when cc-switch v3.20+
 * manages pi, its own db rows already flow through readCcSwitch() and merging
 * models.json rows on top would double-count providers. Pricing fills gaps
 * only — shared model ids keep their cc-switch entries so claude/codex views
 * are never contaminated by pi-specific prices. Pure.
 * @param {any} cc cc-switch ctx (mutated copy returned)
 * @param {any | null} piAsCc result of readPiAsCc()
 * @returns {any}
 */
export function mergePiIntoCc(cc, piAsCc) {
  if (!piAsCc || !cc) return cc;
  cc.allProviders = [...(cc.allProviders || []), ...piAsCc.allProviders];
  if (piAsCc.currentProviders.pi) cc.currentProviders.pi = piAsCc.currentProviders.pi;
  cc.appTypes = [...new Set([...(cc.appTypes || []), "pi"])];
  const merged = { ...(cc.modelPricing || {}) };
  for (const [k, v] of Object.entries(piAsCc.modelPricing)) if (!merged[k]) merged[k] = v;
  cc.modelPricing = merged;
  return cc;
}
