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
 * Names-only view of the credential reference space. Records contain opaque
 * OAuth payloads, not reference names. Unsupported layouts return no claims.
 * Values are read as text but never returned, logged, or included in errors.
 * @param {string} [dshHome]
 * @returns {string[]}
 */
export function readCredentialKeys(dshHome) {
  const dir = dshHome || findDshHome();
  if (!dir) return [];
  try {
    const lines = readText(path.join(dir, ".credentials.yaml")).split(/\r?\n/);
    const top = lines.filter((l) => l.trim() && !/^\s|^#/.test(l));
    const keyName = (line) => { const m = line.match(/^(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+)):/); return m ? m[1] || m[2] || m[3] : null; };
    const versioned = top.some((l) => keyName(l) === "version");
    if (versioned && !top.some((l) => /^version:\s*1\s*(?:#.*)?$/.test(l))) return [];
    if (versioned && top.some((l) => !/^(?:version|refs|records):/.test(l))) return [];
    if (!versioned && top.some((l) => /^(?:refs|records):/.test(l))) return [];
    const keys = [];
    const topKeys = new Set();
    let inRefs = !versioned;
    let valueIndent = null;
    for (const line of lines) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/\t/.test(line.match(/^\s*/)[0])) return [];
      const indent = line.match(/^ */)[0].length;
      if (valueIndent !== null && indent > valueIndent) continue;
      valueIndent = null;
      if (!indent) {
        const key = keyName(line);
        if (!key || topKeys.has(key)) return [];
        topKeys.add(key);
        if (versioned) {
          inRefs = key === "refs";
          if (inRefs && !/^refs:\s*(?:\{\})?\s*(?:#.*)?$/.test(line)) return [];
          continue;
        }
      }
      if (!inRefs) continue;
      if (indent !== (versioned ? 2 : 0)) return [];
      const m = line.trim().match(/^(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+)):\s+(.+)$/);
      if (!m) return [];
      const key = m[1] || m[2] || m[3];
      const value = m[4].trim();
      if (keys.includes(key) || /^(?:null|~|true|false|\d+)(?:\s+#.*)?$/.test(value) || /^[!&*[{]/.test(value)) return [];
      if (/^[|>][-+]?\s*(?:#.*)?$/.test(value)) valueIndent = indent;
      else if (/^["']/.test(value) && !/^(?:"(?:[^"\\]|\\.)+"|'(?:[^']|'')+')(?:\s+#.*)?$/.test(value)) return [];
      keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Bounded extraction of one ordinary component config from JS-tagged YAML.
 * Never evaluate tags; unsupported component configs yield null. Sibling
 * rows cannot supply a missing field, and disabled rows cannot select models.
 * @param {string} dump
 * @param {string} id
 */
export function extractDshComponent(dump, id) {
  const lines = String(dump).split(/\r?\n/);
  // Remove block-scalar bodies before looking for row headers. An embedded
  // script/string that happens to contain YAML must never create a component.
  let scalarIndent = null;
  for (let n = 0; n < lines.length; n++) {
    const indent = lines[n].match(/^ */)[0].length;
    if (scalarIndent !== null && (!lines[n].trim() || indent > scalarIndent)) {
      lines[n] = "";
      continue;
    }
    scalarIndent = null;
    if (/^\s*(?:- )?[\w-]+:\s*(?:![^\s]+\s+)?[|>][-+]?\s*(?:#.*)?$/.test(lines[n])) scalarIndent = indent;
  }
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^( *)- ([\w-]+):/);
    if (!header) continue;
    const depth = header[1].length + 2;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && !/^\s*#/.test(line) && line.match(/^ */)[0].length < depth) break;
      end++;
    }
    const body = [" ".repeat(depth) + lines[i].slice(depth), ...lines.slice(i + 1, end)];
    const fields = body.filter((l) => l.match(/^ */)[0].length === depth);
    const identity = fields.some((l) => {
      const m = l.trim().match(/^(id|name):\s*['"]?([^'"\s]+)['"]?\s*(?:#.*)?$/);
      return m && (m[2] === id || (m[1] === "name" && m[2] === `@deepseek-ai/dsh-${id}`));
    });
    if (!identity) continue;
    if (fields.some((l) => /^disabled:\s*true\s*(?:#.*)?$/.test(l.trim()))) return { disabled: true, config: null };
    const start = body.findIndex((l) => l.match(/^ */)[0].length === depth && /^config:\s*(?:#.*)?$/.test(l.trim()));
    if (start < 0) return { disabled: false, config: {} };
    const config = [];
    for (const line of body.slice(start + 1)) {
      if (line.trim() && !/^\s*#/.test(line) && line.match(/^ */)[0].length <= depth) break;
      config.push(line);
    }
    try { return { disabled: false, config: parseYamlSubset(config.join("\n")) }; }
    catch { return { disabled: false, config: null }; }
  }
  return null;
}

function selection(value) {
  if (!value || typeof value.provider !== "string" || typeof value.model !== "string") return null;
  if (!value.provider.trim() || !value.model.trim() || /^[!&*|>]/.test(value.provider.trim()) || /^[!&*|>]/.test(value.model.trim())) return null;
  return { provider: value.provider.trim(), model: value.model.trim() };
}

/** Read-only composition probe, always scoped to the requested home/profile. */
function composedDump(opts) {
  if (opts.dumpConfig !== undefined) return opts.dumpConfig;
  try {
    return execFile("dsh", ["--profile", opts.profile || "web", "--dump-config"], {
      stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 15000,
      env: { ...process.env, ...(opts.dshHome ? { DSH_HOME: opts.dshHome } : {}) },
    });
  } catch { return ""; }
}

/**
 * Saved settings override composition. No cache: settings are mutable, and
 * different homes/profiles must never reuse an earlier deployment selection.
 * @param {{ dshHome?: string, profile?: string, dumpConfig?: string }} [opts]
 * @returns {{ provider: string, model: string } | null}
 */
export function dshDefaultModel(opts = {}) {
  const saved = selection(readDshConfig(opts.dshHome)?.settings?.["agent-default-model"]);
  if (saved) return saved;
  const row = extractDshComponent(composedDump(opts), "agent-default-model");
  return row && !row.disabled ? selection(row.config) : null;
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
  if (!cfg && !opts.dumpConfig) return null;
  const settings = cfg?.settings || {};
  const dump = composedDump({ ...opts, dshHome: cfg?.dshHome || opts.dshHome });
  const llm = settings["llm-pi-ai"] ?? {};
  const piRow = extractDshComponent(dump, "llm-pi-ai");
  const providersMap = {};
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const asMap = (value) => isMap(value) ? value : {};
  if (!piRow?.disabled) {
    const base = asMap(piRow?.config?.providers);
    const saved = asMap(llm.providers);
    for (const name of new Set([...Object.keys(base), ...Object.keys(saved)])) {
      if (isMap(base[name]) || isMap(saved[name])) providersMap[name] = { ...asMap(base[name]), ...asMap(saved[name]) };
    }
  }
  const directRow = extractDshComponent(dump, "llm-deepseek");
  const directSettings = settings["llm-deepseek"];
  // Mere home/default-model presence is not evidence of an adapter. Settings
  // are configured evidence; a supplied disabled composition wins over them.
  const directEvidence = directRow ? !directRow.disabled && directRow.config !== null : isMap(directSettings);
  if (directEvidence) {
    const direct = { ...asMap(directRow?.config), ...asMap(directSettings) };
    providersMap["deepseek-official"] = { ...direct, api: "deepseek-direct", apiKeyEnv: direct.apiKeyEnv || "DEEPSEEK_API_KEY" };
  }

  // pricing: cc-switch synced JSON first, SQLite cross-ref fills gaps (pi pattern)
  /** @type {Record<string, any>} */
  const modelPricing = { ...readCcPricingJson(opts.pricingPath) };
  if (opts.ccSwitch?.modelPricing) {
    for (const [k, v] of Object.entries(opts.ccSwitch.modelPricing)) {
      if (!modelPricing[k]) modelPricing[k] = v;
    }
  }

  const def = dshDefaultModel({ dshHome: cfg?.dshHome || opts.dshHome, profile: opts.profile, dumpConfig: dump }) || {};
  const entries = Object.entries(providersMap);
  let defaultProvider = def.provider || "";
  if (!defaultProvider && entries.length) defaultProvider = entries[0][0];

  /** @type {any[]} */
  const allProviders = [];
  /** @type {Record<string, any>} */
  const currentProviders = {};
  for (const [name, prov] of entries) {
    const p = prov && typeof prov === "object" ? prov : {};
    const rawModels = Array.isArray(p.models) ? p.models : [];
    const models = rawModels.filter((m) => isMap(m) && typeof m.id === "string" && m.id.trim());
    const catalogComplete = Array.isArray(p.models) && models.length === rawModels.length;
    // Do not invent the installed pi-ai catalog or infer availability from
    // modelOverrides. A selected unadvertised model remains visible separately.
    const ids = models.map((m) => m?.id).filter(Boolean);
    const isCurrent = name === defaultProvider;
    const row = {
      id: name,
      name: name,
      app_type: "dsh",
      is_current: isCurrent ? 1 : 0,
      provider_type: p.api || "openai-completions",
      cost_multiplier: 1,
      catalogComplete,
      catalogOverrideIds: Object.keys(asMap(p.modelOverrides)),
      evidence: name === "deepseek-official" && directEvidence ? "llm-deepseek-config" : "llm-pi-ai-config",
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
  if (!def.provider && !currentProviders.dsh && allProviders.length) {
    const fb = { ...allProviders[0], is_current: 1 };
    currentProviders.dsh = fb;
    allProviders[0] = fb;
  }

  return {
    dshHome: cfg?.dshHome || opts.dshHome || null,
    defaultSelection: def.provider ? def : null,
    defaultSelectionSource: selection(settings["agent-default-model"]) ? "settings.yaml" : (def.provider ? "composed agent-default-model" : "first provider fallback"),
    unresolvedSelection: def.provider && !currentProviders.dsh ? def : null,
    catalogComplete: allProviders.length > 0 && allProviders.every((p) => p.catalogComplete),
    appTypes: allProviders.length ? ["dsh"] : [],
    currentProviders,
    allProviders,
    modelPricing,
    credentialKeys: readCredentialKeys(cfg?.dshHome || opts.dshHome),
  };
}
