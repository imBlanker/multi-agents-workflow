// @ts-check
// `mawf companion serve` — loopback HTTP companion (P5.1, task
// 09-17-mawf-four-tool-integration).
//
//   mawf companion serve [--project <dir>] [--port <n>] [--open]
//
// Serves the vendored Notes Board (vendor/notes-board/board.html) and exposes
// the SAME typed workspace providers used by `mawf bridge serve` over a
// token-authed POST /rpc endpoint. The board is never modified on disk: the
// `window.__INLINE_DATA__ = null;` slot is replaced IN MEMORY at serve time
// with a `<!-- mawf:companion-bootstrap -->` block, so the vendored file stays
// byte-identical and upgrade-safe re-injection is always possible.
//
// AUTH MODEL (token must never leak via URLs/logs/history):
// - A per-session token is generated at startup (crypto.randomBytes) and
//   printed to STDERR ONLY — stdout stays protocol-only-silent.
// - The printed entry URL carries the token in the FRAGMENT
//   (http://127.0.0.1:<port>/#token=...). Fragments are never sent to the
//   server, so the token cannot appear in server logs.
// - First load of `/` without credentials returns a tiny bootstrap page that
//   moves the token from the fragment (or ?token= query, for convenience)
//   into sessionStorage via history.replaceState (URL stripped client-side),
//   then redirects to /board. The board HTML itself NEVER contains the token.
// - Every /rpc and asset request (e.g. /workspace-datasource.js) requires the
//   `Authorization: Bearer <token>` OR `X-Mawf-Token` header; anything else
//   gets 401. The board's injected bootstrap sends the header from
//   sessionStorage; script tags cannot carry headers, so the data-source
//   script is fetch()ed and evaluated (same-origin, our own code).
// - The app shell (/board, the / bootstrap page) is served unauthenticated:
//   it is vendored/static content with zero secrets — all DATA flows through
//   the token-gated /rpc.
//
// ORIGIN/HOST VALIDATION (contract §9.1/§12.2, DNS-rebinding defense):
// - Bound to 127.0.0.1 ONLY. The Host header must be exactly
//   `127.0.0.1:<port>` or `localhost:<port>`; any other Host → 403.
// - When an Origin header is present it must match the same two origins,
//   otherwise 403. Absent Origin (curl, Node fetch, plain GETs) is allowed.
//
// RPC ROUTING: requests are dispatched through a real BridgeServer instance
// (hello handshaked internally at startup) built on the SAME createProviders()
// used by `mawf bridge serve` — so the method allowlist, capability gating,
// provider containment checks and structured error semantics are identical to
// the stdio bridge. Responses are protocol response frames
// {type:"response", id, ok, result|error} delivered with HTTP 200; HTTP
// status codes describe transport-level facts only (401/403/404/405/413).
// Runtime event channels (runtime.subscribe/SSE) are intentionally absent in
// P5.1 — plain request/response only (Card transport/SSE deferred).
//
// Zero runtime dependencies (Node built-ins only).

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BridgeServer } from "../workspace/bridge.js";
import { CAPABILITIES, PROTOCOL_VERSION, ERR, err } from "../workspace/protocol.js";
import { createProviders } from "../workspace/providers.js";
import { readOrCreateMachineId } from "../workspace/cli.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { expand } from "../util.js";

/** Vendored board + MAWF data-source script (read-only at rest). */
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "notes-board");
const BOARD_PATH = path.join(VENDOR_DIR, "board.html");
const DATASOURCE_PATH = path.join(VENDOR_DIR, "workspace-datasource.js");

/** Exact injection anchor in the vendored board (README: adaptation contract). */
const INLINE_DATA_SLOT = "window.__INLINE_DATA__ = null;";
/** Marker comments around the injected block (upgrade-safe re-injection). */
export const BOOTSTRAP_MARKER = "mawf:companion-bootstrap";

/** sessionStorage keys shared with the injected bootstrap + data source. */
const TOKEN_KEY = "mawf.companion.token";
const NOTES_KEY = "mawf.companion.notes";

/** POST /rpc body cap (requests are small; artifacts flow outward, not in). */
const MAX_RPC_BODY_BYTES = 1024 * 1024;

/**
 * The client-side bootstrap injected in place of the inline-data slot. Static
 * source — the token is NEVER interpolated here; it travels fragment →
 * sessionStorage → request headers only.
 * @param {string} tokenKey @param {string} notesKey @returns {string}
 */
function bootstrapBlock(tokenKey, notesKey) {
  return `<!-- ${BOOTSTRAP_MARKER} (MAWF companion, injected at serve time — the vendored board.html on disk stays byte-identical) -->
<script id="embedded-data">
window.__INLINE_DATA__ = null;
</script>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = ${JSON.stringify(tokenKey)};
  var NOTES_KEY = ${JSON.stringify(notesKey)};
  // 1) fragment/query token -> sessionStorage, then strip it from the URL.
  //    The fragment never reaches the server; replaceState keeps it out of
  //    the visible URL without a reload.
  var m = (location.hash || '').match(/[#&]token=([^&]+)/) || (location.search || '').match(/[?&]token=([^&]+)/);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1])); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  var token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
  // 2) cached dataset hydrates __INLINE_DATA__ synchronously so the board's
  //    own DOMContentLoaded init renders immediately (board reads it non-null).
  try {
    var cached = sessionStorage.getItem(NOTES_KEY);
    if (cached && window.__INLINE_DATA__ === null) {
      var data = JSON.parse(cached);
      if (Array.isArray(data)) window.__INLINE_DATA__ = data;
    }
  } catch (e) {}
  // 3) load the MAWF workspace data source — the token travels in a HEADER,
  //    never in a URL; <script src> cannot carry headers, so fetch + eval.
  if (!token) return; // shell shows its own empty state; nothing to fetch
  fetch('/workspace-datasource.js', { credentials: 'omit', headers: { 'X-Mawf-Token': token } })
    .then(function (r) { if (!r.ok) throw new Error('data source HTTP ' + r.status); return r.text(); })
    .then(function (src) { (new Function(src + '\\n//# sourceURL=mawf/workspace-datasource.js'))(); })
    .catch(function (e) { console.error('[mawf] companion data source failed:', e); });
})();
</script>
<!-- /${BOOTSTRAP_MARKER} -->
`;
}

/**
 * First-load token bootstrap page (no secrets; moves fragment/query token to
 * sessionStorage and redirects to the board path).
 * @param {string} tokenKey @returns {string}
 */
function tokenBootstrapPage(tokenKey) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MAWF Companion</title></head>
<body style="font-family:monospace;max-width:40em;margin:4em auto;color:#334155">
<p id="mawf-msg">Opening the Notes Board&hellip;</p>
<!-- mawf:companion-token-bootstrap -->
<script>
(function () {
  'use strict';
  var m = (location.hash || '').match(/[#&]token=([^&]+)/) || (location.search || '').match(/[?&]token=([^&]+)/);
  if (m) {
    try { sessionStorage.setItem(${JSON.stringify(tokenKey)}, decodeURIComponent(m[1])); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    location.replace('/board');
    return;
  }
  document.getElementById('mawf-msg').textContent =
    'No token in URL. Open the mawf companion URL printed by the server (the #token=... link).';
})();
</script>
</body>
</html>
`;
}

/**
 * Replace the board's inline-data slot with the companion bootstrap block.
 * @param {string} raw @returns {string}
 */
function injectCompanionBootstrap(raw) {
  const at = raw.indexOf(INLINE_DATA_SLOT);
  if (at < 0) {
    throw new Error(`vendored board.html does not contain the expected injection anchor ${JSON.stringify(INLINE_DATA_SLOT)}; refusing to serve a mangled board`);
  }
  return raw.slice(0, at) + bootstrapBlock(TOKEN_KEY, NOTES_KEY) + raw.slice(at + INLINE_DATA_SLOT.length);
}

/**
 * Host header must name THIS loopback server (DNS-rebinding defense,
 * contract §9.1/§12.2).
 * @param {unknown} host @param {number} port @returns {boolean}
 */
function hostAllowed(host, port) {
  if (typeof host !== "string" || host.length === 0) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * Origin, when the client sends one, must be one of the two loopback origins.
 * @param {unknown} origin @param {number} port @returns {boolean}
 */
function originAllowed(origin, port) {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  const o = origin.trim().toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

/**
 * Capability set for the companion /rpc endpoint: the read-only bridge
 * surface WITHOUT runtime event channels (no push transport in P5.1).
 * @returns {string[]}
 */
function companionCapabilities() {
  return [
    CAPABILITIES.PROJECT_READ,
    CAPABILITIES.KNOWLEDGE_READ,
    CAPABILITIES.ARTIFACT_READ,
    CAPABILITIES.CHUNKED_ARTIFACTS,
    CAPABILITIES.TERMINAL_META,
  ];
}

/** @param {http.ServerResponse} res @returns {void} */
function noStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** @param {http.ServerResponse} res @param {number} status @param {string} text */
function sendText(res, status, text) {
  noStoreHeaders(res);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} obj */
function sendJson(res, status, obj) {
  noStoreHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/** @param {http.ServerResponse} res @param {number} status @param {string} html */
function sendHtml(res, status, html) {
  noStoreHeaders(res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** @param {http.ServerResponse} res @param {number} status @param {string} src */
function sendJs(res, status, src) {
  noStoreHeaders(res);
  res.writeHead(status, { "Content-Type": "text/javascript; charset=utf-8" });
  res.end(src);
}

/**
 * Read the request body with a hard cap; rejects {statusCode:413} when over.
 * @param {http.IncomingMessage} req @param {number} cap @returns {Promise<string>}
 */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > cap) {
        const e = new Error(`rpc body exceeds ${cap} bytes`);
        /** @type {any} */ (e).statusCode = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Open the URL in the OS default browser; fail-open (stderr note only).
 * @param {string} url
 */
function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => process.stderr.write(`mawf companion: could not open a browser (${cmd}); open ${url} manually\n`));
    child.unref();
  } catch {
    process.stderr.write(`mawf companion: could not open a browser; open ${url} manually\n`);
  }
}

/**
 * `mawf companion serve` — loopback Notes Board + token-authed workspace RPC.
 * @param {string[]} f args after "companion" (must start with "serve")
 * @param {Record<string, string|boolean>} flags parsed CLI flags
 * @returns {Promise<number>} resolves after SIGINT/SIGTERM (0) or startup error (1/2)
 */
export async function runCompanionServe(f, flags) {
  // bin/mawf.js discards resolved promise values (numeric codes only work for
  // sync handlers), so nonzero exits must ALSO set process.exitCode here.
  const fail = (/** @type {number} */ code) => {
    if (code !== 0) process.exitCode = code;
    return code;
  };
  if (f[0] !== "serve") {
    process.stderr.write(`mawf companion: unknown subcommand ${JSON.stringify(f[0] ?? "")} (expected: serve)\n`);
    return fail(2);
  }
  const projectDir = expand(typeof flags.project === "string" && flags.project.trim() !== "" ? flags.project : process.cwd());
  const portRaw = flags.port === true || flags.port === undefined ? 0 : Number(flags.port);
  if (!Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    process.stderr.write(`mawf companion: --port must be an integer 0-65535 (0 = ephemeral), got ${JSON.stringify(flags.port)}\n`);
    return fail(2);
  }

  // Assets are loaded once; a missing/mangled vendored board is a startup
  // error, never a mid-request surprise.
  const boardHtml = injectCompanionBootstrap(fs.readFileSync(BOARD_PATH, "utf8"));
  const datasourceSrc = fs.readFileSync(DATASOURCE_PATH, "utf8");
  const bootstrapPage = tokenBootstrapPage(TOKEN_KEY);

  const token = crypto.randomBytes(32).toString("base64url");
  // sha256 both sides so timingSafeEqual gets equal-length buffers (no length leak).
  const expectedTokenHash = crypto.createHash("sha256").update(token).digest();

  const store = KnowledgeStore.open(projectDir);
  const machineId = readOrCreateMachineId();
  const providers = createProviders({ projectDir, store, machineId });
  const bridgeServer = new BridgeServer({
    serverId: "mawf-companion",
    machineId,
    capabilities: companionCapabilities(),
    providers,
  });
  // Internal handshake up front: /rpc requests then flow through the SAME
  // routing/allowlist/capability/error path as the stdio bridge.
  await bridgeServer.handleLine(JSON.stringify({
    type: "hello",
    v: PROTOCOL_VERSION,
    clientId: "mawf-companion-internal",
    capabilities: Object.values(CAPABILITIES),
  }));

  /** @type {number} actual bound port (set after listen) */
  let boundPort = portRaw;

  /**
   * Constant-time token check: X-Mawf-Token header or Authorization: Bearer.
   * @param {http.IncomingMessage} req @returns {boolean}
   */
  function tokenOk(req) {
    let given;
    const direct = req.headers["x-mawf-token"];
    if (typeof direct === "string" && direct.length > 0) given = direct;
    const auth = req.headers.authorization;
    if (given === undefined && typeof auth === "string") {
      const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
      if (m) given = m[1];
    }
    if (typeof given !== "string" || given.length === 0) return false;
    const actual = crypto.createHash("sha256").update(given).digest();
    return crypto.timingSafeEqual(expectedTokenHash, actual);
  }

  /**
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    try {
      if (!hostAllowed(req.headers.host, boundPort)) {
        sendText(res, 403, "forbidden: Host header must be 127.0.0.1:<port> or localhost:<port>\n");
        return;
      }
      if (!originAllowed(req.headers.origin, boundPort)) {
        sendText(res, 403, "forbidden: Origin is not the loopback companion origin\n");
        return;
      }
      const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`).pathname;
      const isGet = req.method === "GET" || req.method === "HEAD";

      if (pathname === "/healthz") {
        if (!isGet) {
          res.setHeader("Allow", "GET, HEAD");
          sendText(res, 405, "method not allowed\n");
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/rpc") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          sendText(res, 405, "method not allowed: /rpc speaks POST only\n");
          return;
        }
        if (!tokenOk(req)) {
          sendText(res, 401, "unauthorized: send the session token via Authorization: Bearer or X-Mawf-Token\n");
          return;
        }
        let body;
        try {
          body = await readBody(req, MAX_RPC_BODY_BYTES);
        } catch (e) {
          sendText(res, /** @type {any} */ (e)?.statusCode ?? 400, `${e instanceof Error ? e.message : "bad request"}\n`);
          return;
        }
        // The companion wire contract is {id, method, params}; a frame without
        // an explicit type defaults to a protocol request before it reaches
        // the bridge's routing (hello/cancel still flow through verbatim).
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          msg = undefined; // let handleLine produce its structured bad_message
        }
        if (msg && typeof msg === "object" && !Array.isArray(msg) && msg.type === undefined) {
          msg.type = "request";
        }
        let lines;
        try {
          lines = await bridgeServer.handleLine(msg === undefined ? body : JSON.stringify(msg));
        } catch (e) {
          // Only escape hatch: oversized provider result (encodeFrame throws
          // outside handleLine's per-frame guards). Keep the wire contract.
          sendJson(res, 200, {
            type: "response",
            id: "",
            ok: false,
            error: err(ERR.INTERNAL, e instanceof Error ? e.message : String(e)),
          });
          return;
        }
        // One request frame -> exactly one response frame; invalid JSON and
        // unknown methods come back as structured in-band errors (HTTP 200).
        sendJson(res, 200, JSON.parse(lines[0]));
        return;
      }

      if (pathname === "/" || pathname === "/board") {
        if (!isGet) {
          res.setHeader("Allow", "GET, HEAD");
          sendText(res, 405, "method not allowed\n");
          return;
        }
        // "/" with valid credentials -> the board directly (API/direct access);
        // "/" fresh -> fragment->sessionStorage bootstrap page, then /board.
        if (pathname === "/" && !tokenOk(req)) {
          sendHtml(res, 200, bootstrapPage);
          return;
        }
        sendHtml(res, 200, boardHtml);
        return;
      }

      if (pathname === "/workspace-datasource.js") {
        if (!isGet) {
          res.setHeader("Allow", "GET, HEAD");
          sendText(res, 405, "method not allowed\n");
          return;
        }
        if (!tokenOk(req)) {
          sendText(res, 401, "unauthorized: send the session token via Authorization: Bearer or X-Mawf-Token\n");
          return;
        }
        sendJs(res, 200, datasourceSrc);
        return;
      }

      sendText(res, 404, "not found\n");
    } catch (e) {
      // Absolute last resort: never let one request kill the server.
      try {
        sendText(res, 500, "internal error\n");
      } catch { /* response already gone */ }
      process.stderr.write(`mawf companion: request error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { /* handled inside */ });
  });
  // Defensive: keep working whether or not BridgeServer exposes close()
  // (runtime-event work may add provider-owned timers).
  const bridgeClose = /** @type {any} */ (bridgeServer).close;

  return await new Promise((resolve) => {
    let settled = false;
    /** @param {number} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      // closeIdleConnections first: HTTP keep-alive sockets (e.g. undici
      // pools) would otherwise hold server.close() open past shutdown.
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      server.close(() => {
        if (typeof bridgeClose === "function") {
          try { bridgeClose.call(bridgeServer); } catch { /* best effort */ }
        }
        resolve(code);
      });
    };
    server.on("error", (e) => {
      const code = /** @type {{code?: string}} */ (/** @type {unknown} */ (e)).code;
      if (code === "EADDRINUSE") {
        process.stderr.write(`mawf companion: port ${portRaw} is already in use (EADDRINUSE); choose another with --port <n>\n`);
      } else {
        process.stderr.write(`mawf companion: server error: ${e.message}\n`);
      }
      settled = true;
      try { server.close(); } catch { /* not listening yet */ }
      if (typeof bridgeClose === "function") {
        try { bridgeClose.call(bridgeServer); } catch { /* best effort */ }
      }
      resolve(fail(1));
    });
    server.listen(portRaw, "127.0.0.1", () => {
      const addr = /** @type {{port: number}} */ (/** @type {unknown} */ (server.address()));
      boundPort = addr.port;
      const base = `http://127.0.0.1:${boundPort}`;
      const openUrl = `${base}/#token=${token}`;
      // URL + token on STDERR ONLY — stdout stays silent (protocol-only
      // convention; shell history/logs capture stdout far more often).
      process.stderr.write(`mawf companion: serving ${projectDir}\n`);
      process.stderr.write(`mawf companion: board    ${base}/board  (rpc: POST ${base}/rpc, health: ${base}/healthz)\n`);
      process.stderr.write(`mawf companion: open     ${openUrl}\n`);
      process.stderr.write(`mawf companion: token    ${token}\n`);
      process.stderr.write(`mawf companion: session token is memory-only; Ctrl+C to stop\n`);
      if (flags.open === true) openBrowser(openUrl);
    });
    process.once("SIGINT", () => finish(0));
    process.once("SIGTERM", () => finish(0));
  });
}
