// @ts-check
// `mawf bridge` — CLI surface for the workspace bridge (P4.2).
//
//   mawf bridge serve [--project <dir>] [--machine-id <id>]
//   mawf bridge machine-id
//   mawf bridge install-helper <ssh-host-alias>
//   mawf bridge status [ssh-host-alias]
//
// install-helper probes the remote over ONE ssh invocation whose remote
// command is a MAWF-owned fixed literal (contract §8.2 remote PATH probe)
// and records the discovered absolute Node/MAWF entries under
// <home>/.mawf/bridge/hosts/<sanitized-alias>.json. Records NEVER contain
// keys or credentials; on failure nothing is written.
//
// Contract (execution contract §8.2/§8.5):
// - stdout is PROTOCOL-ONLY (NDJSON frames); every log/diagnostic goes to
//   stderr. The pump never writes noise between frames.
// - The server keeps the connection open until stdin EOF; requests are
//   answered in arrival order (chained promise pump).
//
// Zero runtime dependencies (Node built-ins only).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { BridgeServer } from "./bridge.js";
import { CAPABILITIES } from "./protocol.js";
import { createProviders } from "./providers.js";
import { KnowledgeStore } from "../knowledge/store.js";
import {
  listInstallRecords,
  probeRemote,
  readInstallRecord,
  sanitizeAlias,
  writeInstallRecord,
} from "./install-record.js";
import { expand, ensureDir, home } from "../util.js";

/** Stable per-machine id file (stabilization §13: survives alias changes). */
export function machineIdPath(h = home()) {
  return path.join(h, ".mawf", "bridge", "machine-id");
}

/**
 * Read the machine id, creating one (crypto.randomUUID, 0600) when absent or
 * empty. This is the ONLY filesystem write in the bridge CLI.
 * @param {string} [h] home dir override (tests)
 * @returns {string}
 */
export function readOrCreateMachineId(h = home()) {
  const p = machineIdPath(h);
  try {
    const cur = fs.readFileSync(p, "utf8").trim();
    if (cur) return cur;
  } catch {
    // absent — fall through and provision
  }
  const id = crypto.randomUUID();
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  return id;
}

/** Capability set offered by `mawf bridge serve` (read-only + transport features). */
function bridgeCapabilities() {
  return [
    CAPABILITIES.PROJECT_READ,
    CAPABILITIES.KNOWLEDGE_READ,
    CAPABILITIES.ARTIFACT_READ,
    CAPABILITIES.CHUNKED_ARTIFACTS,
    CAPABILITIES.RUNTIME_EVENTS,
    CAPABILITIES.TERMINAL_META,
    CAPABILITIES.EVENT_RESUME,
    CAPABILITIES.CANCEL,
  ];
}

/**
 * `mawf bridge serve` — NDJSON-over-stdio bridge server.
 * @param {string[]} _rest extra positionals (unused; serve takes none)
 * @param {Record<string, string|boolean>} flags parsed CLI flags
 * @returns {Promise<number>} resolves 0 after stdin EOF + final flush
 */
async function bridgeServe(_rest, flags) {
  const project = expand(typeof flags.project === "string" ? flags.project : process.cwd());
  const store = KnowledgeStore.open(project);
  const flagId = typeof flags["machine-id"] === "string" ? flags["machine-id"].trim() : "";
  const machineId = flagId || readOrCreateMachineId();
  const providers = createProviders({ projectDir: project, store, machineId });
  const server = new BridgeServer({
    serverId: "mawf-bridge",
    machineId,
    capabilities: bridgeCapabilities(),
    providers,
  });
  // Server-initiated frames (runtime subscription events) share the same
  // protocol-only stdout — never stderr, never interleaved log noise.
  server.onFrame((line) => process.stdout.write(line));

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let tail = Promise.resolve();
  rl.on("line", (/** @type {string} */ line) => {
    tail = tail
      .then(async () => {
        const frames = await server.handleLine(line);
        if (frames.length > 0) process.stdout.write(frames.join(""));
      })
      .catch((e) => {
        // handleLine maps everything to wire errors; this is a last-resort
        // guard so one bad frame can never kill the pump (stderr, never stdout)
        process.stderr.write(`mawf bridge: pump error: ${e?.message ?? e}\n`);
      });
  });
  return new Promise((resolve) => {
    rl.on("close", () => {
      server.close(); // clear provider-owned timers (runtime poll) before flush
      tail.then(
        () => resolve(0),
        () => resolve(0),
      );
    });
  });
}

/**
 * `mawf bridge install-helper <ssh-host-alias>` — probe the remote over ONE
 * ssh invocation (argv is ONLY [batch/timeout options, "--", alias,
 * "node -e '<fixed probe script>'"]; nothing user-controlled is escaped —
 * the alias passes buildSshArgs-grade host checks and the probe script is a
 * fixed MAWF-owned literal). On success write the install record (paths and
 * versions only — never credentials); on failure print a structured
 * diagnostic (auth / node-missing / mawf-missing / timeout) with actionable
 * next steps and write NOTHING.
 * @param {string[]} rest args after "install-helper"
 * @param {Record<string, string|boolean>} _flags parsed CLI flags (unused)
 * @param {{spawnFn?: typeof import("node:child_process").spawn, sshPath?: string,
 *          home?: string, connectTimeoutMs?: number, timeoutMs?: number,
 *          out?: (s: string) => void, err?: (s: string) => void}} [deps] test seams
 * @returns {Promise<number>} 0 recorded | 1 probe failed | 2 usage
 */
export async function bridgeInstallHelper(rest, _flags = {}, deps = {}) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const err = deps.err ?? ((t) => process.stderr.write(t));
  const alias = rest[0];
  if (!alias) {
    err("usage: mawf bridge install-helper <ssh-host-alias>\n");
    return 2;
  }
  try {
    sanitizeAlias(alias);
  } catch (e) {
    err(`mawf bridge install-helper: ${e.message}\n`);
    return 2;
  }
  err(`[mawf bridge] probing ${JSON.stringify(alias)} over a single ssh invocation...\n`);
  const r = await probeRemote({
    alias,
    sshPath: deps.sshPath,
    spawnFn: deps.spawnFn,
    connectTimeoutMs: deps.connectTimeoutMs,
    timeoutMs: deps.timeoutMs,
    // §8.2: non-interactive remote PATH often misses npm-global bins; a
    // caller may supply the known absolute entry (charset-gated).
    overrideMawfBin: typeof _flags["mawf-bin"] === "string" ? _flags["mawf-bin"] : undefined,
  });
  if (!r.ok) {
    err(`mawf bridge install-helper: probe failed [${r.kind}]\n  ${r.message}\n  no install record written.\n`);
    return 1;
  }
  const p = writeInstallRecord(r.record, { home: deps.home });
  out(
    `install-helper: recorded ${JSON.stringify(alias)}\n` +
      `  node:   ${r.record.nodePath}\n` +
      `  mawf:   ${r.record.mawfBin}${r.record.mawfVersion ? ` (${r.record.mawfVersion})` : ""}\n` +
      `  hint:   ${r.record.remoteMachineHint || "(remote hostname unavailable)"}\n` +
      `  record: ${p}\n` +
      "  (paths only — no credentials are ever stored)\n",
  );
  return 0;
}

/**
 * `mawf bridge status [alias]` — list recorded hosts and their recorded
 * entry. INFORMATIONAL ONLY: nothing is probed, connected or refreshed here.
 * @param {string[]} rest args after "status"
 * @param {Record<string, string|boolean>} _flags parsed CLI flags (unused)
 * @param {{home?: string, out?: (s: string) => void}} [deps] test seams
 * @returns {number} exit code (0 — informational)
 */
export function bridgeStatus(rest, _flags = {}, deps = {}) {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const alias = rest[0];
  if (alias) {
    sanitizeAlias(alias); // same file-name safety as the writer
    const rec = readInstallRecord(alias, { home: deps.home });
    if (!rec) {
      out(`no install record for ${JSON.stringify(alias)} (informational — run: mawf bridge install-helper ${alias})\n`);
      return 0;
    }
    out(formatInstallRecord(rec));
    return 0;
  }
  const records = listInstallRecords({ home: deps.home });
  if (records.length === 0) {
    out("no recorded bridge hosts (run: mawf bridge install-helper <ssh-host-alias>)\n");
    return 0;
  }
  for (const rec of records) out(formatInstallRecord(rec));
  return 0;
}

/** One-line human rendering of an install record. */
function formatInstallRecord(rec) {
  return (
    `${String(rec.alias ?? "?")}  node=${rec.nodePath ?? "?"}  mawf=${rec.mawfBin ?? "?"}` +
    `${rec.mawfVersion ? ` (${rec.mawfVersion})` : ""}` +
    `  hint=${rec.remoteMachineHint || "-"}  recordedAt=${rec.recordedAt ?? "-"}\n`
  );
}

/**
 * Entry used from index.js: `bridge <sub> [flags]`.
 * @param {string[]} f args after "bridge"
 * @param {Record<string, string|boolean>} flags parsed CLI flags
 * @param {{spawnFn?: typeof import("node:child_process").spawn, sshPath?: string,
 *          home?: string, connectTimeoutMs?: number, timeoutMs?: number,
 *          out?: (s: string) => void, err?: (s: string) => void}} [deps] test seams
 * @returns {Promise<number>|number} exit code (serve resolves after EOF)
 */
export function runBridge(f, flags, deps = {}) {
  const [sub] = f;
  switch (sub) {
    case "serve":
      return bridgeServe(f.slice(1), flags);
    case "machine-id": {
      process.stdout.write(`${readOrCreateMachineId()}\n`);
      return 0;
    }
    case "install-helper":
      return bridgeInstallHelper(f.slice(1), flags, deps);
    case "status":
      return bridgeStatus(f.slice(1), flags, deps);
    default:
      process.stderr.write(
        `mawf bridge: unknown subcommand ${JSON.stringify(sub ?? "")} (expected: serve | machine-id | install-helper | status)\n`,
      );
      return 2;
  }
}
