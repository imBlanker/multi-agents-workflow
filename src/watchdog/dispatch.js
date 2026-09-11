// @ts-check
// Watchdog rescue dispatch (PRD R4/R5): host selection (fixed order
// claude→pi→dsh→codex, skip stalled/unavailable/tried), price-valve model
// pick, Phase A (lossless unblock) / Phase B (takeover) prompt builders,
// headless invocation with injectable runner, verdict parsing, codex native
// resume/fork first-try, budget pre-check. Never kills the original process.
//
// Stable machine footer (precedent: ADVISE-DONE) — rescues MUST end with:
//   RESCUE-DONE outcome=resolved|failed|blocked
import { run as spawnSync, pythonCommand } from "../platform/index.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { exists, ensureDir, writeText, nowSec } from "../util.js";
import { candidatesForAppType } from "../modelcap.js";
import { resolvePrice } from "../pricing.js";
import { checkPriceGate } from "../pricegate.js";
import { applyEvent, saveIncident } from "./incidents.js";
import { ensureSnapshot, isGitProject, reconcileSnapshot } from "./snapshot.js";
import { signature, findCase, appendCase, precedentText } from "./knowledge.js";
import { spendSince } from "../ccswitch.js";

export const PHASE_WINDOW_SEC = 15 * 60;
export const VERDICT_RE = /RESCUE-DONE outcome=(resolved|failed|blocked)/;

/** App-type per rescue host (cc-switch app_type for candidates). */
const APP_TYPE = { claude: "claude", pi: "pi", dsh: "dsh", codex: "codex" };

/**
 * Fixed rotation minus {stalled host, unavailable hosts, already-tried}.
 * Pure.
 * @param {{ stalled: string, tried?: string[], order?: string[], available?: string[] | Set<string> }} args
 * @returns {string[]}
 */
export function selectRescueHosts(args) {
  const order = args.order && args.order.length ? args.order : ["claude", "pi", "dsh", "codex"];
  const avail = args.available == null ? null : new Set(args.available);
  const tried = new Set(args.tried || []);
  // normalize host naming: discovery layer says "claude-code", rotation says "claude"
  const stalled = String(args.stalled ?? "").replace(/^claude-code$/, "claude");
  return order.filter((h) => h !== stalled && !tried.has(h) && (avail == null || avail.has(h)));
}

/**
 * mawf-recommended model for a rescue host, not exceeding the price valve.
 * First candidate (current provider first) within the gate wins; unknown
 * price is allowed (gate policy: not blocked) but tagged.
 * @param {any} cc cc-switch ctx (readCcSwitch result)
 * @param {string} host rescue host
 * @returns {{ model: string, providerName: string, estimated: boolean } | null}
 */
export function pickRescueModel(cc, host) {
  const appType = APP_TYPE[host];
  if (!appType) return null;
  const cands = candidatesForAppType(cc, appType);
  /** @type {any} */
  let unknownPriceFallback = null;
  for (const c of cands) {
    const price = resolvePrice(c.model, { modelPricing: cc.modelPricing });
    const gate = checkPriceGate(c.model, price);
    if (gate.blocked) continue;
    const pick = { model: c.model, providerName: c.providerName || c.providerId || "", estimated: !!(price && price.estimated) };
    if (gate.priceKnown) return pick; // known + within gate wins immediately
    if (!unknownPriceFallback) unknownPriceFallback = pick; // unknown price = gate-passing fallback only
  }
  return unknownPriceFallback;
}

/**
 * Phase A prompt — LOSSLESS contract (R8: reads + non-destructive fixes only).
 * @param {{ incident: any, transcriptExcerpt?: string, precedent?: string | null }} args
 */
export function buildPhaseAPrompt(args) {
  const inc = args.incident;
  const f = inc.finding || {};
  return [
    `You are a mawf watchdog rescue agent (Phase A: unblock only).`,
    ``,
    `A ${inc.host} session (${String(inc.sessionId).slice(0, 36)}) in project ${inc.projectDir} is blocked.`,
    `Blocked signal: ${f.signal ?? "?"} — ${f.reason ?? "unknown"}.`,
    `Evidence: ${f.evidence ?? "n/a"}.`,
    `Transcript: ${inc.file} (read the tail yourself for full context).`,
    args.transcriptExcerpt ? `\nTranscript tail excerpt:\n${args.transcriptExcerpt}` : "",
    args.precedent ? `\nKnowledge-base precedent for this problem signature:\n${args.precedent}\n(fast path — still verify it actually applies)` : "",
    ``,
    `CONTRACT — Phase A is READ-ONLY + LOSSLESS only:`,
    `- Diagnose the blockage and attempt LOSSLESS unblocking (e.g. restart hung MCP servers, fix config-class issues OUTSIDE the target project's own files only when they are clearly yours to fix such as ~/.mawf/* state).`,
    `- NEVER write, modify, or delete files inside the target project. NEVER kill or signal processes. NEVER install packages.`,
    `- Operate from ${workspaceDefault()} via absolute paths into the target project.`,
    ``,
    `Report your action as one line BEFORE the footer:`,
    `FIX: <one-line description of what you did (or "none")>`,
    ``,
    `End with EXACTLY one line:`,
    `RESCUE-DONE outcome=resolved   (blockage cleared)`,
    `or RESCUE-DONE outcome=failed  (could not clear losslessly)`,
    `or RESCUE-DONE outcome=blocked (needs a human decision)`,
  ].filter((x) => x !== "").join("\n");
}

/**
 * Phase B prompt — takeover with task-context handoff (R5) + trellis discipline.
 * @param {{ incident: any, snapshotRef?: string, trellis?: boolean }} args
 */
export function buildPhaseBPrompt(args) {
  const inc = args.incident;
  const lines = [
    `You are a mawf watchdog rescue agent (Phase B: takeover).`,
    ``,
    `A ${inc.host} agent was working in ${inc.projectDir} and got blocked (${inc.finding?.reason ?? "unknown"}); Phase A could not unblock it.`,
    `Its transcript is at ${inc.file} — read it, summarize the recent state, and CONTINUE the unfinished task from there.`,
    `Work from ${workspaceDefault()} via absolute paths into the target project.`,
  ];
  if (args.trellis) {
    lines.push(
      ``,
      `This is a mawf+trellis workspace. Respect the trellis discipline:`,
      `- Check the active task: ${pythonCommand([path.join(inc.projectDir, ".trellis", "scripts", "task.py"), "current"])}`,
      `- Planning gates apply: never implement before the task is started (task.py start); follow its prd.md/design.md/implement.md.`,
      `- Record progress in the task's own artifacts, not ad-hoc files.`
    );
  }
  if (args.snapshotRef) {
    lines.push(``, `A pre-write git snapshot ref was created (${args.snapshotRef}). Prefer committing your work on a branch named rescue/${inc.id}.`);
  }
  lines.push(
    ``,
    `Report your action as one line BEFORE the footer:`,
    `FIX: <one-line description of what you did (or "none")>`,
    ``,
    `End with EXACTLY one line:`,
    `RESCUE-DONE outcome=resolved   (task continued to a sane stopping point)`,
    `or RESCUE-DONE outcome=failed  (could not continue)`,
    `or RESCUE-DONE outcome=blocked (needs a human decision)`
  );
  return lines.join("\n");
}

/**
 * Headless command for a host. cwd is ALWAYS the rescue workspace.
 * @param {{ host: string, prompt: string, model?: string | null, workspace: string, native?: "resume"|"fork", sessionId?: string }} args
 * @returns {{ bin: string, args: string[], cwd: string } | null}
 */
export function hostCommand(args) {
  const p = args.prompt.replace(/\s+$/, "");
  switch (args.host) {
    case "claude":
      return { bin: "claude", args: ["-p", ...(args.model ? ["--model", args.model] : []), p], cwd: args.workspace };
    case "pi":
      // pi -p has no per-run model flag; the price valve is enforced where
      // the host supports per-run model selection. pi runs its configured
      // default (cost-guard still bounds spend).
      return { bin: "pi", args: ["-p", p], cwd: args.workspace };
    case "dsh":
      return { bin: "dsh", args: ["--profile", "headless", p], cwd: args.workspace };
    case "codex":
      if (args.native === "resume" && args.sessionId) return { bin: "codex", args: ["exec", "resume", args.sessionId, "--", p], cwd: args.workspace };
      if (args.native === "fork" && args.sessionId) return { bin: "codex", args: ["exec", "fork", args.sessionId, "--", p], cwd: args.workspace };
      return { bin: "codex", args: ["exec", ...(args.model ? ["-m", args.model] : []), p], cwd: args.workspace };
    default:
      return null;
  }
}

/** Parse a rescue verdict from process output. */
export function parseVerdict(stdout) {
  const m = String(stdout ?? "").match(VERDICT_RE);
  return m ? { outcome: m[1] } : null;
}

/** Default headless runner (injectable). Returns { status, stdout, timedOut }. */
export function runDefault(bin, args, cwd, timeoutSec) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: (timeoutSec ?? PHASE_WINDOW_SEC) * 1000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? (r.error ? 1 : 0), stdout: String(r.stdout ?? "") + String(r.stderr ?? ""), timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM" };
}

/** Rescue workspace path (~/.mawf/watchdog/workspace; env-overridable). */
export function workspaceDefault() {
  return process.env.MAW_WATCHDOG_WORKSPACE || path.join(os.homedir(), ".mawf", "watchdog", "workspace");
}

/**
 * Bootstrap the dedicated rescue workspace: a light mawf workspace (default
 * config, agents/runtime/knowledge dirs). NEVER registered in projects.json
 * (that would make the watchdog watch itself) and never a full `mawf init`
 * (no cc-switch snapshot churn from a rescue path).
 * @param {string} [workspace]
 */
export function bootstrapWorkspace(workspace) {
  const ws = workspace ?? workspaceDefault();
  ensureDir(path.join(ws, ".mawf", "agents"));
  ensureDir(path.join(ws, ".mawf", "runtime"));
  ensureDir(path.join(ws, "knowledge"));
  const cfg = path.join(ws, ".mawf", "config.yaml");
  if (!exists(cfg)) {
    writeText(cfg, [
      "# mawf rescue workspace (watchdog-owned; standard default settings)",
      "watchdog:",
      "  # this workspace is the dispatch home, not a watched project",
      "  exclude: true",
      "",
    ].join("\n"));
  }
  return ws;
}

/**
 * Dispatch a rescue for one OPEN incident. Mutates + persists the incident.
 * @param {{
 *   incident: any, cc: any, cfg?: any,
 *   available?: string[] | Set<string>, run?: typeof runDefault,
 *   workspace?: string, dryRun?: boolean, nowSec?: number, dbPath?: string,
 *   transcriptExcerpt?: string, precedent?: string | null,
 *   ensureSnap?: typeof ensureSnapshot, log?: (line: string) => void,
 * }} args
 * @returns {{ dispatched: boolean, reason: string, host?: string, phase?: "a"|"b", native?: string, dryRun?: boolean }}
 */
export function dispatchIncident(args) {
  const inc = args.incident;
  const log = args.log ?? (() => {});
  const run = args.run ?? runDefault;
  const now = args.nowSec ?? nowSec();
  if (inc.state !== "open") return { dispatched: false, reason: `incident not open (${inc.state})` };

  // budget pre-check (hard cap; spend attribution lands in Stage 4 — the
  // check itself is here so dispatch can never outrun the cap once wired)
  if (Number(inc.budgetUsd) >= Number(inc.budgetCapUsd)) {
    applyEvent(inc, { type: "budget-stop", nowSec: now, reason: `budget $${inc.budgetUsd} >= cap $${inc.budgetCapUsd}` });
    return { dispatched: false, reason: "budget-stop" };
  }

  const cfg = args.cfg || {};
  const order = cfg.hostOrder;
  const workspace = bootstrapWorkspace(args.workspace);

  // knowledge-base lookup (R7): same-signature precedents guide the rescue
  const knowledgeDir = path.join(workspace, "knowledge");
  const sig = signature({ host: inc.host, finding: inc.finding });
  const hit = findCase(knowledgeDir, sig);
  const precedent = precedentText(hit);
  inc.signature = sig;
  saveIncident(inc);

  // phase selection: no completed Phase A yet → Phase A; else Phase B
  const phaseADone = inc.phases.some((p) => p.phase === "a" && p.endedAt);
  const phase = phaseADone ? "b" : "a";

  // Phase B safety gates: git snapshot required (R8); non-git → diagnose-only
  let snapshotRef = null;
  if (phase === "b") {
    if (inc.host === "codex" && !inc.phases.some((p) => p.native)) {
      // codex-on-codex: native resume/fork first-try (R5), then cross-host
      const native = tryNativeCodex(inc, workspace, run, args, now, log);
      if (native) return native;
    }
    const snap = (args.ensureSnap ?? ensureSnapshot)(inc.projectDir, inc.id);
    if (!snap.ok) {
      if (snap.nonGit) {
        applyEvent(inc, { type: "diagnose-only", nowSec: now, reason: snap.reason });
        return { dispatched: false, reason: "diagnose-only (non-git)" };
      }
      return { dispatched: false, reason: `snapshot failed: ${snap.reason}` };
    }
    snapshotRef = snap.ref;
    inc.snapshotRef = snap.ref;
    saveIncident(inc);
  }

  const hosts = selectRescueHosts({ stalled: inc.host, tried: inc.hostsTried, order, available: args.available });
  if (!hosts.length) {
    applyEvent(inc, { type: "hosts-exhausted", nowSec: now, reason: "no rescue host left in rotation" });
    return { dispatched: false, reason: "hosts-exhausted" };
  }
  const host = hosts[0];
  const modelPick = pickRescueModel(args.cc, host);
  if (!modelPick && (host === "claude" || host === "codex")) {
    // claude/codex support per-run models — no candidate within the valve is
    // a real stop for them; pi/dsh run their configured defaults regardless
    if (!inc.hostsTried.includes(host)) inc.hostsTried.push(host);
    saveIncident(inc);
    const next = selectRescueHosts({ stalled: inc.stalledHost ?? inc.host, tried: inc.hostsTried, order, available: args.available });
    if (!next.length) {
      applyEvent(inc, { type: "hosts-exhausted", nowSec: now, reason: `price valve: no ${host} model within gate and no host left` });
      return { dispatched: false, reason: "hosts-exhausted (price valve)" };
    }
    return { dispatched: false, reason: `no ${host} model within price valve — retry cycle with next host` };
  }

  const trellis = phase === "b" && exists(path.join(inc.projectDir, ".trellis", "scripts", "task.py"));
  const prompt = phase === "a"
    ? buildPhaseAPrompt({ incident: inc, transcriptExcerpt: args.transcriptExcerpt, precedent })
    : buildPhaseBPrompt({ incident: inc, snapshotRef, trellis });

  applyEvent(inc, { type: phase === "a" ? "dispatch-a" : "dispatch-b", nowSec: now, host });
  if (!inc.hostsTried.includes(host)) inc.hostsTried.push(host);
  const phaseRec = { phase, host, startedAt: now };
  inc.phases.push(phaseRec);

  if (args.dryRun) {
    phaseRec.endedAt = now;
    phaseRec.outcome = "dry-run";
    saveIncident(inc);
    log(`[watchdog dry-run] ${inc.id} phase ${phase} → ${host}${modelPick ? ` (${modelPick.model})` : ""}\n--- prompt ---\n${prompt}\n--- end prompt ---`);
    return { dispatched: true, dryRun: true, host, phase, reason: "dry-run (nothing spawned)" };
  }

  const cmd = hostCommand({ host, prompt, model: modelPick?.model ?? null, workspace });
  const res = run(cmd.bin, cmd.args, cmd.cwd, cfg.phaseWindowSec ? Number(cfg.phaseWindowSec) : PHASE_WINDOW_SEC);
  phaseRec.endedAt = nowSec();
  // spend attribution (R6 layer 2): window-attribution over the rescue window
  // on that host's app_type — conservative (may include concurrent user
  // requests, never misses rescue spend that went through cc-switch)
  phaseRec.spendUsd = spendSince({ dbPath: args.dbPath ?? args.cc?.dbPath, sinceSec: phaseRec.startedAt, untilSec: phaseRec.endedAt, appTypes: [APP_TYPE[host]] });
  inc.budgetUsd = Math.round((Number(inc.budgetUsd || 0) + Number(phaseRec.spendUsd || 0)) * 1e6) / 1e6;

  const verdict = res.timedOut ? { outcome: "failed" } : parseVerdict(res.stdout);
  const fixLine = String(res.stdout ?? "").match(/^FIX: (.*)$/m)?.[1] ?? "unknown";
  appendCase(knowledgeDir, {
    sig, host: inc.host, symptom: inc.finding?.reason ?? "",
    fix: fixLine, outcome: verdict && verdict.outcome === "resolved" ? "success" : "failed",
    notes: res.stdout,
  });
  if (verdict && verdict.outcome === "resolved") {
    phaseRec.outcome = "resolved";
    saveIncident(inc);
    applyEvent(inc, { type: "resolved", nowSec: nowSec(), reason: `${host} ${phase === "a" ? "unblocked" : "took over"} (verdict resolved)` });
    return { dispatched: true, host, phase, reason: "resolved" };
  }
  // failure: verdict failed/blocked, no verdict, or timeout
  phaseRec.outcome = res.timedOut ? "window-elapsed" : (verdict ? verdict.outcome : "no-verdict");
  saveIncident(inc);
  if (Number(inc.budgetUsd) >= Number(inc.budgetCapUsd)) {
    applyEvent(inc, { type: "budget-stop", nowSec: nowSec(), reason: `budget $${inc.budgetUsd} >= cap $${inc.budgetCapUsd} after ${host} ${phase}` });
    return { dispatched: true, host, phase, reason: "budget-stop" };
  }
  applyEvent(inc, { type: phase === "a" ? "phase-a-failed" : "phase-b-failed", nowSec: nowSec(), reason: `${host}: ${phaseRec.outcome}` });
  const remaining = selectRescueHosts({ stalled: inc.host, tried: inc.hostsTried, order, available: args.available });
  if (!remaining.length && phase === "b") {
    applyEvent(inc, { type: "hosts-exhausted", nowSec: nowSec(), reason: "all rescue hosts tried" });
  }
  return { dispatched: true, host, phase, reason: phaseRec.outcome };
}

/** codex-on-codex native first-try (resume, then fork). Returns a result when a native attempt ran (or errored decisively). */
function tryNativeCodex(inc, workspace, run, args, now, log) {
  for (const mode of ["resume", "fork"]) {
    const tag = `codex-native-${mode}`;
    if (inc.phases.some((p) => p.native === tag)) continue;
    applyEvent(inc, { type: "dispatch-b", nowSec: now, host: "codex" });
    const phaseRec = { phase: "b", host: "codex", native: tag, startedAt: now };
    inc.phases.push(phaseRec);
    if (args.dryRun) {
      phaseRec.endedAt = now; phaseRec.outcome = "dry-run";
      saveIncident(inc);
      log(`[watchdog dry-run] ${inc.id} phase b → codex native ${mode}`);
      return { dispatched: true, dryRun: true, host: "codex", phase: "b", native: mode, reason: "dry-run" };
    }
    const cmd = hostCommand({ host: "codex", prompt: buildPhaseBPrompt({ incident: inc, trellis: exists(path.join(inc.projectDir, ".trellis", "scripts", "task.py")) }), workspace, native: mode, sessionId: String(inc.sessionId) });
    const res = run(cmd.bin, cmd.args, cmd.cwd, PHASE_WINDOW_SEC);
    phaseRec.endedAt = nowSec();
    phaseRec.spendUsd = spendSince({ dbPath: args.dbPath ?? args.cc?.dbPath, sinceSec: phaseRec.startedAt, untilSec: phaseRec.endedAt, appTypes: ["codex"] });
    inc.budgetUsd = Math.round((Number(inc.budgetUsd || 0) + Number(phaseRec.spendUsd || 0)) * 1e6) / 1e6;
    const verdict = res.timedOut ? { outcome: "failed" } : parseVerdict(res.stdout);
    const sig0 = inc.signature || signature({ host: inc.host, finding: inc.finding });
    appendCase(path.join(workspace, "knowledge"), {
      sig: sig0, host: inc.host, symptom: inc.finding?.reason ?? "",
      fix: String(res.stdout ?? "").match(/^FIX: (.*)$/m)?.[1] ?? "unknown",
      outcome: verdict && verdict.outcome === "resolved" ? "success" : "failed",
      notes: res.stdout,
    });
    if (verdict && verdict.outcome === "resolved") {
      phaseRec.outcome = "resolved";
      saveIncident(inc);
      applyEvent(inc, { type: "resolved", nowSec: nowSec(), reason: `codex native ${mode} resolved` });
      return { dispatched: true, host: "codex", phase: "b", native: mode, reason: "resolved" };
    }
    phaseRec.outcome = res.timedOut ? "window-elapsed" : (verdict ? verdict.outcome : "no-verdict");
    saveIncident(inc);
    if (verdict && verdict.outcome === "blocked") {
      applyEvent(inc, { type: "hosts-exhausted", nowSec: nowSec(), reason: `codex native ${mode}: blocked (needs human)` });
      return { dispatched: true, host: "codex", phase: "b", native: mode, reason: "blocked" };
    }
    // resume failed → try fork next loop iteration; fork failed → caller continues cross-host
  }
  return null;
}
