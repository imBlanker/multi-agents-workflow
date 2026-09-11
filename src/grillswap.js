import { fileURLToPath } from "node:url";
// @ts-check
// Grill-brainstorm swap (task 08-21-grill-brainstorm-swap): in mawf-initialized
// workspaces, trellis-brainstorm is replaced by a wrapper running the vendored
// grill-with-docs interview (grilling + domain-modeling, mattpocock/skills,
// MIT — skills/vendor/), while preserving the full Trellis planning contract.
//
// Files in the workspace, per trellis skill root (trellis writes skills to
// .agents/skills/ for codex-ish platforms and .claude/skills/ for Claude Code —
// the swap patches EVERY root where trellis-brainstorm exists):
//   <root>/trellis-brainstorm/SKILL.md   ← wrapper (from skills/mawf-grill/)
//   <root>/trellis-brainstorm.orig.md    ← one-time backup of the stock file
//   <root>/grilling/SKILL.md             ← vendored (mawf-amended)
//   <root>/grill-with-docs/SKILL.md      ← vendored
//   <root>/domain-modeling/{SKILL,CONTEXT-FORMAT,ADR-FORMAT}.md ← vendored
//
// Idempotent; detects `trellis update` clobbering (wrapper hash mismatch) and
// repairs. Pure-ish: fs injected for tests; pkgRoot injectable.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exists, readText, writeText, ensureDir } from "./util.js";

/** @param {string} [pkgRoot] repo/package root holding skills/ */
export function grillAssetsRoot(pkgRoot) {
  return pkgRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const VENDORED = ["grilling", "grill-with-docs", "domain-modeling"];

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** trellis skill roots that may exist in a workspace (platform-dependent). */
export function skillRoots(projectDir, fsh = fs) {
  return [".agents", ".claude"]
    .map((d) => path.join(projectDir, d, "skills"))
    .filter((p) => existsWith(fsh, path.join(p, "trellis-brainstorm", "SKILL.md")));
}

/**
 * Current swap status for a workspace (aggregate over all trellis skill roots).
 * @param {string} projectDir
 * @param {{ pkgRoot?: string, fs?: any }} [opts]
 * @returns {{ trellisBrainstormPresent: boolean, wrapperInstalled: boolean, wrapperCurrent: boolean, vendored: string[], missing: string[], origBackup: boolean, roots: string[] }}
 */
export function grillSwapStatus(projectDir, opts = {}) {
  const fsh = opts.fs ?? fs;
  const root = grillAssetsRoot(opts.pkgRoot);
  const read = (p) => { try { return fsh.readFileSync(p, "utf8"); } catch { return null; } };
  const wrapperAsset = read(path.join(root, "skills", "mawf-grill", "SKILL.md"));
  const roots = skillRoots(projectDir, fsh);
  let present = false, installed = false, current = true, backup = false;
  const vendored = new Set();
  for (const skillsDir of roots) {
    const installedTxt = read(path.join(skillsDir, "trellis-brainstorm", "SKILL.md"));
    if (installedTxt == null) continue;
    present = true;
    const isWrapper = /grill edition \(mawf\)/.test(installedTxt);
    if (isWrapper) installed = true;
    if (!isWrapper || !wrapperAsset || sha(installedTxt) !== sha(wrapperAsset)) current = false;
    if (existsWith(fsh, path.join(skillsDir, "trellis-brainstorm.orig.md"))) backup = true;
    for (const name of VENDORED) {
      if (read(path.join(skillsDir, name, "SKILL.md")) === read(path.join(root, "skills", "vendor", name, "SKILL.md"))) vendored.add(name);
    }
  }
  const missing = VENDORED.filter((n) => !vendored.has(n));
  return {
    trellisBrainstormPresent: present,
    wrapperInstalled: installed,
    wrapperCurrent: present && current && installed,
    vendored: [...vendored], missing,
    origBackup: backup,
    roots: roots.map((r) => path.relative(projectDir, r)),
  };
}

function existsWith(fsh, p) { try { return fsh.existsSync(p); } catch { return false; } }

/**
 * Apply (or repair) the swap. Idempotent; safe when trellis never ran.
 * @param {string} projectDir
 * @param {{ pkgRoot?: string, fs?: any }} [opts]
 * @returns {{ applied: boolean, reason: string, wrote: string[] }}
 */
export function applyGrillSwap(projectDir, opts = {}) {
  const fsh = opts.fs ?? fs;
  const root = grillAssetsRoot(opts.pkgRoot);
  const roots = skillRoots(projectDir, fsh);
  if (!roots.length) {
    return { applied: false, reason: "trellis-brainstorm not present (trellis init not run?) — nothing to swap", wrote: [] };
  }
  /** @type {string[]} */
  const wrote = [];
  for (const skillsDir of roots) {
    const targetFile = path.join(skillsDir, "trellis-brainstorm", "SKILL.md");
    // one-time backup of the stock file (escape hatch)
    const backup = path.join(skillsDir, "trellis-brainstorm.orig.md");
    if (!existsWith(fsh, backup)) {
      writeText(backup, readText(targetFile));
      wrote.push(path.relative(projectDir, backup));
    }
    // wrapper
    const wrapperAsset = readText(path.join(root, "skills", "mawf-grill", "SKILL.md"));
    if (readText(targetFile) !== wrapperAsset) {
      writeText(targetFile, wrapperAsset);
      wrote.push(path.relative(projectDir, targetFile));
    }
    // vendored skills
    for (const name of VENDORED) {
      const srcDir = path.join(root, "skills", "vendor", name);
      const dstDir = path.join(skillsDir, name);
      let names = [];
      try { names = fsh.readdirSync(srcDir); } catch { continue; }
      for (const f of names) {
        const src = path.join(srcDir, f);
        const dst = path.join(dstDir, f);
        if (readText(src) !== (existsWith(fsh, dst) ? readText(dst) : null)) {
          ensureDir(dstDir);
          writeText(dst, readText(src));
          wrote.push(path.relative(projectDir, dst));
        }
      }
    }
    // vendored license notice travels once per root
    const licDst = path.join(skillsDir, "VENDOR-SKILLS-LICENSE.md");
    if (!existsWith(fsh, licDst)) {
      writeText(licDst, readText(path.join(root, "skills", "vendor", "LICENSE")));
      wrote.push(path.relative(projectDir, licDst));
    }
  }
  return { applied: wrote.length > 0, reason: wrote.length ? `swapped (${roots.length} root(s), ${wrote.length} file(s))` : "already current", wrote };
}
