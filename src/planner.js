// @ts-check
// The planner: given a project + task analysis, the host capabilities, and the
// cc-switch provider/pricing data, select the right agent architecture (or a
// combination) and emit a concrete workflow plan with an agent roster, parallel
// /serial groups, review points, loops, and per-agent cost limits.
//
// Selection follows the principles from the MAW architecture report:
//   - start simple; add complexity only when it demonstrably helps
//   - workflows (graph) for predictability/HITL/persistence
//   - loop/agent for open-ended single tasks
//   - subagents (orchestrator-workers) for dynamic, parallelizable subtasks
//   - multi-agent for high-value breadth-first work that tolerates ~15x cost
//   - prefer the host's NATIVE dynamic workflow / multi-agent when present
//   - codex review invoked only at risk-based gates, not every step
//
// The decision is a deterministic scoring function => fully testable.

/**
 * @typedef {"loop"|"orchestrator-workers"|"multi-agent"|"graph"|"dynamic"|"ultracode"|"none"} Arch
 * @typedef {"low"|"medium"|"high"} Level
 * @typedef {"coding"|"research"|"refactor"|"review"|"migration"|"greenfield"|"ops"} TaskType
 *
 * @typedef {{
 *   files?: number, loc?: number, languages?: string[],
 *   taskType?: TaskType, parallelizableSubtasks?: number,
 *   risk?: Level, contextNeed?: "small"|"medium"|"large",
 *   valuePerRun?: Level, maxIterations?: number,
 *   needHITL?: boolean, needPersistence?: boolean,
 *   description?: string,
 * }} ProjectSignals
 *
 * @typedef {{
 *   role: string, agent: string, model: string, appType: string,
 *   costRateLimitUsdPerMin: number, concurrency: number, tools: string[],
 *   reviewRequired: boolean, task: string, modelChoice?: object,
 *   priceGateBlocked?: boolean, modelReasoningEffort?: string,
 * }} AgentSpec
 *
 * @typedef {{
 *   name: string, selected: Arch[], primary: Arch,
 *   rationale: string[], agents: AgentSpec[],
 *   priceGate?: { thresholds: { inputPerM: number, outputPerM: number }, blockedRoles: { role: string, model: string, appType: string, provider?: string|null, price?: object|null, gate?: object|null }[] },
 *   groups: { parallel?: boolean, agents: string[], steps?: { role: string, agent: string, task: string }[], label?: string }[],
 *   reviewPoints: { by: string, scope: string, label?: string }[],
 *   loops: { maxIterations: number, exitWhen: string, label?: string }[],
 *   cost: { perAgentLimitUsdPerMin: number, totalLimitUsdPerMin: number, maxConcurrency: number, sources: string[] },
 *   hostApp: string, hostCapabilities: string[],
 *   codex: { enabled: boolean, when: string[], reviewScopes: string[] },
 *   signals: ProjectSignals, createdAt: string,
 * }} Plan
 */

import { isoNow, round, slug } from "./util.js";
import { selectModelForRole, baseRole, classifyModel, capabilityScore, ROLE_REQUIREMENTS } from "./modelcap.js";
import { resolvePrice } from "./pricing.js";
import { checkPriceGate, PRICE_GATE_THRESHOLDS } from "./pricegate.js";
import { reviewerPlanOverride } from "./codexplan.js";

const DEFAULT_PER_AGENT = 5.0;   // USD/min (real inference spend from cc-switch logs)
const DEFAULT_TOTAL = 10.0;      // USD/min
const DEFAULT_MAX_CONCURRENCY = 16;

/**
 * Score how well each architecture fits the signals. Higher = better fit.
 * Returns a map of Arch -> { score, reasons[] }.
 * @param {ProjectSignals} s
 * @param {{ hasDynamicWorkflow?: boolean, hasMultiAgent?: boolean, hasSubagents?: boolean, codexPluginInstalled?: boolean, app?: string }} host
 */
export function scoreArchitectures(s, host = {}) {
  /** @type {Record<string, { score: number, reasons: string[] }>} */
  const out = {
    "none": { score: 0, reasons: [] },
    "loop": { score: 0, reasons: [] },
    "orchestrator-workers": { score: 0, reasons: [] },
    "multi-agent": { score: 0, reasons: [] },
    "graph": { score: 0, reasons: [] },
    "dynamic": { score: 0, reasons: [] },
    "ultracode": { score: 0, reasons: [] },
  };

  const files = s.files ?? 1;
  const parallel = s.parallelizableSubtasks ?? 0;
  const risk = level(s.risk ?? "medium");
  const value = level(s.valuePerRun ?? "medium");
  const ctx = s.contextNeed ?? "medium";
  const ctxLarge = ctx === "large";
  const taskType = s.taskType ?? "coding";

  // "none": trivially small, fixed tasks -> no agent needed
  if (files <= 3 && parallel === 0 && risk <= 1 && ctx === "small") {
    out["none"].score += 100;
    out["none"].reasons.push("very small, low-risk, fixed task: a single LLM call + retrieval suffices");
  }

  // loop: open-ended, steps unpredictable, single context adequate
  if (ctx !== "large" && risk >= 1) {
    out["loop"].score += 45 + (taskType === "coding" ? 10 : 0);
    out["loop"].reasons.push("open-ended single task, steps unpredictable, context fits one window");
  }
  if (taskType === "review") out["loop"].score += 8;

  // orchestrator-workers: many dynamic parallelizable subtasks, context grows
  if (parallel >= 3 || ctxLarge) {
    out["orchestrator-workers"].score += 55 + Math.min(parallel, 6) * 4;
    out["orchestrator-workers"].reasons.push(`${parallel} parallelizable subtasks / context ${ctx}: delegate to subagents with own windows`);
  }

  // multi-agent: high value, breadth-first, parallel, tolerate cost
  if (value >= 2 && parallel >= 4) {
    out["multi-agent"].score += 50 + value * 6;
    out["multi-agent"].reasons.push(`high-value (${s.valuePerRun}) breadth-first work, ${parallel} parallel directions: multi-agent scales token spend`);
  }
  if (taskType === "research") out["multi-agent"].score += 10;

  // graph: predictability, HITL, persistence, branching
  if (s.needHITL || s.needPersistence || risk >= 2) {
    out["graph"].score += 40 + (s.needHITL ? 12 : 0) + (s.needPersistence ? 10 : 0) + (risk === 3 ? 8 : 0);
    out["graph"].reasons.push(`risk ${s.risk}${s.needHITL ? ", human-in-the-loop" : ""}${s.needPersistence ? ", persistence/checkpoints" : ""}: graph gives predictable, inspectable control`);
  }
  if (taskType === "migration") out["graph"].score += 12;

  // dynamic: prefer host native dynamic workflow / multi-agent when available
  if (host.hasDynamicWorkflow || host.hasMultiAgent) {
    out["dynamic"].score += 30;
    out["dynamic"].reasons.push(`host (${host.app}) provides native dynamic workflow / multi-agent: drive it instead of re-implementing`);
  }

  // ultracode: complex coding with implement -> codex-review -> fix loop + graph checkpoints
  if (taskType === "coding" && (files >= 20 || risk >= 2) && host.codexPluginInstalled) {
    out["ultracode"].score += 45 + (files >= 50 ? 10 : 0) + (risk >= 2 ? 15 : 0) + (files >= 20 ? 8 : 0);
    out["ultracode"].reasons.push("complex coding with codex-review available: graph checkpoints + implement→review→fix loop");
  }
  if (taskType === "greenfield" && files >= 15) out["ultracode"].score += 6;

  return out;
}

/** @param {Level} l @returns {number} */
function level(l) {
  return l === "low" ? 1 : l === "high" ? 3 : 2;
}

/**
 * Produce the workflow plan.
 * @param {ProjectSignals} signals
 * @param {object} ctx
 * @param {{ hasSubagents?: boolean, hasMultiAgent?: boolean, hasDynamicWorkflow?: boolean, app?: string, codexPluginInstalled?: boolean, codexBinary?: string|null }} [ctx.host]
 * @param {{ currentProviders?: Record<string, any>, modelPricing?: Record<string, any> }} [ctx.ccSwitch]
 * @param {{ perAgent?: number, total?: number, maxConcurrency?: number }} [ctx.cost]
 * @param {import("./codexplan.js").CodexPlanInfo | null} [ctx.codexPlan]
 *   local codex login state — when a Pro/Pro-Lite ChatGPT plan is active, the
 *   reviewer role (app_type codex) defaults to `gpt-5.6-sol` @ reasoning `low`
 *   (machine policy 2026-08-24) and the price gate treats it as
 *   subscription-covered (flat rate; not blocked).
 */
export function planWorkflow(signals, ctx = {}) {
  const host = ctx.host ?? {};
  const cc = ctx.ccSwitch ?? {};
  const cost = ctx.cost ?? {};
  const codexPlan = ctx.codexPlan ?? null;
  const perAgent = round(cost.perAgent ?? DEFAULT_PER_AGENT, 2);
  const total = round(cost.total ?? DEFAULT_TOTAL, 2);
  const maxConcurrency = cost.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  const scores = scoreArchitectures(signals, host);
  const ranked = /** @type {[string, { score: number, reasons: string[] }][]} */ (Object.entries(scores))
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1].score - a[1].score);
  const primary = ranked[0]?.[0] ?? "loop";

  // Build the selected set. When the host has native dynamic/multi-agent and we
  // picked a topology that needs coordination, layer `dynamic` on top so the
  // host drives execution natively while MAW provides plan + cost gate + codex.
  /** @type {Arch[]} */
  const selected = [];
  if (primary === "graph" || primary === "ultracode") selected.push("graph");
  if (primary === "multi-agent" || primary === "orchestrator-workers") {
    selected.push(host.hasDynamicWorkflow ? "dynamic" : "orchestrator-workers");
    if (primary === "multi-agent") selected.push("multi-agent");
  }
  if (primary === "loop") selected.push("loop");
  if (primary === "dynamic") selected.push("dynamic");
  if (!selected.length) selected.push("loop");
  // ultracode => add loop + codex review explicitly
  if (primary === "ultracode" && !selected.includes("loop")) selected.push("loop");
  if (primary === "ultracode" && !selected.includes("ultracode")) selected.push("ultracode");

  const rationale = ranked.slice(0, 3).flatMap(([k, v]) => v.reasons.map((r) => `[${k}] ${r}`));

  // --- model selection (capability-aware: suitability -> remaining quota -> cost rate) ---
  // Models differ WITHIN a leaderboard (some agentic models are full-multimodal,
  // some are reasoning/dialogue-only, some multimodal models are not agentic at
  // all), so each role picks from the available provider models by capability
  // fit first, then provider balance/remaining quota, then cost rate.
  /** @type {Record<string, any>} */
  const selCache = {};
  function modelFor(role, appType, fallbackId, preferCheap = false) {
    const key = `${baseRole(role)}|${appType}|${preferCheap ? "cheap" : "std"}`;
    if (!selCache[key]) {
      let sel = selectModelForRole({ role, appType, cc, quota: cc.quota, preferCheap });
      // Machine policy (2026-08-24): reviewer on codex defaults to gpt-5.6-sol
      // @ reasoning low IFF the local codex login carries a Pro / Pro-Lite
      // ChatGPT plan (flat-rate subscription; codex usage is not billed per
      // token). The assignment is then subscription-covered — the price gate
      // reports `covered:true` instead of blocking. Every other login state
      // keeps the normal capability-aware selection + gate.
      const planOv = baseRole(role) === "reviewer" && appType === "codex" ? reviewerPlanOverride(codexPlan) : null;
      const normal = sel;
      if (planOv) {
        const cls = classifyModel(planOv.model);
        const req = ROLE_REQUIREMENTS.reviewer ?? { require: ["agentic"], prefer: [], why: "independent review" };
        const cap = capabilityScore(cls.caps, req);
        const ovPrice = resolvePrice(planOv.model, {
          modelPricing: cc.modelPricing,
          costMultiplier: Number(cc.currentProviders?.[appType]?.cost_multiplier ?? 1),
        });
        sel = {
          role, appType,
          model: planOv.model,
          providerId: null, providerName: planOv.providerLabel,
          capabilityScore: cap, classification: cls, quota: null,
          price: ovPrice ? { input_per_m: ovPrice.input_per_m, output_per_m: ovPrice.output_per_m, source: ovPrice.source, estimated: !!ovPrice.estimated } : null,
          reasons: [
            `machine policy: local codex is logged in via ChatGPT ${planOv.planLabel} (pro-covered plan) — reviewer defaults to \`${planOv.model}\` @ reasoning ${planOv.reasoningEffort}`,
            `price gate: subscription-covered by ChatGPT plan "${planOv.planType}" (flat rate; listed per-token price does not apply to codex usage)`,
            `capability fit ${cap}/100 for role "${role}" (${req.why})`,
            `model class: ${cls.notes[0] ?? cls.family}`,
            "runs on the local ChatGPT login (codex OAuth direct, not the cc-switch proxy)",
          ],
          estimated: true,
          alternates: normal?.alternates ?? [],
          considered: normal?.considered ?? 0,
          reasoningEffort: planOv.reasoningEffort,
        };
      } else {
        sel = sel ?? {
          role, appType, model: pickModel(cc, appType, fallbackId), providerId: null, providerName: null,
          capabilityScore: null, quota: null, price: null,
          reasons: ["cc-switch provider list unavailable; using the current provider's default model"],
          estimated: true, alternates: [], considered: 0,
        };
      }
      // Price gate (HITL): resolve the FULL price chain (cc-switch model_pricing
      // + provider cost_multiplier + vendored fallback — the same chain
      // configgen writes into .mawf/agents/*.json) and check the thresholds.
      // A blocked assignment pauses the related work and is reported to a human.
      // A subscription-covered assignment (ChatGPT Pro/Pro-Lite login) is
      // reported as covered:true instead of blocked — flat rate, no per-token
      // spend to gate.
      const price = resolvePrice(sel.model, {
        modelPricing: cc.modelPricing,
        costMultiplier: Number(cc.currentProviders?.[appType]?.cost_multiplier ?? 1),
      });
      sel.priceGate = checkPriceGate(sel.model, price, planOv ? { coveredByPlan: planOv.planType } : undefined);
      selCache[key] = sel;
    }
    return selCache[key];
  }
  // Host adaptation: on a pi or dsh host the workers run under that host's
  // runtime (not claude-code), and model selection should query that host's
  // app_type (its providers are merged into cc by loadCtx). Codex keeps its
  // reviewer-only role; claude/codex/unknown hosts stay claude-code.
  const isAltHost = host.app === "pi" || host.app === "dsh";
  const hostAgent = isAltHost ? host.app : "claude-code";
  const hostAppType = isAltHost ? host.app : "claude";
  const orchChoice = modelFor("orchestrator", hostAppType, "claude-opus-5");
  const resChoice = modelFor("researcher", hostAppType, "claude-sonnet-5");
  const implChoice = modelFor("implementer", hostAppType, "claude-sonnet-5");
  const lightChoice = modelFor("researcher-2", hostAppType, "claude-haiku-4-5", true);
  const codexChoice = modelFor("reviewer", "codex", "gpt-5.2-codex");
  const claudeRevChoice = modelFor("reviewer", hostAppType, "claude-opus-5");

  /** @type {AgentSpec[]} */
  const agents = [];
  const needsOrch = selected.some((a) => a === "orchestrator-workers" || a === "dynamic" || a === "multi-agent" || a === "ultracode");
  if (needsOrch) {
    agents.push(mkAgent("orchestrator", hostAgent, orchChoice.model, hostAppType, perAgent, ["Task", "Read", "Edit", "Bash"], "Plan, decompose, delegate, synthesize.", true, orchChoice));
  }
  const workerCount = Math.min(Math.max(signals.parallelizableSubtasks ?? 2, selected.includes("multi-agent") ? 4 : 2), maxConcurrency);
  if (selected.includes("multi-agent") || selected.includes("orchestrator-workers") || selected.includes("dynamic")) {
    agents.push(mkAgent("researcher", hostAgent, resChoice.model, hostAppType, perAgent, ["WebFetch", "Grep", "Read"], "Investigate independent facets and compress findings.", false, resChoice));
    agents.push(mkAgent("implementer", hostAgent, implChoice.model, hostAppType, perAgent, ["Read", "Edit", "Write", "Bash"], "Implement a vertical slice end-to-end.", false, implChoice));
    if (workerCount >= 3) agents.push(mkAgent("implementer-2", hostAgent, implChoice.model, hostAppType, perAgent, ["Read", "Edit", "Write", "Bash"], "Implement a second independent slice in parallel.", false, implChoice));
    if (workerCount >= 4) agents.push(mkAgent("researcher-2", hostAgent, lightChoice.model, hostAppType, perAgent, ["WebFetch", "Grep"], "Secondary breadth-first exploration.", false, lightChoice));
  }
  if (selected.includes("loop") || selected.includes("ultracode")) {
    agents.push(mkAgent("implementer", hostAgent, implChoice.model, hostAppType, perAgent, ["Read", "Edit", "Write", "Bash", "Task"], "Iterate implement→test→fix in a loop until criteria met.", false, implChoice));
  }
  // codex reviewer only if codex available
  const codexOn = !!host.codexPluginInstalled;
  if (codexOn) {
    agents.push(mkAgent("reviewer", "codex", codexChoice.model, "codex", perAgent, ["codex:review", "codex:adversarial-review"], "Independent code/architecture/security review via codex-plugin-cc.", true, codexChoice));
  } else if (riskLevel(signals.risk) >= 2) {
    // graceful degradation: no codex -> use a second claude agent as reviewer
    agents.push(mkAgent("reviewer", "claude-code", claudeRevChoice.model, "claude", perAgent, ["Read", "Grep", "Glob"], "Independent review (codex unavailable; using second claude agent).", true, claudeRevChoice));
  }

  // --- groups (parallel/serial) ---
  /** @type {Plan["groups"]} */
  const groups = [];
  groups.push({ label: "plan", parallel: false, agents: ["orchestrator"], steps: [{ role: "orchestrator", agent: hostAgent, task: "Decompose the task; write .mawf/plan.md." }] });
  if (selected.includes("multi-agent") || selected.includes("orchestrator-workers") || selected.includes("dynamic")) {
    groups.push({
      label: "execute-parallel",
      parallel: true,
      agents: agents.filter((a) => a.role.startsWith("implementer") || a.role.startsWith("researcher")).map((a) => a.role),
      steps: [
        { role: "researcher", agent: hostAgent, task: "Explore landscape; return compressed findings." },
        { role: "implementer", agent: hostAgent, task: "Implement vertical slice A." },
        ...(workerCount >= 3 ? [{ role: "implementer-2", agent: hostAgent, task: "Implement vertical slice B in parallel." }] : []),
        ...(workerCount >= 4 ? [{ role: "researcher-2", agent: hostAgent, task: "Secondary parallel exploration." }] : []),
      ],
    });
  } else {
    groups.push({ label: "execute", parallel: false, agents: ["implementer"], steps: [{ role: "implementer", agent: hostAgent, task: "Implement the task step by step." }] });
  }
  groups.push({ label: "synthesize", parallel: false, agents: ["orchestrator"], steps: [{ role: "orchestrator", agent: hostAgent, task: "Merge subagent results; resolve conflicts." }] });

  // --- review points (risk-gated, not every step) ---
  /** @type {Plan["reviewPoints"]} */
  const reviewPoints = [];
  const riskN = riskLevel(signals.risk);
  if (codexOn && riskN >= 1) {
    reviewPoints.push({ by: "codex", scope: "auto", label: "post-implementation review" });
    if (riskN >= 2) reviewPoints.push({ by: "codex", scope: "working-tree", label: "architecture/security review" });
  }
  if (primary === "ultracode") {
    reviewPoints.push({ by: "codex", scope: "branch", label: "ultracode fix-gate review" });
  }

  // --- loops ---
  /** @type {Plan["loops"]} */
  const loops = [];
  if (selected.includes("loop") || selected.includes("ultracode")) {
    loops.push({ maxIterations: signals.maxIterations ?? 5, exitWhen: "all tests green AND reviewer approves", label: "implement-test-fix loop" });
  }

  // --- cost sources ---
  const sources = [];
  sources.push(cc.modelPricing && Object.keys(cc.modelPricing).length ? "cc-switch:model_pricing" : "cc-switch:none");
  if (Object.values(cc.currentProviders || {}).some((p) => Number(p.cost_multiplier) !== 1)) sources.push("cc-switch:provider_multiplier");

  const plan = /** @type {Plan} */ ({
    name: `${primary}-${slug(signals.description || "workflow")}`,
    selected,
    primary,
    rationale,
    agents,
    groups,
    reviewPoints,
    loops,
    cost: { perAgentLimitUsdPerMin: perAgent, totalLimitUsdPerMin: total, maxConcurrency, sources },
    priceGate: {
      thresholds: PRICE_GATE_THRESHOLDS,
      blockedRoles: agents.filter((a) => a.priceGateBlocked).map((a) => ({
        role: a.role, model: a.model, appType: a.appType,
        provider: a.modelChoice?.provider ?? null,
        price: a.modelChoice?.price ?? null,
        gate: a.modelChoice?.priceGate ?? null,
      })),
    },
    hostApp: host.app || "unknown",
    hostCapabilities: [
      host.hasSubagents && "subagents",
      host.hasMultiAgent && "multi-agent",
      host.hasDynamicWorkflow && "dynamic-workflow",
      host.codexPluginInstalled && "codex-review",
    ].filter(Boolean),
    codex: {
      enabled: codexOn,
      when: codexOn ? ["risk>=medium", "ultracode fix-gate"] : [],
      reviewScopes: reviewPoints.map((r) => r.scope),
    },
    signals,
    createdAt: isoNow(),
  });
  return plan;
}

/** @param {Level|string|undefined} r @returns {number} */
function riskLevel(r) {
  if (r === "low") return 1;
  if (r === "high") return 3;
  return 2;
}

/**
 * @param {string} role
 * @param {string} agent
 * @param {string} model
 * @param {string} appType
 * @param {number} perAgent
 * @param {string[]} tools
 * @param {string} task
 * @param {boolean} reviewRequired
 * @param {any} [modelChoice]  capability-aware selection result (from modelcap)
 * @returns {AgentSpec}
 */
function mkAgent(role, agent, model, appType, perAgent, tools, task, reviewRequired, modelChoice) {
  /** @type {AgentSpec} */
  const spec = { role, agent, model, appType, costRateLimitUsdPerMin: perAgent, concurrency: 1, tools, reviewRequired, task };
  if (modelChoice) {
    spec.modelChoice = {
      provider: modelChoice.providerName ?? null,
      providerId: modelChoice.providerId ?? null,
      capabilityScore: modelChoice.capabilityScore ?? null,
      quota: modelChoice.quota ?? null,
      price: modelChoice.price ?? null,
      priceGate: modelChoice.priceGate ?? null,
      reasons: modelChoice.reasons ?? [],
      estimated: modelChoice.estimated ?? true,
      considered: modelChoice.considered ?? 0,
      alternates: (modelChoice.alternates ?? []).map((a) => ({ provider: a.providerName, model: a.model, capabilityScore: a.capabilityScore })),
      ...(modelChoice.reasoningEffort ? { reasoningEffort: modelChoice.reasoningEffort } : {}),
    };
    if (modelChoice.priceGate?.blocked) spec.priceGateBlocked = true;
    if (modelChoice.reasoningEffort) spec.modelReasoningEffort = modelChoice.reasoningEffort;
  }
  return spec;
}

/**
 * Pick a model id for an app_type from cc-switch current provider, falling back
 * to a sensible default when cc-switch is unavailable.
 * @param {{ currentProviders?: Record<string, any>, modelPricing?: Record<string, any> }} cc
 * @param {string} appType
 * @param {string} fallbackId
 */
function pickModel(cc, appType, fallbackId) {
  try {
    const p = cc.currentProviders?.[appType];
    if (!p) return fallbackId;
    const sc = p.settings_config || {};
    const env = sc.env || {};
    if (appType === "claude") return env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || sc.model || fallbackId;
    if (appType === "codex") return sc.model || env.CODEX_MODEL || fallbackId;
    if (appType === "gemini") return env.GEMINI_MODEL || sc.model || fallbackId;
    return sc.model || fallbackId;
  } catch {
    return fallbackId;
  }
}

/**
 * Heuristic project analysis from a directory tree (used by `mawf plan` when no
 * explicit signals are given).
 * @param {{ files?: number, loc?: number, languages?: string[] }} probe
 * @returns {ProjectSignals}
 */
export function inferSignals(probe) {
  const files = probe.files ?? 1;
  const loc = probe.loc ?? 0;
  const langN = (probe.languages ?? []).length;
  const parallel = Math.max(1, Math.min(8, Math.round(files / 12) + (langN > 1 ? 1 : 0)));
  const risk = files >= 50 || langN >= 4 ? "high" : files >= 15 ? "medium" : "low";
  const ctx = files >= 80 || loc >= 5000 ? "large" : files >= 20 ? "medium" : "small";
  const value = files >= 50 ? "high" : files >= 15 ? "medium" : "low";
  return {
    files, loc, languages: probe.languages ?? [],
    taskType: "coding",
    parallelizableSubtasks: parallel,
    risk,
    contextNeed: ctx,
    valuePerRun: value,
    maxIterations: 5,
    needHITL: risk === "high",
    needPersistence: ctx === "large",
  };
}
