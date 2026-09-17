// @ts-check
// Tests for src/workspace/bridge.js — server-half protocol logic, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeServer } from "../src/workspace/bridge.js";
import { CAPABILITIES, ERR, MAX_FRAME_BYTES, PROTOCOL_VERSION, helloClient } from "../src/workspace/protocol.js";

const ALL_CAPS = Object.values(CAPABILITIES);

function stubProviders() {
  return {
    workspace: { describe: async () => ({ name: "ws" }) },
    project: {
      list: async () => ({ projects: [{ id: "p1" }] }),
      get: async (p) => {
        if (!p?.id) throw new Error("task id required");
        return { id: p.id };
      },
    },
    knowledge: { get: async (p) => ({ id: String(p?.id ?? "") }) },
  };
}

function makeServer(overrides = {}) {
  return new BridgeServer({
    providers: stubProviders(),
    capabilities: ALL_CAPS,
    serverId: "test-bridge",
    ...overrides,
  });
}

async function handshake(s, caps = [CAPABILITIES.PROJECT_READ, CAPABILITIES.KNOWLEDGE_READ]) {
  const lines = await s.handleLine(JSON.stringify(helloClient({ clientId: "c1", capabilities: caps })));
  return JSON.parse(lines[0]);
}

const parse = (lines) => lines.map((l) => JSON.parse(l));

test("hello handshake accepts a compatible client and negotiates capabilities", async () => {
  const s = makeServer();
  const reply = await handshake(s);
  assert.equal(reply.type, "hello_ok");
  assert.equal(reply.accepted, true);
  assert.equal(reply.serverId, "test-bridge");
  assert.deepEqual(s.negotiated.shared, [CAPABILITIES.KNOWLEDGE_READ, CAPABILITIES.PROJECT_READ]);
  assert.deepEqual(s.negotiated.serverMissing, [], "client declared nothing extra");
  assert.ok(s.negotiated.clientMissing.length > 0, "unoffered caps reported to the client side");
});

test("hello refusal on version mismatch carries ERR.PROTOCOL_VERSION and is terminal", async () => {
  const s = makeServer();
  const [reply] = parse(
    await s.handleLine(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION + 1, clientId: "c1", capabilities: [] })),
  );
  assert.equal(reply.accepted, false);
  assert.equal(reply.error.code, ERR.PROTOCOL_VERSION);
  assert.match(reply.error.message, /v2 != v1/);
  assert.equal(s.refused, true);
  // requests after a refusal are refused too — incompatible base protocol never degrades
  const [errLine] = parse(
    await s.handleLine(JSON.stringify({ type: "request", id: "1", method: "project.list" })),
  );
  assert.equal(errLine.error.code, ERR.PROTOCOL_VERSION);
});

test("requests before a handshake are rejected with BAD_MESSAGE", async () => {
  const s = makeServer();
  const [r] = parse(await s.handleLine(JSON.stringify({ type: "request", id: "1", method: "project.list" })));
  assert.equal(r.error.code, ERR.BAD_MESSAGE);
  assert.match(r.error.message, /handshake/);
});

test("unknown method (incl. exec) → ERR.UNKNOWN_METHOD — no exec ever", async () => {
  const s = makeServer();
  await handshake(s);
  for (const method of ["exec", "fs.readFile", "project.doAnything"]) {
    const [r] = parse(await s.handleLine(JSON.stringify({ type: "request", id: "1", method, params: {} })));
    assert.equal(r.error.code, ERR.UNKNOWN_METHOD, method);
  }
});

test("provider success and error mapping", async () => {
  const s = makeServer();
  await handshake(s);
  const [ok] = parse(await s.handleLine(JSON.stringify({ type: "request", id: "r1", method: "project.list" })));
  assert.equal(ok.ok, true);
  assert.equal(ok.result.projects[0].id, "p1");
  // provider throw → PROVIDER_FAILED with the provider's message
  const [bad] = parse(await s.handleLine(JSON.stringify({ type: "request", id: "r2", method: "task.get", params: {} })));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, ERR.PROVIDER_FAILED);
  assert.match(bad.error.message, /task id required/);
  // a provider's own protocol code is preserved as providerCode metadata
  const throwing = stubProviders();
  throwing.project.get = async () => {
    const e = new Error("no such task");
    e.code = ERR.NOT_FOUND;
    throw e;
  };
  const s2 = makeServer({ providers: throwing });
  await handshake(s2);
  const [coded] = parse(await s2.handleLine(JSON.stringify({ type: "request", id: "r3", method: "task.get", params: { id: "x" } })));
  assert.equal(coded.error.code, ERR.PROVIDER_FAILED);
  assert.equal(coded.error.providerCode, ERR.NOT_FOUND);
});

test("missing provider or undeclared capability → ERR.CAPABILITY_MISSING", async () => {
  const s = makeServer();
  await handshake(s);
  // terminal provider absent, capability declared → no handler
  const [t1] = parse(await s.handleLine(JSON.stringify({ type: "request", id: "1", method: "terminal.snapshot" })));
  assert.equal(t1.error.code, ERR.CAPABILITY_MISSING);
  // capability not declared though provider exists → gate fires
  const s2 = makeServer({ capabilities: [CAPABILITIES.PROJECT_READ] });
  await handshake(s2);
  const [t2] = parse(await s2.handleLine(JSON.stringify({ type: "request", id: "2", method: "knowledge.get", params: { id: "k" } })));
  assert.equal(t2.error.code, ERR.CAPABILITY_MISSING);
});

test("request.cancel for an unknown id is a no-op ok response", async () => {
  const s = makeServer();
  await handshake(s);
  const [r] = parse(
    await s.handleLine(JSON.stringify({ type: "request", id: "9", method: "request.cancel", params: { cancelId: "does-not-exist" } })),
  );
  assert.equal(r.ok, true);
  assert.equal(r.result.cancelled, false);
});

test("snapshot/event ordering: per-channel epoch binding and monotonic seq", async () => {
  const s = makeServer();
  await handshake(s);
  const snap = JSON.parse(s.snapshot("runtime", 3, 100));
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.epoch, 3);
  assert.equal(snap.cursor, 100);
  const [ev1, ev2] = [JSON.parse(s.event("runtime", { k: 1 })), JSON.parse(s.event("runtime"))];
  assert.equal(ev1.epoch, 3);
  assert.equal(ev1.seq, 101, "events continue from the snapshot cursor");
  assert.equal(ev2.epoch, 3);
  assert.equal(ev2.seq, 102, "seq is monotonic within an epoch");
  // epoch bump rebinds the channel and restarts the sequence
  const snap2 = JSON.parse(s.snapshot("runtime", 4, 0));
  const ev3 = JSON.parse(s.event("runtime"));
  assert.equal(snap2.epoch, 4);
  assert.equal(ev3.epoch, 4);
  assert.equal(ev3.seq, 1);
  // events before any snapshot default to epoch 0, seq from 0
  const ev0 = JSON.parse(s.event("other"));
  assert.equal(ev0.epoch, 0);
  assert.equal(ev0.seq, 0);
  assert.throws(() => s.snapshot("runtime", -1), /epoch/);
});

test("malformed frames get structured BAD_MESSAGE responses", async () => {
  const s = makeServer();
  await handshake(s);
  const [r1] = parse(await s.handleLine("not json {"));
  assert.equal(r1.error.code, ERR.BAD_MESSAGE);
  const [r2] = parse(await s.handleLine("[1,2,3]"));
  assert.equal(r2.error.code, ERR.BAD_MESSAGE);
  const [r3] = parse(await s.handleLine(JSON.stringify({ type: "request", method: "project.list" })));
  assert.equal(r3.error.code, ERR.BAD_MESSAGE, "missing request id");
  const [r4] = parse(await s.handleLine("x".repeat(MAX_FRAME_BYTES + 2)));
  assert.equal(r4.error.code, ERR.BAD_MESSAGE, "oversized frame");
  const [r5] = parse(await s.handleLine(JSON.stringify({ type: "event", channel: "x", epoch: 0, seq: 0 })));
  assert.equal(r5.error.code, ERR.BAD_MESSAGE, "client cannot push events");
  const [r6] = parse(await s.handleLine(""));
  assert.equal(r6.error.code, ERR.BAD_MESSAGE, "empty frame");
});
