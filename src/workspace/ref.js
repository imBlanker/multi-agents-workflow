// @ts-check
// WorkspaceRef — structured workspace identity for MAWF bridge/local providers.
//
// Contract (task: 09-17-mawf-four-tool-integration, contract §8.4):
// - Identity distinguishes endpoint (connection), workspace (canonical root on a
//   machine), repository (project identity) and worktree; SSH alias is a
//   connection label, NOT the server identity.
// - `ssh://...` strings must never be stuffed into local PathBuf semantics; the
//   remote normalizes its own paths (Linux stays case-sensitive).
// - Session keys are machine/workspace/host scoped — never a bare session id.
// - Workspace roots must be explicitly authorized (contract §12.1); this module
//   validates refs but does not itself grant filesystem access.
//
// Zero runtime dependencies (Node built-ins only). All functions are pure.

import { createHash } from "node:crypto";

/** Protocol/identity model version. Bump on breaking shape changes. */
export const WORKSPACE_REF_VERSION = 1;

/**
 * @typedef {"local" | "ssh"} EndpointKind
 * Connection endpoint. For ssh, `host` is the user-facing alias (connection
 * label); `serverId` is the resolved, sticky server identity (see serverId()).
 * @typedef {object} Endpoint
 * @property {EndpointKind} kind
 * @property {string} [host]          ssh alias or hostname (ssh kind only)
 * @property {string} [user]          ssh user, if known
 * @property {string} [port]          ssh port, if non-default
 * @property {string} [serverId]      resolved server identity hash (ssh kind)
 */

/**
 * @typedef {object} WorkspaceRef
 * @property {1} refVersion            schema version (this constant)
 * @property {Endpoint} endpoint
 * @property {string} root             canonical workspace root ON ITS MACHINE
 *                                     (already normalized by the owning side)
 * @property {string|null} [repoId]    stable repository identity (git remote URL,
 *                                     or "plain:<abs-path>" for non-git dirs)
 * @property {string|null} [worktree]  worktree label when root is a linked
 *                                     worktree (git dir basename), else null
 */

/**
 * Stable server identity from connection facts. The ssh alias alone is not an
 * identity (two aliases may reach one server; one alias may be re-pointed).
 * We hash only user-provided connection facts — never run ssh from here.
 * @param {{host: string, user?: string, port?: string}} conn
 * @returns {string} 16-hex-char id
 */
export function serverId(conn) {
  const h = createHash("sha256");
  h.update("mawf-server-v1\x1f");
  h.update(String(conn.user ?? "").toLowerCase());
  h.update("\x1f");
  h.update(String(conn.host ?? "").toLowerCase());
  h.update("\x1f");
  h.update(String(conn.port ?? "22"));
  return h.digest("hex").slice(0, 16);
}

/**
 * Canonicalize a workspace root path for identity purposes.
 * Purely lexical (no fs access): posix rules for remote roots, host rules only
 * via the caller-supplied platform flag (never assume the caller's platform
 * applies to a remote path — Linux roots must not get Windows casing rules).
 * @param {string} root raw root path as given by the user/remote
 * @param {{platform?: "posix"|"win32"}} [opts] platform of the machine that owns
 *        the root; default posix (remote-normalized)
 * @returns {string} normalized root
 */
export function normalizeRoot(root, opts = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("workspace root must be a non-empty string");
  }
  const p = root.trim();
  if (p.includes("\0")) throw new Error("workspace root contains NUL byte");
  const plat = opts.platform === "win32" ? "win32" : "posix";
  if (plat === "win32") {
    return p.replace(/[./]+$/g, "").replace(/\\/g, "/").replace(/\/+$/g, "") || p;
  }
  // posix: collapse trailing slashes and duplicate slashes; keep leading "/"
  let out = p.replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/g, "");
  if (out === "") out = "/";
  return out;
}

/**
 * Build and validate a WorkspaceRef. Throws on invalid shape.
 * @param {object} input
 * @param {Endpoint} input.endpoint
 * @param {string} input.root
 * @param {string|null} [input.repoId]
 * @param {string|null} [input.worktree]
 * @returns {WorkspaceRef}
 */
export function makeWorkspaceRef(input) {
  if (
    input?.refVersion !== undefined &&
    input.refVersion !== WORKSPACE_REF_VERSION
  ) {
    throw new Error(
      `unsupported refVersion ${input.refVersion} (expected ${WORKSPACE_REF_VERSION})`,
    );
  }
  const endpoint = input?.endpoint;
  if (!endpoint || (endpoint.kind !== "local" && endpoint.kind !== "ssh")) {
    throw new Error("endpoint.kind must be 'local' or 'ssh'");
  }
  if (endpoint.kind === "ssh") {
    if (!endpoint.host || typeof endpoint.host !== "string") {
      throw new Error("ssh endpoint requires a host (alias or hostname)");
    }
    if (endpoint.serverId !== undefined && !/^[0-9a-f]{16}$/.test(endpoint.serverId)) {
      throw new Error("endpoint.serverId must be a 16-hex string");
    }
  }
  const root = normalizeRoot(input.root, {
    platform: endpoint.kind === "local" && /^([a-zA-Z]:|\\\\)/.test(String(input.root))
      ? "win32" : "posix",
  });
  /** @type {WorkspaceRef} */
  const ref = {
    refVersion: WORKSPACE_REF_VERSION,
    endpoint: { kind: endpoint.kind },
    root,
    repoId: input.repoId ?? null,
    worktree: input.worktree ?? null,
  };
  for (const k of ["host", "user", "port", "serverId"]) {
    const v = endpoint[k];
    if (v !== undefined) ref.endpoint[k] = v;
  }
  if (endpoint.kind === "ssh" && !ref.endpoint.serverId) {
    ref.endpoint.serverId = serverId({
      host: ref.endpoint.host, user: ref.endpoint.user, port: ref.endpoint.port,
    });
  }
  if (ref.repoId !== null && typeof ref.repoId !== "string") {
    throw new Error("repoId must be string or null");
  }
  if (ref.worktree !== null && typeof ref.worktree !== "string") {
    throw new Error("worktree must be string or null");
  }
  return ref;
}

/**
 * Stable identity key for a workspace ref: endpoint server + canonical root.
 * Same server reached via two aliases with the same resolved serverId and the
 * same root share a key (alias is a label, not identity). Different servers
 * with identical paths do NOT share a key.
 * @param {WorkspaceRef} ref
 * @returns {string} e.g. "ws_local:...hash" / "ws_ssh:...hash"
 */
export function workspaceKey(ref) {
  assertRef(ref);
  const h = createHash("sha256");
  h.update("mawf-ws-v1\x1f");
  if (ref.endpoint.kind === "local") {
    h.update("local\x1f");
    h.update(ref.root);
  } else {
    h.update("ssh\x1f");
    h.update(String(ref.endpoint.serverId));
    h.update("\x1f");
    h.update(ref.root);
  }
  return h.digest("hex").slice(0, 24);
}

/**
 * Machine/workspace/host-scoped session key (contract §8.4: a bare session id
 * or "unknown-session" is never a valid key on its own).
 * @param {{ ref: WorkspaceRef, hostApp: string, sessionId: string }} p
 * @returns {string}
 */
export function sessionKey(p) {
  assertRef(p.ref);
  if (!p.hostApp || typeof p.hostApp !== "string") {
    throw new Error("sessionKey requires hostApp (e.g. 'claude', 'codex', 'dsh', 'pi')");
  }
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw new Error("sessionKey requires a non-empty sessionId scoped to its workspace");
  }
  const h = createHash("sha256");
  h.update("mawf-sess-v1\x1f");
  h.update(workspaceKey(p.ref));
  h.update("\x1f");
  h.update(p.hostApp);
  h.update("\x1f");
  h.update(p.sessionId);
  return h.digest("hex").slice(0, 32);
}

/**
 * Human-readable display label with explicit locality, so remote data can
 * never be mistaken for local (contract §9.2: clear host/workspace identity).
 * @param {WorkspaceRef} ref
 * @returns {string} e.g. "local:/srv/proj" or "myserver:/srv/proj"
 */
export function displayLabel(ref) {
  assertRef(ref);
  if (ref.endpoint.kind === "local") return `local:${ref.root}`;
  return `${ref.endpoint.host}:${ref.root}`;
}

/** Serialize for transport/storage (JSON-safe, stable field order). */
export function encodeWorkspaceRef(ref) {
  assertRef(ref);
  return JSON.stringify(ref);
}

/** Parse + validate; throws on tampered/unknown versions. */
export function decodeWorkspaceRef(json) {
  const obj = JSON.parse(json);
  return makeWorkspaceRef(obj);
}

/** @param {WorkspaceRef} ref */
function assertRef(ref) {
  if (!ref || ref.refVersion !== WORKSPACE_REF_VERSION) {
    throw new Error(`not a v${WORKSPACE_REF_VERSION} WorkspaceRef`);
  }
  if (!ref.root || !ref.endpoint) throw new Error("malformed WorkspaceRef");
}
