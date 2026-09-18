// @ts-check
// Knowledge corpus migrator (contract §5.1): EXPLICIT migration from legacy
// roots (.agents/notes/, docs/solutions/) into the default layout
// (docs/knowledge/{decisions,solutions}/...) — with dry-run, conflict skip,
// a rollback record, and zero data loss. Adoption (read-compatible use of the
// legacy root as canonical) remains the DEFAULT; migration is opt-in only.
//
// Guarantees:
// - dry-run writes nothing
// - every move is recorded in a rollback record under
//   .mawf/runtime/knowledge/migrations/<id>.json (from → to, original order)
// - existing destinations are NEVER overwritten (skipped + reported)
// - rollback reverses the exact move set; failures mid-way leave the record
//   on disk so a second rollback attempt can resume

import fs from "node:fs";
import path from "node:path";
import { resolveLayout } from "./store.js";
import { ensureDir, isoNow, readJson } from "../util.js";

const ROLLBACK_DIR = path.join(".mawf", "runtime", "knowledge", "migrations");

/** @param {string} dir walk .md/.json files (dot-skip), return root-relative posix paths */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const visit = (d) => {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name.startsWith(".")) continue;
      const abs = path.join(d, it.name);
      if (it.isDirectory()) visit(abs);
      else if (it.isFile()) out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  visit(dir);
  return out;
}

/**
 * Plan the migration: which legacy files would move where.
 * @param {string} projectDir
 * @returns {{plans: Array<{fromRoot: string, toRoot: string, kind: string, moves: Array<{from: string, to: string}>, conflicts: string[]}>, hasWork: boolean}}
 */
export function planMigration(projectDir) {
  const layout = resolveLayout(projectDir);
  const legacy = [];
  if (layout.legacy.decisions === "legacy") {
    legacy.push({ kind: "decision", fromRoot: layout.decisions, toRoot: path.join(projectDir, "docs", "knowledge", "decisions") });
  }
  if (layout.legacy.solutions === "legacy") {
    legacy.push({ kind: "solution", fromRoot: layout.solutions, toRoot: path.join(projectDir, "docs", "knowledge", "solutions") });
  }
  const plans = legacy.map(({ kind, fromRoot, toRoot }) => {
    /** @type {{from: string, to: string}[]} */
    const moves = [];
    /** @type {string[]} */
    const conflicts = [];
    for (const rel of walkFiles(fromRoot)) {
      const to = path.join(toRoot, rel);
      if (fs.existsSync(to)) conflicts.push(rel);
      else moves.push({ from: path.join(fromRoot, rel), to });
    }
    return { kind, fromRoot, toRoot, moves, conflicts };
  });
  return { plans, hasWork: plans.some((p) => p.moves.length > 0) };
}

/**
 * Execute a planned migration. Returns a rollback record id.
 * @param {string} projectDir
 * @param {{dryRun?: boolean}} [opts]
 */
export function migrateToDefault(projectDir, opts = {}) {
  const { plans, hasWork } = planMigration(projectDir);
  if (!hasWork) return { ok: true, dryRun: !!opts.dryRun, moved: 0, conflicts: [], migrationId: null, plans };
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      moved: 0,
      conflicts: plans.flatMap((p) => p.conflicts),
      migrationId: null,
      plans,
    };
  }
  const id = isoNow().replace(/[:.]/g, "-");
  const runtimeDir = path.join(projectDir, ROLLBACK_DIR);
  ensureDir(runtimeDir);
  /** @type {Array<{from: string, to: string}>} */
  const done = [];
  /** @type {string[]} */
  const skipped = [];
  for (const plan of plans) {
    for (const mv of plan.moves) {
      ensureDir(path.dirname(mv.to));
      try {
        fs.renameSync(mv.from, mv.to); // same-filesystem atomic move
        done.push(mv);
      } catch {
        // cross-device: copy+verify+unlink
        try {
          fs.copyFileSync(mv.from, mv.to);
          if (fs.statSync(mv.from).size !== fs.statSync(mv.to).size) throw new Error("size mismatch after copy");
          fs.unlinkSync(mv.from);
          done.push(mv);
        } catch (e2) {
          skipped.push(`${mv.from} (${e2.message})`);
        }
      }
    }
    // prune the now-empty legacy root AND its empty parents up to (not
    // including) the project dir — e.g. .agents/Notes disappears entirely
    pruneEmptyDirs(plan.fromRoot, projectDir);
  }
  const record = {
    schema: 1,
    id,
    projectDir,
    recordedAt: isoNow(),
    moves: done,
    skipped,
    // original roots so rollback can also restore the "legacy adopted" state
    legacyRoots: plans.map((p) => ({ kind: p.kind, fromRoot: p.fromRoot })),
  };
  fs.writeFileSync(path.join(runtimeDir, `${id}.json`), JSON.stringify(record, null, 2) + "\n");
  return { ok: skipped.length === 0, dryRun: false, moved: done.length, conflicts: plans.flatMap((p) => p.conflicts), migrationId: id, skipped, plans };
}

/**
 * Roll back a migration by id: reverse every recorded move (dest → origin),
 * never overwriting anything that appeared at the origin meanwhile.
 * @param {string} projectDir
 * @param {string} migrationId
 */
export function rollbackMigration(projectDir, migrationId) {
  const safe = String(migrationId).replace(/[^a-zA-Z0-9-]/g, "");
  const recordPath = path.join(projectDir, ROLLBACK_DIR, `${safe}.json`);
  const record = readJson(recordPath, null);
  if (!record) return { ok: false, error: `migration record not found: ${safe}` };
  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const skipped = [];
  for (const mv of [...record.moves].reverse()) {
    if (!fs.existsSync(mv.to)) {
      skipped.push(`dest missing (already moved back?): ${mv.to}`);
      continue;
    }
    if (fs.existsSync(mv.from)) {
      skipped.push(`origin re-occupied, refusing overwrite: ${mv.from}`);
      continue;
    }
    ensureDir(path.dirname(mv.from));
    fs.renameSync(mv.to, mv.from);
    restored.push(mv.from);
  }
  return { ok: true, restored: restored.length, skipped };
}

/** Remove empty directories bottom-up (nested empties first, root included). */
function pruneEmptyDirs(dir, stopAt) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of entries) {
    if (it.isDirectory()) pruneEmptyDirs(path.join(dir, it.name), stopAt);
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* non-empty or raced — keep */
  }
  // walk empty parents upward, never escaping the project dir
  let parent = path.dirname(dir);
  const stop = stopAt ? path.resolve(stopAt) : null;
  while (stop && path.resolve(parent).startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(parent).length > 0) break;
      fs.rmdirSync(parent);
    } catch {
      break;
    }
    parent = path.dirname(parent);
  }
}
