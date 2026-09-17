// @ts-check
// P4.2.2 integration proof: the `runtime.*` provider group of
// `mawf bridge serve` — Trellis session snapshots with composite scopedKeys,
// watchdog open-incident counts, malformed-file tolerance, and the
// subscribe/poll event stream (channel "runtime", epoch/seq per §8.5).
//
// Asserts (dispatch P4.2.2):
// - runtime.snapshot derives sessions from <root>/.trellis/.runtime/sessions/
//   with scopedKey = machineId:workspace-basename:sessionId
// - malformed session files are skipped with a warning, never a crash
// - watchdog incidents summary counts state === "open" only
// - subscribe -> sessions-dir change -> event on channel "runtime" with the
//   incremented data epoch; unsubscribe stops events
// - provider failure never kills the server (next request still works)
// - stdout carries protocol frames only (every line must JSON.parse)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { fixtureEnv } from "./fixtures/test-env.mjs";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CAPABILITIES, PROTOCOL_VERSION } from "../src/workspace/protocol.js";
import { createProviders, RUNTIME_POLL_MS, RUNTIME_MAX_SUBSCRIBERS } from "../src/workspace/providers.js";
import { BridgeServer } from "../src/workspace/bridge.js";
import { machineIdPath } from "../src/workspace/cli.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mawf.js");
const MACHINE_ID = "feed0001-cafe-4bef-9d0f-fixture-machine";

// ----------------------------------------------------------------- fixture
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maw-runtime-"));
const homeDir = path.join(tmpRoot, "home");
const fixture = path.join(tmpRoot, "rt-proj");

const SESSIONS_DIR = path.join(fixture, ".trellis", ".runtime", "sessions");
const INCIDENTS_DIR = path.join(fixture, ".mawf", "watchdog", "incidents");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(INCIDENTS_DIR, { recursive: true });

const writeSession = (name, json) =>
  fs.writeFileSync(path.join(SESSIONS_DIR, name), typeof json === "string" ? json : JSON.stringify(json));

// one good session + two malformed ones (invalid JSON / not an object)
writeSession("pi_alpha.json", {
  platform: "pi",
  last_seen_at: "2026-09-17T08:00:00Z",
  current_task: ".trellis/tasks/09-17-rt",
  current_run: null,
});
writeSession("broken.json", "{definitely not json");
writeSession("nonobject.json", "[1, 2, 3]");

// watchdog incidents: one open, one resolved, one malformed (ignored)
fs.writeFileSync(
  path.join(INCIDENTS_DIR, "inc-1-open.json"),
  JSON.stringify({ id: "inc-1", state: "open", host: "codex", openedAt: "2026-09-17T07:00:00.000Z" }),
);
fs.writeFileSync(
  path.join(INCIDENTS_DIR, "inc-2-resolved.json"),
  JSON.stringify({ id: "inc-2", state: "resolved", host: "codex", openedAt: "2026-09-17T06:00:00.000Z" }),
);
fs.writeFileSync(path.join(INCIDENTS_DIR, "inc-bad.json"), "{oops");

fs.mkdirSync(path.join(fixture, ".trellis", "tasks", "09-17-rt"), { recursive: true });
fs.writeFileSync(path.join(fixture, ".trellis", "tasks", "09-17-rt", "task.json"), JSON.stringify({ name: "09-17-rt", status: "in_progress" }));

fs.mkdirSync(path.dirname(machineIdPath(homeDir)), { recursive: true });
fs.writeFileSync(machineIdPath(homeDir), MACHINE_ID + "\n", { mode: 0o600 });

// ------------------------------------------------------------- stdio client
// Same harness shape as tests/workspace-bridge-serve.test.js: spawn the REAL
// CLI as a subprocess and speak NDJSON over stdio. Any non-protocol stdout
// noise makes JSON.parse throw and fails the test.

/**
 * @param {number} [sleepMs] extra settle time before returning (event races)
 */
function startServe() {
  const child = spawn(process.execPath, [BIN, "bridge", "serve", "--project", fixture], {
    cwd: tmpRoot,
    env: fixtureEnv(homeDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  /** @type {object[]} */ const received = [];
  /** @type {string[]} */ const stderr = [];
  /** @type {{match: (m: object) => boolean, resolve: (m: object) => void}[]} */ const pending = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line); // throws (test fails) on ANY non-protocol noise
      received.push(msg);
      const idx = pending.findIndex((w) => w.match(msg));
      if (idx >= 0) pending.splice(idx, 1)[0].resolve(msg);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const awaitMsg = (match, label) => {
    const already = received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout: ${label}\nlast: ${JSON.stringify(received.slice(-4))}\nstderr: ${stderr.join("")}`)),
        15000,
      );
      pending.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  const request = async (id, method, params) => {
    send({ type: "request", id, method, params: params ?? {} });
    return awaitMsg((m) => m.type === "response" && m.id === id, `response ${id} (${method})`);
  };
  const close = async () => {
    child.stdin.end();
    child.kill();
    await new Promise((res) => child.on("exit", res));
  };
  return { child, send, request, awaitMsg, close, received, stderrText: () => stderr.join("") };
}

async function handshake(b) {
  b.send({ type: "hello", v: PROTOCOL_VERSION, clientId: "runtime-test", capabilities: Object.values(CAPABILITIES) });
  return b.awaitMsg((m) => m.type === "hello_ok", "hello_ok");
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const runtimeEvents = (b) => b.received.filter((m) => m.type === "event" && m.channel === "runtime");

// ------------------------------------------------------------------ tests

test("serve: runtime.snapshot derives sessions with composite scopedKey + open incident count", async () => {
  const b = startServe();
  try {
    await handshake(b);
    const r = await b.request("r1", "runtime.snapshot");
    assert.equal(r.ok, true, `snapshot failed: ${JSON.stringify(r.error ?? null)}`);
    assert.equal(typeof r.result.epoch, "number");
    // scopedKey = machineId : workspace basename : sessionId (readable composite)
    const alpha = r.result.sessions.find((/** @type {{sessionId: string}} */ s) => s.sessionId === "pi_alpha");
    assert.ok(alpha, "good session listed");
    assert.equal(alpha.platform, "pi");
    assert.equal(alpha.currentTask, ".trellis/tasks/09-17-rt");
    assert.equal(alpha.lastSeenAt, "2026-09-17T08:00:00Z");
    const parts = alpha.scopedKey.split(":");
    assert.equal(parts.length, 3, `scopedKey is a 3-part composite: ${alpha.scopedKey}`);
    assert.ok(alpha.scopedKey.includes(MACHINE_ID), "scopedKey contains the machine id");
    assert.ok(alpha.scopedKey.includes(path.basename(fixture)), "scopedKey contains the workspace basename");
    assert.ok(alpha.scopedKey.includes("pi_alpha"), "scopedKey contains the session id");
    // malformed files skipped with warnings — never a crash
    assert.ok(!r.result.sessions.some((/** @type {{sessionId: string}} */ s) => s.sessionId === "broken"));
    assert.ok(!r.result.sessions.some((/** @type {{sessionId: string}} */ s) => s.sessionId === "nonobject"));
    assert.ok(Array.isArray(r.result.warnings) && r.result.warnings.length >= 2, "both malformed files warned");
    assert.ok(r.result.warnings.some((/** @type {string} */ w) => w.includes("broken.json")), "warning names broken.json");
    assert.ok(r.result.warnings.some((/** @type {string} */ w) => w.includes("nonobject.json")), "warning names nonobject.json");
    // watchdog summary: only state === "open" counts; malformed ignored
    assert.deepEqual(r.result.incidents, { open: 1 });
    // epoch is a STATE version: unchanged content -> same epoch (no bump)
    const r2 = await b.request("r2", "runtime.snapshot");
    assert.equal(r2.result.epoch, r.result.epoch, "epoch stable while content unchanged");
  } finally {
    await b.close();
  }
});

test("serve: subscribe -> sessions change -> runtime event; unsubscribe stops events", async () => {
  const b = startServe();
  try {
    await handshake(b);
    const sub = await b.request("s1", "runtime.subscribe");
    assert.equal(sub.ok, true, `subscribe failed: ${JSON.stringify(sub.error ?? null)}`);
    assert.equal(sub.result.epoch, 0, "baseline epoch before any change");
    assert.ok(Number.isInteger(sub.result.cursor), "cursor is the resume point");

    // change the sessions dir: a new session file must surface as an event
    writeSession("pi_beta.json", { platform: "codex", last_seen_at: "2026-09-17T09:00:00Z", current_task: null });
    const ev = await b.awaitMsg(
      (m) => m.type === "event" && m.channel === "runtime" && m.payload?.sessions?.some((/** @type {{sessionId: string}} */ s) => s.sessionId === "pi_beta"),
      "runtime event carrying pi_beta",
    );
    assert.equal(ev.epoch, 0, "frame channel epoch defaults to 0 before any snapshot binding (§8.5)");
    assert.equal(ev.seq, 0, "first event seq starts at 0 (§8.5)");
    assert.ok(typeof ev.at === "string" && ev.at.length > 0, "event carries a timestamp");
    assert.equal(ev.payload.kind, "runtime.sessions");
    assert.equal(ev.payload.epoch, sub.result.epoch + 1, "payload epoch incremented");
    assert.deepEqual(ev.payload.incidents, { open: 1 });
    const beta = ev.payload.sessions.find((/** @type {{sessionId: string}} */ s) => s.sessionId === "pi_beta");
    assert.equal(beta.platform, "codex", "event payload carries the refreshed session list");

    // unsubscribe stops the events for this client
    const un = await b.request("s2", "runtime.unsubscribe");
    assert.equal(un.ok, true);
    assert.equal(un.result.stopped, true);
    const eventsBefore = runtimeEvents(b).length;
    writeSession("pi_after_unsub.json", { platform: "pi", last_seen_at: "2026-09-17T10:00:00Z", current_task: null });
    // outlive one full poll cycle (RUNTIME_POLL_MS) while the server is alive
    const keepalive = await b.request("s3", "workspace.describe");
    assert.equal(keepalive.ok, true, "server still answering after unsubscribe");
    await sleep(RUNTIME_POLL_MS + 900);
    assert.equal(runtimeEvents(b).length, eventsBefore, "no events after unsubscribe");
    // idempotent unsubscribe; snapshot still reflects the late addition
    const un2 = await b.request("s4", "runtime.unsubscribe");
    assert.deepEqual(un2.result, { stopped: false, subscribers: 0 });
    const snap = await b.request("s5", "runtime.snapshot");
    assert.ok(snap.result.sessions.some((/** @type {{sessionId: string}} */ s) => s.sessionId === "pi_after_unsub"));
  } finally {
    await b.close();
  }
});

test("serve: provider failure never kills the server; stdout stays protocol-only", async () => {
  const b = startServe();
  try {
    await handshake(b);
    // a provider-level rejection is surfaced as provider_failed...
    const r1 = await b.request("f1", "knowledge.get", { path: "../../escape.md" });
    assert.equal(r1.ok, false, "provider rejection surfaced");
    assert.equal(r1.error?.code, "provider_failed");
    // ...and the very next request still works
    const r2 = await b.request("f2", "runtime.snapshot");
    assert.equal(r2.ok, true, "next request still works after a provider failure");
    const r3 = await b.request("f3", "runtime.unsubscribe");
    assert.deepEqual(r3.result, { stopped: false, subscribers: 0 }, "unsubscribe without subscribe is a no-op");
    // stderr is the LOG channel (contract §8.2) — environment-dependent
    // warnings are fine; what matters is that protocol frames never leak there
    assert.ok(!/\\"type\\":\\"(request|response|event)\\"/.test(b.stderrText()), "no protocol frames on stderr");
  } finally {
    await b.close();
  }
});

// ------------------------------------------------- in-process provider units

/** @param {{clientId: string, closed?: boolean}} o minimal server double */
function fakeServer(o) {
  return {
    clientId: o.clientId,
    closed: o.closed ?? false,
    /** @param {NodeJS.Timeout} t */ ownTimer: (t) => t,
    /** @param {NodeJS.Timeout} _t */ disownTimer: (_t) => {},
    channelCursor: () => ({ epoch: 0, cursor: -1 }),
    /** @param {string} _c @param {object} _p */ event: (_c, _p) => "{}\n",
    /** @param {string} _l */ pushFrame: (_l) => true,
  };
}

test("providers: subscribe caps distinct subscribers; provider stays healthy after refusal", async () => {
  const store = KnowledgeStore.open(fixture);
  const providers = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });

  // 16 distinct subscribers fit; the 17th is refused with a conflict, and the
  // provider (hence the server) stays healthy afterwards.
  for (let i = 0; i < RUNTIME_MAX_SUBSCRIBERS; i++) {
    const res = await providers.runtime.subscribe({}, { server: fakeServer({ clientId: `client-${i}` }) });
    assert.equal(res.epoch, 0);
  }
  await assert.rejects(
    () => providers.runtime.subscribe({}, { server: fakeServer({ clientId: "one-too-many" }) }),
    (/** @type {Error & {code?: string}} */ e) => e.code === "conflict",
  );
  const snap = await providers.runtime.snapshot();
  assert.ok(Array.isArray(snap.sessions), "provider still healthy after cap refusal");

  // re-subscribe replaces instead of stacking
  const again = await providers.runtime.subscribe({}, { server: fakeServer({ clientId: "client-0" }) });
  assert.equal(again.epoch, 0, "re-subscribe accepted (replace semantics)");

  // cleanup: drop every subscription so the shared poll interval stops and
  // this process can exit (no live timer keeps node --test hanging)
  for (let i = 0; i < RUNTIME_MAX_SUBSCRIBERS; i++) {
    await providers.runtime.unsubscribe({}, { server: fakeServer({ clientId: `client-${i}` }) });
  }
  const drained = await providers.runtime.unsubscribe({}, { server: fakeServer({ clientId: "client-0" }) });
  assert.deepEqual(drained, { stopped: false, subscribers: 0 }, "extra unsubscribe is an idempotent no-op");
});

test("bridge: provider throw maps to provider_failed and the next request still works", async () => {
  const store = KnowledgeStore.open(fixture);
  const providers = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });
  providers.runtime.snapshot = async () => {
    throw new Error("boom");
  };
  const server = new BridgeServer({ providers, capabilities: [CAPABILITIES.RUNTIME_EVENTS, CAPABILITIES.PROJECT_READ] });
  const [hello] = await server.handleLine(
    JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, clientId: "unit", capabilities: [] }),
  );
  assert.equal(JSON.parse(/** @type {string} */ (hello)).accepted, true);

  const [failLine] = await server.handleLine(JSON.stringify({ type: "request", id: "u1", method: "runtime.snapshot", params: {} }));
  const failed = JSON.parse(/** @type {string} */ (failLine));
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "provider_failed");
  assert.match(failed.error.message, /boom/);

  const [okLine] = await server.handleLine(JSON.stringify({ type: "request", id: "u2", method: "workspace.describe", params: {} }));
  const ok = JSON.parse(/** @type {string} */ (okLine));
  assert.equal(ok.ok, true, "a failed provider never takes the server down");
});

test("bridge: subscribe registers an owned poll interval; close() clears it", async () => {
  const store = KnowledgeStore.open(fixture);
  const providers = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });
  const server = new BridgeServer({ providers, capabilities: [CAPABILITIES.RUNTIME_EVENTS] });
  server.onFrame(() => {}); // events must not crash without a transport sink either
  const [hello] = await server.handleLine(
    JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, clientId: "unit-close", capabilities: [] }),
  );
  assert.equal(JSON.parse(/** @type {string} */ (hello)).accepted, true);
  const [subLine] = await server.handleLine(JSON.stringify({ type: "request", id: "c1", method: "runtime.subscribe", params: {} }));
  const sub = JSON.parse(/** @type {string} */ (subLine));
  assert.equal(sub.ok, true, `subscribe failed: ${JSON.stringify(sub.error ?? null)}`);
  assert.equal(sub.result.cursor, -1, "fresh channel: cursor -1 so the first event (seq 0) applies");
  assert.equal(server._ownedTimers.size, 1, "poll interval owned by the server instance");
  server.close();
  assert.equal(server.closed, true);
  assert.equal(server._ownedTimers.size, 0, "close() cleared the owned interval");
  server.close(); // idempotent
  const [after] = await server.handleLine(JSON.stringify({ type: "request", id: "c2", method: "runtime.subscribe", params: {} }));
  const refused = JSON.parse(/** @type {string} */ (after));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "provider_failed");
  assert.match(refused.error.message, /closed/);
});
