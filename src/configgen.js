// @ts-check
// Generate per-agent / per-role, independently-editable config files from a
// plan + cc-switch data. Output layout under `.mawf/`:
//   .mawf/workflow.json          the full plan (machine-readable)
//   .mawf/config.yaml           global knobs: cost limits, concurrency, pricing
//   .mawf/plan.md               human-readable execution guide
//   .mawf/agents/<role>.md       agent definition (portable; works for Claude Code
//                               subagents and as a spec for Codex/other tools)
//   .mawf/agents/<role>.json     machine config: model, appType, cost limit, tools
//   .mawf/graph.json             the workflow graph (nodes/edges)
//
// Nothing is hardcoded: agents/roles are derived from the plan, and the user
// can add/remove/edit any file. `mawf add-agent`/`mawf remove-agent` mutate the
// plan and regenerate affected files.
import path from "node:path";
import fs from "node:fs";
import { writeText, writeJson, slug, toYaml, round, exists } from "./util.js";
import { resolvePrice } from "./pricing.js";
import { graphFromPlan, WorkflowGraph } from "./graph.js";

/**
 * @param {string} projectRoot
 * @param {import("./planner.js").Plan} plan
 * @param {{ modelPricing?: Record<string, any>, currentProviders?: Record<string, any> }} ccSwitch
 * @param {{ outDir?: string }} [opts] override output dir (default <projectRoot>/.mawf)
 * @returns {{ dir: string, files: string[], warnings: string[] }}
 */
export function generateConfigs(projectRoot, plan, ccSwitch = {}, opts = {}) {
  const maw = opts.outDir ? path.resolve(opts.outDir) : path.join(projectRoot, ".mawf");
  const agentsDir = path.join(maw, "agents");
  const files = [];
  const warnings = [];

  // workflow.json
  files.push(writeJson(path.join(maw, "workflow.json"), plan));

  // graph.json
  const g = graphFromPlan({ ...plan, name: plan.name });
  const v = g.validate();
  files.push(writeJson(path.join(maw, "graph.json"), { graph: g.toJSON(), validation: v }));

  // config.yaml — global knobs, all editable
  const costSources = plan.cost.sources.length ? plan.cost.sources : ["cc-switch:unavailable"];
  const priceGate = plan.priceGate ?? { thresholds: { inputPerM: 2, outputPerM: 10 }, blockedRoles: [] };
  const configYaml = toYaml({
    workflow: { id: plan.name, primary: plan.primary, selected: plan.selected, host_app: plan.hostApp },
    cost: {
      per_agent_limit_usd_per_min: plan.cost.perAgentLimitUsdPerMin,
      total_limit_usd_per_min: plan.cost.totalLimitUsdPerMin,
      max_concurrency: plan.cost.maxConcurrency,
      window_seconds: 3600,
      pricing_sources: costSources,
    },
    price_gate: {
      thresholds: { input_per_m: priceGate.thresholds.inputPerM, output_per_m: priceGate.thresholds.outputPerM },
      blocked_roles: (priceGate.blockedRoles ?? []).map((b) => b.role),
      policy: "Assigning a model with Input > $2/1M or Output > $10/1M pauses the work and reports to a human; approve with `mawf approve-model --role X --yes` or pick a cheaper model.",
    },
    codex: { enabled: plan.codex.enabled, when: plan.codex.when, review_scopes: plan.codex.reviewScopes },
    models: Object.fromEntries(plan.agents.map((a) => [a.role, { model: a.model, app_type: a.appType }])),
    editable: "Every field above is user-editable. Re-run `mawf plan` to regenerate from signals.",
  });
  files.push(writeText(path.join(maw, "config.yaml"), configYaml));

  // plan.md — human-readable execution guide
  files.push(writeText(path.join(maw, "plan.md"), planMarkdown(plan, ccSwitch)));

  // per-agent files
  for (const a of plan.agents) {
    const base = path.join(agentsDir, slug(a.role));
    const price = resolvePrice(a.model, {
      modelPricing: ccSwitch.modelPricing,
      costMultiplier: Number(ccSwitch.currentProviders?.[a.appType]?.cost_multiplier ?? 1),
    });
    if (!price) warnings.push(`No price found for ${a.role} model ${a.model}; tagged as unknown. Verify on Artificial Analysis/OpenRouter.`);

    // machine config
    const gate = a.modelChoice?.priceGate ?? null;
    // sticky human approval: keep `approved:true` across `mawf plan` re-runs
    let stickyApproved = false;
    try {
      const prev = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
      stickyApproved = !!prev?.price_gate?.approved;
    } catch {}
    const priceGateBlock = gate && (gate.blocked || gate.covered || stickyApproved)
      ? { blocked: !!gate.blocked, approved: stickyApproved, covered: !!gate.covered, plan: gate.plan ?? null, thresholds: { input_per_m: gate.thresholdIn, output_per_m: gate.thresholdOut }, price: { input_per_m: gate.inputPerM, output_per_m: gate.outputPerM }, estimated: !!gate.estimated, model: a.model, reason: gate.reason }
      : null;
    if (gate?.blocked) {
      warnings.push(`PRICE GATE: role ${a.role} model ${a.model} is expensive (${gate.reason}) — PAUSED until a human approves (mawf approve-model --role ${a.role} --yes) or a cheaper model is configured.`);
    }
    files.push(writeJson(`${base}.json`, {
      role: a.role,
      agent: a.agent,
      app_type: a.appType,
      model: a.model,
      ...(a.modelReasoningEffort ? { model_reasoning_effort: a.modelReasoningEffort } : {}),
      model_selection: a.modelChoice ?? null,
      price_gate: priceGateBlock,
      cost_rate_limit_usd_per_min: a.costRateLimitUsdPerMin,
      concurrency: a.concurrency,
      tools: a.tools,
      review_required: a.reviewRequired,
      task: a.task,
      price: price || { model_id: a.model, source: "unknown", estimated: true, notes: ["Price not found in cc-switch or fallback."] },
      editable: "All fields are independently editable. The runner reads this file at execute time.",
    }));

    // agent definition (portable)
    files.push(writeText(`${base}.md`, agentMarkdown(a, price, plan)));

    // When the host is pi (or this specific agent is pi-native), also
    // materialize the native pi agent file so pi-subagents can spawn it
    // directly. Non-destructive: only `maw-*` files are managed (pruned below).
    if (plan.hostApp === "pi" || a.agent === "pi") {
      const piAgentsDir = path.join(projectRoot, ".pi", "agents");
      files.push(writeText(path.join(piAgentsDir, `maw-${slug(a.role)}.md`), piAgentFileMd(a, plan)));
    }
  }

  // .mawf/runtime/ dir for concurrency state
  files.push(writeText(path.join(maw, "runtime", ".keep"), "# concurrency + cost state lives here (gitignored)\n"));

  // prune stale agent files for roles that are no longer in the plan
  try {
    const keep = new Set(plan.agents.map((a) => slug(a.role)));
    for (const f of fs.readdirSync(agentsDir)) {
      const m = f.match(/^(.*)\.(md|json)$/);
      if (m && !keep.has(m[1])) { fs.unlinkSync(path.join(agentsDir, f)); files.push(`(pruned) ${path.join(agentsDir, f)}`); }
    }
  } catch {}

  // prune stale maw-* pi agent files (only when pi materialization is active).
  // NEVER touch trellis-* or other non-maw pi agent files.
  try {
    const piAgentsDir = path.join(projectRoot, ".pi", "agents");
    if (exists(piAgentsDir)) {
      const keepPi = new Set(plan.agents.filter((a) => plan.hostApp === "pi" || a.agent === "pi").map((a) => `maw-${slug(a.role)}`));
      for (const f of fs.readdirSync(piAgentsDir)) {
        if (f.startsWith("maw-") && f.endsWith(".md") && !keepPi.has(f.slice(0, -3))) {
          fs.unlinkSync(path.join(piAgentsDir, f)); files.push(`(pruned) ${path.join(piAgentsDir, f)}`);
        }
      }
    }
  } catch {}

  return { dir: maw, files, warnings };
}

/**
 * @param {import("./planner.js").AgentSpec} a
 * @param {any} price
 * @param {import("./planner.js").Plan} plan
 */
function agentMarkdown(a, price, plan) {
  const priceLine = price
    ? `**Price** (${price.estimated ? "estimated" : "exact"}): ${price.input_per_m}/M in, ${price.output_per_m}/M out — source: \`${price.source}\`${price.notes ? `\n  - ${price.notes.join("\n  - ")}` : ""}`
    : `**Price**: unknown (not in cc-switch or fallback). Treat as estimate.`;
  const gate = a.modelChoice?.priceGate ?? null;
  const coveredNote = gate?.covered ? `\n> 📌 **Subscription-covered**: ${gate.reason}` : "";
  const gateBlock = gate?.blocked
    ? `
## ⚠ PRICE GATE — PAUSED (human decision required)

This agent's model is expensive and its assignment is **paused**: the work will not be
released until a human acts. Thresholds: Input > $${gate.thresholdIn}/1M Tokens OR Output > $${gate.thresholdOut}/1M Tokens.

- **Model**: \`${a.model}\` — ${gate.reason}${gate.estimated ? " (estimated price)" : ""}
- **Continue**: (a) edit this file's machine config (\`.mawf/agents/${slug(a.role)}.json\`) to use a cheaper
  model, then re-run \`mawf plan\`; or (b) explicitly approve: \`mawf approve-model --role ${a.role} --yes\`.
`
    : "";
  return `# Agent: ${a.role}
${gateBlock}${coveredNote}
> Part of workflow \`${plan.name}\` (primary: ${plan.primary}). Edit freely; the runner re-reads this file at execute time.

## Identity

- **Role**: ${a.role}
- **Host agent software**: \`${a.agent}\`
- **App type (cc-switch)**: \`${a.appType}\`
- **Model**: \`${a.model}\`${a.modelReasoningEffort ? ` @ reasoning \`${a.modelReasoningEffort}\`` : ""}
${modelSelectionMd(a)}

## Task

${a.task}

## Tools

${a.tools.map((t) => `- \`${t}\``).join("\n")}

## Cost control

- **Per-agent cost-rate limit**: $${a.costRateLimitUsdPerMin}/min (USD, real inference spend measured from cc-switch logs)
- **Concurrency**: ${a.concurrency}
- **Review required at this agent's output**: ${a.reviewRequired ? "yes" : "no"}

${priceLine}

## How to invoke

${a.agent === "codex" ? `This agent runs via **codex-plugin-cc**. From Claude Code:

\`\`\`bash
node "$CLAUDE_PLUGIN_ROOT/scripts/codex-companion.mjs" review --wait
\`\`\`

or use the slash command \`/codex:review\` (review-only). For adversarial review use \`/codex:adversarial-review\`.` : (plan.hostApp === "pi" || a.agent === "pi") ? `This agent runs via **pi-subagents**. Spawn it from the orchestrator with the native \`trellis_subagent\` tool (single/parallel/chain) or the \`/agents\` command, pointing at the pi agent file \`.pi/agents/maw-${slug(a.role)}.md\`:

- Pass the task verbatim (see the Task section above) and require it to return a compressed summary + file diffs.
- Cost control for pi is **concurrency-only**: pi is not routed via the cc-switch proxy, so real-spend is not measured. Wrap spawns with \`mawf acquire --role ${a.role}\` / \`mawf release --role ${a.role}\` to enforce concurrency.` : (plan.hostApp === "dsh" || a.agent === "dsh") ? `This agent runs via **dsh's prompt-driven subagent tool**. Spawn it from the orchestrator session (\`dsh web\`, or \`dsh --profile headless "<task>"\` for one-shot runs) — dsh has no named agent-definition files, so the portable spec IS the payload:

- Point the spawn at \`.mawf/agents/${slug(a.role)}.md\`: pass the Task section verbatim plus the tool list, and require it to return a compressed summary + file diffs.
- Cost control for dsh is **concurrency-only** (rate): dsh is not routed via the cc-switch proxy, so real-spend rate is not measured. Wrap spawns with \`mawf acquire --role ${a.role}\` / \`mawf release --role ${a.role}\`. Model prices come from cc-switch's synced \`~/.cc-switch/model-pricing.json\` where model ids match; unmatched ids price as unknown.` : `Spawn this agent from the orchestrator as a subagent with the tool list above. Pass the task verbatim and require it to return a compressed summary + file diffs.`}
`;
}

/**
 * Render the native pi agent file (`.pi/agents/maw-<role>.md`) for pi hosts.
 * Frontmatter mirrors the pi agent format (name/description/tools); the body
 * points at the portable `.mawf/agents/<role>.md` spec.
 * @param {import("./planner.js").AgentSpec} a
 * @param {import("./planner.js").Plan} plan
 */
function piAgentFileMd(a, plan) {
  const fm = [
    "---",
    `name: maw-${slug(a.role)}`,
    `description: ${a.role} agent for the MAW "${plan.name}" workflow`,
    `tools: ${a.tools.join(", ")}`,
    "---",
    "",
  ].join("\n");
  return `${fm}# maw-${slug(a.role)}

This is the pi-native spawn target for the MAW agent \`${a.role}\`. The full
spec (model, model-selection, cost control, task) lives in the portable files
\`.mawf/agents/${slug(a.role)}.md\` / \`${slug(a.role)}.json\` — read those for the
verbatim task and tool list.

- Role: ${a.role}
- Model: ${a.model}
- Task: ${a.task}
`;
}

/**
 * @param {import("./planner.js").Plan} plan
 * @param {any} ccSwitch
 */
/**
 * Render the "Model selection" block for an agent definition.
 * @param {import("./planner.js").AgentSpec} a
 */
function modelSelectionMd(a) {
  const mc = a.modelChoice;
  if (!mc) return "";
  const lines = [];
  lines.push("## Model selection (capability-aware)");
  lines.push("");
  lines.push(`- **Provider (api key)**: ${mc.provider ?? "(current provider)"}${mc.providerId ? ` (\`${mc.providerId}\`)` : ""} — chosen from ${mc.considered ?? "?"} available candidate(s)`);
  if (mc.capabilityScore != null) lines.push(`- **Capability fit**: ${mc.capabilityScore}/100 for this role`);
  lines.push(`- **Remaining quota (today)**: ${mc.quota?.remainingTodayUsd != null ? `$${mc.quota.remainingTodayUsd}` : "unknown (no daily limit set in cc-switch)"}`);
  if (mc.quota?.ratePerMin != null) lines.push(`- **Provider current spend rate**: $${mc.quota.ratePerMin}/min`);
  lines.push(`- **Estimated**: ${mc.estimated ? "yes (curated capability catalog + cc-switch pricing)" : "no"}`);
  if (mc.reasons?.length) {
    lines.push("- **Why this provider+model**:");
    for (const r of mc.reasons) lines.push(`  - ${r}`);
  }
  if (mc.alternates?.length) {
    lines.push("- **Alternates** (next-best fits):");
    for (const al of mc.alternates) lines.push(`  - ${al.provider ?? "?"} / \`${al.model}\` (fit ${al.capabilityScore ?? "?"})`);
  }
  lines.push("");
  return lines.join("\n");
}

function planMarkdown(plan, ccSwitch) {
  const lines = [];
  lines.push(`# Workflow Plan: ${plan.name}`);
  lines.push(`Generated ${plan.createdAt} on host \`${plan.hostApp}\` (capabilities: ${plan.hostCapabilities.join(", ") || "none"}).`);
  lines.push("");
  lines.push("## Selected architecture");
  lines.push(`- **Primary**: \`${plan.primary}\``);
  lines.push(`- **Combined**: ${plan.selected.map((s) => `\`${s}\``).join(", ")}`);
  lines.push("");
  lines.push("## Rationale");
  for (const r of plan.rationale) lines.push(`- ${r}`);
  lines.push("");
  if (plan.hostApp === "dsh") {
    lines.push("## Host notes — DeepSeek Harness (dsh)");
    lines.push("");
    lines.push("- **Orchestration**: one orchestrator session (`dsh web` or `dsh --profile headless`); workers spawn via the prompt-driven `subagent` tool with `.mawf/agents/<role>.md` as the payload — dsh has no named agent files.");
    lines.push("- **Headless output** (dsh ≥0.1.2-rc.1): progress streams to stderr; stdout carries only the final result.");
    lines.push("- **Skills**: trellis skills live in the shared `.agents/skills/` and dsh-private `.dsh/skills/` roots (rank 100–600 discovery).");
    lines.push("- **Context**: AGENTS.md is loaded by dsh from `$DSH_HOME/AGENTS.md` plus the project root down to the session cwd (64 KiB cap).");
    lines.push("- **Cost**: rate limits degrade to concurrency-only (`mawf acquire` / `mawf release`); model prices come from cc-switch's synced `~/.cc-switch/model-pricing.json` where model ids match.");
    lines.push("");
  }
  lines.push("## Agents & roles");
  for (const a of plan.agents) {
    lines.push(`### ${a.role}  (\`${a.agent}\`, model \`${a.model}\`${a.modelReasoningEffort ? ` @ reasoning ${a.modelReasoningEffort}` : ""})`);
    lines.push(`- Task: ${a.task}`);
    lines.push(`- Cost-rate limit: $${a.costRateLimitUsdPerMin}/min; concurrency ${a.concurrency}; review required: ${a.reviewRequired}`);
  }
  lines.push("");
  // Model assignments: capability fit -> provider remaining quota -> cost rate.
  if (plan.agents.some((a) => a.modelChoice)) {
    lines.push("## Model assignments (capability-aware)");
    lines.push("Models differ WITHIN a leaderboard (some agentic models are full-multimodal, some are reasoning/dialogue-only, some multimodal models are not agentic), so each role first filters the available provider models by capability fit, then ranks by provider remaining quota/balance and cost rate. Capability data is curated and marked estimated.");
    lines.push("");
    lines.push("| Role | Provider (api key) | Model | Capability fit | Remaining quota today | Price per M (in/out) |");
    lines.push("|---|---|---|---|---|---|");
    for (const a of plan.agents) {
      const mc = a.modelChoice;
      if (!mc) { lines.push(`| ${a.role} | (current) | \`${a.model}\` | — | — | — |`); continue; }
      const priceCell = mc.price ? `$${mc.price.input_per_m}/$${mc.price.output_per_m}${mc.price.estimated ? " est." : ""}` : "unknown";
      lines.push(`| ${a.role} | ${mc.provider ?? "(current)"} | \`${a.model}\` | ${mc.capabilityScore ?? "?"}/100 | ${mc.quota?.remainingTodayUsd != null ? "$" + mc.quota.remainingTodayUsd : "unknown"} | ${priceCell}${mc.priceGate?.covered ? " (plan-covered)" : ""} |`);
    }
    lines.push("");
  }
  lines.push("## Execution order");
  for (const g of plan.groups) {
    lines.push(`### ${g.label} ${g.parallel ? "(parallel)" : "(serial)"}`);
    for (const step of (g.steps || [])) lines.push(`- \`${step.role}\`: ${step.task}`);
  }
  lines.push("");
  lines.push("## Review gates");
  for (const rp of plan.reviewPoints) lines.push(`- ${rp.label || "review"} — by ${rp.by}, scope ${rp.scope}`);
  if (!plan.reviewPoints.length) lines.push("- (none: risk below threshold or codex unavailable)");
  lines.push("");
  lines.push("## Loops");
  for (const lp of plan.loops) lines.push(`- ${lp.label || "loop"} — max ${lp.maxIterations} iterations; exit when ${lp.exitWhen}`);
  if (!plan.loops.length) lines.push("- (none)");
  lines.push("");
  lines.push("## Cost control");
  lines.push(`- Per-agent limit: $${plan.cost.perAgentLimitUsdPerMin}/min (real inference spend from cc-switch proxy_request_logs)`);
  lines.push(`- Total workflow limit: $${plan.cost.totalLimitUsdPerMin}/min (independent constraint; enforced via concurrency + rate gating)`);
  lines.push(`- Max concurrency: ${plan.cost.maxConcurrency}`);
  lines.push(`- Pricing sources: ${plan.cost.sources.join(", ") || "cc-switch unavailable"}`);
  const gateBlocks = plan.priceGate?.blockedRoles ?? [];
  if (gateBlocks.length) {
    lines.push("");
    lines.push("## ⚠ Price gate — PAUSED roles (human decision required)");
    lines.push(`Thresholds: Input > $${plan.priceGate.thresholds.inputPerM}/1M Tokens OR Output > $${plan.priceGate.thresholds.outputPerM}/1M Tokens. The roles below were assigned an expensive model and are **paused** until a human approves or configures a cheaper model:`);
    lines.push("");
    lines.push("| Role | Provider | Model | Price (in/out per M) |");
    lines.push("|---|---|---|---|");
    for (const b of gateBlocks) {
      const p = b.price ? `$${b.price.input_per_m}/$${b.price.output_per_m}` : (b.gate ? `$${b.gate.inputPerM ?? "?"}/$${b.gate.outputPerM ?? "?"}` : "unknown");
      lines.push(`| ${b.role} | ${b.provider ?? "(current)"} | \`${b.model}\` | ${p} |`);
    }
    lines.push("");
    lines.push("Continue with `mawf approve-model --role <role> --yes` (per role) or edit `.mawf/agents/<role>.json` to a cheaper model and re-run `mawf plan`.");
  }
  lines.push("");
  lines.push("## Dynamic mutation");
  lines.push("- Add an agent: `mawf add-agent --role NAME --model ID --app claude` (or `--app codex` / `--app pi`)");
  lines.push("- Remove an agent: `mawf remove-agent --role NAME`");
  lines.push("- Re-plan: `mawf plan --project .`");
  lines.push("");
  lines.push("Edit any file under `.mawf/agents/` directly; the runner reads them at execute time.");
  return lines.join("\n") + "\n";
}
