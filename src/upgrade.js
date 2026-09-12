import { fileURLToPath } from "node:url";
// @ts-check
// `mawf upgrade` — self-upgrade (trellis-upgrade parity, fork-first aware).
//
// Two install modes, auto-detected from the package root the running `mawf`
// resolves to (same PKG_ROOT logic as installer.js):
//
// - checkout mode (default): the repo is a git checkout (fork-first). Upgrade
//   = `git fetch <remote>` + `git merge --ff-only <remote>/<branch>` on the
//   current branch. HARD RULES: never stash, never rebase, never force. A
//   dirty tree or a diverged branch aborts with the exact manual commands.
//   Success reports old→new version and refreshes installed host templates
//   automatically (0.4.1 default; --no-apply-templates skips) by spawning
//   bin/mawf.js update — spawning so the POST-merge code runs, not this
//   already-loaded process.
//
// - npm mode: the package root sits under the global npm prefix with no .git
//   → `npm i -g <name>@latest`, then the same automatic template refresh via
//   <pkgRoot>/bin/mawf.js update (npm installs in place, so the spawned
//   binary is already the NEW code). CAVEAT (verified 2026-08-18): the unscoped
//   name `multi-agent-workflow` on npm is an unrelated third-party package
//   (squatted), so legacy installs under that name are REPORTED, not
//   upgraded. Publishes must use a different (scoped or new) name.
import { execFile as execFileSync, run as spawnSync } from "./platform/index.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { readJson, exists } from "./util.js";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {string} */
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts }).trim();
}

/** @param {string} cmd @param {string[]} args @param {object} [opts] */
function trySh(cmd, args, opts = {}) {
  try { return { ok: true, out: sh(cmd, args, opts) }; }
  catch (e) { return { ok: false, out: "", err: String(e?.message || e) }; }
}

/**
 * Detect how this `mawf` was installed.
 * @param {string} pkgRoot
 * @param {{ npmPrefix?: string }} [opts]
 * @returns {{ mode: "checkout"|"npm", pkgRoot: string, pkgName: string, version: string, gitRoot?: string, npmPrefix?: string, squatted?: boolean }}
 */
export function detectInstallMode(pkgRoot = PKG_ROOT, opts = {}) {
  const pkg = readJson(path.join(pkgRoot, "package.json"), { name: "?", version: "?" });
  const gitRoot = gitRootOf(pkgRoot);
  if (gitRoot) return { mode: "checkout", pkgRoot, pkgName: pkg.name, version: pkg.version, gitRoot };
  const npmPrefix = opts.npmPrefix ?? npmGlobalPrefix();
  const underNpm = !!npmPrefix && path.resolve(pkgRoot).startsWith(path.resolve(npmPrefix) + path.sep);
  return {
    mode: underNpm ? "npm" : "checkout", // unknown layouts degrade to checkout guidance
    pkgRoot, pkgName: pkg.name, version: pkg.version,
    npmPrefix, squatted: pkg.name === "multi-agent-workflow",
  };
}

/** @param {string} dir @returns {string|undefined} */
function gitRootOf(dir) {
  let cur = path.resolve(dir);
  while (true) {
    if (exists(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/** @returns {string} */
function npmGlobalPrefix() {
  const r = trySh("npm", ["prefix", "-g"]);
  return r.ok ? r.out : "";
}

/**
 * Host inheritance hint (0.4.2): the previously-installed manifest's host.app.
 * Injected as MAW_HOST into the spawned `update` so a bare `mawf upgrade` on
 * e.g. a dsh-install machine (that also has ~/.claude) does NOT re-detect as
 * claude-code, rewrite the manifest without the dsh files, and let the
 * stale-asset cleanup purge the dsh skills. Whitelist-guarded; undefined when
 * there is no manifest or the recorded host is unknown.
 * @returns {string|undefined}
 */
function manifestHostHint() {
  try {
    const m = readJson(path.join(os.homedir(), ".mawf", "installed.json"), null);
    const app = m?.host?.app;
    return ["pi", "dsh", "claude-code", "codex"].includes(app) ? app : undefined;
  } catch { return undefined; }
}

/**
 * Refresh installed host templates by spawning the NEW code — the running
 * process may still be the pre-upgrade binary, so an in-process install()
 * call would execute stale logic. Shared by npm and checkout modes (0.4.1:
 * runs by default after a successful upgrade; --no-apply-templates skips).
 * A refresh failure NEVER fails the upgrade itself (the new code is already
 * on disk): it degrades to a warning + manual `mawf update` hint.
 * @param {string} pkgRoot package root holding the POST-upgrade bin/mawf.js
 * @param {string[]} output
 * @param {(cmd: string, args: string[], opts?: object) => { status?: number|null, error?: any, stdout?: string }} spawnFn
 * @param {string} [hostHint] recorded install host to inject as MAW_HOST (0.4.2)
 * @returns {{ appliedTemplates: boolean }}
 */
function refreshTemplates(pkgRoot, output, spawnFn, hostHint) {
  const spawnOpts = { cwd: pkgRoot, encoding: "utf8", timeout: 300000 };
  if (hostHint) spawnOpts.env = { ...process.env, MAW_HOST: hostHint };
  // The top-level lifecycle runs Trellis only after the MAWF stage completes.
  const r = spawnFn(process.execPath, [path.join(pkgRoot, "bin", "mawf.js"), "update", "--mawf-only"], spawnOpts);
  const ok = !r.error && r.status === 0;
  const tail = String(r.stdout || "").trim().split("\n").filter(Boolean).slice(-3);
  if (ok) {
    output.push("templates refreshed (post-upgrade code):", ...tail);
    return { appliedTemplates: true };
  }
  const why = r.error ? String(r.error.message || r.error) : `exit ${r.status ?? "?"}`;
  output.push(
    `template refresh FAILED (${why}) — the upgrade itself succeeded; run \`mawf update\` manually`,
    ...tail,
  );
  return { appliedTemplates: false };
}

/**
 * Self-upgrade.
 * @param {{ dryRun?: boolean, remote?: string, applyTemplates?: boolean, tag?: string, pkgRoot?: string, npmPrefix?: string, spawnFn?: Function, runSh?: Function }} [opts]
 * @returns {{ ok: boolean, mode: string, from?: string, to?: string, followUp?: string, appliedTemplates?: boolean, output: string[], error?: string }}
 */
export function upgrade(opts = {}) {
  /** @type {string[]} */
  const output = [];
  const det = detectInstallMode(opts.pkgRoot || PKG_ROOT, { npmPrefix: opts.npmPrefix });
  const dry = !!opts.dryRun;
  const applyTpl = opts.applyTemplates !== false; // default ON since 0.4.1 (was opt-in)
  const spawnFn = opts.spawnFn ?? spawnSync;
  const runSh = opts.runSh ?? sh;
  const hostHint = opts.hostHint !== undefined ? opts.hostHint : manifestHostHint(); // test seam: explicit override

  if (opts.tag && det.mode === "checkout") {
    return { ok: false, mode: det.mode, output: [], error: "--tag is reserved for npm-mode installs; this is a git checkout — pull a branch/tag with git instead" };
  }

  if (det.mode === "npm") {
    if (det.squatted) {
      // The unscoped name on npm is NOT this project. Report; never install it.
      return {
        ok: true, mode: "npm", appliedTemplates: false, output: [
          `this install resolves to package name "${det.pkgName}", which on npm is an unrelated third-party package (name squatted)`,
          `refusing to run npm i -g; upgrade from your git checkout instead (clone the repo, \`npx . install\`)`,
        ],
      };
    }
    const installCmd = `npm i -g ${det.pkgName}@${opts.tag || "latest"}`;
    if (dry) {
      return {
        ok: true, mode: "npm", from: det.version, output: [
          `dry-run: would run \`${installCmd}\``,
          applyTpl
            ? "dry-run: would refresh templates via bin/mawf.js update (post-install code)"
            : "dry-run: templates NOT refreshed (--no-apply-templates)",
        ],
      };
    }
    try {
      const out = runSh("npm", ["i", "-g", `${det.pkgName}@${opts.tag || "latest"}`], { timeout: 300000 });
      output.push(installCmd, ...(out || "").split("\n").filter(Boolean).slice(-5));
      // npm i -g overwrites the package in place — <pkgRoot>/bin/mawf.js is
      // already the NEW code, so spawning it refreshes templates with 0.4.1+.
      const tpl = applyTpl
        ? refreshTemplates(det.pkgRoot, output, spawnFn, hostHint)
        : { appliedTemplates: false };
      if (!applyTpl) output.push("follow-up: run `mawf update` manually to refresh installed host templates");
      return { ok: true, mode: "npm", from: det.version, appliedTemplates: tpl.appliedTemplates, output };
    } catch (e) {
      return { ok: false, mode: "npm", from: det.version, output: [installCmd], error: String(e?.message || e) };
    }
  }

  // ---- checkout mode ----
  const gitRoot = det.gitRoot || det.pkgRoot;
  const remote = opts.remote || "origin";
  const branch = trySh("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok || branch.out === "HEAD") {
    return { ok: false, mode: "checkout", output: [], error: `cannot resolve the current branch in ${gitRoot} (detached HEAD?) — upgrade manually with git` };
  }

  const dirty = trySh("git", ["-C", gitRoot, "status", "--porcelain"]);
  if (dirty.ok && dirty.out) {
    return {
      ok: false, mode: "checkout", output: [],
      error: `working tree is dirty in ${gitRoot} — commit or stash first; mawf upgrade never stashes/rebases/forces. Manual: git -C ${gitRoot} status`,
    };
  }

  const remotes = trySh("git", ["-C", gitRoot, "remote"]);
  if (!remotes.ok || !remotes.out.split(/\s+/).includes(remote)) {
    return {
      ok: false, mode: "checkout", output: [],
      error: `git remote "${remote}" not found (have: ${remotes.out || "none"}). Fork users: pass --remote <name>, or add upstream: git -C ${gitRoot} remote add upstream https://github.com/imBlanker/multi-agents-workflow.git`,
    };
  }

  const target = `${remote}/${branch.out}`;
  if (dry) {
    return {
      ok: true, mode: "checkout", from: det.version, output: [
        `dry-run: git -C ${gitRoot} fetch ${remote}`,
        `dry-run: git -C ${gitRoot} merge --ff-only ${target} (branch ${branch.out})`,
        applyTpl
          ? "dry-run: would refresh templates via bin/mawf.js update (post-merge code)"
          : "dry-run: templates NOT refreshed (--no-apply-templates)",
      ],
    };
  }

  const fetch = trySh("git", ["-C", gitRoot, "fetch", remote], { timeout: 120000 });
  if (!fetch.ok) return { ok: false, mode: "checkout", output: [], error: `git fetch ${remote} failed: ${fetch.err}` };

  const merge = trySh("git", ["-C", gitRoot, "merge", "--ff-only", target], { timeout: 120000 });
  if (!merge.ok) {
    return {
      ok: false, mode: "checkout", output: [],
      error: `ff-only merge to ${target} failed (diverged from remote?) — resolve manually; mawf upgrade never rewrites history. Manual: git -C ${gitRoot} merge --ff-only ${target}   # or git pull --rebase ${remote} ${branch.out}`,
    };
  }

  const newPkg = readJson(path.join(gitRoot, "package.json"), { version: det.version });
  const followUp = "npx . update";
  output.push(`pulled ${target}: ${det.version} -> ${newPkg.version}`);
  // 0.4.1: template refresh is the DEFAULT (opt out with --no-apply-templates);
  // spawn the post-merge code so the refresh runs with the NEW templates.
  const tpl = applyTpl
    ? refreshTemplates(gitRoot, output, spawnFn, hostHint)
    : { appliedTemplates: false };
  if (!applyTpl) output.push(`follow-up: run \`${followUp}\` to refresh installed host templates (automatic unless --no-apply-templates)`);
  return { ok: true, mode: "checkout", from: det.version, to: newPkg.version, followUp, appliedTemplates: tpl.appliedTemplates, output };
}
