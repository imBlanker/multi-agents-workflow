// @ts-check
// Knowledge store — durable storage for Decision + Solution documents.
//
// Contract (task: 09-17-mawf-four-tool-integration, contract §5):
// - Default roots: docs/knowledge/{decisions,solutions}/... ; legacy corpora
//   (.agents/notes/ for decisions, docs/solutions/ for CE-style solutions) are
//   auto-adopted as canonical when present (§5.1) — never silently copied.
// - Durable store is NOT under .mawf/ (purge must not delete knowledge, §R11);
//   .mawf/runtime/knowledge/ holds only rebuildable caches: index, locks, id map.
// - Writes: single-writer by task (main coordinator); compare-and-swap by
//   content hash; atomic tmp+rename; lock files for cross-worktree safety.
// - last_verified never updates implicitly (§5.4) — only via verify() calls.
//
// Zero runtime dependencies; pure Node stdlib.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseKnowledgeDoc, deriveFallbackId, LIFECYCLES, DECISION_CLASSES, PROBLEM_TYPES, SEVERITIES } from "./schema.js";
import { readJson, readText, ensureDir, isoNow } from "../util.js";

const SIDECAR_SUFFIX = ".mawf.json";

/** Well-known store roots, checked in order (first existing wins). */
const LEGACY_DECISION_ROOTS = [".agents/notes"];
const LEGACY_SOLUTION_ROOTS = ["docs/solutions"];
const DEFAULT_DECISION_ROOT = "docs/knowledge/decisions";
const DEFAULT_SOLUTION_ROOT = "docs/knowledge/solutions";

/**
 * @typedef {object} StoreLayout
 * @property {string} decisions  absolute dir of the decision corpus
 * @property {string} solutions  absolute dir of the solution corpus
 * @property {string} runtime    absolute dir of rebuildable state
 * @property {{decisions: "default"|"legacy", solutions: "default"|"legacy"}} legacy
 */

/**
 * Resolve the store layout for a project (no writes).
 * @param {string} projectDir
 * @param {{decisionRoot?: string, solutionRoot?: string}} [cfg]
 * @returns {StoreLayout}
 */
export function resolveLayout(projectDir, cfg = {}) {
  const decLegacy = cfg.decisionRoot
    ? null
    : LEGACY_DECISION_ROOTS.map((r) => path.join(projectDir, r)).find((p) => fs.existsSync(p)) ?? null;
  const solLegacy = cfg.solutionRoot
    ? null
    : LEGACY_SOLUTION_ROOTS.map((r) => path.join(projectDir, r)).find((p) => fs.existsSync(p)) ?? null;
  return {
    decisions: cfg.decisionRoot ?? decLegacy ?? path.join(projectDir, DEFAULT_DECISION_ROOT),
    solutions: cfg.solutionRoot ?? solLegacy ?? path.join(projectDir, DEFAULT_SOLUTION_ROOT),
    runtime: path.join(projectDir, ".mawf", "runtime", "knowledge"),
    legacy: { decisions: decLegacy ? "legacy" : "default", solutions: solLegacy ? "legacy" : "default" },
  };
}

/** sha256 of content (hex). */
export function contentHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Knowledge store. All mutating operations are atomic and lock-protected.
 */
export class KnowledgeStore {
  /** @param {StoreLayout} layout */
  constructor(layout) {
    this.layout = layout;
    ensureDir(layout.runtime);
    ensureDir(layout.decisions);
    ensureDir(layout.solutions);
  }

  /** @param {string} projectDir @param {object} [cfg] */
  static open(projectDir, cfg) {
    return new KnowledgeStore(resolveLayout(projectDir, cfg));
  }

  dirFor(kind) {
    return kind === "decision" ? this.layout.decisions : this.layout.solutions;
  }

  // ---------------------------------------------------------------- locking

  /**
   * Acquire an advisory lock (mkdir-based, atomic on POSIX and Windows).
   * @param {string} key logical resource key (used as file name)
   * @param {{staleMs?: number}} [opts]
   * @returns {{release(): void}}
   */
  lock(key, opts = {}) {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = path.join(this.layout.runtime, "locks");
    ensureDir(dir);
    const p = path.join(dir, `${safe}.lock`);
    const staleMs = opts.staleMs ?? 60_000;
    for (;;) {
      try {
        fs.mkdirSync(p);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          const age = Date.now() - fs.statSync(p).mtimeMs;
          if (age > staleMs) {
            fs.rmSync(p, { recursive: true, force: true }); // stale lock: break it
            continue;
          }
        } catch { /* holder released concurrently */ }
        const err = new Error(
          `knowledge store: lock busy: ${key} (held by another writer; not stale). CAS still protects content — retry.`,
        );
        err.code = "KNOWLEDGE_LOCK_BUSY";
        throw err;
      }
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  }

  // ------------------------------------------------------------- sidecars

  sidecarPath(absDocPath) {
    const dir = path.dirname(absDocPath);
    const base = path.basename(absDocPath, ".md");
    return path.join(dir, base + SIDECAR_SUFFIX);
  }

  readSidecar(absDocPath) {
    const p = this.sidecarPath(absDocPath);
    return readJson(p, null);
  }

  /**
   * Write sidecar metadata (stable id, provenance, verification, relations).
   * Only explicit verification updates last_verified (contract §5.4).
   * @param {string} absDocPath
   * @param {{id?: string, sourceTask?: string, sourceCommit?: string,
   *          verification?: {method: string, result: string, at?: string},
   *          relations?: object, extra?: object}} patch
   */
  writeSidecar(absDocPath, patch) {
    const cur = this.readSidecar(absDocPath) ?? {};
    const next = {
      schema: 1,
      id: patch.id ?? cur.id ?? null,
      sourceTask: patch.sourceTask ?? cur.sourceTask ?? null,
      sourceCommit: patch.sourceCommit ?? cur.sourceCommit ?? null,
      created: cur.created ?? isoNow(),
      updated: isoNow(),
      // verification REPLACES prior record only when explicitly given;
      // lastVerified mirrors verification.at and is never touched otherwise.
      verification: patch.verification
        ? { ...patch.verification, at: patch.verification.at ?? isoNow() }
        : cur.verification ?? null,
      lastVerified: patch.verification
        ? (patch.verification.at ?? isoNow())
        : cur.lastVerified ?? null,
      relations: patch.relations ?? cur.relations ?? null,
      ...patch.extra ? { extra: patch.extra } : {},
    };
    const p = this.sidecarPath(absDocPath);
    atomicWriteJson(p, next);
    return next;
  }

  /**
   * Resolve the stable id of a document: explicit sidecar id wins, else a
   * deterministic fallback (kind-date-slug). The id map records path aliases
   * so old references stay traceable after moves (contract §5.1).
   */
  stableId(kind, relPath, absDocPath, parsed) {
    const sc = this.readSidecar(absDocPath);
    if (sc?.id) return sc.id;
    if (parsed?.ok && parsed.doc.date && parsed.doc.slug) {
      return deriveFallbackId(kind, parsed.doc.date, parsed.doc.slug);
    }
    return deriveFallbackId(kind, "0000-00-00", path.basename(relPath, ".md"));
  }

  // ------------------------------------------------------------------- I/O

  /**
   * Parse + validate one document (pure read; no lock needed).
   * @param {"decision"|"solution"} kind
   * @param {string} relPath relative to the kind root
   */
  read(kind, relPath) {
    const abs = path.join(this.dirFor(kind), relPath);
    const text = readText(abs);
    const parsed = parseKnowledgeDoc(text, { kind, relPath });
    return { abs, text, parsed, sidecar: this.readSidecar(abs), hash: contentHash(text) };
  }

  /**
   * Atomic create. Fails if the target exists or the document is invalid.
   * @param {"decision"|"solution"} kind
   * @param {string} relPath
   * @param {string} text
   * @param {{expectedHash?: string, sourceTask?: string, sourceCommit?: string}} [meta]
   */
  create(kind, relPath, text, meta = {}) {
    const abs = path.join(this.dirFor(kind), relPath);
    const lk = this.lock(`doc:${kind}:${relPath}`);
    try {
      if (fs.existsSync(abs)) throw new Error(`knowledge store: already exists: ${relPath}`);
      const parsed = parseKnowledgeDoc(text, { kind, relPath });
      if (!parsed.ok) {
        throw new Error(`knowledge store: invalid document: ${parsed.errors.map((e) => e.message).join("; ")}`);
      }
      atomicWriteText(abs, text);
      this.writeSidecar(abs, { sourceTask: meta.sourceTask, sourceCommit: meta.sourceCommit });
      this.invalidateIndex();
      return { abs, parsed: parsed.doc };
    } finally {
      lk.release();
    }
  }

  /**
   * Compare-and-swap update (contract §5.4: two writers must not silently
   * overwrite). expectedHash = hash of the content the caller based edits on.
   */
  update(kind, relPath, text, meta = {}) {
    const abs = path.join(this.dirFor(kind), relPath);
    const lk = this.lock(`doc:${kind}:${relPath}`);
    try {
      const cur = contentHash(readText(abs));
      if (meta.expectedHash && meta.expectedHash !== cur) {
        const e = new Error(`knowledge store: conflict on ${relPath}: content changed since read (CAS)`);
        e.code = "KNOWLEDGE_CAS_CONFLICT";
        e.currentHash = cur;
        throw e;
      }
      const parsed = parseKnowledgeDoc(text, { kind, relPath });
      if (!parsed.ok) {
        throw new Error(`knowledge store: invalid document: ${parsed.errors.map((e) => e.message).join("; ")}`);
      }
      atomicWriteText(abs, text);
      if (meta.sidecar) this.writeSidecar(abs, meta.sidecar);
      this.invalidateIndex();
      return { abs, hash: contentHash(text), parsed: parsed.doc };
    } finally {
      lk.release();
    }
  }

  /**
   * Archive a decision (upstream mechanics: insert Archived: line under
   * Status, move to archived/<class>/, seal into archived/manifest.json,
   * report inbound links). Locks both paths; refuses collisions.
   * @param {string} relPath e.g. "implemented/architecture/2026-01-01-x.md"
   * @param {{supersededBy?: string}} [opts]
   */
  archiveDecision(relPath, opts = {}) {
    const srcAbs = path.join(this.layout.decisions, relPath);
    const lk = this.lock(`archive:${relPath}`);
    try {
      const text = readText(srcAbs);
      const parsed = parseKnowledgeDoc(text, { kind: "decision", relPath });
      if (!parsed.ok) throw new Error(`knowledge store: cannot archive invalid doc: ${relPath}`);
      if (parsed.doc.lifecycle !== "implemented") {
        throw new Error(`knowledge store: only implemented decisions can be archived (got ${parsed.doc.lifecycle})`);
      }
      const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
      const statusIdx = lines.findIndex((l, i) => i < 6 && /^Status[:：]\s*implemented\s*$/.test(l.trim()));
      if (statusIdx < 0) throw new Error("knowledge store: Status: implemented line not found in header");
      const archivedDate = isoNow().slice(0, 10);
      lines.splice(statusIdx + 1, 0, `Archived: ${archivedDate}`);
      let next = lines.join("\n");
      if (opts.supersededBy) {
        next += `\n[历史快照] superseded by: ${opts.supersededBy}\n`;
      }
      const destRel = relPath.replace(/^implemented\//, "archived/");
      const destAbs = path.join(this.layout.decisions, destRel);
      if (fs.existsSync(destAbs)) throw new Error(`knowledge store: archive collision: ${destRel}`);
      // move + seal atomically under one lock
      ensureDir(path.dirname(destAbs));
      atomicWriteText(destAbs, next);
      this.sealArchived(destRel, next);
      fs.rmSync(srcAbs, { force: true });
      const sc = this.readSidecar(srcAbs);
      if (sc) {
        atomicWriteJson(this.sidecarPath(destAbs), sc);
        fs.rmSync(this.sidecarPath(srcAbs), { force: true });
      }
      this.invalidateIndex();
      return { from: relPath, to: destRel, archivedDate, inbound: this.inboundLinks(relPath, destRel) };
    } finally {
      lk.release();
    }
  }

  /** Append-only seal entry for an archived file (contract: archives frozen). */
  sealArchived(destRel, content) {
    const manifestPath = path.join(this.layout.decisions, "archived", "manifest.json");
    const manifest = readJson(manifestPath, { version: 1, files: {} });
    manifest.version = manifest.version ?? 1;
    manifest.files = manifest.files ?? {};
    const key = destRel.startsWith("archived/") ? destRel : `archived/${destRel}`;
    manifest.files[key] = `sha256:${contentHash(content)}`;
    atomicWriteJson(manifestPath, manifest);
  }

  /** Notes whose relative links point at `fromRel` (pre-move links). */
  inboundLinks(fromRel, toRel) {
    const hits = [];
    for (const { rel } of this.walk("decision")) {
      const base = path.basename(fromRel);
      const text = readText(path.join(this.layout.decisions, rel));
      if (text.includes(base) && rel !== fromRel && rel !== toRel) hits.push(rel);
    }
    return hits;
  }

  /**
   * Walk a corpus and yield parse results. Unknown/invalid files are yielded
   * with `parsed.ok=false` — never silently skipped (migration rule §5.1).
   * Each item carries its sidecar metadata so index/retrieval keep provenance
   * and freshness (stabilization §7 — a previous version dropped sidecars
   * here, silently emptying every index entry's verification fields).
   * @param {"decision"|"solution"} kind
   */
  walk(kind) {
    const root = this.dirFor(kind);
    /** @type {{rel: string, abs: string, text: string, parsed: object, sidecar: object|null}[]} */
    const out = [];
    visit(root, root, (rel, abs) => {
      if (!rel.endsWith(".md")) return;
      if (path.basename(rel).endsWith(SIDECAR_SUFFIX)) return;
      const text = readText(abs);
      out.push({ rel, abs, text, parsed: parseKnowledgeDoc(text, { kind, relPath: rel }), sidecar: this.readSidecar(abs) });
    });
    return out;
  }

  // ----------------------------------------------------------------- index

  indexPath() {
    return path.join(this.layout.runtime, "index.json");
  }

  invalidateIndex() {
    try { fs.rmSync(this.indexPath(), { force: true }); } catch { /* ignore */ }
  }

  /**
   * Build/rebuild the summary index (rebuildable cache — deleting it must
   * never lose data; A07).
   */
  buildIndex() {
    /** @type {object[]} */
    const entries = [];
    for (const kind of ["decision", "solution"]) {
      for (const item of this.walk(kind)) {
        const d = item.parsed.doc ?? {};
        entries.push({
          kind,
          rel: item.rel,
          id: this.stableId(kind, item.rel, item.abs, item.parsed),
          title: d.title ?? null,
          lifecycle: d.lifecycle ?? null,
          cls: d.cls ?? null,
          category: d.category ?? null,
          date: d.date ?? null,
          status: d.status?.status ?? null,
          hash: contentHash(item.text),
          digest: digestOf(item.parsed.doc),
          valid: item.parsed.ok,
          errors: item.parsed.ok ? [] : item.parsed.errors.map((e) => `${e.code}: ${e.message}`),
          sidecar: item.sidecar ? {
            sourceTask: item.sidecar.sourceTask, sourceCommit: item.sidecar.sourceCommit,
            lastVerified: item.sidecar.lastVerified,
          } : null,
        });
      }
    }
    const idx = { schema: 1, builtAt: isoNow(), entries };
    atomicWriteJson(this.indexPath(), idx);
    return idx;
  }

  /** Load index, rebuilding when missing or when any corpus file hash differs. */
  index() {
    const cached = readJson(this.indexPath(), null);
    const idx = cached && this.indexFresh(cached) ? cached : this.buildIndex();
    return idx;
  }

  /** @private */
  indexFresh(cached) {
    if (!cached?.entries) return false;
    const byRel = new Map(cached.entries.map((e) => [`${e.kind}:${e.rel}`, e]));
    for (const kind of ["decision", "solution"]) {
      let n = 0;
      for (const item of this.walk(kind)) {
        n++;
        const e = byRel.get(`${kind}:${item.rel}`);
        if (!e || e.hash !== contentHash(item.text)) return false;
      }
      const count = cached.entries.filter((x) => x.kind === kind).length;
      if (count !== n) return false;
    }
    return true;
  }
}

/** Compact searchable section digest (bounded; bodies stay on disk). */
function digestOf(doc) {
  const d = doc ?? {};
  const pick = (k, n = 200) => {
    const s = d.sections?.[k];
    return typeof s === "string" ? s.slice(0, n) : "";
  };
  return {
    problem: pick("problem"),
    decision: pick("decision") || pick("proposal") || pick("fix"),
    rootCause: pick("rootCause"),
    symptom: pick("symptom"),
    consequences: pick("consequences"),
  };
}

/** Recursive walk with dot-skip; callback receives root-relative posix paths. */
function visit(root, dir, cb) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    const abs = path.join(dir, it.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (it.isDirectory()) visit(root, abs, cb);
    else if (it.isFile()) cb(rel, abs);
  }
}

/** Atomic text write: tmp file in same dir + rename. */
function atomicWriteText(abs, text) {
  ensureDir(path.dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, abs);
}

/** Atomic JSON write with sorted-stable shape. */
function atomicWriteJson(abs, obj) {
  atomicWriteText(abs, JSON.stringify(obj, null, 2) + "\n");
}

export { LIFECYCLES, DECISION_CLASSES, PROBLEM_TYPES, SEVERITIES };
