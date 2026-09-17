// @ts-check
// `mawf archify` — thin host-neutral adapter for the locked Archify engine
// (contract §10.1: all four hosts reach the same engine through MAWF; no DSH
// bundle dependency; npm 'archify' is an unrelated package — never used).
//
// Engine resolution order:
//   1. $MAWF_ARCHIFY_BIN explicit override
//   2. installed component: ~/.mawf/components/archify/<ver>/.../bin/archify.mjs
//   3. development source checkout: $MAWF_ARCHIFY_SRC/archify/bin/archify.mjs
//      (reported as development/source, never release-certified)
// Resolution NEVER downloads or installs anything implicitly (§11.3).
//
// Only forwarded subcommands are allowed (allowlist); unknown commands are
// rejected here so the engine never sees unvetted args.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson } from "./util.js";
import { loadLock, componentStatus } from "./components/registry.js";

const ALLOWED_COMMANDS = new Set([
  "render", "validate", "deliver", "preview", "compare", "check",
  "inspect", "migrate", "guide", "examples", "doctor", "demo",
  "visual-check",
]);
// brands intentionally not forwarded (brand marks include NC-licensed icons)

/**
 * Locate the locked engine. Returns { path, source } or { error }.
 */
export function resolveEngine(env = process.env) {
  if (env.MAWF_ARCHIFY_BIN) {
    if (!fs.existsSync(env.MAWF_ARCHIFY_BIN)) return { error: `MAWF_ARCHIFY_BIN not found: ${env.MAWF_ARCHIFY_BIN}` };
    return { path: env.MAWF_ARCHIFY_BIN, source: "env-override" };
  }
  const home = os.homedir();
  const compDir = path.join(home, ".mawf", "components", "archify");
  const current = readJson(path.join(compDir, "current.json"), null);
  if (current?.dir) {
    const candidate = findEngineUnder(current.dir);
    if (candidate) return { path: candidate, source: "component (installed)", sourceCommit: current.sourceCommit };
  }
  if (env.MAWF_ARCHIFY_SRC) {
    const candidate = path.join(env.MAWF_ARCHIFY_SRC, "archify", "bin", "archify.mjs");
    if (fs.existsSync(candidate)) {
      return { path: candidate, source: "development/source checkout (not release-certified)" };
    }
    return { error: `MAWF_ARCHIFY_SRC set but engine not found at ${candidate}` };
  }
  return {
    error: "archify engine not installed. Run: mawf components install archify --from-file <archify.zip> (see defaults/components.lock.json for the locked source) — or set MAWF_ARCHIFY_SRC to a source checkout.",
  };
}

function findEngineUnder(dir) {
  const direct = path.join(dir, "archify", "bin", "archify.mjs");
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(dir, "bin", "archify.mjs");
  if (fs.existsSync(nested)) return nested;
  return null;
}

/**
 * Run an engine command. Engine stdout/stderr are passed through; exit code
 * is preserved (engine receipts remain authoritative, contract §10.5).
 * @param {string[]} argv full argv after "archify", e.g. ["validate", "workflow", "x.json", "--json"]
 */
export function runArchify(argv, env = process.env) {
  const cmd = argv[0];
  if (!cmd || !ALLOWED_COMMANDS.has(cmd)) {
    console.error(`mawf archify: command not allowed: ${cmd ?? "(none)"}`);
    console.error(`allowed: ${[...ALLOWED_COMMANDS].sort().join(" ")}`);
    return 2;
  }
  const resolved = resolveEngine(env);
  if (resolved.error) {
    console.error(`mawf archify: ${resolved.error}`);
    return 3;
  }
  const lock = loadLock();
  const entry = lock.components.find((c) => c.name === "archify");
  const st = componentStatus(entry, { home: env.MAWF_HOME_OVERRIDE });
  console.error(`[mawf archify] engine: ${resolved.path} (${resolved.source}; locked ${entry.upstream.commit.slice(0, 10)})`);
  const child = spawnSync(process.execPath, [resolved.path, ...argv], { stdio: "inherit" });
  return child.status ?? 1;
}
