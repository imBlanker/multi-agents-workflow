// @ts-check
// CLI dispatch for `mawf`. All subcommands are plain functions so they can be
// unit-tested without spawning a process.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeText, writeJson, exists, ensureDir, isoNow, slug, isFile, readText, parseYamlSubset } from "./util.js";
import { readCcSwitch, piManagedByCcSwitch } from "./ccswitch.js";
import { detectHost, hostCapabilities } from "./host.js";
import { planWorkflow, inferSignals } from "./planner.js";
import { generateConfigs } from "./configgen.js";
import { report as costReport, guard as costGuard, acquire, release } from "./cost.js";
import { install, uninstall, update, migrateLegacyMawDirs } from "./installer.js";
import { doctor } from "./doctor.js";
import { upgrade } from "./upgrade.js";
import { runReview, shouldReview, status as codexStatus } from "./codex.js";
import { probeProject } from "./probe.js";
import { WorkflowGraph, graphFromPlan } from "./graph.js";
import { createProjectProfile, readRouting, routingPolicy, applyRouting, readProviderQuota, projectSyncEnabled, restoreRoutingFromSnapshot } from "./ccswitch.js";
import { runTrellisInit } from "./trellis.js";
import { snapshotCcSwitch } from "./backup.js";
import { classifyModel, selectModelForRole, candidatesForAppType, baseRole } from "./modelcap.js";
import { resolvePrice } from "./pricing.js";
import { checkPriceGate, priceGateReport } from "./pricegate.js";
import { readCodexPlan, reviewerPlanOverride } from "./codexplan.js";
import { readDshAsCc } from "./dshprovider.js";
import { readPiAsCc, mergePiIntoCc, enrichPiDbRowsWithModelsJson } from "./piprovider.js";
import { scanInventory, writeInventoryArtifacts } from "./inventory.js";
import { scanOnce } from "./watchdog/scan.js";
import { registerProject } from "./watchdog/registry.js";
import { applyGrillSwap, grillSwapStatus } from "./grillswap.js";
import { readRegistry, resolveWatchList } from "./watchdog/registry.js";
import { adviseTask, checkFreshness, renderAdvise, deriveTaskProfile } from "./advise.js";
import { loadCatalog, detectPool, deriveStages, judgePool, renderPool, readPoolState, recordJudgment } from "./pool.js";
import { writeManagedBlocks, removeManagedBlocks } from "./injectblock.js";

/**
 * Load cc-switch + host context once.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 */
function loadCtx(opts = {}) {
  const host = detectHost();
  const cc = readCcSwitch(opts.dbPath ? { dbPath: opts.dbPath } : {});
  if (cc.dbPath) cc.quota = readProviderQuota({ dbPath: cc.dbPath });
  // pi worldview (cc-switch v3.20.0+, schema v17): when cc-switch manages pi,
  // its own providers rows (app_type='pi') already flow through readCcSwitch()
  // with EXACT pricing — do NOT merge models.json rows on top (double count).
  // When unmanaged, merge models.json-derived providers under app_type "pi"
  // (pricing fills gaps only, mirroring the dsh merge below).
  cc.piManaged = piManagedByCcSwitch(cc);
  if (cc.piManaged) {
    // db rows are presence records; model lists live in models.json (written
    // by cc-switch itself) — read-only name join, pricing priority untouched
    enrichPiDbRowsWithModelsJson(cc, host.piDir);
  } else if (host.piDir) {
    mergePiIntoCc(cc, readPiAsCc({ piDir: host.piDir, ccSwitch: { modelPricing: cc.modelPricing } }));
  }
  // dsh merge (dsh is not cc-switch-managed): when a dsh home is detected,
  // its settings.yaml providers join the candidate pool under app_type
  // "dsh" and the cc-switch-synced model-pricing.json prices fill pricing
  // gaps. Existing claude/codex rows and prices are never altered.
  if (host.dshHome) {
    const dsh = readDshAsCc({ dshHome: host.dshHome, ccSwitch: { modelPricing: cc.modelPricing } });
    if (dsh) {
      cc.allProviders = [...(cc.allProviders || []), ...dsh.allProviders];
      if (dsh.currentProviders.dsh) cc.currentProviders.dsh = dsh.currentProviders.dsh;
      cc.appTypes = [...new Set([...(cc.appTypes || []), "dsh"])];
      const merged = { ...(cc.modelPricing || {}) };
      for (const [k, v] of Object.entries(dsh.modelPricing)) if (!merged[k]) merged[k] = v;
      cc.modelPricing = merged;
    }
  }
  return { host, cc, codexPlan: readCodexPlan() };
}

/** @param {string[]} args @returns {{}} */
function parse(args) {
  const out = { _: /** @type {string[]} */ ([]), flags: /** @type {Record<string,string|boolean>} */ ({}) };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.replace(/^--/, "");
      if (args[i + 1] && !args[i + 1].startsWith("--")) { out.flags[k] = args[++i]; }
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

/** @param {{signal?:any, code?:number}} [o] */
function exit0(o) { if (o?.signal) process.kill(process.pid, o.signal); }

/**
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const cmd = a._[0];
  const f = a._.slice(1);
  const flags = a.flags;
  // --version / -v prints the version regardless of position (standard CLI
  // convention); without this the flag fell through to help.
  // Legacy `.maw` -> `.mawf` migration first (single choke point; idempotent).
  const mig = migrateLegacyMawDirs({ project: flags.project });
  for (const note of mig) out(`migrated: ${note}`);
  if (flags.version === true) return cmdVersion();
  switch (cmd) {
    case "init": return cmdInit(f, flags);
    case "plan": return cmdPlan(f, flags);
    case "config": return cmdConfig(f, flags);
    case "cost": return cmdCost(f, flags);
    case "guard": return cmdGuard(f, flags);
    case "acquire": return cmdAcquire(f, flags);
    case "release": return cmdRelease(f, flags);
    case "approve-model": return cmdApproveModel(f, flags);
    case "add-agent": return cmdAddAgent(f, flags);
    case "remove-agent": return cmdRemoveAgent(f, flags);
    case "run": return cmdRun(f, flags);
    case "review": return cmdReview(f, flags);
    case "models": return cmdModels(f, flags);
    case "inventory": return cmdInventory(f, flags);
    case "watchdog": return cmdWatchdog(f, flags);
    case "advise": return cmdAdvise(f, flags);
    case "routing": return cmdRouting(f, flags);
    case "install": return cmdInstall(f, flags);
    case "uninstall": return cmdUninstall(f, flags);
    case "update": return cmdUpdate(f, flags);
    case "upgrade": return cmdUpgrade(f, flags);
    case "doctor": return cmdDoctor(f, flags);
    case "graph": return cmdGraph(f, flags);
    case "version": return cmdVersion();
    case "help": case undefined: return cmdHelp();
    default: return cmdUnknown(cmd);
  }
}

/** @param {string} s @param {boolean} [ok] */
function out(s, ok) { process.stdout.write(s + "\n"); if (ok === false) process.exitCode = 1; }

function cmdVersion() { out(`mawf ${pkgVersion()}`); }

function pkgVersion() {
  try {
    const p = readJson(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), { version: "?" });
    return p.version;
  } catch { return "?"; }
}

function cmdHelp() {
  out(`mawf — portable multi-agents workflow system for complex codebases

Usage: mawf <command> [options]

Commands:
  init          Snapshot cc-switch, then initialize a .mawf/ workspace
                (cc-switch project-profile sync is DECOUPLED by default; set
                MAW_CC_PROJECT_SYNC=1 to temporarily re-enable)
  plan          Probe the project and generate a workflow plan + per-agent configs
  inventory     Scan ALL installed supported hosts (claude/codex/pi/dsh) and
                write .mawf/inventory.json + inventory-digest.md (machine-wide
                awareness: skills/plugins/MCP/prompts/models); --json to stdout
  advise        Deterministic stay/switch recommendation for the current task
                across ALL installed hosts (scores + reasons + exact launch
                command; switch pre-creates a .mawf/handoff brief). Never
                executes anything. --check-fresh prints STALE/ADVISED_TODAY
                [--pool] stage-gated plugin-pool judgment (add/keep/remove
                verdicts + D3-safe procedures; records .mawf/runtime/
                pool-state.json; POOL-DONE footer)
                (UTC+8 day gate for proactive re-advising)
  watchdog      Scan mawf-initialized projects for alarm-blocked agent/
                subagent sessions (signals d>c>a>b) and record incidents
                (.mawf/watchdog/). --once = single cycle for cron/systemd;
                default is a resident loop every --interval min (15). Opt-in:
                nothing runs until you invoke it
  models        Show capability-aware model/provider selection per role
  config        Print the effective .mawf/config.yaml
  cost          Report current cost rate (USD/min) from cc-switch logs
  guard         Check if a new agent run is allowed under the cost/concurrency budget
  acquire       Acquire a concurrency/cost slot for an agent run
  release       Release an acquired slot
  add-agent     Dynamically add an agent/role to the current plan
  approve-model Mark a price-gated role's expensive model as human-approved
                (unblocks guard/acquire for that role; sticky across re-plans)
  remove-agent  Dynamically remove an agent/role
  run           Emit execution guidance for the current plan (host-driven)
  review        Invoke a Codex review via codex-plugin-cc (when available)
  graph         Print the workflow graph (nodes/edges) + topo batches
  routing       Show the cc-switch local-routing policy (claude on+failover;
                codex on-except-OAuth; pi/dsh N/A). Use --fix to apply.
  install       Install the MAW plugin + skills into the host agent software
  uninstall     Remove exactly what install wrote (manifest-driven, all
                hosts); configs are KEPT unless --purge-config (--keep-config
                wins if both); --restore-routing rolls cc-switch proxy_config
                back to the pre-init snapshot
  update        Reinstall (overwrites templates, keeps user edits)
  upgrade       Self-upgrade: git fetch + ff-only pull (checkout installs);
                npm i -g <name>@latest (npm installs). --dry-run to preview.
                Never stashes/rebases/forces; follow up with 'mawf update'
  doctor        Environment + capability check
  version       Print version
  help          This message

Flags (common):
  --project <dir>      project root (default: cwd)
  --db <path>          cc-switch db path override
  --task-type <t>      coding|research|refactor|review|migration|greenfield|ops
  --risk <l>           low|medium|high
  --parallel <n>       parallelizable subtasks estimate
  --per-agent <usd>    per-agent cost-rate limit USD/min (default 5)
  --total <usd>        total workflow cost-rate limit USD/min (default 10)
  --concurrency <n>    max concurrent agents (default 16)
  --allow-pricey       record human approval for every price-gated role and
                       continue (same effect as "mawf approve-model --role X --yes")
  --self-test          run planner against the mawf repo itself (smoke)

Price gate (mandatory policy): assigning a model with Input > $2/1M Tokens or
Output > $10/1M Tokens pauses the related work and reports to a human first.
plan/init/add-agent exit 3 when paused; guard/acquire deny gated roles until
"mawf approve-model --role <role> --yes" or a cheaper model is configured.
`);
}

function cmdUnknown(cmd) {
  out(`unknown command: ${cmd} (try \`mawf help\`)`, false);
}

// --- init ---
function cmdInit(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const user = flags.u || flags.user || "";
  if (!user) { out(`init requires -u <user-name> (e.g. mawf init -u alice)`, false); return; }
  ensureDir(path.join(project, ".mawf", "agents"));
  ensureDir(path.join(project, ".mawf", "runtime"));
  const ctx = loadCtx({ dbPath: flags.db });

  // 0) packaged snapshot of ALL cc-switch config BEFORE anything else touches
  //    cc-switch (only reads existing files; creates ~/.cc-switch/maw-backups/)
  const snap = snapshotCcSwitch({ dbPath: ctx.cc.dbPath || flags.db });
  if (snap.ok) out(`Initialized .mawf/ in ${project}`), out(`  cc-switch snapshot: ${snap.archive ?? snap.dir} (${snap.files} files, ${snap.totalBytes} bytes, ${snap.impl})`);
  else out(`Initialized .mawf/ in ${project}`), out(`  cc-switch snapshot: skipped — ${snap.error}`);
  const plan = planWorkflow(
    { taskType: "greenfield", files: 0, parallelizableSubtasks: 1, risk: "medium", contextNeed: "small", valuePerRun: "medium", description: "init" },
    { host: ctx.host, ccSwitch: ctx.cc, cost: costFrom(flags), codexPlan: ctx.codexPlan }
  );
  generateConfigs(project, plan, ctx.cc);
  writeText(path.join(project, ".mawf", "AGENTS.md"), AGENTS_INIT);
  try {
    const inj = writeManagedBlocks(project);
    out(`  cross-host advise block: ${inj.created.length ? `${inj.created.length} created, ` : ""}${inj.written.length} ensured (AGENTS.md/CLAUDE.md)`);
  } catch (e) { out(`  cross-host advise block: skipped — ${e?.message ?? e}`); }
  try {
    const inv = scanInventory({ projectDir: project, dbPath: flags.db });
    const invPaths = writeInventoryArtifacts(project, inv);
    out(`  inventory: ${inv.hosts.length} host(s) → ${path.relative(project, invPaths.digestPath)}`);
  } catch (e) { out(`  inventory: skipped — ${e?.message ?? e}`); }
  // watchdog registry (opt-out: --no-watchdog): machine-level projects.json;
  // nothing ever auto-runs — this only makes the project VISIBLE to `mawf
  // watchdog` when the user invokes it
  try {
    const reg = registerProject(project, { excluded: flags["no-watchdog"] === true });
    out(`  watchdog registry: ${reg.added ? "project registered (~/.mawf/projects.json)" : "already registered"}${flags["no-watchdog"] === true ? " — EXCLUDED (--no-watchdog)" : ""}`);
  } catch (e) { out(`  watchdog registry: skipped — ${e?.message ?? e}`); }
  out(`  host: ${ctx.host.app} (caps: ${hostCapabilities(ctx.host).join(", ") || "none"}); supported: Claude Code + Codex + Pi + DeepSeek Harness (dsh)`);
  out(`  cc-switch: ${ctx.cc.dbPath ? "ok (read-only)" : "not found"}; user: ${user}`);
  out(`  primary architecture: ${plan.primary}`);
  const revOv = reviewerPlanOverride(ctx.codexPlan);
  if (revOv) out(`  reviewer: codex ChatGPT ${revOv.planLabel} login → \`${revOv.model}\` @ reasoning ${revOv.reasoningEffort} (machine default; subscription-covered — price gate exempt)`);
  if (ctx.cc.dbPath && !projectSyncEnabled()) {
    out(`  cc-switch project: DECOUPLED — profiles sync disabled by policy; MAW manages project-level agent/subagent model configs in .mawf/; cc-switch is a read-only provider-config source`);
  }

  // 0b) PRICE GATE — pause + report to a human BEFORE anything else when a
  //     model assignment is expensive (Input > $2/1M or Output > $10/1M).
  const gateBlocks = (plan.priceGate?.blockedRoles ?? []).map((b) => ({ role: b.role, model: b.model, provider: b.provider, check: b.gate }));
  if (gateBlocks.length) {
    out("");
    out(priceGateReport(gateBlocks));
    if (!flags["allow-pricey"]) {
      out(`mawf init PAUSED by the price gate (exit 3) — resolve the roles above (\`mawf approve-model --role <role> --yes\` or edit .mawf/agents/*.json to a cheaper model), then re-run \`mawf init -u ${user}\`.`, false);
      process.exitCode = 3;
      return;
    }
    for (const b of gateBlocks) approveRoleModel(project, b.role, { yes: true });
    out(`  price gate: ${gateBlocks.length} expensive assignment(s) approved via --allow-pricey (recorded in .mawf/agents/*.json)`);
  }

  // 1) cc-switch project profile — DECOUPLED by default (2026-08-12): cc-switch's
  //    "project" feature (profiles) is incomplete, so MAW manages project-level
  //    agent/subagent model configs itself (.mawf/agents/*.json) and only syncs
  //    provider configs read-only. The profile code is kept but disabled;
  //    MAW_CC_PROJECT_SYNC=1 temporarily re-enables the legacy create/reuse.
  if (ctx.cc.dbPath && projectSyncEnabled()) {
    const profName = `MAW: ${path.basename(project)}${user ? ` (${user})` : ""}`;
    const pr = createProjectProfile({ name: profName, user, hostApp: ctx.host.app, dbPath: ctx.cc.dbPath });
    if (pr.ok) {
      if (pr.skipped) out(`  cc-switch project: skipped — ${pr.reason}`);
      else out(`  cc-switch project: ${pr.created ? `created "${profName}" (${pr.id})` : `reused "${profName}"`}` + (pr.protectedDefaults?.length ? `; protected 默认 profiles: ${pr.protectedDefaults.join(", ")}` : ""));
    } else {
      out(`  cc-switch project: not created — ${pr.error}`, false);
    }
  }

  // 2) routing policy check (read-only; --fix-routing applies the carve-out).
  //    pi/dsh are NOT cc-switch-managed → routing is N/A for those hosts.
  if (ctx.host.app === "pi") {
    out(`  routing policy: N/A — pi is not cc-switch-managed (providers/MCP/skills live in ~/.pi/agent/)`);
  } else if (ctx.host.app === "dsh") {
    out(`  routing policy: N/A — dsh is not cc-switch-managed (providers/MCP/skills live in $DSH_HOME; models via dsh web → Settings → Models)`);
  } else if (ctx.cc.dbPath) {
    const routing = readRouting({ dbPath: ctx.cc.dbPath });
    const pol = routingPolicy(routing);
    if (pol.compliant) {
      out(`  routing policy: compliant (claude local-routing+failover on; codex ${pol.codexOAuthInUse ? "OFF (OAuth)" : "ON"})`);
    } else {
      out(`  routing policy: NOT compliant — ${pol.violations.length} violation(s):`);
      for (const v of pol.violations) out(`    - ${v.app}.${v.field}: expected ${v.expected}, actual ${v.actual}${v.reason ? ` (${v.reason})` : ""}`);
      if (flags["fix-routing"]) {
        const ar = applyRouting({ dbPath: ctx.cc.dbPath, fix: true });
        if (ar.ok) { out(`  routing applied: ${ar.applied.join("; ")}`); }
        else out(`  routing fix failed: ${ar.error}`, false);
      } else {
        out(`    run \`mawf routing --fix\` to apply (writes ONLY proxy_config for claude/codex)`);
      }
    }
  }

  // 3) trellis init -u <user> as the mandatory next step (unless --no-trellis)
  if (flags["no-trellis"]) {
    out(`  trellis init: skipped (--no-trellis). Next step: run \`trellis init -u ${user}\`.`);
    return;
  }
  out(`  next step: trellis init -u ${user} (chained automatically)`);
  const tr = runTrellisInit({ project, user, hostApp: ctx.host.app, nonInteractive: !process.stdin.isTTY });
  if (tr.stdout) process.stdout.write(tr.stdout);
  if (tr.stderr && !tr.ok) process.stderr.write(tr.stderr);
  out(`  trellis init: ${tr.ok ? "ok" : (tr.code == null ? "interrupted" : `exit ${tr.code}`)} (via ${tr.via}); log: ${path.relative(project, tr.logPath)}`);
  if (tr.conflicts.length) {
    out(`  ⚠ ${tr.conflicts.length} conflict(s) between MAW and trellis detected (see log):`, false);
    for (const c of tr.conflicts.slice(0, 10)) out(`    - ${path.relative(project, c.file)} (${c.kind})`);
    out(`    re-run \`mawf plan --project ${project}\` to regenerate MAW's side, or \`trellis init -u ${user}\` to resume trellis`);
  }
  // grill-brainstorm swap (task 08-21-grill-brainstorm-swap): wrapper +
  // vendored grilling/grill-with-docs/domain-modeling, trellis contract kept
  try {
    const g = applyGrillSwap(project);
    out(`  trellis-brainstorm: ${g.applied ? `grill edition applied (${g.wrote.join(", ")})` : g.reason}`);
  } catch (e) { out(`  trellis-brainstorm swap: skipped — ${e?.message ?? e}`); }
}

// --- models ---
/** @param {import("./modelcap.js").Caps} caps */
function capLine(caps) {
  const mark = (v) => (v === true ? "✓" : v === false ? "✗" : "?");
  return `agentic${mark(caps.agentic)} reasoning${mark(caps.reasoning)} coding${mark(caps.coding)} vision${mark(caps.visionIn)}`;
}
function cmdWatchdog(f, flags) {
  const single = flags.once === true;
  const intervalMin = Number(flags.interval) || 15;
  const runOnce = async () => {
    const r = await scanOnce({
      projectDir: flags.project ? path.resolve(flags.project) : undefined,
      dbPath: flags.db || undefined,
      dispatch: true,
      dryRun: flags["dry-run"] === true,
      log: (l) => out(l),
    });
    if (flags.json) { out(JSON.stringify(r, null, 2)); return 0; }
    out(`watchdog scan @ ${r.at}: ${r.projects.length} project(s), ${r.blockedTotal} blocked session(s)`);
    for (const p of r.projects) {
      out(`  ${p.projectDir}: scanned ${p.sessionsScanned}, blocked ${p.blocked}, incidents opened ${p.incidentsOpened}, active ${p.activeIncidents.length}${p.dispatched.length ? `, dispatched ${p.dispatched.length}` : ""}`);
      for (const d of p.dispatched) out(`    dispatched ${d.id} → ${d.host} phase ${d.phase}${d.native ? ` (${d.native})` : ""} — ${d.reason}`);
      for (const i of p.activeIncidents) out(`    incident ${i.id} [${i.state}] ${i.host} ${String(i.sessionId).slice(0, 12)}`);
    }
    return 0;
  };
  if (single) return runOnce();
  // resident loop: `--once` is the primitive; cron/systemd users own scheduling
  out(`watchdog resident loop every ${intervalMin} min (ctrl-c to stop; use --once for schedulers)`);
  const timer = setInterval(() => { runOnce().catch((err) => out(`watchdog cycle error: ${err?.message ?? err}`, false)); }, intervalMin * 60 * 1000);
  timer.unref?.();
  runOnce().catch((err) => out(`watchdog cycle error: ${err?.message ?? err}`, false));
  return 0;
}

function cmdInventory(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const report = scanInventory({ projectDir: project, dbPath: flags.db, probe: !!flags.verify });
  if (flags.json) { out(JSON.stringify(report, null, 2)); return; }
  const paths = writeInventoryArtifacts(project, report);
  out(`cross-host inventory${flags.verify ? " (--verify: probed host CLIs for MCP status)" : ""}: ${report.hosts.length} host(s) — ${report.hosts.map((h) => h.app).join(", ") || "none"}`);
  for (const h of report.hosts) {
    if (h.error) out(`  ${h.app}: scan error — ${h.error} (skipped gracefully)`);
    else {
      const mcpStatus = h.mcps.length ? `; mcp ${h.mcps.filter((m) => m.status === "connected").length}✓/${h.mcps.filter((m) => m.status === "failed").length}✗/${h.mcps.filter((m) => m.status === "pending-approval").length}⏸/${h.mcps.filter((m) => m.status === "unsupported").length}⚠` : "";
      out(`  ${h.app}: ${h.skills.length} skills, ${h.plugins.length} plugins${h.marketplaces?.length ? `, ${h.marketplaces.length} marketplaces` : ""}, ${h.mcps.length} mcp${mcpStatus}, ${h.models.length} models; prompts global ${h.prompts?.global ? "✓" : "✗"} / project ${(h.prompts?.project || []).join("+") || "✗"}`);
      if (flags.verify) {
        const cliOnly = h.mcps.filter((m) => m.source === "claude-cli" || m.source === "codex-cli");
        if (cliOnly.length) out(`    verify: CLI-only servers added: ${cliOnly.map((m) => m.name).join(", ")}`);
        if (h.mcpNote) out(`    verify: ${h.mcpNote}`);
        if (h.harnessNote) out(`    verify: ${h.harnessNote}`);
      }
    }
  }
  out(`  wrote ${paths.jsonPath} + ${paths.digestPath}`);
}

function cmdAdvise(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  if (flags["check-fresh"]) {
    const state = path.join(project, ".mawf", "runtime", "advise-state.json");
    out(checkFreshness(state));
    return;
  }
  if (flags.pool) return cmdAdvisePool(project, flags);
  const r = adviseTask({
    projectDir: project,
    task: flags.task,
    domain: flags.domain,
    difficulty: flags.difficulty ? Number(flags.difficulty) : undefined,
    currentHost: flags.host,
  });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return; }
  out(renderAdvise(r));
}

/** Stage-gated plugin-pool judgment (advisory-only; never executes). */
function cmdAdvisePool(project, flags) {
  const catalog = loadCatalog(flags.catalog);
  const report = scanInventory({ projectDir: project });
  const pool = report.pool || detectPool(report, catalog);
  const profile = flags.task
    ? { text: flags.task, domain: flags.domain || "" }
    : deriveTaskProfile(project);
  const stageInfo = deriveStages(project);
  const poolState = readPoolState(project);
  // current stage = first with <2 judgments, else the last stage
  let stageCtx = null;
  if (stageInfo) {
    stageCtx = stageInfo.stages.find((s) => ((poolState.stages[s.id]?.judgments) || []).length < 2) || stageInfo.stages[stageInfo.stages.length - 1];
  }
  const cfg = readPoolConfig(project);
  const j = judgePool({ catalog, pool, profile, stageCtx, poolState, cfg });
  const verdictMap = {};
  for (const v of j.verdicts) verdictMap[v.component] = { verdict: v.verdict, low: v.low === true };
  const state = recordJudgment(project, stageCtx, verdictMap, new Date().toISOString());
  const n = stageCtx ? ((state.stages[stageCtx.id]?.judgments) || []).length : 0;
  if (flags.json) { out(JSON.stringify({ ...j, state }, null, 2)); return; }
  out(renderPool(j, stageCtx ? { judgments: n, needed: 2 } : undefined));
}

/** pool: section of .mawf/config.yaml (threshold/stayBonus/removeLookback). */
function readPoolConfig(project) {
  const file = path.join(project, ".mawf", "config.yaml");
  if (!isFile(file)) return {};
  try {
    const parsed = parseYamlSubset(readText(file));
    const p = parsed?.pool;
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}

function cmdModels(f, flags) {
  const ctx = loadCtx({ dbPath: flags.db });
  if (!ctx.cc.dbPath && !(ctx.cc.allProviders || []).length) { out(`cc-switch database not found`, false); return; }
  const appType = flags.app || "claude";
  const cands = candidatesForAppType(ctx.cc, appType);
  if (appType === "pi") out(ctx.cc.piManaged
    ? `  note: pi is cc-switch-managed (schema v17+); providers & exact pricing come from the cc-switch db; live config still mirrors ~/.pi/agent/models.json`
    : `  note: pi models come from ~/.pi/agent/models.json (estimated; pi is not cc-switch-managed)`);
  if (appType === "dsh") out(`  note: dsh models come from $DSH_HOME/settings.yaml (not cc-switch-managed); prices from ~/.cc-switch/model-pricing.json where model ids match`);
  out(`Model capability view — curated catalog, estimated (dimensions mirror the artificialanalysis.ai model leaderboards: intelligence / coding / math / agentic / multimodal-vision / image / image-edit / video / tts / stt)`);
  out(`Available ${appType} provider models (${cands.length}):`);
  for (const c of cands) {
    const cls = classifyModel(c.model);
    const q = ctx.cc.quota?.providers?.[c.providerId] ?? {};
    out(`  ${c.providerName}${c.isCurrent ? " (current)" : ""}: ${c.model} — ${cls.family}; ${capLine(cls.caps)}${q.remainingTodayUsd != null ? `; quota today $${q.remainingTodayUsd}` : "; quota unknown"}${q.ratePerMin ? `; rate $${q.ratePerMin}/min` : ""}`);
  }
  out(`\nRole assignments (capability fit → provider remaining quota/balance → cost rate):`);
  const roles = flags.role ? [flags.role] : ["orchestrator", "researcher", "implementer", "researcher-2", "reviewer"];
  for (const role of roles) {
    // Machine policy (2026-08-24): reviewer on codex with a Pro / Pro-Lite
    // ChatGPT login → gpt-5.6-sol @ low, subscription-covered.
    const planOv = baseRole(role) === "reviewer" && appType === "codex" ? reviewerPlanOverride(ctx.codexPlan) : null;
    if (planOv) {
      out(`  ${role} → ${planOv.providerLabel} / ${planOv.model} (machine default, reasoning ${planOv.reasoningEffort}; subscription-covered — price gate exempt)`);
      continue;
    }
    const at = baseRole(role) === "reviewer" && appType !== "codex" ? appType : appType;
    const sel = selectModelForRole({ role, appType: at, cc: ctx.cc, quota: ctx.cc.quota, preferCheap: /-2$/.test(role) });
    if (!sel) { out(`  ${role}: no available candidates for app_type "${at}"`); continue; }
    const gate = checkPriceGate(sel.model, resolvePrice(sel.model, {
      modelPricing: ctx.cc.modelPricing,
      costMultiplier: Number(ctx.cc.currentProviders?.[at]?.cost_multiplier ?? 1),
    }));
    out(`  ${role} → ${sel.providerName} / ${sel.model} (fit ${sel.capabilityScore}/100${sel.quota?.remainingTodayUsd != null ? `, quota today $${sel.quota.remainingTodayUsd}` : ", quota unknown"}${sel.price ? `, $${sel.price.input_per_m}/$${sel.price.output_per_m} per M${sel.price.estimated ? " est." : ""}` : ""})${gate.blocked ? " ⚠ PRICE GATE (would pause: " + gate.reason + ")" : ""}`);
    for (const al of sel.alternates) out(`    alt: ${al.providerName} / ${al.model} (fit ${al.capabilityScore})`);
  }
}

// --- routing ---
function cmdRouting(f, flags) {
  const ctx = loadCtx({ dbPath: flags.db });
  if (ctx.host.app === "dsh") {
    out(`routing policy: N/A — dsh is not cc-switch-managed (providers/MCP/skills live in $DSH_HOME; nothing to route or fix)`);
    return;
  }
  if (!ctx.cc.dbPath) { out(`cc-switch database not found`, false); return; }
  const routing = readRouting({ dbPath: ctx.cc.dbPath });
  const pol = routingPolicy(routing);
  out(`cc-switch routing policy (claude: local-routing+auto-failover always ON; codex: OFF when OpenAI-OAuth, else ON)`);
  out(`  codex OAuth login in use: ${pol.codexOAuthInUse}`);
  out(`  claude: routing ${routing.claude?.enabled ? "on" : "off"}, failover ${routing.claude?.autoFailoverEnabled ? "on" : "off"} (queue: ${pol.claudeFailoverProviders.join(", ") || "none"})`);
  out(`  codex:  routing ${routing.codex?.enabled ? "on" : "off"} (queue: ${pol.codexFailoverProviders.join(", ") || "none"})`);
  out(`  pi:     N/A (not cc-switch-managed; config lives in ~/.pi/agent/)`);
  out(`  dsh:    N/A (not cc-switch-managed; config lives in $DSH_HOME/settings.yaml)`);
  if (pol.compliant) { out(`  status: compliant ✓`); return; }
  out(`  status: NOT compliant — ${pol.violations.length} violation(s):`);
  for (const v of pol.violations) out(`    - ${v.app}.${v.field}: expected ${v.expected}, actual ${v.actual}${v.reason ? ` — ${v.reason}` : ""}`);
  if (flags.fix) {
    const ar = applyRouting({ dbPath: ctx.cc.dbPath, fix: true });
    if (ar.ok) { out(`  applied: ${ar.applied.join("; ")}`); out(`  ${ar.note}`); }
    else out(`  fix failed: ${ar.error}`, false);
  } else {
    out(`  run \`mawf routing --fix\` to apply (writes ONLY proxy_config for claude/codex; never touches profiles/providers)`);
  }
}

// --- plan ---
function cmdPlan(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const ctx = loadCtx({ dbPath: flags.db });
  let signals;
  if (flags["self-test"]) {
    const probe = probeProject(path.dirname(new URL(import.meta.url).pathname));
    signals = inferSignals(probe);
  } else if (exists(project) && !flags.taskType) {
    const probe = probeProject(project);
    signals = inferSignals(probe);
  } else {
    signals = {
      taskType: flags["task-type"] || "coding",
      parallelizableSubtasks: Number(flags.parallel) || 2,
      risk: flags.risk || "medium",
      contextNeed: flags.context || "medium",
      valuePerRun: flags.value || "medium",
      files: Number(flags.files) || 10,
    };
  }
  if (flags["task-type"]) signals.taskType = flags["task-type"];
  if (flags.parallel) signals.parallelizableSubtasks = Number(flags.parallel);
  if (flags.risk) signals.risk = flags.risk;
  if (flags.context) signals.contextNeed = flags.context;
  if (flags.value) signals.valuePerRun = flags.value;
  if (flags["max-iter"]) signals.maxIterations = Number(flags["max-iter"]);
  if (flags.hitl) signals.needHITL = true;
  if (flags.persistence) signals.needPersistence = true;
  signals.description = flags.description || path.basename(project);

  const plan = planWorkflow(signals, { host: ctx.host, ccSwitch: ctx.cc, cost: costFrom(flags), codexPlan: ctx.codexPlan });
  const gen = generateConfigs(project, plan, ctx.cc);
  try {
    const inv = scanInventory({ projectDir: project, dbPath: flags.db });
    const invPaths = writeInventoryArtifacts(project, inv);
    out(`  inventory: ${inv.hosts.length} host(s) → ${path.relative(project, invPaths.digestPath)}`);
  } catch (e) { out(`  inventory: skipped — ${e?.message ?? e}`); }
  try {
    writeManagedBlocks(project);
  } catch {}

  // Price gate (HITL): a model assignment with Input > $2/1M or Output >
  // $10/1M pauses the plan and reports to a human. --allow-pricey records the
  // human approval (same effect as `mawf approve-model`) and continues.
  const gateBlocks = (plan.priceGate?.blockedRoles ?? []).map((b) => ({ role: b.role, model: b.model, provider: b.provider, check: b.gate }));
  if (gateBlocks.length) {
    out("");
    out(priceGateReport(gateBlocks));
    if (!flags["allow-pricey"]) {
      out(`mawf plan PAUSED by the price gate (exit 3) — resolve via \`mawf approve-model --role <role> --yes\`, a cheaper model in .mawf/agents/*.json, or re-run with --allow-pricey.`, false);
      process.exitCode = 3;
      return;
    }
    for (const b of gateBlocks) approveRoleModel(project, b.role, { yes: true });
    out(`price gate: ${gateBlocks.length} expensive assignment(s) approved via --allow-pricey (recorded in .mawf/agents/*.json)`);
  }
  const outDir = flags.out ? path.resolve(flags.out) : path.join(project, ".mawf");
  if (flags.out) {
    const g = generateConfigs(project, plan, ctx.cc, { outDir: flags.out });
    out(`plan written to ${outDir} (${g.files.length} files)`);
    if (g.warnings.length) { out(`  warnings:`); for (const w of g.warnings) out(`    - ${w}`); }
  } else {
    out(`plan: ${plan.primary} (${plan.selected.join(", ")})`);
    const revOv = reviewerPlanOverride(ctx.codexPlan);
    if (revOv) out(`  reviewer: codex ChatGPT ${revOv.planLabel} login → \`${revOv.model}\` @ reasoning ${revOv.reasoningEffort} (machine default; subscription-covered — price gate exempt)`);
    out(`  agents: ${plan.agents.map((a) => `${a.role}(${a.agent})`).join(", ")}`);
    out(`  review gates: ${plan.reviewPoints.length}`);
    out(`  loops: ${plan.loops.length}`);
    out(`  cost: $${plan.cost.perAgentLimitUsdPerMin}/min per agent, $${plan.cost.totalLimitUsdPerMin}/min total, max ${plan.cost.maxConcurrency} concurrent`);
    out(`  written: ${gen.files.length} files to ${gen.dir}`);
    if (gen.warnings.length) { out(`  warnings:`); for (const w of gen.warnings) out(`    - ${w}`); }
  }
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

// --- review ---
function cmdReview(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const wfPath = path.join(project, ".mawf", "workflow.json");
  let plan = null;
  if (exists(wfPath)) plan = readJson(wfPath);
  const cs = codexStatus();
  if (!cs.ready) { out(`codex not ready: ${cs.reason}`, false); return; }
  const dec = plan ? shouldReview(plan, { after: flags.after || "post-implementation" }) : { review: true, scope: flags.scope || "auto" };
  if (flags.force !== true && dec.review === false) { out(`no review gate matched (run with --force to review anyway): ${dec.reason}`); return; }
  const r = runReview({
    command: flags.command || "review",
    scope: dec.scope || flags.scope,
    base: flags.base,
    mode: flags.mode === "background" ? "background" : "wait",
  });
  if (r.stdout) out(r.stdout);
  if (r.stderr && !r.ok) out(`[stderr] ${r.stderr}`, false);
  if (!r.ok) out(`review exited with code ${r.code}`, false);
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

// --- install/uninstall/update ---
function cmdInstall(f, flags) {
  const r = install({ force: flags.force });
  try { writeManagedBlocks(flags.project ? path.resolve(flags.project) : process.cwd()); } catch {}
  out(`installed mawf ${pkgVersion()}`);
  for (const c of r.copied) out(`  copied -> ${c}`);
  if (r.removedStale?.length) {
    out(`  removed ${r.removedStale.length} stale asset(s) from an older install:`);
    for (const s of r.removedStale) out(`    - ${s}`);
  }
  out(`  host: ${r.host.app} (codex plugin: ${r.host.codexPluginInstalled ? "yes" : "no"})`);
  if (r.warnings.length) for (const w of r.warnings) out(`  ! ${w}`);
}
function cmdUninstall(f, flags) {
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  // --keep-config (explicit) and --purge-config both given -> keep (safe default)
  const purge = flags["purge-config"] === true && flags["keep-config"] !== true;
  const r = uninstall({ project, purgeConfig: purge });
  out(`uninstalled mawf — ${r.removed.length} file(s)/dir(s) removed`);
  for (const c of r.removed) out(`  removed: ${c}`);
  if (r.purged.length) {
    out(`  purged configs (--purge-config):`);
    for (const p of r.purged) out(`    - ${p}`);
  }
  if (r.kept.length) {
    out(`  kept configs (default; pass --purge-config to delete):`);
    for (const p of r.kept) out(`    - ${p}`);
  }
  out(`  trellis-owned files (.trellis/, .agents/skills, .dsh/skills trellis entries) are NOT removed — remove them manually if desired`);
  if (flags["restore-routing"]) {
    const rr = restoreRoutingFromSnapshot({});
    if (rr.ok) {
      out(`  routing restored from snapshot (${rr.snapshot}):`);
      for (const a of rr.applied) out(`    - ${a}`);
    } else {
      out(`  routing restore failed: ${rr.error}`, false);
    }
  } else {
    out(`  routing: pass --restore-routing to roll cc-switch proxy_config (claude/codex) back to the latest pre-MAW snapshot`);
  }
}
function cmdUpdate(f, flags) {
  const r = update({ force: flags.force });
  try { writeManagedBlocks(flags.project ? path.resolve(flags.project) : process.cwd()); } catch {}
  out(`updated mawf ${pkgVersion()}`);
  // grill-swap repair across registered workspaces (a `trellis update` may
  // have restored the stock trellis-brainstorm; re-apply idempotently)
  try {
    const list = resolveWatchList(readRegistry(), {}, { exists: (p) => exists(p) });
    let repaired = 0;
    for (const { dir } of list) {
      const st = grillSwapStatus(dir);
      if (st.trellisBrainstormPresent && (!st.wrapperCurrent || st.missing.length)) {
        const g = applyGrillSwap(dir);
        if (g.applied) repaired++;
      }
    }
    if (repaired) out(`  grill swap: repaired in ${repaired} registered workspace(s)`);
  } catch {}
  for (const c of r.copied) out(`  copied -> ${c}`);
  if (r.removedStale?.length) {
    out(`  removed ${r.removedStale.length} stale asset(s) from an older install:`);
    for (const s of r.removedStale) out(`    - ${s}`);
  }
}
function cmdUpgrade(f, flags) {
  const r = upgrade({
    dryRun: flags["dry-run"] === true,
    remote: typeof flags.remote === "string" ? flags.remote : undefined,
    // 0.4.1: templates refresh by default; --no-apply-templates opts out
    // (explicit opt-out wins over --apply-templates regardless of order).
    applyTemplates: flags["no-apply-templates"] === true ? false : undefined,
    tag: typeof flags.tag === "string" ? flags.tag : undefined,
  });
  for (const line of r.output) out(`  ${line}`);
  if (!r.ok) { out(`upgrade failed: ${r.error}`, false); process.exitCode = 1; return; }
  if (flags["dry-run"] === true) { out(`upgrade dry-run ok (mode: ${r.mode}; nothing changed)`); return; }
  out(`upgraded mawf${r.from && r.to ? ` ${r.from} -> ${r.to}` : ""} (mode: ${r.mode}; templates: ${r.appliedTemplates === true ? "refreshed" : r.appliedTemplates === false ? "not refreshed" : "n/a"})`);
  try { writeManagedBlocks(flags.project ? path.resolve(flags.project) : process.cwd()); } catch {}
}

// --- doctor ---
function cmdDoctor(f, flags) {
  const r = doctor({ projectDir: flags.project, catalogPath: flags.catalog });
  out(`mawf doctor — ${r.summary}`);
  for (const c of r.checks) out(`  [${c.status.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`);
  if (!r.ok) process.exitCode = 1;
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

const AGENTS_INIT = `# MAW Workspace

This directory is generated by \`mawf plan\`. Everything here is editable.

- \`workflow.json\` — the full plan (re-read by the runner at execute time)
- \`config.yaml\`   — global knobs: cost limits, concurrency, pricing sources
- \`plan.md\`       — human-readable execution guide
- \`agents/*.md\`    — portable agent definitions (one per role)
- \`agents/*.json\`  — machine configs (model, cost limit, tools)
- \`graph.json\`     — workflow graph (nodes/edges)
- \`runtime/\`       — concurrency + cost state (gitignored)

Re-run \`mawf plan\` to regenerate from fresh project signals.
`;
