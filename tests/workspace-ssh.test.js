// @ts-check
// Tests for src/workspace/ssh.js — NO real network. The "remote helper" is the
// in-fixture fake (tests/fixtures/fake-ssh-helper.mjs) spawned DIRECTLY via
// process.execPath through SshTransport's injectable argv builder, so the same
// spawn → hello → request code path runs without an ssh binary. A scripted
// fake child (injectable spawnFn) covers transport edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_PRE_HELLO_BYTES,
  SSH_FAILURE,
  SshTransport,
  buildSshArgs,
  classifySshFailure,
  FIXED_REMOTE_COMMAND, validateRemoteCommand,
} from "../src/workspace/ssh.js";
import { CAPABILITIES, ERR, MAX_FRAME_BYTES, helloServer } from "../src/workspace/protocol.js";
import { makeWorkspaceRef } from "../src/workspace/ref.js";

const HELPER = fileURLToPath(new URL("./fixtures/fake-ssh-helper.mjs", import.meta.url));

/** Fresh empty dir (record-dir injection seam). */
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mawf-ssh-rec-"));

const ref = () => makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/srv/proj" });

/** Test seam: spawn the fixture helper directly — host/remoteCommand are
 *  deliberately ignored (there is no ssh binary in this sandbox); argv goes to
 *  process.execPath via sshPath. */
const helperArgv =
  (...extra) =>
  () => [HELPER, "serve", ...extra];

const frame = (msg) => JSON.stringify(msg) + "\n";

/** Minimal scripted child: EventEmitter streams + recording stdin/kill. */
function makeFakeChild() {
  const stdout = new EventEmitter();
  stdout.pause = () => {
    stdout.paused = true;
  };
  stdout.resume = () => {
    stdout.paused = false;
  };
  const stderr = new EventEmitter();
  stderr.pause = () => {};
  stderr.resume = () => {};
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.written = [];
  child.stdin = {
    write: (s) => {
      child.written.push(String(s));
      return true;
    },
  };
  child.kill = (sig) => {
    child.killed = true;
    child.killSignal = sig;
    queueMicrotask(() => child.emit("close", null, sig));
    return true;
  };
  return child;
}

/** Drive connect() against a fake child and complete the hello handshake. */
async function handshakeFake(t, child, caps = Object.values(CAPABILITIES)) {
  const p = t.connect(ref(), { helperPath: "/opt/mawf/helper.mjs" });
  assert.match(child.written[0], /"type":"hello"/, "client hello is the first frame on stdin");
  child.stdout.emit("data", frame(helloServer({ serverId: "fake-srv", machineId: "mid-test-42", accepted: true, capabilities: caps })));
  const hello = await p;
  assert.equal(hello.machineId, "mid-test-42", "handshake surfaces the stable machine identity");
  return p;
}

async function waitFor(fn, ms = 2000, what = "condition") {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("buildSshArgs: fixed options + host alias + remote command only — business params never appear", () => {
  const args = buildSshArgs({ host: "devbox", remoteCommand: "/opt/mawf/helper.mjs" });
  assert.deepEqual(args, [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "RequestTTY=no",
    "--", "devbox", "/opt/mawf/helper.mjs",
  ]);
  // the MAWF-owned fixed entry (with spaces) is the sanctioned default
  assert.deepEqual(
    buildSshArgs({ host: "devbox", remoteCommand: FIXED_REMOTE_COMMAND }).slice(-2),
    ["devbox", FIXED_REMOTE_COMMAND],
  );
  const noBatch = buildSshArgs({ host: "devbox", remoteCommand: "/opt/mawf/helper.mjs", batchMode: false });
  assert.ok(!noBatch.includes("BatchMode=yes"), "BatchMode only when requested");
  assert.equal(noBatch.filter((x) => x.startsWith("-o")).length, 2);
  assert.ok(
    buildSshArgs({ host: "d", remoteCommand: "/x", connectTimeoutMs: 250 }).includes("ConnectTimeout=1"),
    "sub-second timeout clamps to 1s (ssh granularity)",
  );
  for (const bad of ["-oProxyCommand=evil", "host with space", "host\nx", ""]) {
    assert.throws(() => buildSshArgs({ host: bad, remoteCommand: "/x" }), /host/);
  }
});

test("remote command boundary: shell metacharacters and traversal are rejected (§12.2)", () => {
  const payloads = [
    "/opt/x; rm -rf /",            // command chaining
    "/opt/x && curl evil",          // chaining
    "/opt/$(whoami)",               // command substitution
    "/opt/`id`",                    // backtick substitution
    "/opt/a|b",                     // pipe
    "/opt/a&b",                     // background
    "/opt/my helper.mjs",           // space (would split into two shell words)
    "/opt/'quoted'",                // quotes
    "/opt/\"dq\"",                  // double quotes
    "/opt/$HOME/bin",               // variable expansion
    "/opt/*",                        // glob
    "/opt/~x",                       // tilde expansion
    "/opt/a\nb",                     // CR/LF injection
    "/opt/a\rb",                     // CR injection
    "mawf bridge serve; extra",     // fixed-string prefix games
    "relative/path.mjs",             // must be absolute
    "/opt/../etc/passwd",            // traversal
    "/opt//double//slash",           // empty segments
    "/opt/x\0y",                     // NUL
  ];
  for (const p of payloads) {
    assert.throws(() => validateRemoteCommand(p), Error, `must reject: ${JSON.stringify(p)}`);
    assert.throws(() => buildSshArgs({ host: "d", remoteCommand: p }), Error, `buildSshArgs must reject: ${JSON.stringify(p)}`);
  }
  // allowed forms
  assert.equal(validateRemoteCommand(FIXED_REMOTE_COMMAND), FIXED_REMOTE_COMMAND);
  assert.equal(validateRemoteCommand("/opt/mawf/helper.mjs"), "/opt/mawf/helper.mjs");
  assert.equal(validateRemoteCommand("/opt/mawf.helpers/bridge-v1.mjs"), "/opt/mawf.helpers/bridge-v1.mjs");
});

test("no helperPath and no install record falls back to FIXED_REMOTE_COMMAND (§8.2)", async () => {
  // Behavior change with install records (contract §8.2 PATH probe): without
  // an explicit helperPath the transport consults the install record and,
  // finding none, proceeds with the MAWF-owned fixed entry instead of
  // rejecting. The remote command reaching the argv builder is asserted via
  // the injected builder — no real ssh is spawned here.
  /** @type {{host: string, remoteCommand: string}[]} */
  const seen = [];
  const t = new SshTransport({
    sshPath: process.execPath,
    argvBuilder: (p) => {
      seen.push(p);
      return [HELPER, "serve"];
    },
    installRecordDir: emptyDir(),
  });
  try {
    const hello = await t.connect(ref(), {});
    assert.equal(hello.serverId, "fake-helper");
    assert.equal(seen[0].remoteCommand, FIXED_REMOTE_COMMAND, "fixed entry used when no record exists");
  } finally {
    t.close();
  }
});

test("handshake, capability negotiation and request roundtrips via the fixture helper", async () => {
  const t = new SshTransport({ sshPath: process.execPath, argvBuilder: helperArgv() });
  try {
    const hello = await t.connect(ref(), { helperPath: "/opt/mawf/helper.mjs" });
    assert.equal(hello.serverId, "fake-helper");
    assert.ok(hello.capabilities.includes(CAPABILITIES.PROJECT_READ));
    assert.ok(hello.negotiated.shared.includes(CAPABILITIES.KNOWLEDGE_READ));
    assert.deepEqual(hello.negotiated.clientMissing, [], "fixture helper offers every capability");

    const listing = await t.request("project.list");
    assert.equal(listing.projects[0].id, "p1");
    // CJK query travels via stdin frames, never the command line
    const hits = await t.request("knowledge.search", { q: "锁" });
    assert.match(hits.hits[0].title, /锁/);
    assert.equal((await t.request("workspace.describe")).name, "fake-ws");

    // unknown method never leaves the client (protocol allowlist)
    assert.throws(() => t.request("exec", { cmd: "never-executes" }), (e) => e.code === ERR.UNKNOWN_METHOD);
    // provider throw → structured PROVIDER_FAILED over the wire
    await assert.rejects(
      t.request("task.get", { id: "boom" }),
      (e) => e.code === ERR.PROVIDER_FAILED && /exploded/.test(e.message),
    );
  } finally {
    t.close();
  }
});

test("request timeout produces a structured TIMEOUT error and sends a cancel frame", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  await handshakeFake(t, child);
  await assert.rejects(
    t.request("project.list", {}, { timeoutMs: 50 }),
    (e) => e.code === ERR.TIMEOUT,
  );
  const cancel = child.written.find((s) => s.includes('"method":"request.cancel"'));
  assert.ok(cancel, "request.cancel sent for the timed-out request");
  assert.match(cancel, /"cancelId":"r1"/);
  t.close();
});

test("pre-hello banner noise is tolerated within the bounded budget", async () => {
  const t = new SshTransport({ sshPath: process.execPath, argvBuilder: helperArgv("--noise-lines", "20") });
  try {
    const hello = await t.connect(ref(), { helperPath: "unused" });
    assert.equal(hello.serverId, "fake-helper", "connect succeeds past bounded banner noise");
  } finally {
    t.close();
  }
});

test("pre-hello banner noise beyond the budget is rejected with BAD_MESSAGE", async () => {
  const t = new SshTransport({
    sshPath: process.execPath,
    argvBuilder: helperArgv("--noise-bytes", String(MAX_PRE_HELLO_BYTES * 2)),
  });
  await assert.rejects(
    t.connect(ref(), { helperPath: "unused" }),
    (e) => e.code === ERR.BAD_MESSAGE && /banner/.test(e.message),
  );
});

test("no protocol hello within the timeout is a structured TIMEOUT", async () => {
  const t = new SshTransport({
    sshPath: process.execPath,
    argvBuilder: helperArgv("--silent"),
    helloTimeoutMs: 150,
  });
  await assert.rejects(t.connect(ref(), { helperPath: "unused" }), (e) => e.code === ERR.TIMEOUT);
});

test("classifier: auth failure / host-key refusal / exit-127 / connect timeout are distinguishable", () => {
  const auth = classifySshFailure({ exitCode: 255, stderr: "user@devbox: Permission denied (publickey,password)." });
  assert.equal(auth.kind, SSH_FAILURE.AUTH);
  assert.equal(auth.code, ERR.WORKSPACE_UNAUTHORIZED);
  assert.equal(classifySshFailure({ stderr: "authentication failed for user" }).kind, SSH_FAILURE.AUTH);

  const hk = classifySshFailure({ exitCode: 255, stderr: "Host key verification failed." });
  assert.equal(hk.kind, SSH_FAILURE.HOST_KEY);
  assert.match(hk.message, /never bypassed/i);

  const nf = classifySshFailure({ exitCode: 127, stderr: "bash: helper: command not found" });
  assert.equal(nf.kind, SSH_FAILURE.REMOTE_NOT_FOUND);
  assert.equal(nf.code, ERR.CAPABILITY_MISSING);
  assert.match(nf.message, /install-helper/);

  const ct = classifySshFailure({ stderr: "ssh: connect to host devbox port 22: Connection timed out" });
  assert.equal(ct.kind, SSH_FAILURE.CONNECT_TIMEOUT);
  assert.equal(ct.code, ERR.TIMEOUT);
});

test("pre-hello exit with auth stderr rejects as WORKSPACE_UNAUTHORIZED with kind=auth", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  const p = t.connect(ref(), { helperPath: "/opt/mawf/helper.mjs" });
  child.stderr.emit("data", "devbox: Permission denied (publickey).\n");
  child.emit("close", 255, null);
  await assert.rejects(
    p,
    (e) => e.code === ERR.WORKSPACE_UNAUTHORIZED && e.kind === SSH_FAILURE.AUTH,
  );
});

test("responses for unknown ids are ignored with a warning, never a crash", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  /** @type {object[]} */
  const warnings = [];
  t.on("warning", (w) => warnings.push(w));
  await handshakeFake(t, child);
  child.stdout.emit("data", frame({ type: "response", id: "nope-404", ok: true, result: {} }));
  await waitFor(() => warnings.length === 1, 2000, "unknown-id warning");
  assert.equal(warnings[0].code, ERR.BAD_MESSAGE);
  t.close();
});

test("backpressure: stdout pauses past 64 queued frames and resumes after drain", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  let events = 0;
  t.on("event", () => {
    events += 1;
  });
  await handshakeFake(t, child);
  const chunk = Array.from({ length: 200 }, (_, i) =>
    frame({ type: "event", channel: "runtime", epoch: 1, seq: i, at: "2026-09-17T00:00:00Z", payload: { i } }),
  ).join("");
  child.stdout.emit("data", chunk);
  assert.equal(child.stdout.paused, true, "stdout paused once the consumer queue exceeded 64 frames");
  await waitFor(() => events === 200, 2000, "all events delivered");
  assert.equal(child.stdout.paused, false, "stdout resumed after the queue drained");
  t.close();
});

test("an oversized inbound frame is rejected with BAD_MESSAGE and the child is killed", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  /** @type {object[]} */
  const errors = [];
  t.on("error", (e) => errors.push(e));
  await handshakeFake(t, child);
  child.stdout.emit("data", Buffer.from("x".repeat(MAX_FRAME_BYTES + 16) + "\n", "utf8"));
  await waitFor(() => errors.length === 1, 2000, "protocol error");
  assert.equal(errors[0].code, ERR.BAD_MESSAGE);
  assert.equal(child.killed, true, "child killed after the framing violation");
  t.close();
});

test("close() kills only the child this transport spawned; later requests fail closed", async () => {
  const child = makeFakeChild();
  const t = new SshTransport({ spawnFn: () => child });
  await handshakeFake(t, child);
  const closed = new Promise((r) => t.once("close", r));
  t.close();
  await closed;
  assert.equal(child.killed, true);
  assert.equal(child.killSignal, "SIGTERM");
  await assert.rejects(t.request("project.list"), (e) => e.code === ERR.INTERNAL);
  t.close(); // double close is a no-op
});
