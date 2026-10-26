// @ts-check
// Packaged snapshot of the entire cc-switch config directory, taken BEFORE
// every `mawf init` (before MAW creates its project profile or touches routing).
//
// Policy fit: this only READS existing files and creates NEW files under
// `<cc-switch dir>/maw-backups/` — it never modifies any existing cc-switch
// config file.
//
// Preferred format: a `.tar.gz` via the system `tar` (present on macOS/Linux,
// and as bsdtar on Windows, which the platform facade picks over PATH order).
// Fallback: a recursive directory copy + a manifest.json (sha256 + sizes) so
// the snapshot is still a verifiable package on systems without tar.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exists, ensureDir } from "./util.js";
import { findDb } from "./ccswitch.js";
import { tarCommand } from "./platform/index.js";

/** @param {number} [d] */
function stamp(d = Date.now()) {
  return new Date(d).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

/** Recursively list files (relative paths) under dir, excluding `excludeDir`. */
function listFiles(dir, excludeDir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} cur @param {string} rel */
  function walk(cur, rel) {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (excludeDir && full.startsWith(excludeDir)) continue;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile() || e.isSymbolicLink()) out.push(r);
    }
  }
  walk(dir, "");
  return out.sort();
}

/**
 * Snapshot the whole cc-switch directory.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]  cc-switch db path (its dirname is snapshotted)
 * @param {string} [opts.destDir] override snapshot destination dir
 * @returns {{ ok: boolean, error?: string, srcDir?: string, archive?: string, dir?: string,
 *   impl?: "tar"|"copy", files?: number, totalBytes?: number, manifest?: string }}
 */
export function snapshotCcSwitch(opts = {}) {
  const dbPath = opts.dbPath ?? findDb();
  if (!dbPath) return { ok: false, error: "cc-switch database not found; nothing to snapshot" };
  const srcDir = path.dirname(dbPath);
  if (!exists(srcDir)) return { ok: false, error: `cc-switch directory not found: ${srcDir}` };
  const destDir = opts.destDir ? path.resolve(opts.destDir) : path.join(srcDir, "maw-backups");
  ensureDir(destDir);
  const name = `cc-switch-snapshot-${stamp()}`;
  const files = listFiles(srcDir, destDir);
  if (!files.length) return { ok: false, error: "cc-switch directory is empty" };

  // Preferred: tar.gz package (exclude the backups dir itself to avoid recursion)
  try {
    const archive = path.join(destDir, `${name}.tar.gz`);
    execFileSync(tarCommand(), ["-czf", archive, "--exclude", `./${path.basename(destDir)}`, "-C", srcDir, "."], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    });
    if (exists(archive)) {
      const totalBytes = Number(fs.statSync(archive).size);
      return { ok: true, impl: "tar", srcDir, archive, files: files.length, totalBytes };
    }
  } catch { /* fall through to copy */ }

  // Fallback: recursive copy + manifest with sha256
  try {
    const dir = path.join(destDir, name);
    ensureDir(dir);
    let totalBytes = 0;
    const manifest = { createdAt: new Date().toISOString(), srcDir, impl: "copy", files: /** @type {any[]} */ ([]) };
    for (const rel of files) {
      const from = path.join(srcDir, rel);
      const to = path.join(dir, rel);
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
      const buf = fs.readFileSync(from);
      totalBytes += buf.length;
      manifest.files.push({ path: rel, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
    }
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true, impl: "copy", srcDir, dir, files: files.length, totalBytes, manifest: manifestPath };
  } catch (e) {
    return { ok: false, error: `snapshot failed: ${String(e?.message || e)}` };
  }
}
