// @ts-check
// Orchestrates `trellis init -u <user-name>` as the mandatory next step after
// `mawf init`. Trellis (npm: @mindfoldhq/trellis — "AI-assisted development
// workflow framework for Cursor, Claude Code and more") is a more powerful,
// more rigorous workflow system; MAW defers to it for the heavy workflow
// scaffolding and only provides plan + cost gate + codex review.
//
// Behaviour mandated by the project policy:
//   - run `trellis init -u <user>` as the step right after MAW init
//   - if trellis init touches a file MAW also manages (a CONFLICT), PAUSE,
//     print the conflict details + overview, and save an init log
//   - let the user choose between the MAW side and the trellis side, then
//     immediately CONTINUE trellis init (re-run, which is idempotent)
//
// A black-box CLI can't be paused mid-write, so MAW implements this as:
//   pre-snapshot MAW files → run trellis init (logged) → post-diff → on any
//   conflict, pause + prompt + apply the user's choice + re-run trellis init.
// `detectConflicts`/`applyConflictChoice` are pure and unit-tested separately.
import { findExecutable, run as spawnSync } from "./platform/index.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exists, readText, writeText, ensureDir, isoNow, home } from "./util.js";

/**
 * Detect how to invoke trellis.
 * Order: TRELLIS_BIN env → `trellis` on PATH → `npx --yes @mindfoldhq/trellis@latest`.
 * @returns {{ via: "env"|"path"|"npx", bin: string|null, args: string[] }}
 */
export function detectTrellis() {
  if (process.env.TRELLIS_BIN && exists(process.env.TRELLIS_BIN)) {
    return { via: "env", bin: process.env.TRELLIS_BIN, args: [] };
  }
  const p = findExecutable("trellis");
  if (p && exists(p)) return { via: "path", bin: p, args: [] };
  return { via: "npx", bin: null, args: ["--yes", "@mindfoldhq/trellis@latest"] };
}

/**
 * The MAW-managed files we snapshot for conflict detection (everything under
 * `.mawf/` except runtime/logs state).
 * @param {string} project
 * @returns {string[]}
 */
export function mawManagedFiles(project) {
  const out = [];
  const walk = (d) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "runtime" || e.name === "logs") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(path.join(project, ".mawf"));
  return out;
}

/**
 * Snapshot file→hash for the MAW-managed files (short sha256 prefix).
 * @param {string} project
 * @returns {Record<string, string>}
 */
export function snapshotFiles(project) {
  const map = {};
  for (const f of mawManagedFiles(project)) {
    try { map[f] = crypto.createHash("sha256").update(readText(f)).digest("hex").slice(0, 16); } catch {}
  }
  return map;
}

/**
 * Pure conflict detection: which MAW-managed files changed (or were removed)
 * between two snapshots.
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 * @returns {{ file: string, kind: "modified"|"removed", mawHash?: string, afterHash?: string }[]}
 */
export function detectConflicts(before, after) {
  const out = [];
  for (const [file, mawHash] of Object.entries(before)) {
    if (after[file] && after[file] !== mawHash) out.push({ file, kind: "modified", mawHash, afterHash: after[file] });
    else if (!after[file] && !exists(file)) out.push({ file, kind: "removed", mawHash });
  }
  return out;
}

/**
 * Restore MAW's version of a file from a snapshot hash (used when the user
 * picks "keep MAW"). Since snapshots only store hashes, MAW restores by
 * regenerating from the plan: in practice we re-run `mawf plan`. Here we just
 * surface the choice; the caller drives regeneration. Returns the choice.
 * @param {"maw"|"trellis"|"keep"|"rerun"} choice
 */
export function applyConflictChoice(choice) {
  return { choice, applied: choice === "maw" ? "MAW files will be regenerated via `mawf plan`" : choice === "trellis" ? "trellis version kept; MAW plan files left as-is" : choice === "rerun" ? "re-running trellis init to resume" : "no action" };
}

/**
 * Build the trellis `init` platform flags host-aware. Claude Code / Codex /
 * unknown hosts scope to `--claude --codex` (current behaviour). A pi host
 * scopes to `--pi` and a dsh host to `--dsh` (each plus `--claude` when
 * ~/.claude is also installed, so a dual-host machine keeps both surfaces).
 * Trellis already supports both `--pi` and `--dsh`.
 * @param {string} hostApp
 * @returns {string[]}
 */
export function trellisPlatformFlags(hostApp) {
  if (hostApp === "pi") {
    const flags = ["--pi"];
    try { if (exists(path.join(home(), ".claude"))) flags.push("--claude"); } catch {}
    return flags;
  }
  if (hostApp === "dsh") {
    const flags = ["--dsh"];
    try { if (exists(path.join(home(), ".claude"))) flags.push("--claude"); } catch {}
    return flags;
  }
  return ["--claude", "--codex"];
}

/**
 * Run `trellis init -u <user>` (non-interactive `-y`, scoped to the supported
 * hosts via `trellisPlatformFlags`), teeing output to a log file, then detect
 * + report conflicts. If nonInteractive, returns conflicts for the caller to
 * print (no stdin prompt). If interactive and conflicts exist, prompts the
 * user and re-runs trellis init to resume progress.
 *
 * @param {{ project: string, user: string, hostApp?: string, nonInteractive?: boolean, timeoutMs?: number }} opts
 * @returns {{ ok: boolean, code: number|null, conflicts: any[], logPath: string, via: string, stdout: string, stderr: string, resumed?: boolean }}
 */
export function runTrellisInit(opts) {
  const project = opts.project;
  const user = opts.user;
  const logDir = ensureDir(path.join(project, ".mawf", "logs"));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `trellis-init-${ts}.log`);
  if (!user) return { ok: false, code: null, conflicts: [], logPath, via: "", stdout: "", stderr: "user name required (-u <name>)" };

  const det = detectTrellis();
  const before = snapshotFiles(project);
  const flags = trellisPlatformFlags(opts.hostApp || "");
  const header = [
    `# MAW → trellis init log`,
    `started: ${isoNow()}`,
    `project: ${project}`,
    `user: ${user}`,
    `hostApp: ${opts.hostApp || "(auto)"}`,
    `trellis: ${det.via} ${det.bin || det.args.join(" ")}`,
    `command: trellis init -u ${user} -y ${flags.join(" ")}`,
    ``,
  ].join("\n");
  writeText(logPath, header);

  let cmd, args;
  if (det.via === "npx") { cmd = "npx"; args = [...det.args, "init", "-u", user, "-y", ...flags]; }
  else { cmd = det.bin; args = ["init", "-u", user, "-y", ...flags]; }

  const r = spawnSync(cmd, args, {
    cwd: project,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 300000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  fs.appendFileSync(logPath, stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
  const code = r.status;
  const after = snapshotFiles(project);
  const conflicts = detectConflicts(before, after);

  const summary = `\n# finished: code=${code == null ? "signal/timeout" : code}, conflicts=${conflicts.length}` + (conflicts.length ? "\n# conflicts:\n" + conflicts.map((c) => `- ${c.file} (${c.kind})`).join("\n") : "") + "\n";
  fs.appendFileSync(logPath, summary);

  // non-interactive: surface conflicts + log for the caller to print/decide
  if (opts.nonInteractive || !process.stdin.isTTY) {
    return { ok: code === 0, code, conflicts, logPath, via: det.via, stdout, stderr };
  }

  // interactive: if conflicts, pause + prompt + resume (re-run)
  if (conflicts.length) {
    process.stdout.write(`\n⚠  MAW paused trellis init: ${conflicts.length} conflict(s) between MAW and trellis:\n`);
    for (const c of conflicts) process.stdout.write(`   - ${path.relative(project, c.file)} (${c.kind})\n`);
    process.stdout.write(`   log: ${path.relative(project, logPath)}\n`);
    process.stdout.write(`   choose: [m] keep MAW (regenerate via mawf plan)  [t] keep trellis  [r] re-run trellis init to resume\n> `);
    const ans = readLineSync().trim().toLowerCase() || "r";
    if (ans === "m") {
      // regenerate MAW plan files (caller re-runs mawf plan); here we just note it
      applyConflictChoice("maw");
    } else if (ans === "t") {
      applyConflictChoice("trellis");
    } else {
      // re-run to resume
      const r2 = spawnSync(cmd, args, { cwd: project, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 300000, stdio: ["pipe", "pipe", "pipe"] });
      fs.appendFileSync(logPath, `\n# resume run: code=${r2.status}\n${r2.stdout || ""}${r2.stderr ? "\n[stderr]\n" + r2.stderr : ""}`);
      return { ok: r2.status === 0, code: r2.status, conflicts: detectConflicts(before, snapshotFiles(project)), logPath, via: det.via, stdout: stdout + (r2.stdout || ""), stderr, resumed: true };
    }
  }
  return { ok: code === 0, code, conflicts, logPath, via: det.via, stdout, stderr };
}

/** Read one line from stdin synchronously (best-effort; "" if no TTY). */
function readLineSync() {
  try {
    const buf = Buffer.alloc(1024);
    const fd = process.stdin.fd;
    const n = fs.readSync(fd, buf, 0, 1024, null);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  }
}
