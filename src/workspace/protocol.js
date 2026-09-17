// @ts-check
// Workspace bridge wire protocol — pure, dependency-free message layer.
//
// Contract (task: 09-17-mawf-four-tool-integration, contract §8.5):
// - Versioned handshake with capability negotiation. Incompatible framing or
//   base protocol => refuse the connection; partial degradation only within a
//   compatible base protocol.
// - NDJSON framing (one JSON message per line, UTF-8, "\n" delimiter), request
//   ids, structured errors, per-message size limits, cancellation + timeouts.
// - Snapshot/event consistency via epoch + sequence numbers.
// - NO exec/eval method, NO arbitrary file read: only the typed methods below.
//
// Transport-agnostic: both stdio (SSH) and loopback WebSocket/HTTP-SSE adapters
// encode/decode through these functions. This module does no I/O.

/** Wire protocol version (major bumps break framing/handshake compatibility). */
export const PROTOCOL_VERSION = 1;

/** Maximum bytes for a single protocol message (frames above => protocol error). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB; artifacts use chunking

/** Request timeout default (ms) — callers may override per request. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Protocol error codes (stable string contract; do not renumber). */
export const ERR = Object.freeze({
  PROTOCOL_VERSION: "protocol_version_mismatch",
  BAD_MESSAGE: "bad_message",
  UNKNOWN_METHOD: "unknown_method",
  CAPABILITY_MISSING: "capability_missing",
  WORKSPACE_UNAUTHORIZED: "workspace_unauthorized",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  PROVIDER_FAILED: "provider_failed",
  INTERNAL: "internal",
});

/** Capabilities a side may declare during handshake. */
export const CAPABILITIES = Object.freeze({
  // provider surface
  PROJECT_READ: "project.read",
  KNOWLEDGE_READ: "knowledge.read",
  ARTIFACT_READ: "artifact.read",
  RUNTIME_EVENTS: "runtime.events",
  TERMINAL_META: "terminal.metadata", // read-only tmux position metadata
  // transport features
  CHUNKED_ARTIFACTS: "artifact.chunked",
  EVENT_RESUME: "event.resume", // client may resume from a cursor
  CANCEL: "request.cancel",
});

/** Methods allowed by the protocol. Anything else is ERR.UNKNOWN_METHOD. */
export const METHODS = Object.freeze([
  "workspace.describe",
  "project.list",
  "project.tasks",
  "task.get",
  "project.specs",
  "project.relations",
  "runtime.snapshot",
  "runtime.subscribe",
  "runtime.unsubscribe",
  "knowledge.list",
  "knowledge.get",
  "knowledge.search",
  "artifact.list",
  "artifact.receipt",
  "artifact.read",
  "artifact.chunk", // read large artifacts by offset/length + digest
  "terminal.snapshot",
  "request.cancel",
]);

/**
 * Client -> server handshake message.
 * @param {{clientId: string, protocolVersion?: number, capabilities?: string[], workspaces?: Array<{ref: object}>}} p
 */
export function helloClient(p) {
  if (!p?.clientId) throw err(ERR.BAD_MESSAGE, "clientId required");
  return {
    v: PROTOCOL_VERSION,
    type: "hello",
    clientId: String(p.clientId),
    capabilities: sanitizeCaps(p.capabilities),
    workspaces: Array.isArray(p.workspaces) ? p.workspaces : [],
  };
}

/**
 * Server -> client handshake reply (accepts or refuses).
 * @param {{serverId: string, accepted: boolean, protocolVersion?: number,
 *           capabilities?: string[], reason?: string}} p
 */
export function helloServer(p) {
  if (!p?.serverId) throw err(ERR.BAD_MESSAGE, "serverId required");
  const out = {
    v: PROTOCOL_VERSION,
    type: "hello_ok",
    serverId: String(p.serverId),
    accepted: !!p.accepted,
    capabilities: sanitizeCaps(p.capabilities),
  };
  if (!out.accepted) {
    out.error = err(p.reason === ERR.PROTOCOL_VERSION ? ERR.PROTOCOL_VERSION : ERR.PROTOCOL_VERSION,
      p.reason ?? "refused");
  }
  return out;
}

/**
 * Capability negotiation for a connection.
 * @param {string[]} serverCaps @param {string[]} clientCaps
 * @returns {{shared: string[], clientMissing: string[], serverMissing: string[]}}
 */
export function negotiate(serverCaps, clientCaps) {
  const s = new Set(sanitizeCaps(serverCaps));
  const c = new Set(sanitizeCaps(clientCaps));
  const shared = [...s].filter((x) => c.has(x)).sort();
  return {
    shared,
    clientMissing: [...s].filter((x) => !c.has(x)).sort(),
    serverMissing: [...c].filter((x) => !s.has(x)).sort(),
  };
}

/**
 * Decide whether a peer is compatible: base protocol major must match exactly.
 * Minor/feature drift is expressed through capabilities, not version ranges.
 * @param {{v: number}} peerHello
 * @returns {{compatible: boolean, reason?: string}}
 */
export function checkVersion(peerHello) {
  const v = peerHello?.v;
  if (!Number.isInteger(v)) return { compatible: false, reason: "missing protocol version" };
  if (v !== PROTOCOL_VERSION) {
    return { compatible: false, reason: `peer protocol v${v} != v${PROTOCOL_VERSION}` };
  }
  return { compatible: true };
}

/** @param {{id: string, method: string, params?: object}} p */
export function request(p) {
  if (!p?.id) throw protocolError(ERR.BAD_MESSAGE, "request id required");
  if (!p.method) throw protocolError(ERR.BAD_MESSAGE, "request method required");
  if (!METHODS.includes(p.method)) throw protocolError(ERR.UNKNOWN_METHOD, p.method);
  return { type: "request", id: String(p.id), method: p.method, params: p.params ?? {} };
}

/** @param {{id: string, ok: boolean, result?: object, error?: {code: string, message: string}}} p */
export function response(p) {
  if (!p?.id) throw protocolError(ERR.BAD_MESSAGE, "response id required");
  const out = { type: "response", id: String(p.id), ok: !!p.ok };
  if (out.ok) out.result = p.result ?? {};
  else out.error = p.error ?? err(ERR.INTERNAL, "unspecified error");
  return out;
}

/** Server-pushed event (runtime activity, artifact changes). */
export function event(p) {
  if (!p?.channel) throw protocolError(ERR.BAD_MESSAGE, "event channel required");
  if (!Number.isInteger(p.seq) || p.seq < 0) throw protocolError(ERR.BAD_MESSAGE, "event seq must be a non-negative integer");
  if (!Number.isInteger(p.epoch) || p.epoch < 0) throw protocolError(ERR.BAD_MESSAGE, "event epoch must be a non-negative integer");
  return {
    type: "event",
    channel: String(p.channel),
    epoch: p.epoch,
    seq: p.seq,
    at: typeof p.at === "string" ? p.at : new Date(0).toISOString(),
    payload: p.payload ?? {},
  };
}

/**
 * Snapshot marker — binds a snapshot to an epoch; subsequent events on the same
 * channel share that epoch until the server bumps it (full resync required).
 * @param {{channel: string, epoch: number, cursor: number}} p
 */
export function snapshotMeta(p) {
  if (!p?.channel) throw protocolError(ERR.BAD_MESSAGE, "snapshot channel required");
  return { type: "snapshot", channel: String(p.channel), epoch: p.epoch, cursor: p.cursor };
}

/**
 * Encode one message as an NDJSON frame. Throws protocol error when the
 * encoded frame exceeds MAX_FRAME_BYTES (large payloads must use chunking).
 * @param {object} msg @returns {string} frame including trailing newline
 */
export function encodeFrame(msg) {
  let line;
  try {
    line = JSON.stringify(msg);
  } catch (e) {
    throw protocolError(ERR.BAD_MESSAGE, `unserializable message: ${e.message}`);
  }
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw protocolError(ERR.BAD_MESSAGE, `frame ${bytes}B > MAX_FRAME_BYTES ${MAX_FRAME_BYTES}B (use artifact.chunk)`);
  }
  return line + "\n";
}

/**
 * Decode a buffer of NDJSON bytes into complete messages.
 * Tolerates partial trailing input (kept in `rest`); blank lines are skipped.
 * Oversized lines raise a protocol error (do not swallow unbounded output —
 * contract §8.2).
 * @param {string|Buffer} chunk @param {{rest?: string}} state
 * @returns {object[]} decoded messages
 */
export function decodeFrames(chunk, state = {}) {
  const text = state.rest ? state.rest + String(chunk) : String(chunk);
  const lines = text.split("\n");
  state.rest = lines.pop() ?? "";
  if (Buffer.byteLength(state.rest, "utf8") > MAX_FRAME_BYTES) {
    throw protocolError(ERR.BAD_MESSAGE, `pending frame exceeds MAX_FRAME_BYTES (${state.rest.length} chars)`);
  }
  /** @type {object[]} */
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      throw protocolError(ERR.BAD_MESSAGE, `invalid JSON frame (${t.length} chars)`);
    }
  }
  return out;
}

/** Structured protocol error object (wire-safe plain object). */
export function err(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * Throwable protocol error: a real Error instance carrying a stable `code`,
 * so transport layers can branch on code while stack traces are preserved.
 * (Wire payloads must use err() — Error instances do not serialize.)
 * @param {string} code @param {string} message @returns {Error & {code: string}}
 */
export function protocolError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Event resume check: given a client cursor and a server event, decide whether
 * the client must resync (epoch changed or gap detected). Duplicate/reordered
 * delivery (seq <= cursor, same epoch) is reported as duplicate, not a gap.
 * @param {{channel: string, epoch: number, seq: number}} ev
 * @param {{epoch: number, cursor: number}|null} clientState null = fresh subscribe
 * @returns {"apply"|"duplicate"|"resync"}
 */
export function resumeDecision(ev, clientState) {
  if (!clientState || clientState.epoch !== ev.epoch) return "resync";
  if (ev.seq <= clientState.cursor) return "duplicate";
  if (ev.seq > clientState.cursor + 1) return "resync"; // gap: lost window
  return "apply";
}

/** @param {string[]|undefined} caps */
function sanitizeCaps(caps) {
  if (!Array.isArray(caps)) return [];
  const known = new Set(Object.values(CAPABILITIES));
  return [...new Set(caps.filter((c) => typeof c === "string" && known.has(c)))].sort();
}
