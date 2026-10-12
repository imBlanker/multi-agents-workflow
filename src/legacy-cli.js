// Compatibility commands share Core selection; no optional module is imported.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, exists, slug } from './util.js';
import { isEnabled } from './integrations.js';
import { generateConfigs } from './configgen.js';
import { report as costReport, guard as costGuard, acquire, release } from './cost.js';
import { WorkflowGraph, graphFromPlan } from './graph.js';
import { resolvePrice } from './pricing.js';
import { checkPriceGate, priceGateReport } from './pricegate.js';
let selectedContext;
const loadCtx = () => selectedContext;
function out(message, ok) { process.stdout.write(message + '\n'); if (ok === false) process.exitCode = 1; }
function parse(args) {
  const out = { _: /** @type {string[]} */ ([]), flags: /** @type {Record<string,string|boolean>} */ ({}) };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.replace(/^--/, "");
      if (args[i + 1] && !args[i + 1].startsWith("-")) { out.flags[k] = args[++i]; }
      else out.flags[k] = true;
    } else if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      // short flag, e.g. -u alice
      const k = a.replace(/^-+/, "");
      if (args[i + 1] && !args[i + 1].startsWith("-")) { out.flags[k] = args[++i]; }
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (!deps.selectedContext) return (await import('./index.js')).main(argv, deps);
  selectedContext = deps.selectedContext;
  const { _: positionals, flags } = parse(argv);
  const [command, ...args] = positionals;
  const handlers = { config: cmdConfig, cost: cmdCost, guard: cmdGuard, acquire: cmdAcquire, release: cmdRelease,
    'approve-model': cmdApproveModel, 'add-agent': cmdAddAgent, 'remove-agent': cmdRemoveAgent, run: cmdRun, graph: cmdGraph };
  if (!handlers[command]) { out(`Unknown command ${command}`, false); return 1; }
  return handlers[command](args, flags);
}
// --- config ---
function cmdConfig(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const p = path.join(project, ".mawf", "config.yaml");
  if (!exists(p)) { out(`no config at ${p}; run \`mawf plan\` first`, false); return; }
  out(fs.readFileSync(p, "utf8"));
}

// --- cost ---
function cmdCost(f, flags) {
  const ctx = loadCtx({ dbPath: flags.db });
  const cfg = costCfgFrom(flags, ctx);
  const r = costReport(cfg);
  out(`Cost rate over last ${Math.round(r.windowSeconds/60)} min (impl: ${r.impl})`);
  out(`  total: ${r.total.ratePerMin} USD/min  (limit ${r.total.limitUsdPerMin}, ${r.total.usedPct}% used; spend $${r.total.totalUsd} across ${r.total.requestCount} requests)`);
  out(`  per-agent limit: $${r.perAgentLimitUsdPerMin}/min; max concurrency: ${r.maxConcurrency}`);
  for (const c of r.caveats || []) out(`  caveat: ${c}`);
  if (r.topSessions.length) {
    out(`  top sessions:`);
    for (const s of r.topSessions) out(`    ${s.sessionId?.slice(0,12)} ${s.appType} ${s.model}: ${s.ratePerMin} USD/min, ${s.requestCount} reqs`);
  }
}

// --- guard ---
function cmdGuard(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const ctx = loadCtx({ dbPath: flags.db });
  const cfg = costCfgFrom(flags, ctx);
  const stateDir = path.join(project, ".mawf", "runtime");
  // Price gate first (most restrictive): paused roles deny until a human acts.
  const blocks = blockedRolesFromAgents(project);
  if (blocks.length) {
    out(`DENY spawn: price gate blocks ${blocks.length} role(s) (${blocks.map((b) => b.role).join(", ")}) — paused for human review`, false);
    out(priceGateReport(blocks.map((b) => ({ role: b.role, model: b.model, provider: null, check: { ...b.gate, model: b.model } }))), false);
    process.exitCode = 3;
    return;
  }
  const g = costGuard(stateDir, cfg);
  // guard is a status query: exit 0 in both cases so callers parse output.
  out(g.allowed ? `ALLOW spawn: ${g.remainingConcurrency} slots free, rate ${g.totalRatePerMin}/${g.totalLimitUsdPerMin} USD/min` : `DENY spawn: ${g.reason} (rate ${g.totalRatePerMin}/${g.totalLimitUsdPerMin}, ${g.remainingConcurrency}/${g.maxConcurrency} free)`);
}

// --- acquire/release ---
function cmdAcquire(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const ctx = loadCtx({ dbPath: flags.db });
  const cfg = costCfgFrom(flags, ctx);
  const stateDir = path.join(project, ".mawf", "runtime");
  const agentId = flags.id || `agent-${Math.random().toString(36).slice(2, 8)}`;
  const role = flags.role || "worker";
  // Price gate: a role whose expensive model is not yet human-approved cannot run.
  const blocks = blockedRolesFromAgents(project).filter((b) => !flags.role || b.role === role);
  if (blocks.length) {
    const b = blocks[0];
    const r = { allowed: false, priceGate: true, reason: `PRICE GATE: role "${b.role}" is paused for human review (expensive model ${b.model}) — approve with \`mawf approve-model --role ${b.role} --yes\` or configure a cheaper model`, running: 0, ratePerMin: 0, remainingConcurrency: 0 };
    out(JSON.stringify(r));
    process.exitCode = 3;
    return;
  }
  const r = acquire(stateDir, cfg, { agentId, role, appType: flags.app });
  out(JSON.stringify(r));
}
function cmdRelease(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const stateDir = path.join(project, ".mawf", "runtime");
  const r = release(stateDir, { agentId: flags.id });
  out(JSON.stringify(r));
}

// --- approve-model (price gate HITL) ---
function cmdApproveModel(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const role = flags.role;
  if (!role) { out(`approve-model requires --role <role>`, false); return; }
  const yes = flags.yes === true || flags.yes === "true" || flags.yes === "1";
  if (!yes) { out(`approve-model requires --yes to confirm the human decision (expensive model for role "${role}")`, false); return; }
  const r = approveRoleModel(project, role, { yes: true });
  if (!r.ok) { out(`approve-model: ${r.error}`, false); return; }
  out(`approved: role "${role}" model ${r.model} (in $${r.price_gate.inputPerM ?? "?"}/M, out $${r.price_gate.outputPerM ?? "?"}/M) — guard/acquire will now allow this role`);
}

/**
 * Price-gate helpers.
 * - `blockedRolesFromAgents`: scan .mawf/agents/*.json for paused roles.
 * - `approveRoleModel`: record a human approval (sticky across re-plans).
 */
function blockedRolesFromAgents(project) {
  const out = [];
  const dir = path.join(project, ".mawf", "agents");
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const j = readJson(path.join(dir, f), null);
    if (!j) continue;
    const g = j.price_gate;
    if (g && g.blocked && !g.approved) out.push({ role: j.role ?? f.slice(0, -5), model: j.model ?? null, gate: g });
  }
  return out;
}

function approveRoleModel(project, role, opts = {}) {
  const p = path.join(project, ".mawf", "agents", slug(role) + ".json");
  const j = exists(p) ? readJson(p, null) : null;
  if (!j) return { ok: false, error: `no agent json for role "${role}" (run mawf plan first)` };
  if (!j.price_gate) return { ok: false, error: `role "${role}" is not price-gated; nothing to approve` };
  if (opts.yes !== true) return { ok: false, error: "pass --yes to confirm" };
  j.price_gate = { ...j.price_gate, approved: true };
  writeJson(p, j);
  return { ok: true, role, model: j.model, price_gate: j.price_gate };
}

// --- add/remove agent ---
function cmdAddAgent(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wfPath = path.join(project, ".mawf", "workflow.json");
  if (!exists(wfPath)) { out(`no workflow.json; run \`mawf plan\` first`, false); return; }
  const plan = readJson(wfPath);
  const role = flags.role || `agent-${plan.agents.length + 1}`;
  if (plan.agents.some((a) => a.role === role)) { out(`role ${role} already exists`, false); return; }
  const ctx = loadCtx({ dbPath: flags.db });
  const model = flags.model || "claude-sonnet-5";
  const appType = flags.app || "claude";
  // Price gate: an explicit expensive model pauses the add (report to human).
  const price = resolvePrice(model, {
    modelPricing: ctx.cc.modelPricing,
    costMultiplier: Number(ctx.cc.currentProviders?.[appType]?.cost_multiplier ?? 1),
  });
  const gate = checkPriceGate(model, price);
  if (gate.blocked && !flags["allow-pricey"]) {
    out(priceGateReport([{ role, model, provider: ctx.cc.currentProviders?.[appType]?.name ?? null, check: gate }]), false);
    out(`add-agent PAUSED by the price gate (exit 3) — re-run with --allow-pricey to approve, or pick a cheaper --model.`, false);
    process.exitCode = 3;
    return;
  }
  plan.agents.push({
    role,
    agent: flags.agent || "claude-code",
    model,
    appType,
    costRateLimitUsdPerMin: Number(flags["per-agent"]) || plan.cost.perAgentLimitUsdPerMin,
    concurrency: Number(flags.concurrency) || 1,
    tools: (flags.tools || "Read,Edit,Bash").split(","),
    reviewRequired: flags.review === true || flags.review === "true",
    task: flags.task || "Contributor agent added dynamically.",
  });
  const spec = plan.agents[plan.agents.length - 1];
  spec.modelChoice = { provider: null, providerId: null, capabilityScore: null, quota: null, price, priceGate: gate, reasons: [], estimated: true, considered: 0, alternates: [] };
  const gen = generateConfigs(project, plan, ctx.cc);
  if (gate.blocked) {
    // --allow-pricey (or the refused path above) implies human approval:
    // record it so guard/acquire release this role.
    approveRoleModel(project, role, { yes: true });
  }
  out(`added agent ${role}; regenerated ${gen.files.length} files`);
}
function cmdRemoveAgent(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wfPath = path.join(project, ".mawf", "workflow.json");
  if (!exists(wfPath)) { out(`no workflow.json`, false); return; }
  const plan = readJson(wfPath);
  const role = flags.role;
  const before = plan.agents.length;
  plan.agents = plan.agents.filter((a) => a.role !== role);
  if (plan.agents.length === before) { out(`role ${role} not found`, false); return; }
  // remove its files
  const base = path.join(project, ".mawf", "agents", slug(role));
  for (const ext of [".md", ".json"]) if (exists(base + ext)) fs.unlinkSync(base + ext);
  const ctx = loadCtx({ dbPath: flags.db });
  generateConfigs(project, plan, ctx.cc);
  out(`removed agent ${role}`);
}

// --- run ---
function cmdRun(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wfPath = path.join(project, ".mawf", "workflow.json");
  if (!exists(wfPath)) { out(`no workflow.json; run \`mawf plan\` first`, false); return; }
  const plan = readJson(wfPath);
  const g = graphFromPlan({ ...plan, name: plan.name });
  const { batches, notes } = g.topoBatches();
  out(`Execution guide for ${plan.name} (primary: ${plan.primary})`);
  out(`Host: ${plan.hostApp}; capabilities: ${(plan.hostCapabilities||[]).join(", ")}`);
  batches.forEach((b, i) => {
    out(`\nBatch ${i + 1} ${b.length > 1 ? "(parallel)" : ""}:`);
    for (const n of b) out(`  - ${n.id} [${n.kind}] ${n.role || ""} — ${n.description || ""}`);
  });
  if (notes.length) { out(`\nnotes:`); for (const n of notes) out(`  - ${n}`); }
  out(`\nBefore each spawn, run: mawf guard${flags.project ? ` --project ${flags.project}` : ""}`);
  out(`Acquire/release slots with: mawf acquire --id <id>; mawf release --id <id>`);
  if (plan.hostApp === "dsh") {
    out(`\ndsh invocation: run one orchestrator session via \`dsh web\` (workspace = ${project}) or`);
    out(`\`dsh --profile headless "<task>"\`; spawn workers with the subagent tool using`);
    out(`.mawf/agents/<role>.md as the payload (see \"How to invoke\" in each agent file).`);
  }
}

// --- graph ---
function cmdGraph(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wfPath = path.join(project, ".mawf", "graph.json");
  if (!exists(wfPath)) { out(`no graph.json; run \`mawf plan\` first`, false); return; }
  const g = readJson(wfPath).graph;
  const wf = new WorkflowGraph(g);
  out(JSON.stringify({ nodes: wf.nodes.length, edges: wf.edges.length, validation: wf.validate(), batches: wf.topoBatches().batches.length }, null, 2));
}

// --- helpers ---
/** @param {Record<string,string|boolean>} flags */
function costFrom(flags) {
  return {
    perAgent: Number(flags["per-agent"]) || undefined,
    total: Number(flags.total) || undefined,
    maxConcurrency: Number(flags.concurrency) || undefined,
  };
}
/** @param {Record<string,string|boolean>} flags @param {any} ctx */
function costCfgFrom(flags, ctx) {
  const planCost = readPlanCost(flags);
  return {
    perAgentLimitUsdPerMin: Number(flags["per-agent"]) || planCost.perAgent || 5.0,
    totalLimitUsdPerMin: Number(flags.total) || planCost.total || 10.0,
    maxConcurrency: Number(flags.concurrency) || planCost.maxConcurrency || 16,
    windowSeconds: Number(flags.window) || 3600,
    usageEnabled: isEnabled(ctx.settings, "cc-switch.usage"),
    usageProvider: ctx.usageProvider,
    dbPath: flags.db || ctx.cc.dbPath || undefined,
  };
}
/** @param {Record<string,string|boolean>} flags */
function readPlanCost(flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wf = path.join(project, ".mawf", "workflow.json");
  if (exists(wf)) {
    const p = readJson(wf);
    return p.cost || {};
  }
  return {};
}
