// @ts-check
// Capability-aware model selection for agents / subagents.
//
// Motivation (from Artificial Analysis — artificialanalysis.ai — which publishes
// ~10 distinct model leaderboards, each measuring a DIFFERENT capability:
// Intelligence, Coding, Math, Agentic, Multimodal/Vision, Image generation,
// Image editing, Video generation, Text-to-Speech, Speech-to-Text):
//   - models in the SAME leaderboard support DIFFERENT functions:
//       · some agentic models do multi-turn reasoning + dialogue AND full
//         multimodal I/O (e.g. claude-opus, gpt-5, gemini-pro)
//       · some agentic models only do multi-turn reasoning + dialogue, text
//         only (e.g. deepseek-r1-style reasoners)
//       · some models are multimodal yet NOT suited to agentic work at all
//         (image/video/speech generators: imagen, dall-e, veo, whisper, tts)
//   - therefore MAW must FIRST classify which of the available provider models
//     could suit a given agent/subagent role, and only THEN pick the provider
//     (api key) + model using provider balance/remaining quota and cost rate.
//
// The catalog below is CURATED (hand-maintained, marked `estimated: true`); it
// is a three-valued map (true / false / "unknown") so we never fabricate
// confidence about an unlisted model.

/**
 * The capability dimensions, mirroring the Artificial Analysis model
 * leaderboard categories. Documented here so contributors extend them
 * consistently.
 */
export const LEADERBOARD_DIMENSIONS = [
  "intelligence",   // AA "Intelligence" leaderboard
  "coding",         // AA "Coding" leaderboard
  "math",           // AA "Math" leaderboard
  "agentic",        // AA "Agentic" leaderboard (multi-turn tool use / work)
  "visionIn",       // AA "Multimodal / Vision" leaderboard (image understanding)
  "imageOut",       // AA "Text-to-Image" leaderboard
  "imageEdit",      // AA "Image Editing" leaderboard
  "videoOut",       // AA "Text-to-Video" leaderboard
  "speechOut",      // AA "Text-to-Speech" leaderboard
  "speechIn",       // AA "Speech-to-Text" leaderboard
];

/**
 * @typedef {{ agentic: boolean|"unknown", reasoning: boolean|"unknown", coding: boolean|"unknown",
 *   math: boolean|"unknown", visionIn: boolean|"unknown", imageOut: boolean|"unknown",
 *   videoOut: boolean|"unknown", speech: boolean|"unknown" }} Caps
 */

const T = true, F = false;

/**
 * Curated catalog. FIRST match wins, so order from the most specific /
 * non-agentic generators to the general families.
 * caps use three-valued logic: only mark `false` when we are confident.
 * @type {{ re: RegExp, family: string, caps: Caps }[]}
 */
const RULES = [
  // --- multimodal generators that are NOT suited to agentic work ---
  { re: /flash-image|imagen|dall-?e|flux|stable-diffusion|sdxl|midjourney|ideogram|recraft/i, family: "image-generation",
    caps: { agentic: F, reasoning: F, coding: F, math: F, visionIn: T, imageOut: T, videoOut: F, speech: F } },
  { re: /^veo|^sora|runway|pika|kling|luma|hailuo/i, family: "video-generation",
    caps: { agentic: F, reasoning: F, coding: F, math: F, visionIn: T, imageOut: F, videoOut: T, speech: F } },
  { re: /whisper|speech-to-text|(^|-)asr/i, family: "speech-to-text",
    caps: { agentic: F, reasoning: F, coding: F, math: F, visionIn: F, imageOut: F, videoOut: F, speech: T } },
  { re: /tts|text-to-speech|(^|-)tts/i, family: "text-to-speech",
    caps: { agentic: F, reasoning: F, coding: F, math: F, visionIn: F, imageOut: F, videoOut: F, speech: T } },
  { re: /embed|bge-|e5-/i, family: "embedding",
    caps: { agentic: F, reasoning: F, coding: F, math: F, visionIn: F, imageOut: F, videoOut: F, speech: F } },

  // --- text-only agentic reasoners (multi-turn reasoning + dialogue, no vision) ---
  { re: /^deepseek-r|reasoner/i, family: "reasoner-text-only",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: F, imageOut: F, videoOut: F, speech: F } },
  // deepseek vision variants (e.g. deepseek-v4-flash-vision-exp, pi 0.84.4 /
  // dsh 0.1.1-rc.1 DeepSeek-V4-Flash-Vision-Exp) are vision-capable — must
  // precede the generic ^deepseek-v text-only rule
  { re: /^deepseek-v[\w.-]*vision/i, family: "multimodal-generalist",
    caps: { agentic: T, reasoning: T, coding: "unknown", math: "unknown", visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /^deepseek-v/i, family: "agentic-text-only",
    caps: { agentic: T, reasoning: T, coding: T, math: F, visionIn: F, imageOut: F, videoOut: F, speech: F } },
  { re: /^kimi-k/i, family: "agentic-text-only",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: F, imageOut: F, videoOut: F, speech: F } },
  { re: /qwen\d*(\.\d+)?-coder/i, family: "coding-specialist",
    caps: { agentic: T, reasoning: T, coding: T, math: F, visionIn: F, imageOut: F, videoOut: F, speech: F } },
  { re: /^glm-4v|glm-.*vision/i, family: "multimodal-generalist",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /^glm/i, family: "agentic-text",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: F, imageOut: F, videoOut: F, speech: F } },
  { re: /qwen.*-vl/i, family: "multimodal-generalist",
    caps: { agentic: T, reasoning: T, coding: "unknown", math: "unknown", visionIn: T, imageOut: F, videoOut: F, speech: F } },

  // --- full multimodal agentic models (reasoning + dialogue + vision) ---
  { re: /claude-(opus|sonnet|haiku)/i, family: "multimodal-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /codex/i, family: "coding-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /^gpt-/i, family: "multimodal-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /^o[0-9]/i, family: "reasoner-multimodal",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /gemini-.*(pro|flash)/i, family: "multimodal-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: T, visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /llama-?4/i, family: "multimodal-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /grok/i, family: "multimodal-agentic",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: T, imageOut: F, videoOut: F, speech: F } },
  { re: /mistral|mixtral|magistral|codestral/i, family: "agentic-text",
    caps: { agentic: T, reasoning: T, coding: T, math: "unknown", visionIn: F, imageOut: F, videoOut: F, speech: F } },
];

const UNKNOWN_CAPS = /** @type {Caps} */ ({ agentic: "unknown", reasoning: "unknown", coding: "unknown", math: "unknown", visionIn: "unknown", imageOut: "unknown", videoOut: "unknown", speech: "unknown" });

/**
 * Classify a model id into capabilities. Always flagged estimated:true — this
 * is curated data, never presented as measured ground truth.
 * @param {string} modelId
 * @returns {{ model: string, family: string, caps: Caps, estimated: true, notes: string[] }}
 */
export function classifyModel(modelId) {
  const id = String(modelId || "").trim();
  for (const r of RULES) {
    if (r.re.test(id)) {
      const notes = [];
      if (r.family === "image-generation" || r.family === "video-generation" || r.family === "text-to-speech" || r.family === "speech-to-text" || r.family === "embedding") {
        notes.push("multimodal/generator model but NOT suited to agentic work");
      }
      if (r.family === "reasoner-text-only" || r.family === "agentic-text-only" || r.family === "agentic-text" || r.family === "coding-specialist") {
        notes.push("agentic (multi-turn reasoning + dialogue) but text-only: no image input");
      }
      if (r.family === "multimodal-agentic" || r.family === "multimodal-generalist" || r.family === "reasoner-multimodal" || r.family === "coding-agentic") {
        notes.push("agentic AND multimodal (supports image input)");
      }
      return { model: id, family: r.family, caps: r.caps, estimated: true, notes };
    }
  }
  return { model: id, family: "unknown", caps: UNKNOWN_CAPS, estimated: true, notes: ["unlisted model: capabilities unknown; ranked conservatively"] };
}

/**
 * Role → capability requirements. Base roles; "implementer-2" maps to
 * "implementer". `require` capabilities gate suitability; `prefer` only
 * affect ranking.
 */
export const ROLE_REQUIREMENTS = {
  orchestrator: { require: ["agentic", "reasoning"], prefer: ["visionIn"], why: "plans, decomposes, delegates and synthesizes; vision helps read diagrams/screenshots" },
  researcher: { require: ["agentic", "reasoning"], prefer: ["visionIn"], why: "investigates and compresses findings; vision helps with screenshots/charts" },
  implementer: { require: ["agentic", "coding"], prefer: ["reasoning"], why: "writes and edits code end-to-end" },
  reviewer: { require: ["agentic", "reasoning", "coding"], prefer: [], why: "independent code/architecture/security review" },
};

/**
 * @param {string} role e.g. "implementer-2" -> "implementer"
 */
export function baseRole(role) {
  return String(role).replace(/-\d+$/, "");
}

/**
 * Score how well `caps` fit a role: 0..100. A required capability explicitly
 * `false` disqualifies (score 0). `unknown` scores partial.
 * @param {Caps} caps
 * @param {{ require: string[], prefer?: string[] }} req
 */
export function capabilityScore(caps, req) {
  const require = req.require ?? [];
  const prefer = req.prefer ?? [];
  for (const c of require) if (caps[c] === false) return 0;
  let score = 0;
  const reqW = require.length ? 80 / require.length : 0;
  for (const c of require) {
    if (caps[c] === true) score += reqW;
    else if (caps[c] === "unknown") score += reqW * 0.4;
  }
  const preW = prefer.length ? 20 / prefer.length : 0;
  for (const c of prefer) {
    if (caps[c] === true) score += preW;
    else if (caps[c] === "unknown") score += preW * 0.4;
  }
  if (!prefer.length && require.length) score = Math.min(100, score / 0.8);
  return Math.round(score);
}

/**
 * Extract the model(s) a provider exposes from its settings_config.
 * Claude providers: env.ANTHROPIC_MODEL (+ subagent/default variants).
 * Codex providers: settings_config.model / env.CODEX_MODEL.
 * @param {any} settingsConfig
 * @param {string} appType
 * @returns {string[]}
 */
export function providerModels(settingsConfig, appType) {
  const sc = settingsConfig ?? {};
  const env = sc.env && typeof sc.env === "object" ? sc.env : {};
  /** @type {string[]} */
  const out = [];
  const push = (v) => { if (v && typeof v === "string" && !out.includes(v)) out.push(v); };
  if (appType === "claude") {
    push(env.ANTHROPIC_MODEL);
    push(env.CLAUDE_CODE_SUBAGENT_MODEL);
    push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
    push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    push(env.ANTHROPIC_DEFAULT_FABLE_MODEL);
    push(env.CLAUDE_MODEL);
  }
  if (appType === "codex") {
    push(sc.model); push(env.CODEX_MODEL);
    // codex providers commonly keep their config as a TOML string:
    //   config: "model_provider = \"custom\"\nmodel = \"gpt-5.5\"\n..."
    if (typeof sc.config === "string") {
      const m = sc.config.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (m) push(m[1]);
    } else if (sc.config && typeof sc.config === "object") {
      push(sc.config.model);
    }
  }
  if (appType === "pi") {
    // pi providers carry their full model id list in settings_config._piModels
    // (populated by readPiAsCc from ~/.pi/agent/models.json). The default model
    // is also in settings_config.model.
    if (Array.isArray(sc._piModels)) for (const m of sc._piModels) push(m);
    push(sc.model);
  }
  if (appType === "dsh") {
    // dsh providers carry their model id list in settings_config._dshModels
    // (populated by readDshAsCc from $DSH_HOME/settings.yaml). The default
    // model is also in settings_config.model.
    if (Array.isArray(sc._dshModels)) for (const m of sc._dshModels) push(m);
    push(sc.model);
  }
  if (!out.length) push(sc.model);
  return out.filter((m) => typeof m === "string" && m.length > 0);
}

/**
 * Build the candidate (provider × model) list for an app_type from cc-switch
 * data. "Available, effective providers" = every provider configured for that
 * app_type (the current one first).
 * @param {{ allProviders?: any[], currentProviders?: Record<string, any> }} cc
 * @param {string} appType
 */
export function candidatesForAppType(cc, appType) {
  /** @type {any[]} */
  let provs = Array.isArray(cc?.allProviders) ? cc.allProviders.filter((p) => p.app_type === appType) : [];
  if (!provs.length && cc?.currentProviders?.[appType]) provs = [cc.currentProviders[appType]];
  /** @type {any[]} */
  const out = [];
  for (const p of provs) {
    const sc = p.settingsConfig ?? p.settings_config ?? {};
    for (const model of providerModels(sc, appType)) {
      out.push({
        providerId: p.id, providerName: p.name || p.id, appType,
        model, isCurrent: !!p.is_current,
        costMultiplier: Number(p.cost_multiplier ?? 1) || 1,
      });
    }
  }
  return out;
}

/**
 * Select the best provider(api key)+model for a role:
 *   1. classify every available provider model (capability fit for the role)
 *   2. drop unfit models (a required capability explicitly false)
 *   3. rank by capability fit → provider remaining quota/balance → cost rate
 * Returns null when there are no candidates at all (caller falls back).
 * @param {object} opts
 * @param {string} opts.role
 * @param {string} opts.appType
 * @param {{ allProviders?: any[], currentProviders?: Record<string, any>, modelPricing?: Record<string, any> }} opts.cc
 * @param {{ providers?: Record<string, any> }} [opts.quota] from readProviderQuota()
 * @param {boolean} [opts.preferCheap] rank cheaper models higher (light "-2" workers)
 */
export function selectModelForRole(opts) {
  const { role, appType, cc } = opts;
  const req = ROLE_REQUIREMENTS[baseRole(role)] ?? { require: ["agentic"], prefer: [], why: "generic agent work" };
  const candidates = candidatesForAppType(cc, appType);
  if (!candidates.length) return null;
  const quotaProviders = opts.quota?.providers ?? {};
  /** @type {any[]} */
  const scored = [];
  for (const cand of candidates) {
    const cls = classifyModel(cand.model);
    const cap = capabilityScore(cls.caps, req);
    if (cap === 0) continue; // capability-unfit for this role (e.g. image-gen model for an implementer)
    const q = quotaProviders[cand.providerId] ?? {};
    const price = cc?.modelPricing?.[cand.model] ?? null;
    const priceCost = price ? (Number(price.input_per_m) + Number(price.output_per_m)) * cand.costMultiplier : null;
    const remaining = q.remainingTodayUsd ?? null;
    const quotaBonus = remaining == null ? 10 : Math.min(Math.max(remaining, 0), 20);
    const cheapW = opts.preferCheap ? 3 : 1;
    const pricePenalty = priceCost == null ? 5 : Math.min(priceCost, 20) * cheapW;
    const rank = cap * 100 + (cand.isCurrent ? 30 : 0) + quotaBonus - pricePenalty;
    scored.push({ ...cand, classification: cls, capabilityScore: cap, quota: {
      remainingTodayUsd: q.remainingTodayUsd ?? null, remainingMonthUsd: q.remainingMonthUsd ?? null,
      spendTodayUsd: q.spendTodayUsd ?? null, ratePerMin: q.ratePerMin ?? null,
    }, price: price ? { input_per_m: price.input_per_m, output_per_m: price.output_per_m, source: price.source ?? "cc-switch", estimated: !!price.estimated } : null, rank });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.rank - a.rank);
  const top = scored[0];
  const reasons = [
    `capability fit ${top.capabilityScore}/100 for role "${role}" (${req.why})`,
    top.classification.notes[0] ? `model class: ${top.classification.notes[0]}` : null,
    top.quota.remainingTodayUsd != null ? `provider remaining quota today: $${top.quota.remainingTodayUsd}` : "provider remaining quota: unknown (no daily limit set in cc-switch)",
    top.quota.ratePerMin != null ? `provider current spend rate: $${top.quota.ratePerMin}/min` : null,
    top.price ? `price $${top.price.input_per_m}/$${top.price.output_per_m} per M tokens (${top.price.source}${top.price.estimated ? ", estimated" : ""})` : "price: unknown (not in cc-switch model_pricing)",
    top.isCurrent ? "provider is the cc-switch current one (known-working)" : null,
  ].filter(Boolean);
  return {
    role, appType,
    providerId: top.providerId, providerName: top.providerName, model: top.model,
    capabilityScore: top.capabilityScore, classification: top.classification,
    quota: top.quota, price: top.price, reasons, estimated: true,
    alternates: scored.slice(1, 4).map((s) => ({ providerId: s.providerId, providerName: s.providerName, model: s.model, capabilityScore: s.capabilityScore, quota: s.quota, price: s.price })),
    considered: scored.length,
  };
}
