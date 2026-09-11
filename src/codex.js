// @ts-check
// Codex integration via codex-plugin-cc. Claude Code is the host; the codex
// plugin ships a companion script we invoke as a subprocess. We never invoke
// Codex blindly: the planner decides *when* to review (risk-based gates), and
// this module performs the actual review and degrades gracefully if codex or
// the plugin is missing.
import { findExecutable, run as spawnSync } from "./platform/index.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { exists, isFile } from "./util.js";

/**
 * Find the codex-plugin-cc companion script.
 * Looks in ~/.claude/plugins/marketplaces/openai-codex and the installed cache.
 * @param {string} [claudeDir]
 * @returns {string|null}
 */
export function findCodexCompanion(claudeDir) {
  const cd = claudeDir ?? path.join(os.homedir(), ".claude");
  const cands = [
    path.join(cd, "plugins", "marketplaces", "openai-codex", "plugins", "codex", "scripts", "codex-companion.mjs"),
    path.join(cd, "plugins", "cache", "openai-codex", "codex", "1.0.6", "scripts", "codex-companion.mjs"),
  ];
  for (const c of cands) if (isFile(c)) return c;
  // last resort: search the cache
  const cacheRoot = path.join(cd, "plugins", "cache");
  if (exists(cacheRoot)) {
    try {
      for (const entry of fs.readdirSync(cacheRoot)) {
        const hit = path.join(cacheRoot, entry, "codex", "scripts", "codex-companion.mjs");
        if (isFile(hit)) return hit;
      }
    } catch {}
  }
  return null;
}

/** @returns {string|null} */
export function findCodexBinary() {
  return findExecutable("codex");
}

/**
 * @returns {{ binary: string|null, companion: string|null, ready: boolean, reason: string }}
 */
export function status() {
  const binary = findCodexBinary();
  const companion = findCodexCompanion();
  let reason = "ok";
  if (!binary) reason = "codex binary not found on PATH";
  else if (!companion) reason = "codex-plugin-cc companion script not found";
  return { binary, companion, ready: !!(binary && companion), reason };
}

/**
 * Run a Codex review through codex-plugin-cc. Returns Codex's output verbatim.
 * @param {object} opts
 * @param {"review"|"adversarial-review"|"delegate"} [opts.command] default "review"
 * @param {string} [opts.base]
 * @param {"auto"|"working-tree"|"branch"} [opts.scope]
 * @param {"wait"|"background"} [opts.mode]
 * @param {string} [opts.task]  for delegate
 * @param {string} [opts.companion] override path
 * @param {number} [opts.timeoutMs] default 120000
 * @param {boolean} [opts.background] spawn detached
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number|null }}
 */
export function runReview(opts = {}) {
  const companion = opts.companion ?? findCodexCompanion();
  if (!companion) {
    return { ok: false, stdout: "", stderr: "codex-plugin-cc companion script not found; install codex-plugin-cc or run `mawf doctor`", code: null };
  }
  const cmd = opts.command ?? "review";
  const args = [cmd];
  if (opts.mode === "wait") args.push("--wait");
  if (opts.mode === "background") args.push("--background");
  if (opts.base) args.push("--base", opts.base);
  if (opts.scope) args.push("--scope", opts.scope);
  if (opts.task && cmd === "delegate") args.push("--", opts.task);

  const spawnFn = opts.spawnFn ?? spawnSync;
  const r = spawnFn(process.execPath, [companion, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: opts.cwd,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(companion)) },
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

/**
 * Decide whether to invoke Codex review for a given plan + step.
 * Mirrors the planner's risk-gating so the runner can ask "should I review now?"
 * @param {{ codex: { enabled: boolean }, reviewPoints: any[], risk?: string }} plan
 * @param {{ after: string }} stepCtx  e.g. { after: "post-implementation" }
 */
export function shouldReview(plan, stepCtx) {
  if (!plan?.codex?.enabled) {
    return { review: false, reason: "codex not enabled in plan (codex-plugin-cc unavailable or not selected)" };
  }
  const hit = plan.reviewPoints.find((rp) => (rp.label || "").includes(stepCtx.after) || stepCtx.after === "any");
  if (hit) return { review: true, scope: hit.scope, by: hit.by, label: hit.label };
  return { review: false, reason: `no review gate matches "${stepCtx.after}"` };
}
