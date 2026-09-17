// @ts-check
// Typed read-only workspace providers for `mawf bridge serve` (P4.2).
//
// Contract (task: 09-17-mawf-four-tool-integration):
// - §8.5: only the typed protocol methods are served — no exec/eval, no
//   arbitrary file read. Every provider here maps 1:1 onto an allowlisted
//   method (task.get is served by the project provider, see bridge.js).
// - §12.1: the workspace root is EXPLICITLY authorized once (realpath);
//   every file-returning method verifies containment with path.relative
//   checks (lexical first, then realpath) — never a string-prefix test.
//   Absolute paths, `..` escapes and symlink escapes are all rejected with
//   workspace_unauthorized protocol errors, regardless of target existence.
// - Read-only by construction: no method writes, no capture-pane/send-keys.
//
// Zero runtime dependencies (Node built-ins only).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ERR, protocolError } from "./protocol.js";
import { searchKnowledge } from "../knowledge/search.js";


/** Max knowledge body bytes returned by knowledge.get (larger => truncated flag). */
export const KNOWLEDGE_BODY_MAX_BYTES = 64 * 1024;
/** Max whole-file bytes returned by artifact.read (larger => use artifact.chunk). */
export const ARTIFACT_READ_MAX_BYTES = 256 * 1024;
/** Max chunk payload bytes per artifact.chunk call (frames stay far below MAX_FRAME_BYTES). */
export const ARTIFACT_CHUNK_MAX_BYTES = 1_000_000;
/** implement.jsonl/check.jsonl scan bound (contract: bounded line reads). */
export const RELATIONS_MAX_LINES = 200;
/** tmux metadata probe timeout (fail-open, bounded, read-only). */
export const TMUX_TIMEOUT_MS = 2000;

const ARTIFACT_EXTS = new Set([".html", ".json", ".md"]);
const TMUX_FORMAT = "#{socket_path}\t#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}";

/**
 * Artifact listing entry.
 * @typedef {{rel: string, bytes: number, mtime: number}} ArtifactEntry
 */

/**
 * Throwable provider error carrying a stable wire `providerCode`.
 * @param {string} code @param {string} message
 * @returns {Error & {code: string}}
 */
function providerError(code, message) {
  return protocolError(code, message);
}

/**
 * Path escaped (or tried to escape) the authorized workspace root.
 * @param {string} message @returns {Error & {code: string}}
 */
function unauthorized(message) {
  return providerError(ERR.WORKSPACE_UNAUTHORIZED, message);
}

/**
 * Requested object does not exist (or the candidate path vanished mid-flight).
 * @param {string} message @returns {Error & {code: string}}
 */
function notFound(message) {
  return providerError(ERR.NOT_FOUND, message);
}

/**
 * Containment test: is `real` inside `dir` (or `dir` itself)? Purely lexical
 * over the two resolved paths — the sanctioned alternative to prefix matching.
 * @param {string} dir resolved directory
 * @param {string} real resolved candidate
 * @returns {null | string} null = outside; else relative path ("." for dir itself)
 */
function relativeInside(dir, real) {
  const r = path.relative(dir, real);
  if (r === "") return ".";
  if (r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return null;
  return r;
}

/**
 * readdir wrapper: missing dir => empty list, never throws to callers.
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * True when a directory has at least one non-dot entry.
 * @param {string} dir
 */
function hasVisibleEntries(dir) {
  return listDir(dir).some((e) => !e.name.startsWith("."));
}

/**
 * Streaming sha256 of a file (receipts/chunks must not whole-read huge artifacts).
 * @param {string} abs
 */
function sha256File(abs) {
  const h = createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.byteLength, null);
      if (n <= 0) break;
      h.update(n === buf.byteLength ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * Create the provider set served by `mawf bridge serve`.
 * @param {{projectDir: string, store: import("../knowledge/store.js").KnowledgeStore,
 *           machineId?: string|null}} p
 *        projectDir is realpath-resolved exactly once (the authorization root).
 * @returns {{workspace: object, project: object, knowledge: object, artifact: object, terminal: object}}
 */
export function createProviders({ projectDir, store, machineId = null }) {
  const root = fs.realpathSync(path.resolve(projectDir));
  /** per-server-instance snapshot epoch for project.tasks */
  let taskEpoch = 0;

  /**
   * §12.1 authorization: rel must resolve (lexically + symlinks) inside root.
   * @param {unknown} rel workspace-relative path
   * @returns {string} the realpath (inside root)
   */
  function authorize(rel) {
    if (typeof rel !== "string" || rel.trim() === "") throw unauthorized("path required");
    if (rel.includes("\0")) throw unauthorized("NUL byte in path");
    if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) {
      throw unauthorized(`absolute paths are not accepted: ${rel}`);
    }
    const abs = path.resolve(root, rel);
    // 1) lexical containment first — a `..` escape is unauthorized even when
    //    the target does not exist (no existence oracle on escape intent)
    if (relativeInside(root, abs) === null) {
      throw unauthorized(`path escapes the authorized workspace root: ${rel}`);
    }
    // 2) then symlink resolution — an in-root path may still resolve outside
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw notFound(`no such path in workspace: ${rel}`);
    }
    if (relativeInside(root, real) === null) {
      throw unauthorized(`path escapes the authorized workspace root: ${rel}`);
    }
    return real;
  }

  /**
   * Require the resolved path to be a regular file.
   * @param {string} real resolved path
   * @param {string} rel original request path
   * @returns {fs.Stats}
   */
  function requireFile(real, rel) {
    let st;
    try {
      st = fs.statSync(real);
    } catch {
      throw notFound(`no such file: ${rel}`);
    }
    if (!st.isFile()) throw notFound(`not a file: ${rel}`);
    return st;
  }

  /**
   * Canonical root-relative posix form (what the wire echoes back).
   * @param {string} real
   */
  const relFromRoot = (real) => path.relative(root, real).split(path.sep).join("/");

  /**
   * Task summary from one task dir (tolerates missing/invalid task.json).
   * @param {string} taskDir
   * @param {string} id
   * @returns {Record<string, unknown>}
   */
  function readTaskSummary(taskDir, id) {
    /** @type {Record<string, unknown>} */
    const out = { id, name: id };
    try {
      const raw = fs.readFileSync(path.join(taskDir, "task.json"), "utf8");
      const tj = JSON.parse(raw);
      if (tj && typeof tj === "object" && !Array.isArray(tj)) {
        for (const k of ["name", "title", "status", "priority", "updatedAt"]) {
          if (tj[k] !== undefined) out[k] = tj[k];
        }
      }
    } catch {
      // tolerate missing/invalid task.json — id + name still identify the dir
    }
    return out;
  }

  /**
   * Collect `file:` edges from one JSONL manifest (bounded line scan; seed
   * rows without a file field are naturally skipped).
   * @param {string} jsonlPath
   * @param {string[]} out
   */
  function collectFileRefs(jsonlPath, out) {
    let text;
    try {
      text = fs.readFileSync(jsonlPath, "utf8");
    } catch {
      return;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (n >= RELATIONS_MAX_LINES) break;
      n++;
      const m = line.match(/"file"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) continue;
      try {
        out.push(JSON.parse(`"${m[1]}"`));
      } catch {
        out.push(m[1]); // keep the raw token rather than dropping the edge
      }
    }
  }

  /**
   * Recursively collect allowlisted artifact files under dir.
   * @param {string} dir
   * @param {ArtifactEntry[]} out
   */
  function walkArtifacts(dir, out) {
    for (const ent of listDir(dir)) {
      if (ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walkArtifacts(abs, out);
      else if (ent.isFile() && ARTIFACT_EXTS.has(path.extname(ent.name).toLowerCase())) {
        const st = fs.statSync(abs);
        out.push({ rel: relFromRoot(abs), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }

  /**
   * Read one bounded slice of a file (no whole-read of large artifacts).
   * @param {string} real
   * @param {number} offset
   * @param {number} length
   * @returns {Buffer}
   */
  function readArtifactSlice(real, offset, length) {
    const fd = fs.openSync(real, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.allocUnsafe(n);
      if (n > 0) {
        const got = fs.readSync(fd, buf, 0, n, offset);
        return got === n ? buf : buf.subarray(0, got);
      }
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    // ------------------------------------------------------- workspace.*
    workspace: {
      /** workspace.describe → identity + display label (ref.js §8.4). */
      describe: async () => ({
        machineId: machineId ?? null,
        // display uses the RESOLVED NATIVE path: identity normalization may
        // fold separators (win32), but the label must show real separators
        label: `local:${root}`,
        root,
        protocolVersion: 1,
      }),
    },

    // ------------------------------------------------- project.* (+ task.get)
    project: {
      /** Single authorized project per server; direct-child `.trellis/tasks` check only. */
      list: async () => ({
        projects: [{ id: path.basename(root), hasTrellis: hasVisibleEntries(path.join(root, ".trellis", "tasks")) }],
      }),

      /** Flat task dirs under `<root>/.trellis/tasks/`; epoch is per-instance monotonic. */
      tasks: async () => {
        const tasksDir = path.join(root, ".trellis", "tasks");
        const tasks = [];
        for (const ent of listDir(tasksDir)) {
          if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
          tasks.push(readTaskSummary(path.join(tasksDir, ent.name), ent.name));
        }
        tasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return { epoch: ++taskEpoch, tasks };
      },

      /**
       * Full task.json (no bodies) + prd/design/implement existence flags.
       * @param {{id?: string}} p
       */
      get: async (p) => {
        const id = typeof p?.id === "string" ? p.id : "";
        if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
          throw notFound("task.get requires a single-segment task id");
        }
        const taskDir = authorize(path.join(".trellis", "tasks", id));
        /** @type {Record<string, unknown>} */
        const out = { id, task: null };
        const tjPath = path.join(taskDir, "task.json");
        if (fs.existsSync(tjPath)) {
          try {
            out.task = JSON.parse(fs.readFileSync(tjPath, "utf8"));
          } catch (e) {
            out.parseError = `invalid task.json: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        out.hasPrd = fs.existsSync(path.join(taskDir, "prd.md"));
        out.hasDesign = fs.existsSync(path.join(taskDir, "design.md"));
        out.hasImplement = fs.existsSync(path.join(taskDir, "implement.md"));
        return out;
      },

      /** `.trellis/spec/` entries: name + filled boolean (no content). */
      specs: async () => {
        const specDir = path.join(root, ".trellis", "spec");
        const specs = [];
        for (const ent of listDir(specDir)) {
          if (ent.name.startsWith(".")) continue;
          const abs = path.join(specDir, ent.name);
          const filled = ent.isDirectory()
            ? hasVisibleEntries(abs)
            : ent.isFile() && fs.statSync(abs).size > 0;
          specs.push({ name: ent.name, filled });
        }
        specs.sort((a, b) => a.name.localeCompare(b.name));
        return { specs };
      },

      /** implement.jsonl/check.jsonl `file:` edges per task dir (bounded). */
      relations: async () => {
        const tasksDir = path.join(root, ".trellis", "tasks");
        const groups = [];
        for (const ent of listDir(tasksDir)) {
          if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
          /** @type {string[]} */
          const files = [];
          for (const name of ["implement.jsonl", "check.jsonl"]) {
            collectFileRefs(path.join(tasksDir, ent.name, name), files);
          }
          groups.push({ task: ent.name, files: [...new Set(files)] });
        }
        groups.sort((a, b) => a.task.localeCompare(b.task));
        return { groups };
      },
    },

    // -------------------------------------------------------- knowledge.*
    knowledge: {
      /** Index summaries only — bodies stay on disk until knowledge.get. */
      list: async () => {
        const idx = store.index();
        return { entries: idx.entries, total: idx.entries.length, builtAt: idx.builtAt ?? null };
      },

      /**
       * Explainable search; raw params pass through to searchKnowledge (§6);
       * a missing q is an empty query (no tokens, no matches) — same as the
       * CLI's raw pass-through behavior, typed for the strict search contract.
       * @param {{q?: string, kinds?: string[], includeArchived?: boolean,
       *           maxDocs?: number, maxBytes?: number, now?: string}} [p]
       */
      search: async (p) => {
        /** @type {{q: string, kinds?: string[], includeArchived?: boolean,
         *          maxDocs?: number, maxBytes?: number, now?: string}} */
        const q = { ...(p ?? {}), q: typeof p?.q === "string" ? p.q : "" };
        return searchKnowledge(store.index().entries, q);
      },

      /**
       * One document body via store.read. kind defaults to an index lookup by
       * path. The candidate path is containment-verified against BOTH the root
       * and the corpus dir; bodies above 64KB are truncated (truncated: true).
       * @param {{path?: string, rel?: string, kind?: string}} p
       */
      get: async (p) => {
        const relPath = typeof p?.path === "string" ? p.path : typeof p?.rel === "string" ? p.rel : "";
        if (!relPath) throw providerError(ERR.BAD_MESSAGE, "knowledge.get requires path");
        let kind = p?.kind;
        if (kind !== "decision" && kind !== "solution") {
          const entry = store.index().entries.find((/** @type {{rel: string, kind?: "decision"|"solution"}} */ e) => e.rel === relPath);
          kind = entry?.kind;
        }
        if (kind !== "decision" && kind !== "solution") {
          throw notFound(`unknown knowledge document: ${relPath}`);
        }
        const corpusDir = store.dirFor(kind);
        const abs = path.resolve(corpusDir, relPath);
        // lexical containment first (see authorize: no existence oracle on escapes)
        if (relativeInside(root, abs) === null) {
          throw unauthorized(`path escapes the authorized workspace root: ${relPath}`);
        }
        let real;
        try {
          real = fs.realpathSync(abs);
        } catch {
          throw notFound(`no such knowledge document: ${relPath}`);
        }
        if (relativeInside(root, real) === null) {
          throw unauthorized(`path escapes the authorized workspace root: ${relPath}`);
        }
        const relToCorpus = relativeInside(corpusDir, real);
        if (relToCorpus === null || relToCorpus === ".") {
          throw unauthorized(`path escapes the knowledge corpus: ${relPath}`);
        }
        const relPosix = relToCorpus.split(path.sep).join("/");
        const { text, parsed, sidecar, hash } = store.read(kind, relPosix);
        const full = Buffer.from(text, "utf8");
        const truncated = full.byteLength > KNOWLEDGE_BODY_MAX_BYTES;
        return {
          kind,
          path: relPosix,
          id: sidecar?.id ?? parsed.doc?.slug ?? null,
          title: parsed.doc?.title ?? null,
          lifecycle: parsed.doc?.lifecycle ?? null,
          cls: parsed.doc?.cls ?? null,
          status: parsed.doc?.status?.status ?? null,
          text: truncated ? full.subarray(0, KNOWLEDGE_BODY_MAX_BYTES).toString("utf8") : text,
          truncated,
          hash,
          sidecar,
          valid: parsed.ok,
        };
      },
    },

    // --------------------------------------------------------- artifact.*
    artifact: {
      /** Only `.trellis/tasks/**` and `docs/architecture/**` with .html/.json/.md. */
      list: async () => {
        /** @type {ArtifactEntry[]} */
        const artifacts = [];
        walkArtifacts(path.join(root, ".trellis", "tasks"), artifacts);
        walkArtifacts(path.join(root, "docs", "architecture"), artifacts);
        artifacts.sort((a, b) => a.rel.localeCompare(b.rel));
        return { artifacts };
      },

      /**
       * Whole-file read (≤256KB) with sha256 — bigger files must use artifact.chunk.
       * @param {{rel?: string}} p
       */
      read: async (p) => {
        const real = authorize(p?.rel);
        const rel = typeof p?.rel === "string" ? p.rel : "";
        const st = requireFile(real, rel);
        if (st.size > ARTIFACT_READ_MAX_BYTES) {
          throw providerError("artifact_too_large", `${rel} is ${st.size}B > ARTIFACT_READ_MAX_BYTES ${ARTIFACT_READ_MAX_BYTES}B; use artifact.chunk`);
        }
        const text = fs.readFileSync(real, "utf8");
        return { rel: relFromRoot(real), sha256: sha256File(real), bytes: st.size, text };
      },

      /**
       * base64 slice + full-file sha256 (large-artifact delivery, §8.5).
       * @param {{rel?: string, offset?: number, length?: number}} p
       */
      chunk: async (p) => {
        const real = authorize(p?.rel);
        const rel = typeof p?.rel === "string" ? p.rel : "";
        const st = requireFile(real, rel);
        const offRaw = Number(p?.offset);
        const offset = Number.isFinite(offRaw) && offRaw >= 0 ? Math.floor(offRaw) : 0;
        const lenRaw = Number(p?.length);
        const reqLen = Number.isFinite(lenRaw) && lenRaw > 0 ? Math.floor(lenRaw) : ARTIFACT_CHUNK_MAX_BYTES;
        const length = Math.min(reqLen, ARTIFACT_CHUNK_MAX_BYTES);
        const buf = offset >= st.size ? Buffer.alloc(0) : readArtifactSlice(real, offset, length);
        return {
          rel: relFromRoot(real),
          offset,
          length: buf.byteLength,
          data: buf.toString("base64"),
          sha256: sha256File(real),
          bytes: st.size,
          done: offset + buf.byteLength >= st.size,
        };
      },

      /**
       * Digest receipt — cache invalidation without content transfer.
       * @param {{rel?: string}} p
       */
      receipt: async (p) => {
        const real = authorize(p?.rel);
        const rel = typeof p?.rel === "string" ? p.rel : "";
        const st = requireFile(real, rel);
        return { rel: relFromRoot(real), sha256: sha256File(real), bytes: st.size };
      },
    },

    // --------------------------------------------------------- terminal.*
    terminal: {
      /**
       * Read-only tmux position metadata. Never capture-pane/send-keys/kill;
       * bounded probe, fail-open with { available: false, reason } (§8.7).
       */
      snapshot: async () => {
        let out;
        try {
          out = execFileSync("tmux", ["list-panes", "-a", "-F", TMUX_FORMAT], {
            timeout: TMUX_TIMEOUT_MS,
            encoding: "utf8",
          });
        } catch (e) {
          const code = /** @type {{code?: string}} */ (/** @type {unknown} */ (e))?.code;
          const reason = code === "ENOENT" ? "tmux not found" : e instanceof Error ? e.message : String(e);
          return { available: false, reason };
        }
        const panes = [];
        for (const line of out.split("\n")) {
          if (line.trim() === "") continue;
          const [socket, session, window, paneId, panePid, command] = line.split("\t");
          panes.push({ socket, session, window, paneId, panePid, command });
        }
        return { available: true, panes };
      },
    },
  };
}
