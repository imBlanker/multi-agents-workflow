import { sessionSlugs } from "../platform/index.js";
// @ts-check
// Watchdog signal classifiers — pure functions over session-transcript tails
// and spend-log stats. Priority order (user-mandated 2026-08-21): d → c → a → b
//   d. log error/interrupt counts      (cc-switch proxy_request_logs / Pi (Session) rows)
//   c. transcript stall                (file not growing while process alive)
//   a. consecutive same-type errors    (transcript tail)
//   b. permission/approval pending     (transcript tail / MCP probe state)
//
// Transcript formats (verified on real files 2026-08-21; tolerant parsing —
// unknown shapes never throw, they just contribute no signal):
//   claude  ~/.claude/projects/<slug>/<sessionId>.jsonl
//           lines: {type:"tool_result", is_error, isSidechain, sessionId,...}
//           isSidechain=true marks subagent turns.
//   pi      ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl
//           lines: {type:"message", timestamp, message:{role, content[]},...}
//   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//           lines: {type:"response_item"|"event_msg", payload:{...}}
//   dsh     session store is OFF-LIMITS by spec (rc.8 broke the SQLite format;
//           mawf keeps zero dependency) — dsh has NO transcript signals; only
//           signal-d would apply if dsh ever gets proxied. Coverage gap is
//           documented, not worked around.
import os from "node:os";

/**
 * @typedef {{ consecutiveErrors: number, stallMin: number, errorCountWindow: number, permissionPendingMin: number }} Thresholds
 * @typedef {{ signal: "d"|"c"|"a"|"b", reason: string, evidence: string, at: number }} BlockedFinding
 */

export const DEFAULT_THRESHOLDS = {
  consecutiveErrors: 3,      // signal a: run of same-class failed calls in the tail
  stallMin: 10,              // signal c: no transcript growth while process alive
  errorCountWindow: 5,       // signal d: per-session error/interrupted count over window
  permissionPendingMin: 15,  // signal b: approval requested and still unanswered
};

/**
 * Tolerantly parse the tail of a JSONL transcript: keep the last `maxLines`
 * non-empty lines that parse as objects. Never throws.
 * @param {string} text
 * @param {number} [maxLines]
 * @returns {{ ts: number, obj: any, line: string }[]}
 */
export function parseTail(text, maxLines = 200) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim());
  const tail = lines.slice(-maxLines);
  /** @type {{ ts: number, obj: any, line: string }[]} */
  const out = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object") {
        out.push({ ts: extractTs(obj), obj, line });
      }
    } catch { /* malformed line — skip */ }
  }
  return out;
}

/** Best-effort timestamp (seconds) from a parsed line; 0 when absent. */
function extractTs(obj) {
  const t = obj?.timestamp ?? obj?.ts ?? obj?.snapshot?.timestamp ?? obj?.payload?.timestamp;
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? Math.floor(n / 1000) : 0;
}

/**
 * Trailing run of consecutive error-ish entries at the END of the tail
 * (signal a) + a permission-pending flag (signal b). Trailing — not
 * window-max — because recovery means later healthy entries break the run;
 * a historical error burst must not keep an incident open forever.
 * Host-tolerant: recognizes each host's error shapes, ignores the rest.
 * @param {{ ts: number, obj: any, line: string }[]} entries
 * @returns {{ consecutiveErrors: number, lastErrorAt: number, permissionPendingSince: number }}
 */
export function classifyTail(entries) {
  let trailing = 0, lastErrorAt = 0, permSince = 0;
  for (const e of entries) {
    const o = e.obj;
    let isErr = false, isPerm = false;
    // claude: tool_result with is_error
    if (o?.type === "tool_result" && o?.is_error === true) isErr = true;
    // claude: sidechain marker doesn't change semantics, errors still count
    // generic: nested content error flags (pi tool results / codex payload errors)
    const content = o?.message?.content ?? o?.payload?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.is_error === true || c?.error != null) isErr = true;
      }
    }
    if (o?.payload?.error != null || o?.payload?.type === "error" || o?.type === "error") isErr = true;
    // error text in tool outputs (codex payload.output is tool output, not
    // user text — user text arrives in payload.content[].input_text)
    if (/\b(error|failed|exception)\b/i.test(String(o?.payload?.output ?? o?.payload?.message ?? "").slice(0, 400))) isErr = true;
    // permission / approval pending (signal b, any host wording)
    const blob = e.line.slice(0, 600);
    if (/pending approval|permission (request|denied|pending)|requires approval|waiting for approval|approve this (tool|action)/i.test(blob)) isPerm = true;

    if (isErr) { trailing++; lastErrorAt = e.ts; }
    else if (isPerm && !permSince) { permSince = e.ts; trailing = 0; }
    else { trailing = 0; }
  }
  return { consecutiveErrors: trailing, lastErrorAt, permissionPendingSince: permSince };
}

/**
 * Signal c: transcript stall — file exists & process alive but mtime/size
 * unchanged for >= stallMin while the session is not complete.
 * @param {{ lastGrowthSec: number, processAlive: boolean, nowSec?: number, thresholds?: Partial<Thresholds> }} args
 * @returns {boolean}
 */
export function detectStall(args) {
  const th = { ...DEFAULT_THRESHOLDS, ...(args.thresholds || {}) };
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  return args.processAlive && (now - args.lastGrowthSec) >= th.stallMin * 60;
}

/**
 * Evaluate all signals in priority order d → c → a → b and return the FIRST
 * firing finding (the highest-priority blocker), or null.
 * @param {{
 *   errorCount?: number,                 // signal d input (perSessionRate().errorCount over window)
 *   lastGrowthSec?: number, processAlive?: boolean,   // signal c inputs
 *   tailEntries?: { ts: number, obj: any, line: string }[], // signal a/b inputs (parseTail output)
 *   nowSec?: number, thresholds?: Partial<Thresholds>, host?: string, sessionId?: string,
 * }} args
 * @returns {BlockedFinding | null}
 */
export function evaluateSignals(args) {
  const th = { ...DEFAULT_THRESHOLDS, ...(args.thresholds || {}) };
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const where = `${args.host ?? "?"}${args.sessionId ? ` ${String(args.sessionId).slice(0, 12)}` : ""}`;

  // d — log error/interrupt counts (authoritative when spend telemetry exists)
  if ((args.errorCount ?? 0) >= th.errorCountWindow) {
    return { signal: "d", reason: `${args.errorCount} error/interrupted requests in window`, evidence: `errorCount=${args.errorCount} >= ${th.errorCountWindow} (${where})`, at: now };
  }
  // c — transcript stall
  if (detectStall({ lastGrowthSec: args.lastGrowthSec ?? 0, processAlive: args.processAlive ?? false, nowSec: now, thresholds: th })) {
    return { signal: "c", reason: `no transcript growth for ${Math.round((now - (args.lastGrowthSec ?? 0)) / 60)} min while process alive`, evidence: `lastGrowth=${args.lastGrowthSec} now=${now} (${where})`, at: now };
  }
  // a — consecutive same-type errors in the tail
  const tail = classifyTail(args.tailEntries || []);
  if (tail.consecutiveErrors >= th.consecutiveErrors) {
    return { signal: "a", reason: `${tail.consecutiveErrors} consecutive error results in transcript tail`, evidence: `run=${tail.consecutiveErrors} >= ${th.consecutiveErrors} (${where})`, at: now };
  }
  // b — permission/approval pending and unanswered
  if (tail.permissionPendingSince && (now - tail.permissionPendingSince) >= th.permissionPendingMin * 60) {
    return { signal: "b", reason: `permission/approval pending for ${Math.round((now - tail.permissionPendingSince) / 60)} min`, evidence: `since=${tail.permissionPendingSince} (${where})`, at: now };
  }
  return null;
}

/**
 * Discover session transcript candidate files for a project cwd, per host.
 * Read-only directory walks; missing dirs yield []. dsh deliberately yields []
 * (session store off-limits by spec).
 * @param {{ claudeDir?: string, piDir?: string, codexDir?: string, projectDir: string, fs?: any, path?: any }} args
 * @returns {{ host: "claude-code"|"pi"|"codex", file: string, sessionId: string }[]}
 */
export function discoverSessionFiles(args) {
  const fsh = args.fs ?? fs_default;
  const p = args.path ?? path_default;
  const cwd = args.projectDir;
  const slugs = sessionSlugs(cwd);
  /** @type {{ host: any, file: string, sessionId: string }[]} */
  const out = [];
  // claude: ~/.claude/projects/<full-path-dash-slug>/*.jsonl (leading dash kept)
  const claudeSlug = slugs.claude;
  const claudeDir = args.claudeDir ?? p.join(os.homedir(), ".claude", "projects");
  const cDir = p.join(claudeDir, claudeSlug);
  for (const file of listJsonl(fsh, cDir)) {
    const sessionId = p.basename(file).replace(/\.jsonl$/, "");
    out.push({ host: "claude-code", file, sessionId });
  }
  // pi: ~/.pi/agent/sessions/<--cwd-slug-->/<ts>_<uuid>.jsonl (dir has trailing dashes)
  const piDir = args.piDir ?? p.join(os.homedir(), ".pi", "agent", "sessions");
  const piSessDir = p.join(piDir, slugs.pi);
  for (const file of listJsonl(fsh, piSessDir)) {
    const base = p.basename(file).replace(/\.jsonl$/, "");
    const sessionId = base.split("_").pop() || base;
    out.push({ host: "pi", file, sessionId });
  }
  // codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — cwd lives inside the
  // file's session_meta, so return ALL rollouts; scan.js filters by content.
  const codexDir = args.codexDir ?? p.join(os.homedir(), ".codex", "sessions");
  for (const file of walkJsonl(fsh, codexDir, 4)) {
    const m = p.basename(file).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i) || p.basename(file).match(/rollout-.*_([0-9a-zA-Z-]+)\.jsonl$/);
    out.push({ host: "codex", file, sessionId: m ? m[1] : p.basename(file) });
  }
  return out;
}

function listJsonl(fsh, dir) {
  try { return fsh.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => dir + "/" + n); } catch { return []; }
}
function walkJsonl(fsh, dir, depth) {
  if (depth < 0) return [];
  let entries = [];
  try { entries = fsh.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  /** @type {string[]} */
  const out = [];
  for (const e of entries) {
    const full = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walkJsonl(fsh, full, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// default fs/path seams (injectable for tests)
import fs_default from "node:fs";
import path_default from "node:path";
