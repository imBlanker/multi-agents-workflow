// @ts-check
// Observer (A15): session-event observation hooks that NEVER interfere.
// Contract §7.4: fail-open, time-bounded, does not affect host command or
// permission decisions; must NOT turn MAWF's cost/permission gates (which
// deliberately deny) into pass-throughs — those live in bin/guard.mjs and are
// untouched here.
//
// Ownership (§7.4): install writes ONLY entries tagged with our marker;
// uninstall removes ONLY entries carrying that marker; unknown fields and
// foreign hooks are preserved byte-level where possible; writes are atomic.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ensureDir, home } from "./util.js";

export const OBSERVER_MARKER = "mawf-observer-v1";
/** Bounded spool: cap lines and bytes so a full disk can never wedge a host. */
export const SPOOL_MAX_LINES = 500;
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024;

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute observer emit entry for the installed host command. */
export function observerCommand() {
  return `node "${path.join(PKG_ROOT, "bin", "mawf.js")}" observer emit`;
}

/** Spool location (project-local so workspaces never cross-contaminate). */
export function spoolPath(projectDir) {
  return path.join(projectDir, ".mawf", "observer", "events.jsonl");
}

/** Host settings path per host app (claude only for now — see README note). */
function settingsPath(hostApp) {
  if (hostApp !== "claude") throw new Error(`observer install unsupported for host: ${hostApp}`);
  return path.join(home(), ".claude", "settings.json");
}

/**
 * Install the observer hook for a host. Idempotent; precise ownership.
 * @param {{projectDir: string, hostApp?: string, home?: string}} p
 */
export function installObserver({ projectDir, hostApp = "claude", home: homeDir } = {}) {
  const file = settingsPath(hostApp);
  const abs = path.join(homeDir ?? home(), ".claude", "settings.json");
  const settingsFile = hostApp === "claude" ? abs : file;
  ensureDir(path.dirname(settingsFile));
  const settings = readJsonSafe(settingsFile);
  const events = Array.isArray(settings.hooks?.SessionStart) ? settings.hooks.SessionStart : [];
  if (events.some((e) => JSON.stringify(e).includes(OBSERVER_MARKER))) {
    return { ok: true, changed: false, reason: "already installed" };
  }
  const entry = {
    matcher: "*",
    hooks: [{ type: "command", command: `${observerCommand()} --project "${projectDir}" # ${OBSERVER_MARKER}` }],
  };
  const next = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}), SessionStart: [...events, entry] },
  };
  atomicWriteJson(settingsFile, next);
  return { ok: true, changed: true };
}

/**
 * Uninstall: remove ONLY entries whose serialized form contains our marker.
 * @param {{hostApp?: string, home?: string}} p
 */
export function uninstallObserver({ hostApp = "claude", home: homeDir } = {}) {
  const settingsFile = path.join(homeDir ?? home(), ".claude", "settings.json");
  const settings = readJsonSafe(settingsFile);
  const events = Array.isArray(settings.hooks?.SessionStart) ? settings.hooks.SessionStart : [];
  const kept = events.filter((e) => !JSON.stringify(e).includes(OBSERVER_MARKER));
  if (kept.length === events.length) return { ok: true, changed: false, reason: "not installed" };
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}), SessionStart: kept } };
  atomicWriteJson(settingsFile, next);
  return { ok: true, changed: true };
}

/**
 * The hook entrypoint: read stdin event, append ONE bounded line to the
 * spool, always exit 0. Any failure is swallowed (fail-open) — the host
 * session must never be blocked or slowed meaningfully by observation.
 * @param {string} raw stdin payload
 * @param {{projectDir: string, now?: () => string}} p
 * @returns {{ok: boolean, written: boolean}}
 */
export function emitEvent(raw, { projectDir, now = () => new Date().toISOString() } = {}) {
  try {
    let event = null;
    try {
      event = JSON.parse(raw);
    } catch {
      event = { raw: String(raw).slice(0, 2000) };
    }
    const line = JSON.stringify({ at: now(), event }) + "\n";
    const file = spoolPath(projectDir);
    ensureDir(path.dirname(file));
    let prior = "";
    try {
      prior = fs.readFileSync(file, "utf8");
    } catch { /* first line */ }
    let lines = prior ? prior.split("\n").filter((l) => l !== "") : [];
    lines.push(line.trim());
    while (lines.length > SPOOL_MAX_LINES) lines.shift(); // drop oldest
    let body = lines.join("\n") + "\n";
    while (Buffer.byteLength(body, "utf8") > SPOOL_MAX_BYTES && lines.length > 1) {
      lines.shift();
      body = lines.join("\n") + "\n";
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, written: true };
  } catch {
    return { ok: true, written: false }; // fail-open, always
  }
}

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function atomicWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
