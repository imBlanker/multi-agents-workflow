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
/** runtime.subscribe poll cadence (ms) — the server-instance polling interval. */
export const RUNTIME_POLL_MS = 2000;
/** Max concurrent runtime subscribers per server instance. */
export const RUNTIME_MAX_SUBSCRIBERS = 16;

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
 * @returns {{workspace: object, project: object, runtime: object, knowledge: object, artifact: object, terminal: object}}
 */
export function createProviders({ projectDir, store, machineId = null }) {
  const root = fs.realpathSync(path.resolve(projectDir));
  /** per-server-instance snapshot epoch for project.tasks */
  let taskEpoch = 0;

  // ------------------------------------------------- runtime.* (P4.2.2)
  // Sessions come from Trellis's own persistence (<root>/.trellis/.runtime/
  // sessions/*.json — fields platform/last_seen_at/current_task; the FILENAME
  // (sans .json) is the session id). scopedKey deliberately composes
  // machineId + workspace-root basename + sessionId: a bare session id is
  // only unique within one workspace, and clients subscribing across several
  // bridged workspaces need a stable READABLE composite (no new crypto).
  const RUNTIME_CHANNEL = "runtime";
  const RUNTIME_SESSIONS_DIR = path.join(root, ".trellis", ".runtime", "sessions");
  const RUNTIME_INCIDENTS_DIR = path.join(root, ".mawf", "watchdog", "incidents");
  const machineKey = typeof machineId === "string" && machineId.trim() !== "" ? machineId.trim() : "unknown";
  /** Runtime state version: 0 = initial baseline, +1 per detected change. */
  let runtimeEpoch = 0;
  /** Composite content signature of the sessions dir at last refresh. */
  let runtimeSig = null;
  /** Last refreshed runtime payload { sessions, warnings, incidents }. */
  let runtimeState = null;
  /** @type {Map<string, {since: number}>} clientId -> subscription record */
  const runtimeSubs = new Map();
  /** Shared poll interval handle; null while no subscriber is registered. */
  let runtimeTimer = null;
  /** The BridgeServer that owns the poll (set on first subscribe). */
  let runtimeServer = null;

  /** scopedKey: machine + workspace + session (stable, readable composite). */
  const runtimeScopedKey = (sessionId) => `${machineKey}:${path.basename(root)}:${sessionId}`;

  /**
   * Parse one session file into the wire shape; throws on malformed content
   * (the caller records a warning and skips the file instead of crashing).
   * @param {string} abs @param {string} sessionId
   */
  function readSessionFile(abs, sessionId) {
    const j = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a JSON object");
    return {
      sessionId,
      platform: typeof j.platform === "string" ? j.platform : null,
      currentTask: typeof j.current_task === "string" ? j.current_task : null,
      lastSeenAt: typeof j.last_seen_at === "string" ? j.last_seen_at : null,
      scopedKey: runtimeScopedKey(sessionId),
    };
  }

  /** Sessions + skip warnings from <root>/.trellis/.runtime/sessions/*.json. */
  function readRuntimeSessions() {
    /** @type {Record<string, unknown>[]} */
    const sessions = [];
    /** @type {string[]} */
    const warnings = [];
    for (const ent of listDir(RUNTIME_SESSIONS_DIR)) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      try {
        sessions.push(readSessionFile(path.join(RUNTIME_SESSIONS_DIR, ent.name), ent.name.slice(0, -5)));
      } catch (e) {
        warnings.push(`sessions: skipped ${ent.name} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    sessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
    return { sessions, warnings };
  }

  /**
   * Count watchdog incidents whose `state` is "open" — the same filter the
   * watchdog itself uses when re-dispatching (scan.js). Malformed records are
   * ignored, never fatal.
   */
  function countOpenIncidents() {
    let open = 0;
    for (const ent of listDir(RUNTIME_INCIDENTS_DIR)) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(RUNTIME_INCIDENTS_DIR, ent.name), "utf8"));
        if (j && typeof j === "object" && !Array.isArray(j) && j.state === "open") open++;
      } catch {
        // malformed incident record: not counted, not fatal
      }
    }
    return open;
  }

  /**
   * Cheap composite change signature: per-file name + short content hash
   * (session files are tiny). Sorted so file order never matters.
   */
  function runtimeSignature() {
    /** @type {string[]} */
    const parts = [];
    for (const ent of listDir(RUNTIME_SESSIONS_DIR)) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      try {
        const digest = createHash("sha256").update(fs.readFileSync(path.join(RUNTIME_SESSIONS_DIR, ent.name))).digest("hex").slice(0, 12);
        parts.push(`${ent.name}:${digest}`);
      } catch {
        parts.push(`${ent.name}:unreadable`); // vanished/unreadable mid-poll
      }
    }
    return parts.sort().join("|");
  }

  /**
   * Re-read the runtime dirs; bumps runtimeEpoch when content changed. The
   * first refresh only establishes the baseline (no event, epoch stays 0).
   */
  function refreshRuntime() {
    const sig = runtimeSignature();
    if (runtimeState !== null && sig === runtimeSig) return { changed: false, state: runtimeState };
    const changed = runtimeState !== null;
    runtimeSig = sig;
    const read = readRuntimeSessions();
    runtimeState = { sessions: read.sessions, warnings: read.warnings, incidents: { open: countOpenIncidents() } };
    if (changed) runtimeEpoch++;
    return { changed, state: runtimeState };
  }

  /**
   * One poll tick: change detected -> bump epoch -> emit ONE event on the
   * "runtime" channel through the BridgeServer event helper (epoch/seq per
   * contract §8.5; seq starts at 0 before any snapshot binding). Every step
   * is guarded — a failed tick must never throw out of a timer callback and
   * kill the process.
   */
  function pollRuntime() {
    if (runtimeSubs.size === 0) return;
    let res;
    try {
      res = refreshRuntime();
    } catch {
      return; // keep the last good state; the next tick retries
    }
    if (!res.changed || !runtimeServer) return;
    try {
      runtimeServer.pushFrame(runtimeServer.event(RUNTIME_CHANNEL, {
        kind: "runtime.sessions",
        epoch: runtimeEpoch,
        sessions: res.state.sessions,
        warnings: res.state.warnings,
        incidents: res.state.incidents,
      }));
    } catch {
      // dropping one event beats killing the pump; the next change re-emits
    }
  }

  /** Start the shared poll interval (registered with the server instance). */
  function startRuntimePolling(server) {
    runtimeServer = server;
    if (runtimeTimer !== null) return;
    runtimeTimer = server.ownTimer(setInterval(pollRuntime, RUNTIME_POLL_MS));
  }

  /** Stop the shared poll interval (last unsubscribe / server close). */
  function stopRuntimePolling(server) {
    if (runtimeTimer === null) return;
    clearInterval(runtimeTimer);
    const owner = server ?? runtimeServer;
    if (owner && typeof owner.disownTimer === "function") owner.disownTimer(runtimeTimer);
    runtimeTimer = null;
  }

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

    // ---------------------------------------------------------- runtime.*
    runtime: {
      /**
       * Runtime snapshot: Trellis sessions + open watchdog incident count.
       * epoch is the runtime STATE version (0 = baseline, +1 per detected
       * change) — unlike project.tasks it does not advance on every call.
       */
      snapshot: async () => {
        refreshRuntime();
        return { epoch: runtimeEpoch, ...runtimeState };
      },

      /**
       * Subscribe the calling client (handshake clientId) to runtime change
       * events on the "runtime" channel: a shared RUNTIME_POLL_MS interval on
       * the server instance re-reads the sessions dir; on change it bumps the
       * runtime epoch and emits one event via BridgeServer.event() with the
       * new payload. Re-subscribing replaces; the 17th distinct subscriber is
       * refused with a conflict. Returns the current data epoch plus the
       * channel cursor (last issued seq, -1 before the first event) so the
       * client's next event applies cleanly per resumeDecision (§8.5).
       * @param {Record<string, unknown>} _p
       * @param {{server?: object}} [ctx]
       */
      subscribe: async (_p, ctx) => {
        const server = ctx?.server;
        if (!server || typeof server.ownTimer !== "function" || typeof server.event !== "function") {
          throw providerError(ERR.INTERNAL, "runtime.subscribe requires a BridgeServer instance");
        }
        if (server.closed) throw providerError(ERR.INTERNAL, "runtime.subscribe: server is closed");
        const clientId = typeof server.clientId === "string" && server.clientId !== "" ? server.clientId : "anonymous";
        if (!runtimeSubs.has(clientId) && runtimeSubs.size >= RUNTIME_MAX_SUBSCRIBERS) {
          throw providerError(ERR.CONFLICT, `runtime.subscribe: subscriber limit ${RUNTIME_MAX_SUBSCRIBERS} reached`);
        }
        refreshRuntime(); // baseline for change detection
        runtimeSubs.set(clientId, { since: Date.now() });
        startRuntimePolling(server);
        return { epoch: runtimeEpoch, cursor: server.channelCursor(RUNTIME_CHANNEL).cursor };
      },

      /**
       * Stop the calling client's subscription. Unsubscribing the last
       * subscriber stops the shared poll interval entirely.
       * @param {Record<string, unknown>} _p
       * @param {{server?: object}} [ctx]
       */
      unsubscribe: async (_p, ctx) => {
        const server = ctx?.server;
        const clientId = server && typeof server.clientId === "string" && server.clientId !== "" ? server.clientId : "anonymous";
        const stopped = runtimeSubs.delete(clientId);
        if (runtimeSubs.size === 0) stopRuntimePolling(server);
        return { stopped, subscribers: runtimeSubs.size };
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
