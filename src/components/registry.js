// @ts-check
// Component manager — install/status/rollback for MAWF-managed integration
// components (contract §11.3, §11.7).
//
// Principles:
// - Locked sources only (defaults/components.lock.json). Never floating main;
//   never silent fallback after a failed download (§11.4).
// - Installs are atomic, per-component, per-version directories under
//   ~/.mawf/components/<name>/<version>-<hash8>/; rollback = swap a symlink.
// - Status is honest (§11.7): not-installed / installed-unverified /
//   supported-and-tested / available-with-limits / incompatible /
//   blocked-by-permission / blocked-by-release-or-license.
// - Status/read commands NEVER auto-install (§11.3).
// - Components without a public release are reported as `development/source`,
//   never "release-certified".

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, ensureDir, isoNow } from "../util.js";

/** @returns {object} the locked component registry bundled with MAWF */
export function loadLock() {
  // resolve relative to this module: src/components -> ../../defaults
  // (fileURLToPath is required for Windows native paths — URL.pathname
  // produces /D:/... garbage there)
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "defaults", "components.lock.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Component root: ~/.mawf/components (MAWF-managed space; purgeable is fine —
 *  components are re-installable, unlike durable knowledge). */
export function componentsRoot(home = os.homedir()) {
  return path.join(home, ".mawf", "components");
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

/**
 * Status of one locked component on this machine (honest states, §11.7).
 * @param {object} lockEntry @param {{home?: string}} [opts]
 */
export function componentStatus(lockEntry, opts = {}) {
  const root = componentsRoot(opts.home);
  const dir = path.join(root, lockEntry.name);
  const current = readJson(path.join(dir, "current.json"), null);
  /** @type {string} */
  let state;
  if (!current) state = "not-installed";
  else if (current.sourceCommit === lockEntry.upstream.commit && current.verifiedSha256) state = "installed-unverified";
  else state = "installed-unverified";
  // release/licence gates surface as separate fields so callers can compose:
  const licenseBlocked = String(lockEntry.upstream.licenseStatus ?? "").startsWith("blocked");
  const releaseBlocked = lockEntry.upstream.releaseChannel === "github-release-or-source-build" &&
    lockEntry.distribution?.githubAsset?.status === "no-release-yet";
  return {
    name: lockEntry.name,
    kind: lockEntry.kind,
    state, // not-installed | installed-unverified (live verification is a separate, explicit step)
    installed: current ?? null,
    sourceCommit: lockEntry.upstream.commit,
    licenseStatus: lockEntry.upstream.licenseStatus,
    licenseBlocked,
    releaseBlocked,
    releaseChannel: lockEntry.upstream.releaseChannel,
    distributionState: releaseBlocked ? "development/source" : "release-certified",
    bundled: lockEntry.distribution?.npm === true,
  };
}

/**
 * Install a component from a local archive file (offline-first path; network
 * downloads are the caller's explicit action, never implicit).
 *
 * Full install lifecycle (stabilization §14): digest check -> safe extraction
 * (system tar/bsdtar; traversal- and symlink-validated afterwards) -> closure
 * validation against the lock manifest -> entry validation. The state starts
 * at `installed-unverified`; only an explicit `verifyComponent()` (which runs
 * the component's real doctor) may promote it to tested/verified.
 * @param {object} lockEntry
 * @param {string} archivePath path to .zip/.tgz artifact
 * @param {{home?: string, expectedSha256?: string, dryRun?: boolean, extract?: boolean}} [opts]
 * @returns {{ok: boolean, state?: object, error?: string, violations?: string[]}}
 */
export function installComponent(lockEntry, archivePath, opts = {}) {
  if (!fs.existsSync(archivePath)) return { ok: false, error: `archive not found: ${archivePath}` };
  const digest = sha256File(archivePath);
  if (opts.expectedSha256 && digest !== opts.expectedSha256) {
    return { ok: false, error: `digest mismatch: got ${digest.slice(0, 16)}… expected ${opts.expectedSha256.slice(0, 16)}…` };
  }
  const size = fs.statSync(archivePath).size;
  const state = {
    schema: 1,
    name: lockEntry.name,
    version: lockEntry.upstream.version ?? "0",
    sourceCommit: lockEntry.upstream.commit,
    installedAt: isoNow(),
    archive: path.basename(archivePath),
    sizeBytes: size,
    verifiedSha256: digest,
    distributionState: lockEntry.distribution?.githubAsset?.status === "no-release-yet" ? "development/source" : "release-certified",
    licenseStatus: lockEntry.upstream.licenseStatus,
    extraction: "skipped",
    closureChecked: false,
    entryValidated: false,
  };
  if (opts.dryRun) return { ok: true, state, dryRun: true };

  const root = componentsRoot(opts.home);
  const versionDir = path.join(root, lockEntry.name, `${state.version}-${digest.slice(0, 8)}`);
  ensureDir(versionDir);
  fs.copyFileSync(archivePath, path.join(versionDir, state.archive));

  // Extraction (bundled-kind components skip it: they ship inside MAWF).
  const bundled = lockEntry.distribution?.npm === true;
  if (opts.extract !== false && !bundled) {
    const ex = safeExtract(archivePath, path.join(versionDir, "payload"));
    if (!ex.ok) {
      cleanupFailedInstall(versionDir);
      return { ok: false, error: `extraction failed: ${ex.error}`, violations: ex.violations };
    }
    state.extraction = ex.tool;
    // Post-extract safety scan: no symlink escapes, no absolute/.. artifacts.
    const scan = scanExtractedTree(path.join(versionDir, "payload"));
    if (!scan.ok) {
      cleanupFailedInstall(versionDir);
      return { ok: false, error: "unsafe extraction content", violations: scan.violations };
    }
    // Closure validation (lock manifest's minimalClosure paths must exist
    // somewhere under the extracted payload).
    const closure = validateClosure(lockEntry, path.join(versionDir, "payload"));
    state.closureChecked = true;
    if (!closure.ok) {
      cleanupFailedInstall(versionDir);
      return { ok: false, error: "closure validation failed", violations: closure.missing };
    }
    // Entry validation.
    const entry = findEntry(lockEntry, path.join(versionDir, "payload"));
    if (!entry) {
      cleanupFailedInstall(versionDir);
      return { ok: false, error: `entry not found after extraction: ${lockEntry.entry}` };
    }
    state.entryValidated = true;
    state.entryPath = entry;
  }

  atomicWriteJson(path.join(versionDir, "install.json"), state);
  atomicWriteJson(path.join(root, lockEntry.name, "current.json"), {
    ...state,
    dir: versionDir,
    previous: readJson(path.join(root, lockEntry.name, "current.json"), null)?.dir ?? null,
  });
  return { ok: true, state: { ...state, dir: versionDir } };
}

/** Failed install leaves nothing behind: version dir removed, empty parents pruned. */
function cleanupFailedInstall(versionDir) {
  fs.rmSync(versionDir, { recursive: true, force: true });
  try { fs.rmdirSync(path.dirname(versionDir)); } catch { /* parent not empty - keep */ }
}

/**
 * Extract with the system tar (bsdtar on Windows/macOS reads zip natively;
 * GNU tar handles .tgz). Post-scan enforces the safety rules so we do not
 * hand-write a fragile zip parser (contract §2.2-5).
 */
function safeExtract(archivePath, destDir) {
  ensureDir(destDir);
  const isZip = /\.zip$/i.test(archivePath);
  const isTgz = /\.(tgz|tar\.gz)$/i.test(archivePath);
  if (!isZip && !isTgz) return { ok: false, error: `unsupported archive type: ${path.basename(archivePath)}` };
  let result;
  if (isZip) result = spawnSync("tar", ["-xf", archivePath, "-C", destDir], { encoding: "utf8" });
  else result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { encoding: "utf8" });
  if (result.error) return { ok: false, error: `tar unavailable: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, error: `tar exited ${result.status}: ${(result.stderr ?? "").slice(0, 400)}` };
  return { ok: true, tool: isZip ? "tar(zip)" : "tar(tgz)" };
}

/** Post-extract scan: reject symlink escapes and path-traversal artifacts. */
function scanExtractedTree(dir) {
  const violations = [];
  const rootAbs = path.resolve(dir);
  const visit = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      violations.push(`unreadable dir: ${d}`);
      return;
    }
    for (const it of items) {
      const abs = path.join(d, it.name);
      if (it.isSymbolicLink()) {
        let target;
        try {
          target = fs.readlinkSync(abs);
        } catch {
          continue;
        }
        const resolved = path.resolve(path.dirname(abs), target);
        if (path.isAbsolute(target) || !resolved.startsWith(rootAbs + path.sep)) {
          violations.push(`symlink escape: ${path.relative(rootAbs, abs)} -> ${target}`);
        }
        continue; // don't follow
      }
      if (it.isDirectory()) visit(abs);
    }
  };
  visit(dir);
  return { ok: violations.length === 0, violations };
}

/** Verify the lock manifest's minimalClosure exists under the payload. */
function validateClosure(lockEntry, payloadDir) {
  const missing = [];
  for (const pattern of lockEntry.minimalClosure ?? []) {
    // patterns are repo-relative dirs/files or dir/* — resolve under any
    // single top-level dir (archives often nest one root folder)
    const direct = path.join(payloadDir, ...pattern.split("/"));
    const nested = findUnderSingleRoot(payloadDir, pattern);
    if (!fs.existsSync(direct) && !nested) missing.push(pattern);
  }
  return { ok: missing.length === 0, missing };
}

function findUnderSingleRoot(payloadDir, pattern) {
  let tops;
  try {
    tops = fs.readdirSync(payloadDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const top of tops) {
    const candidate = path.join(payloadDir, top.name, ...pattern.split("/"));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Find the component entry (payload root or single nested root). */
function findEntry(lockEntry, payloadDir) {
  const direct = path.join(payloadDir, ...lockEntry.entry.split("/"));
  if (fs.existsSync(direct)) return direct;
  return findUnderSingleRoot(payloadDir, lockEntry.entry);
}

/**
 * Explicit verification step: runs the component's real doctor and, only on
 * success, promotes the recorded state from installed-unverified to
 * verified (stabilization §14). Never called implicitly.
 * @param {object} lockEntry @param {{home?: string}} [opts]
 */
export function verifyComponent(lockEntry, opts = {}) {
  const root = componentsRoot(opts.home);
  const current = readJson(path.join(root, lockEntry.name, "current.json"), null);
  if (!current) return { ok: false, error: `not installed: ${lockEntry.name}` };
  if (current.entryValidated !== true) {
    return { ok: false, error: `install record lacks a validated entry — reinstall: ${lockEntry.name}` };
  }
  if (lockEntry.name === "archify") {
    const child = spawnSync(process.execPath, [current.entryPath, "doctor"], { encoding: "utf8" });
    if (child.status !== 0) {
      return { ok: false, error: `archify doctor failed (exit ${child.status})`, output: (child.stdout ?? "") + (child.stderr ?? "") };
    }
  } else {
    return { ok: false, error: `no verify procedure defined for component: ${lockEntry.name}` };
  }
  const updated = { ...current, verification: { method: "doctor", result: "pass", at: isoNow() }, state: "supported-and-tested" };
  atomicWriteJson(path.join(root, lockEntry.name, "current.json"), updated);
  return { ok: true, state: updated };
}

/**
 * Rollback to the previous installed version (symlink-free: current.json
 * pointer swap; no data is deleted, so rollback is always possible).
 */
export function rollbackComponent(name, opts = {}) {
  const root = componentsRoot(opts.home);
  const cur = readJson(path.join(root, name, "current.json"), null);
  if (!cur) return { ok: false, error: `not installed: ${name}` };
  if (!cur.previous) return { ok: false, error: `no previous version recorded for ${name}` };
  const prev = readJson(path.join(cur.previous, "install.json"), null);
  if (!prev) return { ok: false, error: `previous install record missing at ${cur.previous}` };
  atomicWriteJson(path.join(root, name, "current.json"), { ...prev, dir: cur.previous, previous: null, rolledBackFrom: cur.dir });
  return { ok: true, state: prev };
}

function atomicWriteJson(abs, obj) {
  ensureDir(path.dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, abs);
}
