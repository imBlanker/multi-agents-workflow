// @ts-check
// Bridge server — the local side a remote headless helper (or a local panel
// companion) talks to. Implements the server half of the workspace protocol:
// hello handshake with capability negotiation, request routing to providers,
// structured error responses, and snapshot/event emission with epoch/seq
// ordering (contract §8.5).
//
// SECURITY BOUNDARY (contract §8.5 + §12.1):
// - STRICT method allowlist. There is NO exec/eval method and NO arbitrary
//   file read — only the typed METHODS exported by protocol.js. Anything else
//   gets ERR.UNKNOWN_METHOD.
// - Workspace-root authorization is PROVIDER responsibility: every provider
//   handler MUST validate that requested paths/ids resolve inside its
//   explicitly authorized workspace root — resolving absolute paths, "..",
//   symlinks and archive traversal (never a bare string-prefix check). The
//   bridge never touches the filesystem itself; it enforces only the method
//   allowlist and the capability gate.
//
// Zero runtime dependencies (Node built-ins only).

import {
  CAPABILITIES,
  ERR,
  MAX_FRAME_BYTES,
  METHODS,
  checkVersion,
  encodeFrame,
  err,
  event as protoEvent,
  helloServer,
  negotiate,
  protocolError,
  response as protoResponse,
  snapshotMeta,
} from "./protocol.js";

/** Capability required per method (null = no capability gate). */
export const METHOD_CAPS = Object.freeze({
  "workspace.describe": null,
  "project.list": CAPABILITIES.PROJECT_READ,
  "project.tasks": CAPABILITIES.PROJECT_READ,
  "task.get": CAPABILITIES.PROJECT_READ,
  "project.specs": CAPABILITIES.PROJECT_READ,
  "project.relations": CAPABILITIES.PROJECT_READ,
  "runtime.snapshot": CAPABILITIES.RUNTIME_EVENTS,
  "runtime.subscribe": CAPABILITIES.RUNTIME_EVENTS,
  "runtime.unsubscribe": CAPABILITIES.RUNTIME_EVENTS,
  "knowledge.list": CAPABILITIES.KNOWLEDGE_READ,
  "knowledge.get": CAPABILITIES.KNOWLEDGE_READ,
  "knowledge.search": CAPABILITIES.KNOWLEDGE_READ,
  "artifact.list": CAPABILITIES.ARTIFACT_READ,
  "artifact.receipt": CAPABILITIES.ARTIFACT_READ,
  "artifact.read": CAPABILITIES.ARTIFACT_READ,
  "artifact.chunk": CAPABILITIES.ARTIFACT_READ,
  "terminal.snapshot": CAPABILITIES.TERMINAL_META,
});

/**
 * Wire-safe error response line for frames whose request id is unknown or
 * absent (protocol response() requires a non-empty id, so these are built raw).
 * @param {string} id
 * @param {string} code
 * @param {string} message
 * @returns {string} NDJSON line including trailing newline
 */
function errorLine(id, code, message) {
  return JSON.stringify({ type: "response", id, ok: false, error: err(code, message) }) + "\n";
}

/**
 * Server half of the workspace bridge protocol.
 *
 * Providers are plain objects keyed by namespace, each method named after the
 * protocol method's suffix, e.g. providers.project = { list, tasks, get,
 * specs, relations }. A handler is `async (params, ctx) => result`; a thrown
 * error becomes ERR.PROVIDER_FAILED (its own `code`, if any, is preserved as
 * `providerCode` on the wire error).
 */
export class BridgeServer {
  /**
   * @param {{providers?: {workspace?: object, project?: object, knowledge?: object,
   *                     artifact?: object, runtime?: object, terminal?: object},
   *           capabilities?: string[],
   *           serverId?: string, machineId?: string}} [opts]
   */
  constructor(opts = {}) {
    this.providers = opts.providers ?? {};
    // Workspace selection travels via stdin hello (contract §8.1: workspace
    // paths never appear in the command line). When the server is started
    // without an explicit --project, `onWorkspace(root)` is called with the
    // client-provided root during handshake and must return a fresh provider
    // set — or throw, which refuses the hello with a structured reason.
    this.onWorkspace = typeof opts.onWorkspace === "function" ? opts.onWorkspace : null;
    this.serverId = opts.serverId ?? "mawf-bridge";
    // Stable machine identity (stabilization 13): survives alias changes and
    // changes when the alias is re-pointed. Servers should derive it from a
    // registration record (written by `mawf bridge install-helper`), never
    // from connection parameters.
    this.machineId = opts.machineId ?? null;
    this.capabilities = [...new Set((opts.capabilities ?? []).filter((c) => typeof c === "string"))].sort();
    /** Set after a successful hello; a refused handshake is terminal. */
    this.handshaked = false;
    this.refused = false;
    this.clientId = null;
    /** Capability negotiation result of the accepted hello. */
    this.negotiated = null;
    /** @type {Map<string, number>} per-channel current epoch */
    this._epoch = new Map();
    /** @type {Map<string, number>} per-channel last issued seq */
    this._seq = new Map();
    /** Server-initiated frame sink (attached by the transport; runtime events). */
    this._sink = null;
    /** Timers registered by providers (runtime poll); close() clears them. */
    this._ownedTimers = new Set();
    /** True after close(); a closed server accepts no new provider timers. */
    this.closed = false;
  }

  /**
   * Handle one inbound NDJSON line; returns the NDJSON lines to write back
   * (possibly empty). Async because provider handlers may be async.
   * @param {string} line
   * @returns {Promise<string[]>}
   */
  async handleLine(line) {
    if (typeof line !== "string" || line.trim() === "") {
      return [errorLine("", ERR.BAD_MESSAGE, "empty frame")];
    }
    if (line.length > MAX_FRAME_BYTES) {
      return [errorLine("", ERR.BAD_MESSAGE, `frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES} bytes)`)];
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return [errorLine("", ERR.BAD_MESSAGE, "invalid JSON frame")];
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return [errorLine("", ERR.BAD_MESSAGE, "frame must be a JSON object")];
    }
    if (msg.type === "hello") return this._hello(msg);
    if (this.refused) {
      return [errorLine(String(msg.id ?? ""), ERR.PROTOCOL_VERSION, "connection refused during handshake (incompatible base protocol)")];
    }
    if (!this.handshaked) {
      return [errorLine(String(msg.id ?? ""), ERR.BAD_MESSAGE, "handshake required before any other message")];
    }
    if (msg.type !== "request") {
      return [errorLine(String(msg.id ?? ""), ERR.BAD_MESSAGE, `unsupported message type ${JSON.stringify(msg.type ?? null)}`)];
    }
    return this._request(msg);
  }

  /**
   * Hello handshake: version check is absolute (incompatible framing/base
   * protocol => refuse the connection, contract §8.5); capabilities are then
   * negotiated for partial degradation within a compatible base protocol.
   * @param {object} msg
   * @returns {string[]}
   */
  _hello(msg) {
    const verdict = checkVersion(msg);
    if (!verdict.compatible) {
      this.refused = true;
      return [encodeFrame(helloServer({ serverId: this.serverId, accepted: false, reason: verdict.reason }))];
    }
    if (!msg.clientId || typeof msg.clientId !== "string") {
      return [errorLine("", ERR.BAD_MESSAGE, "hello requires a clientId string")];
    }
    if (this.handshaked) {
      return [errorLine("", ERR.BAD_MESSAGE, "duplicate hello")];
    }
    this.handshaked = true;
    this.clientId = msg.clientId;
    this.negotiated = negotiate(this.capabilities, Array.isArray(msg.capabilities) ? msg.capabilities : []);
    const ws = Array.isArray(msg.workspaces) ? msg.workspaces[0] : null;
    if (ws && typeof ws.root === "string" && typeof this.onWorkspace === "function") {
      try {
        this.providers = this.onWorkspace(ws.root) ?? this.providers;
      } catch (e) {
        this.refused = true;
        return [encodeFrame(helloServer({ serverId: this.serverId, machineId: this.machineId ?? this.serverId, accepted: false, reason: `workspace rejected: ${e?.message ?? e}` }))];
      }
    }
    return [encodeFrame(helloServer({ serverId: this.serverId, machineId: this.machineId ?? this.serverId, accepted: true, capabilities: this.capabilities }))];
  }

  /**
   * Route a request to its provider handler through the strict allowlist.
   * @param {{id?: unknown, method?: unknown, params?: unknown}} msg
   * @returns {Promise<string[]>}
   */
  async _request(msg) {
    const id = typeof msg.id === "string" && msg.id !== "" ? msg.id : null;
    if (!id) return [errorLine("", ERR.BAD_MESSAGE, "request id required")];
    if (typeof msg.method !== "string" || !METHODS.includes(msg.method)) {
      return [errorLine(id, ERR.UNKNOWN_METHOD, `method ${JSON.stringify(msg.method ?? null)} is not in the protocol allowlist`)];
    }
    if (msg.method === "request.cancel") {
      // No-op by contract: the single-shot stdio bridge has nothing in flight
      // between lines. Long-running providers own their own cancellation.
      return [encodeFrame(protoResponse({ id, ok: true, result: { cancelled: false } }))];
    }
    const required = METHOD_CAPS[msg.method];
    if (required && !this.capabilities.includes(required)) {
      return [errorLine(id, ERR.CAPABILITY_MISSING, `capability ${required} is not offered by this bridge`)];
    }
    const dot = msg.method.indexOf(".");
    const rawNs = msg.method.slice(0, dot);
    const fn = msg.method.slice(dot + 1);
    // task.get is served by the project provider (the task surface lives there)
    const ns = rawNs === "task" ? "project" : rawNs;
    const provider = this.providers[ns];
    const handler = provider && typeof provider[fn] === "function" ? provider[fn].bind(provider) : null;
    if (!handler) {
      return [errorLine(id, ERR.CAPABILITY_MISSING, `no provider handler for ${msg.method}`)];
    }
    let result;
    try {
      result = await handler(msg.params ?? {}, { server: this, negotiated: this.negotiated });
    } catch (e) {
      const extra = e && typeof e.code === "string" ? { providerCode: e.code } : {};
      return [encodeFrame(protoResponse({ id, ok: false, error: err(ERR.PROVIDER_FAILED, e?.message ?? String(e), extra) }))];
    }
    return [encodeFrame(protoResponse({ id, ok: true, result: result ?? {} }))];
  }

  // ------------------------------------------------- snapshot/event helpers

  /**
   * Emit a snapshot marker for a channel and bind its epoch; subsequent
   * events continue from `cursor + 1` (contract §8.5: first snapshot and
   * later events share the epoch until it is bumped).
   * @param {string} channel
   * @param {number} epoch
   * @param {number} [cursor] last seq included in the snapshot payload
   * @returns {string} NDJSON line
   */
  snapshot(channel, epoch, cursor = 0) {
    if (!Number.isInteger(epoch) || epoch < 0) throw protocolError(ERR.BAD_MESSAGE, "epoch must be a non-negative integer");
    if (!Number.isInteger(cursor) || cursor < 0) throw protocolError(ERR.BAD_MESSAGE, "cursor must be a non-negative integer");
    this._epoch.set(channel, epoch);
    this._seq.set(channel, cursor);
    return encodeFrame(snapshotMeta({ channel, epoch, cursor }));
  }

  /**
   * Emit an event on a channel with the channel's current epoch and the next
   * monotonically increasing seq (per epoch). Before any snapshot the epoch
   * defaults to 0 and seq starts at 0.
   * @param {string} channel
   * @param {object} [payload]
   * @param {{at?: string}} [opts]
   * @returns {string} NDJSON line
   */
  event(channel, payload = {}, opts = {}) {
    const epoch = this._epoch.has(channel) ? this._epoch.get(channel) : 0;
    const seq = (this._seq.get(channel) ?? -1) + 1;
    this._seq.set(channel, seq);
    return encodeFrame(protoEvent({ channel, epoch, seq, at: opts.at, payload }));
  }

  // ------------------------------------------------ push/timer/close hooks

  /**
   * Attach the transport sink that receives server-initiated frames (events
   * pushed by providers, e.g. the runtime subscription poll). Passing null
   * detaches. Without a sink, pushFrame() drops frames harmlessly.
   * @param {null | ((line: string) => void)} sink
   */
  onFrame(sink) {
    this._sink = typeof sink === "function" ? sink : null;
  }

  /**
   * Push one server-initiated frame to the attached transport sink.
   * @param {string} line NDJSON line including the trailing newline
   * @returns {boolean} true when a sink received the frame
   */
  pushFrame(line) {
    if (this._sink === null) return false;
    this._sink(line);
    return true;
  }

  /**
   * Current channel binding: epoch and last issued seq (-1 when no event has
   * been emitted yet). runtime.subscribe returns this as the client's resume
   * point so the first event (seq = cursor + 1) applies cleanly per the
   * resumeDecision semantics in protocol.js (contract §8.5).
   * @param {string} channel
   * @returns {{epoch: number, cursor: number}}
   */
  channelCursor(channel) {
    return { epoch: this._epoch.get(channel) ?? 0, cursor: this._seq.get(channel) ?? -1 };
  }

  /**
   * Register a provider-owned timer with the server; close() clears it.
   * @param {NodeJS.Timeout} timer
   * @returns {NodeJS.Timeout} the same timer (fluent)
   */
  ownTimer(timer) {
    this._ownedTimers.add(timer);
    return timer;
  }

  /**
   * Release a previously owned timer (e.g. after unsubscribe) without
   * touching the server lifecycle.
   * @param {NodeJS.Timeout} timer
   */
  disownTimer(timer) {
    this._ownedTimers.delete(timer);
  }

  /**
   * Close the server: clear every owned provider timer and detach the frame
   * sink. Idempotent; request routing keeps working afterwards (close only
   * stops background activity — callers flush pending frames separately).
   */
  close() {
    this.closed = true;
    for (const timer of this._ownedTimers) clearInterval(timer);
    this._ownedTimers.clear();
    this._sink = null;
  }
}
