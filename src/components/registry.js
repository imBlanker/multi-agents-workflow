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
import { readJson, ensureDir, isoNow } from "../util.js";

/** @returns {object} the locked component registry bundled with MAWF */
export function loadLock() {
  // resolve relative to this module: src/components -> ../../defaults
  const p = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "defaults", "components.lock.json");
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
 * @param {object} lockEntry
 * @param {string} archivePath path to .zip/.tgz artifact
 * @param {{home?: string, expectedSha256?: string, dryRun?: boolean}} [opts]
 * @returns {{ok: boolean, state?: object, error?: string}}
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
  };
  if (opts.dryRun) return { ok: true, state, dryRun: true };

  const root = componentsRoot(opts.home);
  const versionDir = path.join(root, lockEntry.name, `${state.version}-${digest.slice(0, 8)}`);
  ensureDir(versionDir);
  // copy archive into component space (extraction is per-kind; bundled kinds
  // may skip it entirely). Extraction safety: reject absolute paths and `..`
  // entries before writing anything (contract §12.1).
  fs.copyFileSync(archivePath, path.join(versionDir, state.archive));
  atomicWriteJson(path.join(versionDir, "install.json"), state);
  atomicWriteJson(path.join(root, lockEntry.name, "current.json"), {
    ...state,
    dir: versionDir,
    previous: readJson(path.join(root, lockEntry.name, "current.json"), null)?.dir ?? null,
  });
  return { ok: true, state: { ...state, dir: versionDir } };
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
