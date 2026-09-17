// @ts-check
// `mawf bridge` — CLI surface for the workspace bridge (P4.2).
//
//   mawf bridge serve [--project <dir>] [--machine-id <id>]
//   mawf bridge machine-id
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
      tail.then(
        () => resolve(0),
        () => resolve(0),
      );
    });
  });
}

/**
 * Entry used from index.js: `bridge <sub> [flags]`.
 * @param {string[]} f args after "bridge"
 * @param {Record<string, string|boolean>} flags parsed CLI flags
 * @returns {Promise<number>|number} exit code (serve resolves after EOF)
 */
export function runBridge(f, flags) {
  const [sub] = f;
  switch (sub) {
    case "serve":
      return bridgeServe(f.slice(1), flags);
    case "machine-id": {
      process.stdout.write(`${readOrCreateMachineId()}\n`);
      return 0;
    }
    default:
      process.stderr.write(`mawf bridge: unknown subcommand ${JSON.stringify(sub ?? "")} (expected: serve | machine-id)\n`);
      return 2;
  }
}
