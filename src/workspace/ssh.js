// @ts-check
// SSH stdio transport — spawns the system ssh client and speaks the workspace
// bridge protocol over its stdin/stdout (contract §8.1–§8.2).
//
// Security rules (contract §8.1):
// - Only the host alias and a FIXED remote entry may be argv items; the
//   entry is either the MAWF-owned fixed command or a strictly-validated
//   install-record helper path (stabilization §12.2). Workspace paths,
//   queries and every other business
//   parameter travel through stdin as protocol frames — they are NEVER
//   interpolated into the command line.
// - The user's ~/.ssh/config, known_hosts, agent and existing ControlMaster
//   sockets are consumed as-is. We never write to ~/.ssh/config, never bypass
//   host-key verification, and never create or clean shared control sockets.
// - close() kills only the child process this transport spawned — never user
//   sessions, never tmux panes, never externally-owned ssh processes.
//
// Channel discipline (contract §8.2): stdout is protocol-only; stderr is log
// lines (emitted as bounded 'log' events). Pre-hello banner noise is tolerated
// up to a bounded byte budget, never swallowed unboundedly. Auth failures,
// host-key refusals, connect timeouts and exit-127 are distinguishable
// (classifySshFailure); timeouts carry the protocol's structured codes.
//
// Zero runtime dependencies (Node built-ins only).

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { readInstallRecord } from "./install-record.js";
import {
  CAPABILITIES,
  DEFAULT_TIMEOUT_MS,
  ERR,
  decodeFrames,
  encodeFrame,
  err,
  helloClient,
  negotiate,
  protocolError,
  request,
} from "./protocol.js";

/** Default byte budget for non-protocol stdout before the protocol hello. */
export const MAX_PRE_HELLO_BYTES = 8 * 1024;
/** Default wait for a valid protocol hello (contract §8.2: bounded, not infinite). */
export const HELLO_TIMEOUT_MS = 10_000;
/** Frames buffered for delivery before stdout is paused (backpressure, §8.5). */
export const MAX_QUEUE_FRAMES = 64;
/** Queue length at which a paused stdout is resumed again. */
const RESUME_WATERMARK = 32;
/** stderr tail kept for failure classification. */
const STDERR_TAIL_LINES = 400;
/** Upper bound of 'log' events emitted per connection. */
const MAX_LOG_EVENTS = 1000;
/** Grace period between SIGTERM and SIGKILL on close(). */
const KILL_GRACE_MS = 2000;

/** Stable failure kinds for ssh-session teardown (orthogonal to ERR codes). */
export const SSH_FAILURE = Object.freeze({
  AUTH: "auth_failed",
  HOST_KEY: "host_key_refused",
  CONNECT_TIMEOUT: "connect_timeout",
  REMOTE_NOT_FOUND: "remote_command_not_found",
  CLOSED: "closed",
});

/**
 * Build the argv for the system ssh client. Strict contract:
 * options + host alias + "--" + the fixed remote command token. Workspace
 * paths/queries never appear here (they travel via stdin frames).
 *
 * The remote entry is either the MAWF-owned FIXED_REMOTE_COMMAND or a
 * helper path validated by validateRemoteCommand (charset gate; §12.2).
 *
 * @param {{host: string, remoteCommand: string, batchMode?: boolean,
 *           connectTimeoutMs?: number}} p
 * @returns {string[]} argv items to pass after the ssh binary
 */

/**
 * Fixed remote entry used when no explicit helper path is installed:
 * `mawf bridge serve` resolved on the remote PATH by the remote login shell.
 * This string is owned by MAWF - it is never built from user, workspace or
 * project input (stabilization section 12.2). Dynamic parameters travel via
 * the stdin protocol, never through the command line.
 */
export const FIXED_REMOTE_COMMAND = "mawf bridge serve";

/**
 * Strict validation for the remote entry. Allowed forms:
 *  1. the exact FIXED_REMOTE_COMMAND (spaces are part of the owned string), or
 *  2. an absolute helper path from MAWF's own install record matching a
 *     restrictive charset - no shell metacharacters survive: only
 *     [A-Za-z0-9._/-], no spaces, quotes, $, backticks, ;|&()<>*?~!#,
 *     no '..' segments, no CR/LF/NUL, no leading '-' (option injection).
 * Callers must not pass arbitrary strings; helper paths come exclusively from
 * the remote helper installation record written by `mawf bridge install-helper`.
 * @param {string} cmd
 * @returns {string} the validated command (unchanged)
 */
export function validateRemoteCommand(cmd) {
  if (cmd === FIXED_REMOTE_COMMAND) return cmd;
  if (typeof cmd !== "string" || cmd.length === 0) {
    throw new Error("remote command is required (fixed entry or install-record helper path)");
  }
  if (!cmd.startsWith("/")) {
    throw new Error(`remote helper path must be absolute: ${JSON.stringify(cmd)}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(cmd)) {
    throw new Error(`remote helper path contains characters outside the safe set [A-Za-z0-9._/-]: ${JSON.stringify(cmd)}`);
  }
  const segments = cmd.split("/").slice(1);
  if (segments.some((s) => s === ".." || s === "")) {
    throw new Error(`remote helper path must not contain '..' or empty segments: ${JSON.stringify(cmd)}`);
  }
  return cmd;
}
export function buildSshArgs({ host, remoteCommand, batchMode = true, connectTimeoutMs = 10000 }) {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("ssh host (alias or hostname) is required");
  }
  if (/[\s\0]/.test(host)) {
    throw new Error("ssh host must not contain whitespace or NUL bytes");
  }
  if (host.startsWith("-")) {
    throw new Error("ssh host must not start with '-' (argv safety)");
  }
  if (typeof remoteCommand !== "string" || remoteCommand.length === 0) {
    throw new Error("remoteCommand (fixed helper entry) is required");
  }
  validateRemoteCommand(remoteCommand); // shell-metacharacter gate (stabilization 12.2)
  let ms = Number(connectTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = 10000;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  /** @type {string[]} */
  const args = [];
  if (batchMode) args.push("-o", "BatchMode=yes");
  args.push("-o", `ConnectTimeout=${seconds}`);
  // Machine channel: never allocate a TTY even if the user config asks for one.
  args.push("-o", "RequestTTY=no");
  // "--" ends option parsing: the host alias is never read as an option, and
  // the fixed remote command follows it (ssh joins argv items with spaces).
  args.push("--", host, remoteCommand);
  return args;
}

/**
 * Classify why an ssh session ended, before the protocol hello completed.
 * Pure function — unit-testable without any process (contract §8.2: auth
 * failure, host-key refusal, timeout and exit-127 must be distinguishable).
 *
 * `code` is the protocol's structured ERR code where one applies; `kind` is
 * always present and distinguishes cases that share a code.
 *
 * @param {{exitCode?: number|null, signal?: string|null, stderr?: string}} [p]
 * @returns {{kind: string, code?: string, message: string}}
 */
export function classifySshFailure({ exitCode = null, signal = null, stderr = "" } = {}) {
  const text = String(stderr ?? "");
  // Host-key refusal is checked before auth: some setups print both.
  if (/HOST[ _-]?KEY/i.test(text) && /VERIFICATION FAILED/i.test(text)) {
    return {
      kind: SSH_FAILURE.HOST_KEY,
      code: ERR.WORKSPACE_UNAUTHORIZED,
      message:
        "host key verification failed — connection refused (host-key checks are never bypassed; verify known_hosts or the host alias)",
    };
  }
  if (/permission denied/i.test(text) || /authenticat/i.test(text)) {
    return {
      kind: SSH_FAILURE.AUTH,
      code: ERR.WORKSPACE_UNAUTHORIZED,
      message:
        "ssh authentication failed — check the host alias, ssh-agent/keys; BatchMode never prompts for passwords",
    };
  }
  if (/connection timed out|operation timed out|connection refused/i.test(text)) {
    return {
      kind: SSH_FAILURE.CONNECT_TIMEOUT,
      code: ERR.TIMEOUT,
      message: "ssh connection failed or timed out before the protocol started",
    };
  }
  if (exitCode === 127) {
    return {
      kind: SSH_FAILURE.REMOTE_NOT_FOUND,
      code: ERR.CAPABILITY_MISSING,
      message:
        "remote command not found (exit 127) — is the headless helper installed? run: mawf bridge install-helper",
    };
  }
  return {
    kind: SSH_FAILURE.CLOSED,
    message: `ssh session closed before protocol hello (exit=${exitCode}, signal=${signal})`,
  };
}

/**
 * Spawn-based SSH stdio transport.
 *
 * Events: 'ready' (handshake done), 'message' (every decoded protocol
 * message), 'event' / 'snapshot' (typed aliases), 'log' (stderr lines,
 * capped), 'warning' (protocol anomalies that are not fatal), 'error'
 * (fatal transport error), 'close'.
 */
export class SshTransport extends EventEmitter {
  /**
   * @param {{sshPath?: string,
   *           argvBuilder?: (p: {host: string, remoteCommand: string,
   *                              batchMode: boolean, connectTimeoutMs: number}) => string[],
   *           spawnFn?: typeof nodeSpawn,
   *           clientId?: string,
   *           capabilities?: string[],
   *           batchMode?: boolean,
   *           connectTimeoutMs?: number,
   *           helloTimeoutMs?: number,
   *           maxPreHelloBytes?: number,
   *           requestTimeoutMs?: number,
   *           killGraceMs?: number,
   *           installRecordDir?: string|null}} [opts]
   *   `argvBuilder` and `spawnFn` are injection seams for tests: tests spawn a
   *   fixture helper via process.execPath directly (no ssh binary, no network)
   *   while exercising this exact code path.
   */
  constructor(opts = {}) {
    super();
    this._sshPath = opts.sshPath ?? "ssh";
    this._argvBuilder = opts.argvBuilder ?? buildSshArgs;
    this._spawnFn = opts.spawnFn ?? nodeSpawn;
    this._clientId = opts.clientId ?? `mawf-ssh-${process.pid}-${Date.now() % 100000}`;
    this._clientCaps = opts.capabilities ?? Object.values(CAPABILITIES);
    this._batchMode = opts.batchMode ?? true;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    this._helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this._maxPreHelloBytes = opts.maxPreHelloBytes ?? MAX_PRE_HELLO_BYTES;
    this._requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    // Install-record dir override (tests). Null = the real
    // <home>/.mawf/bridge/hosts written by `mawf bridge install-helper`.
    this._installRecordDir = opts.installRecordDir ?? null;

    /** @type {import("node:child_process").ChildProcess|null} the ONLY process we own */
    this.child = null;
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any, method: string}>} */
    this._pending = new Map();
    /** @type {Set<string>} fire-and-forget request ids (cancellations). */
    this._fireForget = new Set();
    this._reqSeq = 0;

    this._decodeState = { rest: "" };
    this._preHello = "";
    this._noiseBytes = 0;
    /** @type {object[]} decoded frames awaiting delivery */
    this._queue = [];
    this._pumpScheduled = false;
    this._outPaused = false;

    this._stderrPending = "";
    /** @type {string[]} */
    this._stderrLines = [];
    this._logEmitted = 0;
    /** @type {any} */
    this._helloTimer = null;
    /** @type {any} */
    this._killTimer = null;
    /** @type {((v: any) => void)|null} */
    this._connectResolve = null;
    /** @type {((e: Error) => void)|null} */
    this._connectReject = null;
  }

  /**
   * Spawn ssh (or the injected test process), send the client hello and wait
   * for the server's hello_ok within the hello timeout.
   *
   * @param {object} workspaceRef a ssh WorkspaceRef (endpoint.kind === "ssh")
   * @param {{helperPath?: string, installRecordDir?: string}} [opts] without
   *        an explicit helperPath, the install record for the endpoint host
   *        (written by `mawf bridge install-helper`) is consulted, falling
   *        back to FIXED_REMOTE_COMMAND; installRecordDir overrides the
   *        record dir (tests). helperPath remains the ONLY user-controlled
   *        part of the remote command line.
   * @returns {Promise<{serverId: string, capabilities: string[],
   *                    negotiated: {shared: string[], clientMissing: string[], serverMissing: string[]}}>}
   */
  connect(workspaceRef, opts = {}) {
    if (this._closed) {
      return Promise.reject(protocolError(ERR.INTERNAL, "transport closed"));
    }
    if (this.child) {
      return Promise.reject(protocolError(ERR.CONFLICT, "transport is already connected or connecting"));
    }
    const endpoint = workspaceRef?.endpoint;
    if (!endpoint || endpoint.kind !== "ssh" || !endpoint.host || typeof endpoint.host !== "string") {
      return Promise.reject(
        protocolError(ERR.BAD_MESSAGE, "connect() requires a ssh WorkspaceRef with endpoint.host"),
      );
    }
    // Remote entry resolution (contract §8.2 PATH probe):
    // 1. explicit helperPath (only ever accepted from MAWF's own install
    //    record; passes the strict charset gate inside buildSshArgs), else
    // 2. the install record for this endpoint host, written read-only by
    //    `mawf bridge install-helper` — its mawfBin IS an absolute path from
    //    OUR record and still passes validateRemoteCommand, else
    // 3. the MAWF-owned FIXED_REMOTE_COMMAND.
    // A corrupt record never crashes connect(): it falls back to the fixed
    // entry with a log line.
    let helperPath = typeof opts.helperPath === "string" && opts.helperPath ? opts.helperPath : null;
    if (!helperPath) {
      const record = readInstallRecord(endpoint.host, {
        hostsDir: opts.installRecordDir ?? this._installRecordDir ?? undefined,
      });
      if (record && typeof record.mawfBin === "string" && record.mawfBin) {
        try {
          helperPath = validateRemoteCommand(String(record.mawfBin));
        } catch (e) {
          this.emit(
            "log",
            `install record for "${endpoint.host}" has an unusable mawfBin (${e?.message ?? e}) — falling back to the fixed remote entry`,
          );
        }
      }
    }
    const remoteCommand = helperPath ?? FIXED_REMOTE_COMMAND;
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      /** @type {string[]} */
      let argv;
      try {
        argv = this._argvBuilder({
          host: endpoint.host,
          remoteCommand,
          batchMode: this._batchMode,
          connectTimeoutMs: this._connectTimeoutMs,
        });
      } catch (e) {
        reject(e);
        return;
      }
      try {
        this.child = this._spawnFn(this._sshPath, argv, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        reject(protocolError(ERR.INTERNAL, `failed to start ssh: ${e?.message ?? e}`));
        return;
      }
      this.child.stdout?.on("data", (c) => this._onStdoutData(c));
      this.child.stderr?.on("data", (c) => this._onStderrData(c));
      this.child.on("error", (e) => this._fail(protocolError(ERR.INTERNAL, `ssh process error: ${e?.message ?? e}`)));
      this.child.on("close", (code, signal) => this._onChildClose(code, signal));
      this._helloTimer = setTimeout(() => {
        this._fail(
          protocolError(
            ERR.TIMEOUT,
            `no protocol hello within ${this._helloTimeoutMs}ms (banner noise, dead helper or wrong entry point?)`,
          ),
        );
      }, this._helloTimeoutMs);
      this._send(
        helloClient({
          clientId: this._clientId,
          capabilities: this._clientCaps,
          workspaces: [workspaceRef],
        }),
      );
    });
  }

  /**
   * Send a request and await its matched response (by id).
   * Unknown method names throw synchronously (protocol allowlist).
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<object>}
   */
  request(method, params = {}, opts = {}) {
    const id = `r${++this._reqSeq}`;
    // Validates the method allowlist client-side — throws ERR.UNKNOWN_METHOD.
    const frame = request({ id, method, params });
    if (!this._ready || this._closed) {
      return Promise.reject(
        protocolError(ERR.INTERNAL, `transport not connected (ready=${this._ready}, closed=${this._closed})`),
      );
    }
    return new Promise((resolve, reject) => {
      const limit = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : this._requestTimeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(protocolError(ERR.TIMEOUT, `${method} timed out after ${limit}ms`));
        this.cancel(id); // best-effort cancellation to the server
      }, limit);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this._write(encodeFrame(frame));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Cancel an in-flight request (protocol request.cancel).
   * @param {string} id @returns {boolean} whether a cancel frame was sent
   */
  cancel(id) {
    if (!this._ready || this._closed || !id) return false;
    const cid = `c${++this._reqSeq}`;
    try {
      this._write(encodeFrame(request({ id: cid, method: "request.cancel", params: { cancelId: id } })));
    } catch {
      return false;
    }
    this._fireForget.add(cid); // its response is consumed silently
    return true;
  }

  /**
   * Kill the child process THIS transport spawned (SIGTERM, then SIGKILL after
   * a grace period). Never touches user sessions or shared control sockets.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._helloTimer) clearTimeout(this._helloTimer);
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(protocolError(ERR.CANCELLED, `transport closed before ${p.method} completed`));
    }
    this._pending.clear();
    this._queue.length = 0;
    const child = this.child;
    if (child && typeof child.kill === "function") {
      // `== null` covers real children (null while alive) and fakes alike.
      const alive = child.exitCode == null && child.signalCode == null;
      if (alive) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        this._killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, this._killGraceMs);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  /** @param {object} msg */
  _send(msg) {
    this._write(encodeFrame(msg));
  }

  /** @param {string} frame */
  _write(frame) {
    if (this._closed || !this.child?.stdin) {
      throw protocolError(ERR.INTERNAL, "transport closed");
    }
    this.child.stdin.write(frame);
  }

  /** @param {Buffer|string} chunk */
  _onStdoutData(chunk) {
    if (this._closed || this._lastError) return;
    if (!this._ready) {
      this._onPreHello(String(chunk));
      return;
    }
    this._decodeChunk(String(chunk));
  }

  /**
   * Feed framed-protocol bytes through decodeFrames (streaming, shared rest
   * state across chunks).
   * @param {string} text
   */
  _decodeChunk(text) {
    try {
      const msgs = decodeFrames(text, this._decodeState);
      this._enqueue(msgs);
    } catch (e) {
      this._fail(protocolError(e?.code ?? ERR.BAD_MESSAGE, e?.message ?? "frame decode failed"));
    }
  }

  /**
   * Pre-hello phase: banner/login noise on stdout is tolerated line-by-line up
   * to a bounded byte budget (contract §8.2). The first valid JSON message
   * must be the server's hello_ok.
   * @param {string} chunk
   */
  _onPreHello(chunk) {
    this._preHello += chunk;
    while (!this._ready && !this._lastError && this._preHello.includes("\n")) {
      const idx = this._preHello.indexOf("\n");
      const line = this._preHello.slice(0, idx);
      this._preHello = this._preHello.slice(idx + 1);
      this._preHelloLine(line);
    }
    if (this._lastError) return;
    if (this._ready) {
      // The hello completed mid-chunk: anything still buffered — complete
      // lines and the partial tail — belongs to the framed protocol now.
      const rest = this._preHello;
      this._preHello = "";
      if (rest.length > 0) this._decodeChunk(rest);
      return;
    }
    // Unpaired trailing bytes count against the budget too (no unbounded buffer).
    if (Buffer.byteLength(this._preHello, "utf8") + this._noiseBytes > this._maxPreHelloBytes) {
      this._fail(
        protocolError(
          ERR.BAD_MESSAGE,
          `pre-hello stdout exceeded the ${this._maxPreHelloBytes}B banner budget — refusing to buffer unbounded non-protocol output`,
        ),
      );
    }
  }

  /** @param {string} line */
  _preHelloLine(line) {
    const t = line.trim();
    if (t === "") return;
    this._noiseBytes += Buffer.byteLength(line, "utf8") + 1;
    let msg = null;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") msg = parsed;
    } catch {
      /* banner noise, not JSON */
    }
    if (this._noiseBytes > this._maxPreHelloBytes) {
      this._fail(
        protocolError(ERR.BAD_MESSAGE, `pre-hello banner output exceeded the ${this._maxPreHelloBytes}B budget`),
      );
      return;
    }
    if (!msg) return; // banner noise within budget
    if (msg.type !== "hello_ok") {
      this._fail(protocolError(ERR.BAD_MESSAGE, `expected hello_ok, got type=${JSON.stringify(msg.type ?? null)}`));
      return;
    }
    this._noiseBytes = 0; // protocol channel starts clean
    this._handleHello(msg);
  }

  /** @param {object} msg */
  _handleHello(msg) {
    if (msg.accepted === false) {
      this._fail(
        protocolError(
          msg.error?.code ?? ERR.PROTOCOL_VERSION,
          msg.error?.message ?? "handshake refused by remote helper",
        ),
      );
      return;
    }
    this._ready = true;
    this.hello = msg;
    this.negotiated = negotiate(Array.isArray(msg.capabilities) ? msg.capabilities : [], this._clientCaps);
    // Carry any partial bytes trailing the hello line into the decode state.
    this._decodeState = { rest: this._preHello };
    this._preHello = "";
    if (this._helloTimer) clearTimeout(this._helloTimer);
    this._helloTimer = null;
    const info = {
      serverId: String(msg.serverId ?? ""),
      // Stable machine identity from the remote hello (stabilization §13):
      // canonical workspace keys must be derived from THIS, not the alias.
      machineId: typeof msg.machineId === "string" && msg.machineId ? msg.machineId : null,
      capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
      negotiated: this.negotiated,
    };
    const resolve = this._connectResolve;
    this._connectResolve = null;
    this._connectReject = null;
    resolve?.(info);
    this.emit("ready", info);
  }

  /**
   * Backpressure: decoded frames enter a bounded queue; when it reaches
   * MAX_QUEUE_FRAMES, child stdout is paused until the pump drains below the
   * resume watermark (contract §8.5: events and large artifacts must not
   * starve each other; the OS pipe applies pressure to the remote helper).
   * @param {object[]} msgs
   */
  _enqueue(msgs) {
    if (msgs.length === 0) return;
    this._queue.push(...msgs);
    if (this._queue.length >= MAX_QUEUE_FRAMES) this._pauseStdout();
    this._schedulePump();
  }

  _pauseStdout() {
    if (this._outPaused) return;
    this._outPaused = true;
    try {
      this.child?.stdout?.pause();
    } catch {
      /* stream gone */
    }
  }

  _resumeStdout() {
    if (!this._outPaused) return;
    if (this._queue.length > RESUME_WATERMARK) return;
    this._outPaused = false;
    try {
      this.child?.stdout?.resume();
    } catch {
      /* stream gone */
    }
  }

  _schedulePump() {
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    setImmediate(() => this._pump());
  }

  _pump() {
    this._pumpScheduled = false;
    if (this._closed) {
      this._queue.length = 0;
      return;
    }
    while (this._queue.length > 0) {
      const msg = this._queue.shift();
      this._dispatch(msg);
      this._resumeStdout();
    }
    this._resumeStdout();
  }

  /** @param {object} msg */
  _dispatch(msg) {
    this.emit("message", msg);
    if (msg?.type === "response") {
      const id = String(msg.id ?? "");
      if (this._fireForget.has(id)) {
        this._fireForget.delete(id);
        return;
      }
      const pending = this._pending.get(id);
      if (!pending) {
        // Unknown ids are ignored with a warning — never crash the transport.
        this.emit("warning", err(ERR.BAD_MESSAGE, `response for unknown request id ${JSON.stringify(id)}`));
        return;
      }
      this._pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result ?? {});
      else {
        pending.reject(
          protocolError(msg.error?.code ?? ERR.INTERNAL, msg.error?.message ?? "request failed"),
        );
      }
      return;
    }
    if (msg?.type === "event") {
      this.emit("event", msg);
      return;
    }
    if (msg?.type === "snapshot") {
      this.emit("snapshot", msg);
      return;
    }
    if (msg?.type === "hello_ok") return; // already handled in the pre-hello phase
    this.emit("warning", err(ERR.BAD_MESSAGE, `unexpected message type ${JSON.stringify(msg?.type ?? null)}`));
  }

  /** @param {Buffer|string} chunk */
  _onStderrData(chunk) {
    this._stderrPending += String(chunk);
    if (this._stderrPending.length > 4096) {
      // Pathological single line — flush it rather than buffer unboundedly.
      this._logLine(this._stderrPending);
      this._stderrPending = "";
    }
    let idx;
    while ((idx = this._stderrPending.indexOf("\n")) >= 0) {
      const line = this._stderrPending.slice(0, idx);
      this._stderrPending = this._stderrPending.slice(idx + 1);
      this._logLine(line);
    }
  }

  /** @param {string} line */
  _logLine(line) {
    this._stderrLines.push(line);
    if (this._stderrLines.length > STDERR_TAIL_LINES) this._stderrLines.shift();
    if (this._logEmitted < MAX_LOG_EVENTS) {
      this._logEmitted += 1;
      this.emit("log", line);
    }
  }

  _stderrText() {
    return this._stderrLines.join("\n");
  }

  /**
   * Fatal transport failure: record, notify (connect promise first, then
   * 'error' for post-handshake failures), and tear the child down.
   * @param {Error & {code?: string}} e
   */
  _fail(e) {
    if (this._lastError) return;
    this._lastError = e;
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    if (reject) reject(e);
    else if (this.listenerCount("error") > 0) this.emit("error", e);
    this.close();
  }

  /**
   * @param {number|null} code
   * @param {string|null} signal
   */
  _onChildClose(code, signal) {
    if (this._killTimer) clearTimeout(this._killTimer);
    this._killTimer = null;
    if (this._helloTimer) clearTimeout(this._helloTimer);
    this._helloTimer = null;
    const connectReject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(protocolError(ERR.INTERNAL, `connection closed while ${p.method} was in flight`));
    }
    this._pending.clear();
    this._queue.length = 0;
    this._ready = false;
    this._closed = true; // the spawned child is gone; this transport is done
    if (connectReject && !this._lastError) {
      const c = classifySshFailure({ exitCode: code, signal, stderr: this._stderrText() });
      const e = protocolError(c.code ?? ERR.INTERNAL, c.message);
      // Transport-level kind is layered on the protocol error for callers that
      // need to distinguish cases sharing a code (auth vs host key).
      /** @ts-ignore */
      e.kind = c.kind;
      connectReject(e);
    }
    this.emit("close", { code, signal });
  }
}
