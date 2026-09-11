import { materializePluginAssets } from "./pluginassets.js";
import { fileURLToPath } from "node:url";
// @ts-check
// Installer: copies the MAW plugin (commands/agents/hooks/skills) into the host
// agent software's directories, writes an install manifest, and runs an env
// check. Supports install / uninstall / update for Claude Code and (best-effort)
// Codex. Keeps everything reversible and non-destructive.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exists, isFile, ensureDir, writeJson, readJson, writeText } from "./util.js";
import { detectHost, hostCapabilities } from "./host.js";
import { removeManagedBlocks } from "./injectblock.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Prune directories that became empty — ONLY ancestors of removed paths,
 * and only strict descendants of a recorded host dir (never the host home
 * itself, never unrelated user dirs). Shared by uninstall (post-removal)
 * and install's stale-asset cleanup (0.4.1).
 * @param {string[]} removedPaths absolute file paths that were removed
 * @param {Iterable<string>} hostRoots recorded host dirs (boundaries; never pruned themselves)
 * @param {string[]} [log] collector that receives `(dir) <path>` entries
 */
function pruneEmptyAncestors(removedPaths, hostRoots, log = []) {
  const roots = new Set([...hostRoots].map((d) => path.resolve(d)));
  const candidates = [...new Set(removedPaths.map((p) => path.dirname(path.resolve(p))))];
  for (const start of candidates) {
    let cur = start;
    while (!roots.has(cur)) {
      try {
        if (exists(cur) && fs.readdirSync(cur).length === 0) { fs.rmdirSync(cur); log.push(`(dir) ${cur}`); }
      } catch {}
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
}

/**
 * Stale-asset cleanup (0.4.1). When a previous v2 manifest exists, files it
 * recorded that the CURRENT install no longer writes are leftovers from an
 * older MAW version (e.g. the maw-* → mawf-* rename left both on disk and a
 * hook pointing at a dead bin/maw.js). Remove exactly those leftovers and
 * prune directories that became empty. EXACT manifest diff only — user files
 * are never in the manifest, so they are never touched; no prefix scanning
 * here (uninstall keeps its own conservative fallback).
 * @param {{ files?: string[] }} [oldManifest] manifest captured BEFORE this install overwrites it
 * @param {string[]} keptPaths every file the current install wrote
 * @param {Iterable<string>} hostRoots recorded host dirs of BOTH the old manifest and this install
 * @returns {string[]} removed entries (file paths + `(dir)` markers)
 */
function cleanupStale(oldManifest, keptPaths, hostRoots) {
  /** @type {string[]} */
  const removed = [];
  // legacy (pre-v2) manifests have no files[] — safe skip; uninstall's prefix
  // fallback still covers an explicit uninstall.
  if (!oldManifest || !Array.isArray(oldManifest.files)) return removed;
  const kept = new Set(keptPaths.map((p) => path.resolve(p)));
  const stale = [...new Set(oldManifest.files)].filter((f) => !kept.has(path.resolve(f)));
  for (const f of stale) {
    if (isFile(f)) { try { fs.unlinkSync(f); removed.push(f); } catch {} }
  }
  if (removed.length) pruneEmptyAncestors(removed, hostRoots, removed);
  return removed;
}

/**
 * Copy a directory tree recursively.
 * @param {string} src
 * @param {string} dest
 * @returns {string[]} every file written (absolute paths)
 */
function copyTree(src, dest) {
  ensureDir(dest);
  /** @type {string[]} */
  const written = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) written.push(...copyTree(s, d));
    else { fs.copyFileSync(s, d); written.push(d); }
  }
  return written;
}

/**
 * @returns {string}
 */
function manifestDir() {
  return path.join(os.homedir(), ".mawf");
}

/** @returns {{ version: string, installedAt: string, host: any, dirs: any }} */
function readManifest() {
  return readJson(path.join(manifestDir(), "installed.json"), { version: "", installedAt: "", host: null, dirs: {} });
}
function writeManifest(m) {
  ensureDir(manifestDir());
  writeJson(path.join(manifestDir(), "installed.json"), m);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.claudeDir]
 * @param {boolean} [opts.force]
 * @returns {{ ok: boolean, copied: string[], host: any, warnings: string[] }}
 */
export function install(opts = {}) {
  const host = detectHost(opts);
  const warnings = [];
  // captured BEFORE anything is written — drives the stale-asset cleanup below
  const oldManifest = readManifest();
  if (host.app === "unknown") {
    warnings.push("No host agent software detected; files copied to ~/.mawf only. Install Claude Code or Codex for full integration.");
  }
  const copied = [];
  /** @type {string[]} every file written (manifest v2 — exact uninstall) */
  const written = [];
  const claudeDir = opts.claudeDir ?? path.join(os.homedir(), ".claude");

  // Claude Code: copy commands + agents + skills + hooks into user dirs.
  if (exists(claudeDir) || opts.force) {
    ensureDir(claudeDir);
    const cmdsSrc = path.join(PKG_ROOT, "plugin", "commands");
    const cmdsDest = path.join(claudeDir, "commands");
    if (exists(cmdsSrc)) { written.push(...copyTree(cmdsSrc, cmdsDest)); copied.push(`${cmdsDest} (commands)`); }

    const agentsSrc = path.join(PKG_ROOT, "plugin", "agents");
    const agentsDest = path.join(claudeDir, "agents");
    if (exists(agentsSrc)) { written.push(...copyTree(agentsSrc, agentsDest)); copied.push(`${agentsDest} (agents)`); }

    const skillsSrc = path.join(PKG_ROOT, "skills");
    const skillsDest = path.join(claudeDir, "skills");
    if (exists(skillsSrc)) { written.push(...copyTree(skillsSrc, skillsDest)); copied.push(`${skillsDest} (skills)`); }

    const hooksSrc = path.join(PKG_ROOT, "plugin", "hooks");
    const hooksDest = path.join(claudeDir, "hooks");
    if (exists(hooksSrc)) { written.push(...copyTree(hooksSrc, hooksDest)); copied.push(`${hooksDest} (hooks)`); }
  }

  // Also drop skills into ~/.mawf/skills so non-Claude hosts can symlink.
  const portableSkillsDest = path.join(manifestDir(), "skills");
  const skillsSrc = path.join(PKG_ROOT, "skills");
  if (exists(skillsSrc)) { written.push(...copyTree(skillsSrc, portableSkillsDest)); copied.push(`${portableSkillsDest} (portable skills)`); }

  // Codex agents (best effort)
  const codexDir = path.join(os.homedir(), ".codex");
  if (exists(codexDir)) {
    const agentsSrc = path.join(PKG_ROOT, "plugin", "agents");
    const codexAgentsDest = path.join(codexDir, "agents");
    if (exists(agentsSrc)) { written.push(...copyTree(agentsSrc, codexAgentsDest)); copied.push(`${codexAgentsDest} (codex agents)`); }
  }

  // Pi Agent. Pi is NOT cc-switch-managed; its config lives in ~/.pi/agent/.
  // 0.4.2 UNION semantics: pi assets ship when pi is the detected host OR
  // when a previous manifest recorded a pi install (host.app / dirs.piDir) —
  // installing a second host never drops the first host's assets (explicit
  // removal = uninstall). Pi agent files need pi frontmatter, so per-agent
  // .pi/agents/maw-*.md are materialized by configgen (project-level) rather
  // than copied here as claude-format files.
  const prevPi = oldManifest?.dirs?.piDir || oldManifest?.host?.app === "pi";
  const piDir = host.app === "pi" && host.homeDir
    ? host.homeDir
    : (host.app === "pi" || prevPi) ? (oldManifest?.dirs?.piDir ?? "") : "";
  if (piDir) {
    const skillsSrcPi = path.join(PKG_ROOT, "skills");
    if (exists(skillsSrcPi)) {
      const piSkillsDest = path.join(piDir, "skills");
      written.push(...copyTree(skillsSrcPi, piSkillsDest)); copied.push(`${piSkillsDest} (pi skills)`);
    }
    const cmdsSrcPi = path.join(PKG_ROOT, "plugin", "commands");
    if (exists(cmdsSrcPi)) {
      const piPromptsDest = path.join(piDir, "prompts");
      written.push(...copyTree(cmdsSrcPi, piPromptsDest)); copied.push(`${piPromptsDest} (pi prompts, best-effort format)`);
    }
    copied.push(`${piDir} (pi home)`);
  }

  // DeepSeek Harness (dsh). dsh is NOT cc-switch-managed; its home is
  // $DSH_HOME (~/.dsh). Copy skills into the dsh user skills root (rank-400,
  // never the .system child) when dsh is the detected host OR a previous
  // manifest recorded a dsh install (0.4.2 union — see the pi block above).
  // dsh has no slash-command palette and no named agent-definition surface —
  // role specs stay portable under .mawf/agents/ (materialized by configgen)
  // and spawn prompt-driven.
  const prevDsh = oldManifest?.dirs?.dshDir || oldManifest?.host?.app === "dsh";
  const dshDir = host.app === "dsh" && host.dshHome
    ? host.dshHome
    : (host.app === "dsh" || prevDsh) ? (oldManifest?.dirs?.dshDir ?? "") : "";
  if (dshDir) {
    const skillsSrcDsh = path.join(PKG_ROOT, "skills");
    if (exists(skillsSrcDsh)) {
      const dshSkillsDest = path.join(dshDir, "skills");
      written.push(...copyTree(skillsSrcDsh, dshSkillsDest)); copied.push(`${dshSkillsDest} (dsh skills)`);
    }
    copied.push(`${dshDir} (dsh home)`);
  }

  materializePluginAssets(written, PKG_ROOT);
  const pkg = readJson(path.join(PKG_ROOT, "package.json"), { version: "0.0.0" });

  // Stale-asset cleanup (0.4.1): an older manifest may record files this
  // version no longer ships (e.g. maw-* assets after the mawf rename). Remove
  // exactly those leftovers + prune emptied dirs — never user files, never
  // anything outside the recorded host dirs.
  const oldDirs = oldManifest?.dirs ?? {};
  const hostRoots = [
    oldDirs.claudeDir, oldDirs.codexDir, oldDirs.piDir, oldDirs.dshDir,
    claudeDir, path.join(os.homedir(), ".codex"), piDir, dshDir,
    manifestDir(), // boundary for portable-skill paths (~/.mawf/skills/...)
  ].filter(Boolean);
  const removedStale = cleanupStale(oldManifest, written, hostRoots);

  writeManifest({
    version: pkg.version,
    installedAt: new Date().toISOString(),
    host: { app: host.app, codexPluginInstalled: host.codexPluginInstalled, codexBinary: host.codexBinary, capabilities: hostCapabilities(host) },
    // union dirs (0.4.2): record EVERY host dir this install actually wrote
    // (pi/dsh blocks ship for detected ∪ previously-recorded hosts).
    dirs: { claudeDir, codexDir, piDir: piDir || undefined, dshDir: dshDir || undefined },
    files: written,
  });

  return { ok: true, copied, host, warnings, removedStale };
}

/**
 * Remove everything MAW installed and restore the pre-install state.
 * - manifest v2: every recorded file is removed EXACTLY (including the
 *   non-maw-*-prefixed plugin agents/hooks files); legacy manifests (dirs
 *   only, pre-v2) fall back to the maw- and codex-rescue prefix scan.
 * - recorded host subdirs are pruned when they become empty (never when
 *   non-empty).
 * - configs are KEPT by default; opts.purgeConfig deletes the project's
 *   `.mawf/` and `.pi/agents/maw-*.md` (never trellis-*).
 * - trellis-owned files are never touched.
 * @param {{ project?: string, purgeConfig?: boolean }} [opts]
 * @returns {{ ok: boolean, removed: string[], purged: string[], kept: string[] }}
 */
export function uninstall(opts = {}) {
  const m = readManifest();
  const removed = [];
  const purged = [];
  const kept = [];
  const claudeDir = m.dirs?.claudeDir ?? path.join(os.homedir(), ".claude");
  const codexDir = m.dirs?.codexDir ?? path.join(os.homedir(), ".codex");
  const hostDirs = [claudeDir, codexDir, m.dirs?.piDir, m.dirs?.dshDir].filter(Boolean);

  // 1) exact removal of everything the manifest recorded (v2)
  if (Array.isArray(m.files)) {
    for (const f of m.files) {
      if (isFile(f)) { fs.unlinkSync(f); removed.push(f); }
    }
  }

  // 2) prefix-scan safety net — ALWAYS runs, on top of the exact removal:
  //    `update()` rewrites the manifest with the CURRENT package's file list,
  //    so maw-*/codex-rescue files from an OLDER install that no longer ship
  //    would otherwise survive exact-mode uninstall. The scan is conservative
  //    (maw-*/codex-rescue prefix only) and doubles as the legacy fallback for
  //    pre-v2 manifests that have no files[] at all. Documented limitation:
  //    non-prefixed plugin agents/hooks from a legacy install are only caught
  //    when the current manifest records them (they are recorded since v2).
  for (const dir of hostDirs) {
    for (const sub of ["commands", "agents", "skills", "hooks", "prompts"]) {
      const p = path.join(dir, sub);
      if (exists(p)) removeIfOurs(p, removed);
    }
  }

  // 3) prune directories that became empty — ONLY ancestors of removed
  //    paths, and only strict descendants of a recorded host dir (never the
  //    host home itself, never unrelated user dirs).
  pruneEmptyAncestors(removed.filter((p) => !p.startsWith("(dir)")), hostDirs, removed);

  // 4) portable skills + the manifest itself; prune ~/.mawf when empty
  const portable = path.join(manifestDir(), "skills");
  if (exists(portable)) { fs.rmSync(portable, { recursive: true, force: true }); removed.push(portable); }
  const manifestPath = path.join(manifestDir(), "installed.json");
  if (exists(manifestPath)) { fs.unlinkSync(manifestPath); removed.push(manifestPath); }
  try { if (exists(manifestDir()) && fs.readdirSync(manifestDir()).length === 0) fs.rmdirSync(manifestDir()); } catch {}

  // 5) config retention: keep by default, purge on explicit request
  const project = opts.project ? path.resolve(opts.project) : process.cwd();
  const mawDir = path.join(project, ".mawf");
  if (opts.purgeConfig) {
    // managed advise blocks first (reads .mawf/managed-blocks.json BEFORE the
    // .mawf removal below): strip spans; delete files mawf created that are now
    // header-only. NEVER touches the installer manifest files[].
    try {
      const inj = removeManagedBlocks(project);
      for (const f of inj.emptied) purged.push(f);
    } catch {}
    if (exists(mawDir)) { fs.rmSync(mawDir, { recursive: true, force: true }); purged.push(mawDir); }
    const piAgents = path.join(project, ".pi", "agents");
    if (exists(piAgents)) {
      for (const f of fs.readdirSync(piAgents)) {
        if (/^mawf?-.*\.md$/.test(f)) { const p = path.join(piAgents, f); fs.unlinkSync(p); purged.push(p); }
      }
      try { if (fs.readdirSync(piAgents).length === 0) fs.rmdirSync(piAgents); } catch {}
    }
  } else {
    if (exists(mawDir)) kept.push(mawDir);
  }
  return { ok: true, removed, purged, kept };
}

/**
 * Remove only files whose names start with "maw-" (legacy fallback; recursive
 * for skills dirs that we own).
 * @param {string} dir
 * @param {string[]} [removed]
 */
function removeIfOurs(dir, removed = []) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (!/^(mawf?[-_]|codex-rescue)/.test(name)) continue; // be conservative
      const p = path.join(dir, name);
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  } catch {}
}

/**
 * Update = reinstall (we never mutate user edits in place; re-copy overwrites
 * only our template files, preserving user-added files).
 * @param {object} [opts]
 */
export function update(opts = {}) {
  return install(opts);
}

/**
 * One-time migration: legacy `.maw` dirs -> `.mawf` (both the project
 * workspace and the global manifest dir ~/.maw). Runs at every CLI entry;
 * no-op once the new dir exists. Never merges: old dir is renamed away only
 * when the new one is absent (a pre-existing .mawf always wins).
 * @param {{ project?: string }} [opts]
 * @returns {string[]} migration notes (empty = nothing to do)
 */
export function migrateLegacyMawDirs(opts = {}) {
  const project = path.resolve(opts.project ?? process.cwd());
  const pairs = [
    [path.join(os.homedir(), ".maw"), path.join(os.homedir(), ".mawf")],
    [path.join(project, ".maw"), path.join(project, ".mawf")],
  ];
  /** @type {string[]} */
  const notes = [];
  for (const [oldDir, newDir] of pairs) {
    try {
      if (exists(oldDir) && !exists(newDir)) {
        fs.renameSync(oldDir, newDir);
        notes.push(`${oldDir} -> ${newDir}`);
      }
    } catch { /* best-effort; command proceeds with the old dir if rename fails */ }
  }
  return notes;
}
