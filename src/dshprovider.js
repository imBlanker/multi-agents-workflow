// @ts-check
// DeepSeek Harness (dsh) provider/model reader — WITHOUT cc-switch.
//
// dsh is not managed by cc-switch (no `dsh` app_type, no proxy). Its provider
// truth lives in `$DSH_HOME/settings.yaml` under `llm-pi-ai.providers.<id>`
// (baseURL, api, apiKeyEnv, models[{id,name,contextWindow,maxTokens,input}]),
// with credentials in `$DSH_HOME/.credentials.yaml` (write-only; referenced
// by apiKeyEnv). This module reads those files and exposes a cc-switch-shaped
// object so modelcap / planner / cost reuse works — mirroring piprovider.js.
//
// Pricing: dsh itself has no price source, but cc-switch auto-syncs model
// prices (models.dev) into `~/.cc-switch/model-pricing.json`. Model ids that
// match get REAL per-M prices (source "cc-switch-pricing-json"); unmatched
// ids simply have no entry (price gate reports "unknown" — never fabricated).
import { execFile } from "./platform/index.js";
import path from "node:path";
import fs from "node:fs";
import { home, exists, readText, readJson, parseYamlSubset } from "./util.js";

/** @returns {string|null} */
export function findDshHome() {
  const dir = process.env.DSH_HOME || path.join(home(), ".dsh");
  return exists(dir) ? dir : null;
}

/**
 * Read $DSH_HOME/settings.yaml into { dshHome, settings }.
 * Returns null when the home or file is missing, or the YAML is beyond the
 * subset parser (caller degrades gracefully — never throws).
 * @param {string} [dshHome]
 */
export function readDshConfig(dshHome) {
  const dir = dshHome || findDshHome();
  if (!dir) return null;
  const file = path.join(dir, "settings.yaml");
  if (!exists(file)) return null;
  try {
    return { dshHome: dir, settings: parseYamlSubset(readText(file)) };
  } catch {
    return null;
  }
}

/**
 * Read cc-switch's auto-synced model price JSON (`model-pricing.json`,
 * populated by its models.dev sync). Returns a modelPricing map in the same
 * shape cc-switch's SQLite table produces (numbers per M tokens), tagged
 * source "cc-switch-pricing-json". Honors `deletedModelIds`. Missing or
 * unparseable file → {} (non-fatal).
 * @param {string} [pricingPath]
 * @returns {Record<string, any>}
 */
export function readCcPricingJson(pricingPath) {
  const file = pricingPath || path.join(home(), ".cc-switch", "model-pricing.json");
  let doc = null;
  try {
    doc = readJson(file);
  } catch {
    return {};
  }
  if (!doc || !Array.isArray(doc.models)) return {};
  const deleted = new Set(Array.isArray(doc.deletedModelIds) ? doc.deletedModelIds : []);
  /** @type {Record<string, any>} */
  const out = {};
  for (const m of doc.models) {
    if (!m || typeof m.modelId !== "string" || deleted.has(m.modelId)) continue;
    out[m.modelId] = {
      model_id: m.modelId,
      display_name: m.displayName ?? m.modelId,
      input_per_m: Number(m.inputCostPerMillion ?? 0) || 0,
      output_per_m: Number(m.outputCostPerMillion ?? 0) || 0,
      cache_read_per_m: Number(m.cacheReadCostPerMillion ?? 0) || 0,
      cache_creation_per_m: Number(m.cacheCreationCostPerMillion ?? 0) || 0,
      source: "cc-switch-pricing-json",
    };
  }
  return out;
}

/**
 * Enumerate dsh profile names under $DSH_HOME/profiles — directories only,
 * skipping `node_modules` (pnpm/dsh symlink farm for global deps, NOT a
 * profile) and dot-entries. Missing dir → []. Never throws.
 * @param {string} [dshHome]
 * @returns {string[]}
 */
export function listDshProfiles(dshHome) {
  const dir = dshHome || findDshHome();
  if (!dir) return [];
  const profilesDir = path.join(dir, "profiles");
  if (!exists(profilesDir)) return [];
  try {
    return fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Credential KEY NAMES present in $DSH_HOME/.credentials.yaml — names only,
 * values are never read or copied (they are write-only secrets).
 * @param {string} [dshHome]
 * @returns {string[]}
 */
export function readCredentialKeys(dshHome) {
  const dir = dshHome || findDshHome();
  if (!dir) return [];
  const file = path.join(dir, ".credentials.yaml");
  if (!exists(file)) return [];
  try {
    const keys = [];
    for (const line of readText(file).split(/\r?\n/)) {
      // top-level `key:` line — capture the KEY only, never the value
      const m = line.match(/^([A-Za-z0-9_.-]+):/);
      if (m && !/^\s/.test(line)) keys.push(m[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Best-effort default {provider, model} from the composed
 * `agent-default-model` row, extracted from `dsh --profile <p> --dump-config`
 * output (zero-parse regex; the full dump is JS-tagged YAML we must not
 * parse). Cached in-memory per profile. opts.dumpConfig overrides the
 * subprocess for tests. Returns null on any failure.
 * @param {{ profile?: string, dumpConfig?: string }} [opts]
 * @returns {{ provider: string, model: string } | null}
 */
let _dumpCache = /** @type {Record<string, any>} */ ({});
export function dshDefaultModel(opts = {}) {
  const profile = opts.profile || "web";
  if (opts.dumpConfig !== undefined) {
    return extractDefaultModel(opts.dumpConfig);
  }
  if (profile in _dumpCache) return _dumpCache[profile];
  let out = null;
  try {
    const dump = execFile("dsh", ["--profile", profile, "--dump-config"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 15000,
    });
    out = extractDefaultModel(dump);
  } catch {
    out = null;
  }
  _dumpCache[profile] = out;
  return out;
}

/**
 * Extract {provider, model} from the `agent-default-model` row of a
 * --dump-config listing (zero-parse regex over the JS-tagged YAML).
 * @param {string} dump
 */
function extractDefaultModel(dump) {
  const m = dump.match(/id:\s*agent-default-model\b[\s\S]{0,400}?\bprovider:\s*'?([^\s'\n]+)'?[\s\S]{0,200}?\bmodel:\s*'?([^\s'\n]+)'?/);
  return m ? { provider: m[1], model: m[2] } : null;
}

/**
 * Cost-control note for dsh hosts (mirrors piCostRateNote's role).
 * @returns {string}
 */
export function dshCostRateNote() {
  return "dsh is not cc-switch-managed: spend rate (USD/min) is not measured, so cost-rate limits degrade to concurrency-only (mawf acquire/release). Prices come from ~/.cc-switch/model-pricing.json where model ids match.";
}

/**
 * Read dsh providers/models as a cc-switch-shaped object (mirrors readPiAsCc):
 * { appTypes, currentProviders, allProviders, modelPricing, credentialKeys }.
 * Provider rows carry app_type "dsh"; settings_config._dshModels holds the
 * model id list (consumed by providerModels(sc, "dsh")) and
 * settings_config._dshModelMeta the per-model metadata. NO credential values
 * are copied — apiKeyEnv holds the env var NAME only.
 * @param {{ dshHome?: string, pricingPath?: string, ccSwitch?: { modelPricing?: Record<string, any> }, profile?: string, dumpConfig?: string }} [opts]
 * @returns {any | null}
 */
export function readDshAsCc(opts = {}) {
  const cfg = readDshConfig(opts.dshHome);
  if (!cfg) return null;
  const settings = cfg.settings || {};
  const llm = settings["llm-pi-ai"] ?? {};
  const providersMap =
    llm && typeof llm.providers === "object" && !Array.isArray(llm.providers) ? llm.providers : {};

  // pricing: cc-switch synced JSON first, SQLite cross-ref fills gaps (pi pattern)
  /** @type {Record<string, any>} */
  const modelPricing = { ...readCcPricingJson(opts.pricingPath) };
  if (opts.ccSwitch?.modelPricing) {
    for (const [k, v] of Object.entries(opts.ccSwitch.modelPricing)) {
      if (!modelPricing[k]) modelPricing[k] = v;
    }
  }

  const def = dshDefaultModel({ profile: opts.profile, dumpConfig: opts.dumpConfig }) || {};
  const entries = Object.entries(providersMap);
  let defaultProvider = def.provider || "";
  if (!defaultProvider && entries.length) defaultProvider = entries[0][0];

  /** @type {any[]} */
  const allProviders = [];
  /** @type {Record<string, any>} */
  const currentProviders = {};
  for (const [name, prov] of entries) {
    const p = prov && typeof prov === "object" ? prov : {};
    const models = Array.isArray(p.models) ? p.models : [];
    const ids = models.map((m) => m?.id).filter(Boolean);
    const isCurrent = name === defaultProvider;
    const row = {
      id: name,
      name: name,
      app_type: "dsh",
      is_current: isCurrent ? 1 : 0,
      provider_type: p.api || "openai-completions",
      cost_multiplier: 1,
      baseURL: p.baseURL || null,
      apiKeyEnv: p.apiKeyEnv || null, // env var NAME only — never a secret
      settings_config: {
        model: isCurrent ? (def.model || ids[0] || "") : (ids[0] || ""),
        // _dshModels mirrors _piModels: the id list providerModels(sc,"dsh") consumes.
        _dshModels: ids,
        _dshModelMeta: models.map((m) => ({
          id: m?.id ?? null,
          name: m?.name ?? null,
          contextWindow: m?.contextWindow ?? null,
          maxTokens: m?.maxTokens ?? null,
          input: Array.isArray(m?.input) ? m.input : null,
        })),
      },
    };
    allProviders.push(row);
    if (isCurrent) currentProviders.dsh = row;
  }
  if (!currentProviders.dsh && allProviders.length) {
    const fb = { ...allProviders[0], is_current: 1 };
    currentProviders.dsh = fb;
    allProviders[0] = fb;
  }

  return {
    dshHome: cfg.dshHome,
    appTypes: allProviders.length ? ["dsh"] : [],
    currentProviders,
    allProviders,
    modelPricing,
    credentialKeys: readCredentialKeys(cfg.dshHome),
  };
}
