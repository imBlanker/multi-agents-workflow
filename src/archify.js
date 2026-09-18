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
 * RAW-ARGV CONTRACT (stabilization §5): `argv` is forwarded verbatim — the
 * only transformation MAWF performs is the allowlist check on the first
 * token. Flags, values and ordering are never re-interpreted here; main()
 * guarantees they were never parsed as MAWF flags in the first place.
 * @param {string[]} argv raw Archify argv, e.g. ["validate","workflow","x.json","--quality","showcase","--json"]
 * @param {{env?: object, spawnFn?: typeof import("node:child_process").spawnSync}} [opts]
 */
export function runArchify(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const spawnFn = opts.spawnFn ?? spawnSync;
  // MAWF-owned subcommand (contract §10.4 minimal fallback): the preview
  // state sidecar reader never reaches the engine — intercept it BEFORE the
  // raw pass-through. Every other command is still forwarded verbatim.
  if (argv[0] === "preview-state") return runPreviewState(argv.slice(1), opts);
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
  console.error(`[mawf archify] engine: ${resolved.path} (${resolved.source}; locked ${entry.upstream.commit.slice(0, 10)})`);
  const child = spawnFn(process.execPath, [resolved.path, ...argv], { stdio: "inherit" });
  return child.status ?? 1;
}

// ---------------------------------------------------------------------------
// Preview state sidecar (contract §10.4, MINIMAL fallback).
//
// A preview session (a later, separate step) may write
//   <ir>.preview-state.json  =  {status: "checking"|"verified"|"needs-fix",
//                                revision, artifactSha256, at}
// next to the IR. `mawf archify preview-state <ir>` only READS that sidecar
// and prints a machine-parsable summary. It never starts or manages preview
// processes, never renders, and must never be presented as a live preview
// (§10.4: the fallback must not claim real-time preview).

/** Sidecar path for an IR: `<ir>.preview-state.json` (next to the IR). */
export function previewStatePath(ir) {
  return `${path.resolve(String(ir))}.preview-state.json`;
}

/** Raw sidecar contents; null when absent/unreadable. */
export function readPreviewState(ir) {
  return readJson(previewStatePath(ir), null);
}

/**
 * `mawf archify preview-state <ir> [--project <p>] [--json]` — MAWF-owned
 * reader; intercepted in runArchify before the engine pass-through.
 * --project is accepted for CLI symmetry but the sidecar location is
 * IR-relative, so it does not affect the result.
 * @param {string[]} argv args after "preview-state" (raw — MAWF's flag
 *        parser never sees this subcommand's args)
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [opts] output seams (tests)
 * @returns {number} exit code
 */
export function runPreviewState(argv, opts = {}) {
  const out = opts.out ?? ((t) => process.stdout.write(t));
  const errOut = opts.err ?? ((t) => process.stderr.write(t));
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue; // handled below
    if (a === "--project") {
      i += 1; // accepted, sidecar is IR-relative — value unused
      continue;
    }
    if (a.startsWith("--")) {
      errOut(`mawf archify preview-state: unknown option ${a}\n`);
      return 2;
    }
    pos.push(a);
  }
  const ir = pos[0];
  if (!ir || pos.length > 1) {
    errOut("usage: mawf archify preview-state <ir> [--project <p>] [--json]\n");
    return 2;
  }
  const irAbs = path.resolve(ir);
  const sidecarPath = previewStatePath(irAbs);
  // Read the sidecar directly so a MALFORMED file is distinguishable from an
  // ABSENT one (readJson collapses both to the fallback).
  let state = null;
  let malformed = false;
  try {
    state = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  } catch (e) {
    if (e && e.code !== "ENOENT") malformed = true;
  }
  const valid = state && typeof state === "object" && typeof state.status === "string" ? state : null;
  if (valid === null && state !== null) malformed = true; // parsed but wrong shape
  if (malformed) {
    errOut(`mawf archify preview-state: sidecar is malformed (reporting as absent): ${sidecarPath}\n`);
  }
  const summary = {
    ir: irAbs,
    sidecar: sidecarPath,
    present: Boolean(valid),
    status: valid ? valid.status : "none",
    revision: valid?.revision ?? null,
    artifactSha256: valid?.artifactSha256 ?? null,
    at: valid?.at ?? null,
  };
  if (argv.includes("--json")) {
    out(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    out(
      `preview-state: ${summary.status} revision=${summary.revision ?? "-"} ` +
        `artifactSha256=${summary.artifactSha256 ? `${String(summary.artifactSha256).slice(0, 12)}…` : "-"} at=${summary.at ?? "-"}\n` +
        `  sidecar: ${sidecarPath}${valid ? "" : " (absent — no preview session has reported for this IR)"}\n`,
    );
  }
  return 0;
}
