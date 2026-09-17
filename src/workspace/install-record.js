// @ts-check
// Remote helper install records — contract §8.2 (remote PATH probe).
//
// The remote NON-INTERACTIVE PATH often lacks nvm/fnm/asdf/npm-global dirs,
// so the FIXED_REMOTE_COMMAND (`mawf bridge serve`) cannot resolve there.
// `mawf bridge install-helper <alias>` probes the remote with ONE ssh
// invocation whose remote command is the MAWF-owned fixed literal below
// (`node -e '<PROBE_SCRIPT>'`), and records the discovered absolute
// Node/MAWF entries under <home>/.mawf/bridge/hosts/<sanitized-alias>.json.
// SshTransport.connect() consults these records read-only when no explicit
// helper path is configured.
//
// Security (contract §0.2/§12.1):
// - Records contain ONLY paths, versions and a machine hint — NEVER keys,
//   passwords, tokens or any other credential.
// - The alias passes the same host validation as buildSshArgs' host checks;
//   the probe script is a fixed literal, so NOTHING user-controlled is
//   escaped or interpolated into the remote command line.
//
// Zero runtime dependencies (Node built-ins only).

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureDir, home, isoNow } from "../util.js";

/**
 * Fixed probe program printed by the remote `node -e` invocation.
 * MAWF-owned literal: no user, workspace or project input is ever embedded.
 * It prints ONE JSON line: {node: process.execPath, hostname: os.hostname(),
 * mawfBin: resolved `which mawf` ("" when absent), mawfVersion: "" | version}.
 * Deliberately contains no single quotes so the remote shell sees
 * `node -e '<script>'` unmodified.
 */
export const PROBE_SCRIPT =
  'const os=require("os"),cp=require("child_process");let b="";try{b=cp.execFileSync("which",["mawf"],{encoding:"utf8"}).trim()}catch(e){}' +
  'let v="";if(b){try{v=cp.execFileSync(b,["--version"],{encoding:"utf8"}).trim()}catch(e){}}' +
  'process.stdout.write(JSON.stringify({node:process.execPath,hostname:os.hostname(),mawfBin:b,mawfVersion:v}))';

/** The fixed remote command argv item for the probe (`node -e '<script>'`). */
export const REMOTE_PROBE_COMMAND = `node -e '${PROBE_SCRIPT}'`;

/** Stable failure kinds for the probe (orthogonal to protocol ERR codes). */
export const PROBE_FAILURE = Object.freeze({
  AUTH: "auth_failed",
  TIMEOUT: "timeout",
  NODE_MISSING: "node_missing",
  MAWF_MISSING: "mawf_missing",
  PROBE_FAILED: "probe_failed",
});

/** Record root: <home>/.mawf/bridge/hosts (same MAWF space as machine-id). */
export function hostsDir(h = home()) {
  return path.join(h, ".mawf", "bridge", "hosts");
}

/**
 * Validate an ssh host alias used as BOTH an ssh argv item and a record file
 * name stem. Same host checks as buildSshArgs (no whitespace/NUL, no leading
 * '-'), plus a restrictive charset and a traversal ban — "../../evil" and
 * friends are rejected outright, never encoded around.
 * @param {string} alias
 * @returns {string} the validated alias (unchanged)
 */
export function sanitizeAlias(alias) {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new Error("ssh host alias is required");
  }
  if (/[\s\0]/.test(alias)) {
    throw new Error(`ssh host alias must not contain whitespace or NUL bytes: ${JSON.stringify(alias)}`);
  }
  if (alias.startsWith("-")) {
    throw new Error(`ssh host alias must not start with '-' (argv safety): ${JSON.stringify(alias)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error(`ssh host alias contains characters outside the safe set [A-Za-z0-9._-]: ${JSON.stringify(alias)}`);
  }
  if (alias.includes("..")) {
    throw new Error(`ssh host alias must not contain '..' (path traversal): ${JSON.stringify(alias)}`);
  }
  return alias;
}

/** Record file path for an alias (throws for unsafe aliases, e.g. traversal). */
export function installRecordPath(alias, opts = {}) {
  const dir = opts.hostsDir ?? hostsDir(opts.home);
  return path.join(dir, `${sanitizeAlias(alias)}.json`);
}

/**
 * Atomically write an install record (tmp + rename inside the same dir).
 * The record shape is caller-owned; writeInstallRecord enforces nothing
 * beyond a safe alias — callers pass the shape built by probeRemote().
 * @param {{alias: string, nodePath: string, mawfBin: string, mawfVersion: string,
 *          remoteMachineHint: string, recordedAt: string}} record
 * @param {{home?: string, hostsDir?: string}} [opts]
 * @returns {string} the written path
 */
export function writeInstallRecord(record, opts = {}) {
  const p = installRecordPath(record.alias, opts);
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return p;
}

/**
 * Read one install record; null when absent or unreadable (records are an
 * optimization — callers fall back to the fixed remote entry).
 * @param {string} alias
 * @param {{home?: string, hostsDir?: string}} [opts]
 * @returns {object|null}
 */
export function readInstallRecord(alias, opts = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(installRecordPath(alias, opts), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * List all install records (sorted by file name). Unreadable entries are
 * skipped — a status listing must never crash on one bad file.
 * @param {{home?: string, hostsDir?: string}} [opts]
 * @returns {object[]}
 */
export function listInstallRecords(opts = {}) {
  const dir = opts.hostsDir ?? hostsDir(opts.home);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (rec && typeof rec === "object") records.push(rec);
    } catch {
      /* unreadable record — skip */
    }
  }
  return records;
}

/**
 * Build the probe argv: [batch/timeout options..., "--", alias,
 * REMOTE_PROBE_COMMAND]. The alias is validated with the same host checks as
 * buildSshArgs; the remote command is the fixed MAWF-owned literal above.
 * @param {string} alias
 * @param {{batchMode?: boolean, connectTimeoutMs?: number}} [opts]
 * @returns {string[]}
 */
export function buildProbeArgs(alias, opts = {}) {
  sanitizeAlias(alias); // host argv safety, same rules as buildSshArgs
  let ms = Number(opts.connectTimeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) ms = 10000;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  /** @type {string[]} */
  const args = [];
  if (opts.batchMode !== false) args.push("-o", "BatchMode=yes");
  args.push("-o", `ConnectTimeout=${seconds}`);
  // Machine channel: never allocate a TTY even if the user config asks for one.
  args.push("-o", "RequestTTY=no");
  // "--" ends option parsing; the remote command is the fixed probe literal.
  args.push("--", alias, REMOTE_PROBE_COMMAND);
  return args;
}

/**
 * Classify a failed probe into a stable kind with an actionable next step.
 * Precedence: timeout → auth → timeout(stderr) → node-missing → mawf-missing.
 * @param {{exitCode?: number|null, timedOut?: boolean, stderr?: string,
 *          gotJson?: boolean, mawfBin?: string, alias?: string}} p
 * @returns {{kind: string, message: string}}
 */
export function classifyProbeFailure({
  exitCode = null,
  timedOut = false,
  stderr = "",
  gotJson = false,
  mawfBin = "",
  alias = "",
} = {}) {
  const text = String(stderr ?? "");
  if (timedOut) {
    return {
      kind: PROBE_FAILURE.TIMEOUT,
      message:
        `probe of ${JSON.stringify(alias)} timed out before the remote answered — check network/VPN and the ssh config for this alias` +
        ` (BatchMode never prompts). Next: verify plain "ssh ${alias}" works, then retry mawf bridge install-helper.`,
    };
  }
  if (/permission denied/i.test(text) || /authenticat/i.test(text)) {
    return {
      kind: PROBE_FAILURE.AUTH,
      message:
        "ssh authentication failed — check the host alias, ssh-agent/keys; BatchMode never prompts for passwords" +
        `. Next: verify plain "ssh ${alias}" works, then retry mawf bridge install-helper.`,
    };
  }
  if (/connection timed out|operation timed out|connection refused/i.test(text)) {
    return {
      kind: PROBE_FAILURE.TIMEOUT,
      message:
        `ssh connection to ${JSON.stringify(alias)} failed or timed out — check network/VPN and the ssh config for this alias` +
        ". Next: verify plain ssh connectivity, then retry mawf bridge install-helper.",
    };
  }
  if (!gotJson) {
    return {
      kind: PROBE_FAILURE.NODE_MISSING,
      message:
        "node was not found on the remote non-interactive PATH — install Node >=20 on the remote or add it to the non-interactive PATH" +
        " (nvm/fnm/asdf/npm-global dirs are usually absent in non-interactive shells; MAWF never auto-edits shell rc files)" +
        `. Next: "ssh ${alias} which node" to confirm, install Node >=20, then retry mawf bridge install-helper.`,
    };
  }
  if (!mawfBin) {
    return {
      kind: PROBE_FAILURE.MAWF_MISSING,
      message:
        "node answered but `which mawf` was empty — mawf is missing from the remote non-interactive PATH" +
        ". Next: install MAWF on the remote (npm install -g multi-agents-workflow) or add its bin dir to the non-interactive PATH, then retry.",
    };
  }
  return {
    kind: PROBE_FAILURE.PROBE_FAILED,
    message: `probe failed unexpectedly (exit=${exitCode}): ${text.slice(-200) || "(no stderr)"}`,
  };
}

/**
 * Probe a remote host over ONE ssh invocation (fixed argv shape, see
 * buildProbeArgs). Never throws — resolves {ok:true, record} or
 * {ok:false, kind, message}. stdout/stderr are byte-capped: the probe prints
 * one small JSON line; anything beyond that is noise we refuse to buffer
 * unboundedly (contract §8.2 discipline).
 *
 * `spawnFn` is the test seam (no real ssh, no network in tests).
 *
 * @param {{alias: string, sshPath?: string, spawnFn?: typeof nodeSpawn,
 *          connectTimeoutMs?: number, timeoutMs?: number}} p
 * @returns {Promise<{ok: true, record: {alias: string, nodePath: string,
 *            mawfBin: string, mawfVersion: string, remoteMachineHint: string,
 *            recordedAt: string}} | {ok: false, kind: string, message: string}>}
 */
export function probeRemote({ alias, sshPath = "ssh", spawnFn = nodeSpawn, connectTimeoutMs = 10000, timeoutMs } = {}) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    let argv;
    try {
      argv = buildProbeArgs(alias, { connectTimeoutMs });
    } catch (e) {
      resolve({ ok: false, kind: PROBE_FAILURE.PROBE_FAILED, message: e?.message ?? String(e) });
      return;
    }
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Math.max(connectTimeoutMs + 5000, 15000);
    /** @type {any} */
    let child = null;
    let timedOut = false;
    let settled = false;
    let stdout = "";
    let stderr = "";
    const CAP = 64 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, limit);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawnFn(sshPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, kind: PROBE_FAILURE.PROBE_FAILED, message: `failed to start ssh: ${e?.message ?? e}` });
      return;
    }
    child.stdout?.on?.("data", (c) => {
      if (stdout.length < CAP) stdout += String(c);
    });
    child.stderr?.on?.("data", (c) => {
      if (stderr.length < CAP) stderr += String(c);
    });
    child.on?.("error", (e) => {
      finish({ ok: false, kind: PROBE_FAILURE.PROBE_FAILED, message: `ssh process error: ${e?.message ?? e}` });
    });
    child.on?.("close", (code) => {
      if (timedOut) {
        finish({ ok: false, ...classifyProbeFailure({ timedOut, alias }) });
        return;
      }
      // The probe prints exactly one JSON line; tolerate surrounding whitespace.
      let json = null;
      const line = stdout.trim();
      if (line.startsWith("{")) {
        try {
          json = JSON.parse(line);
        } catch {
          json = null;
        }
      }
      if (json && typeof json === "object" && typeof json.node === "string") {
        const mawfBin = String(json.mawfBin ?? "");
        if (!mawfBin) {
          finish({ ok: false, ...classifyProbeFailure({ gotJson: true, mawfBin, exitCode: code, alias }) });
          return;
        }
        finish({
          ok: true,
          record: {
            alias,
            nodePath: json.node,
            mawfBin,
            mawfVersion: String(json.mawfVersion ?? ""),
            // os.hostname() as seen by the remote node process — a hint only.
            remoteMachineHint: String(json.hostname ?? ""),
            recordedAt: isoNow(),
          },
        });
        return;
      }
      finish({ ok: false, ...classifyProbeFailure({ exitCode: code, stderr, gotJson: false, alias }) });
    });
  });
}
