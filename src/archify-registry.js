// @ts-check
// Rebuildable Archify artifact registry — contract §10.2 (artifact lifecycle).
//
// Location: <project>/.mawf/runtime/archify/artifacts.json — a RUNTIME cache.
//
// REBUILDABLE BY DESIGN: deleting this file loses nothing. The IR is the
// authored source (versioned wherever the task keeps it); HTML/receipts are
// rebuildable from the locked engine; re-run
// `mawf archify-registry record <ir> <html>` after a render to repopulate.
// Persistent semantics must never live ONLY here (§10.2: do not store
// durable meaning solely in the runtime index).
//
// Entry shape (schema 1):
// { id, diagramType, irPath, htmlPath, receiptPath?, engineCommit,
//   irSha256, artifactSha256,
//   lastGood: {sha256, at},          // artifact digest that last validated
//   lastAttempt: {at, ok, error?},   // newest generation attempt
//   taskDir? }
//
// `list` compares the CURRENT ir sha256 against the recorded irSha256 and
// reports staleness — it NEVER re-renders (regeneration is a task-workflow
// decision, §10.4; a stale entry means the shown HTML is the LAST GOOD one,
// not that it validates for the current IR).
//
// Zero runtime dependencies (Node built-ins only).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDir, expand, isoNow, readJson } from "./util.js";
import { loadLock } from "./components/registry.js";

/** Registry file path inside a project. */
export function registryPath(project = process.cwd()) {
  return path.join(expand(project), ".mawf", "runtime", "archify", "artifacts.json");
}

/**
 * Upsert key: resolved IR path + diagram type (§10.2: artifact ID derives
 * from the authored source and its kind, not from output filenames).
 * @param {string} irPath
 * @param {string} diagramType
 * @returns {string}
 */
export function entryId(irPath, diagramType) {
  return `${path.resolve(String(irPath))}::${String(diagramType)}`;
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function readRegistry(project) {
  const data = readJson(registryPath(project), null);
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
    return { schema: 1, updatedAt: null, entries: [] };
  }
  return data;
}

/**
 * Atomic write (tmp + rename inside the same directory): a crashed record
 * never leaves a torn registry, and no tmp files survive a success.
 */
function writeRegistry(project, data) {
  const p = registryPath(project);
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/** Best-effort locked archify commit (fallback when a receipt omits it). */
function lockedArchifyCommit() {
  try {
    return loadLock().components.find((c) => c.name === "archify")?.upstream?.commit ?? null;
  } catch {
    return null;
  }
}

/** Raw entries array from the registry file (empty when absent/corrupt). */
export function readRegistryEntries(project = process.cwd()) {
  const data = readRegistry(project);
  return data.entries.filter((e) => e && typeof e === "object");
}

/**
 * Compute digests and upsert one artifact entry (id = irPath + diagramType).
 * Both IR and HTML must exist — this records REAL renders, never intentions.
 * @param {{ir: string, html: string, receipt?: string, taskDir?: string,
 *          project?: string, now?: string}} p
 * @returns {{ok: true, entry: object, registryPath: string} |
 *           {ok: false, error: string}}
 */
export function recordArtifact({ ir, html, receipt, taskDir, project = process.cwd(), now } = {}) {
  if (!ir || !html) {
    return { ok: false, error: "both <ir> and <html> are required" };
  }
  const irAbs = path.resolve(String(ir));
  const htmlAbs = path.resolve(String(html));
  for (const [label, p] of [["ir", irAbs], ["html", htmlAbs]]) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return { ok: false, error: `${label} file not found: ${p}` };
    }
  }
  let receiptAbs = null;
  let receiptData = null;
  if (receipt) {
    receiptAbs = path.resolve(String(receipt));
    if (!fs.existsSync(receiptAbs)) return { ok: false, error: `receipt file not found: ${receiptAbs}` };
    receiptData = readJson(receiptAbs, null);
    if (receiptData === null) return { ok: false, error: `receipt is not valid JSON: ${receiptAbs}` };
  }
  // Receipt fields win; the locked component commit is the honest fallback.
  const diagramType = String(receiptData?.diagramType ?? receiptData?.type ?? "unknown");
  const engineCommit = String(
    receiptData?.engineCommit ?? receiptData?.commit ?? receiptData?.engine?.commit ?? lockedArchifyCommit() ?? "unknown",
  );
  const at = now ?? isoNow();
  const irSha256 = sha256File(irAbs);
  const artifactSha256 = sha256File(htmlAbs);
  const entry = {
    id: entryId(irAbs, diagramType),
    diagramType,
    irPath: irAbs,
    htmlPath: htmlAbs,
    ...(receiptAbs ? { receiptPath: receiptAbs } : {}),
    engineCommit,
    irSha256,
    artifactSha256,
    lastGood: { sha256: artifactSha256, at },
    lastAttempt: { at, ok: true },
    ...(taskDir ? { taskDir: path.resolve(String(taskDir)) } : {}),
  };
  const data = readRegistry(project);
  const idx = data.entries.findIndex((e) => e && e.id === entry.id);
  if (idx >= 0) data.entries[idx] = entry;
  else data.entries.push(entry);
  data.schema = 1;
  data.updatedAt = at;
  writeRegistry(project, data);
  return { ok: true, entry, registryPath: registryPath(project) };
}

/**
 * Read the registry and annotate staleness: the current IR file digest is
 * compared against the recorded irSha256. The HTML is NOT re-rendered and
 * the artifact is NOT re-validated — "stale" means the recorded HTML is the
 * last good one for the OLD IR.
 * @param {string} [project]
 * @returns {object[]} rows with {stale, staleReason, irCurrentSha256}
 */
export function listArtifacts(project = process.cwd()) {
  const data = readRegistry(project);
  return data.entries
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      let current = null;
      let staleReason = null;
      try {
        current = sha256File(e.irPath);
      } catch {
        staleReason = "ir-missing";
      }
      const stale = staleReason !== null || current !== e.irSha256;
      if (stale && staleReason === null) staleReason = "ir-changed";
      return {
        id: e.id,
        diagramType: e.diagramType,
        irPath: e.irPath,
        htmlPath: e.htmlPath,
        receiptPath: e.receiptPath ?? null,
        engineCommit: e.engineCommit,
        irSha256: e.irSha256,
        irCurrentSha256: current,
        artifactSha256: e.artifactSha256,
        stale,
        staleReason,
        lastGood: e.lastGood ?? null,
        lastAttempt: e.lastAttempt ?? null,
        taskDir: e.taskDir ?? null,
      };
    });
}

/**
 * `mawf archify-registry <sub>` — CLI for the rebuildable registry (§10.2).
 *
 *   record <ir> <html> [--receipt <r>] [--task-dir <d>] [--project <p>]
 *   list [--json] [--project <p>]
 *
 * The registry is a rebuildable cache: deleting it loses nothing; re-record
 * after a render to repopulate.
 * @param {string[]} f args after "archify-registry"
 * @param {Record<string, string|boolean>} flags parsed CLI flags
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [opts] output seams (tests)
 * @returns {number} exit code
 */
export function runArchifyRegistry(f, flags = {}, opts = {}) {
  const out = opts.out ?? ((t) => process.stdout.write(t));
  const errOut = opts.err ?? ((t) => process.stderr.write(t));
  const project = typeof flags.project === "string" ? flags.project : process.cwd();
  const [sub] = f;
  switch (sub) {
    case "record": {
      const [ir, html] = f.slice(1);
      if (!ir || !html) {
        errOut("usage: mawf archify-registry record <ir> <html> [--receipt <r>] [--task-dir <d>] [--project <p>]\n");
        return 2;
      }
      const r = recordArtifact({
        ir,
        html,
        receipt: typeof flags.receipt === "string" ? flags.receipt : undefined,
        taskDir: typeof flags["task-dir"] === "string" ? flags["task-dir"] : undefined,
        project,
      });
      if (!r.ok) {
        errOut(`mawf archify-registry: ${r.error}\n`);
        return 1;
      }
      out(
        `recorded ${r.entry.id}\n` +
          `  ir:       ${r.entry.irPath} (sha256 ${r.entry.irSha256.slice(0, 12)}…)\n` +
          `  html:     ${r.entry.htmlPath} (sha256 ${r.entry.artifactSha256.slice(0, 12)}…)\n` +
          `  engine:   ${r.entry.engineCommit.slice(0, 12)}\n` +
          `  registry: ${r.registryPath}\n` +
          "  (rebuildable cache — deleting it loses nothing)\n",
      );
      return 0;
    }
    case "list": {
      const rows = listArtifacts(project);
      if (flags.json === true) {
        out(`${JSON.stringify({ registryPath: registryPath(project), entries: rows }, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        out(
          `no recorded artifacts in ${registryPath(project)}\n  (rebuildable cache — run: mawf archify-registry record <ir> <html>)\n`,
        );
        return 0;
      }
      for (const r of rows) {
        out(
          `${r.stale ? "STALE" : "ok  "}  ${r.diagramType}  ${r.id}\n` +
            `  html: ${r.htmlPath}\n` +
            `  artifact sha256 ${r.artifactSha256.slice(0, 12)}…  lastGood ${r.lastGood?.at ?? "-"}\n`,
        );
        if (r.stale) {
          out(
            `  stale (${r.staleReason}): recorded ir sha256 ${r.irSha256.slice(0, 12)}… vs current ` +
              `${r.irCurrentSha256 ? `${r.irCurrentSha256.slice(0, 12)}…` : "missing"}\n` +
              "  the recorded HTML is the LAST GOOD artifact — it has NOT been re-validated for the current IR\n",
          );
        }
        if (r.lastAttempt && r.lastAttempt.ok === false) {
          out(`  last attempt FAILED at ${r.lastAttempt.at}: ${r.lastAttempt.error ?? "unknown error"}\n`);
        }
      }
      return 0;
    }
    default:
      errOut("usage: mawf archify-registry record <ir> <html> [--receipt <r>] [--task-dir <d>] | list [--json] [--project <p>]\n");
      return 2;
  }
}
