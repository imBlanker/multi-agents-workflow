// @ts-check
// Tests for src/workspace/protocol.js — pure wire-protocol logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION, MAX_FRAME_BYTES, ERR, CAPABILITIES, METHODS,
  helloClient, helloServer, negotiate, checkVersion,
  request, response, event, snapshotMeta,
  encodeFrame, decodeFrames, resumeDecision,
} from "../src/workspace/protocol.js";

test("handshake: matching version is compatible, mismatched refuses", () => {
  assert.deepEqual(checkVersion({ v: PROTOCOL_VERSION }), { compatible: true });
  const bad = checkVersion({ v: PROTOCOL_VERSION + 1 });
  assert.equal(bad.compatible, false);
  assert.match(bad.reason, /v2 != v1/);
  assert.equal(checkVersion({}).compatible, false);
});

test("helloServer refusal carries a structured protocol_version error", () => {
  const msg = helloServer({ serverId: "srv", accepted: false, reason: ERR.PROTOCOL_VERSION });
  assert.equal(msg.accepted, false);
  assert.equal(msg.error.code, ERR.PROTOCOL_VERSION);
});

test("capability negotiation reports shared and missing per side", () => {
  const n = negotiate([CAPABILITIES.PROJECT_READ, CAPABILITIES.KNOWLEDGE_READ], [CAPABILITIES.PROJECT_READ, CAPABILITIES.CANCEL]);
  assert.deepEqual(n.shared, [CAPABILITIES.PROJECT_READ]);
  assert.deepEqual(n.clientMissing, [CAPABILITIES.KNOWLEDGE_READ]); // server declared, client lacks
  assert.deepEqual(n.serverMissing, [CAPABILITIES.CANCEL]); // client declared, server lacks
  // unknown capability strings are dropped, never negotiated
  assert.deepEqual(negotiate(["make-coffee"], [CAPABILITIES.PROJECT_READ]).shared, []);
});

test("request validates method against the allowlist; no exec ever", () => {
  assert.throws(() => request({ id: "1", method: "exec", params: { cmd: "rm -rf /" } }),
    (e) => e.code === ERR.UNKNOWN_METHOD);
  assert.throws(() => request({ method: "project.list" }),
    (e) => e.code === ERR.BAD_MESSAGE);
  for (const m of METHODS) {
    assert.doesNotThrow(() => request({ id: "x", method: m }));
  }
  const r = request({ id: "r1", method: "knowledge.search", params: { q: "锁" } });
  assert.equal(r.type, "request");
  assert.equal(r.params.q, "锁");
});

test("response ok/error shapes", () => {
  const ok = response({ id: "1", ok: true, result: { a: 1 } });
  assert.deepEqual(ok, { type: "response", id: "1", ok: true, result: { a: 1 } });
  const bad = response({ id: "2", ok: false, error: { code: ERR.NOT_FOUND, message: "no task" } });
  assert.equal(bad.error.code, ERR.NOT_FOUND);
  assert.throws(() => response({ ok: true }), /id/);
});

test("events require epoch+seq; snapshotMeta binds epoch+cursor", () => {
  assert.throws(() => event({ channel: "runtime", seq: 1 }), /epoch/);
  assert.throws(() => event({ channel: "runtime", epoch: 0, seq: -1 }), /seq/);
  const ev = event({ channel: "runtime", epoch: 3, seq: 7, at: "2026-09-16T00:00:00Z", payload: { k: 1 } });
  assert.equal(ev.type, "event");
  assert.deepEqual(snapshotMeta({ channel: "runtime", epoch: 3, cursor: 7 }).type, "snapshot");
});

test("NDJSON framing round-trips across chunk boundaries", () => {
  const frames = [request({ id: "a", method: "project.list" }), event({ channel: "runtime", epoch: 1, seq: 0 })];
  const wire = frames.map(encodeFrame).join("");
  // feed byte-by-byte to force partial frames
  const state = {};
  const got = [];
  for (const ch of wire) got.push(...decodeFrames(ch, state));
  assert.deepEqual(got, frames);
  // final state must be empty (no dangling partial)
  assert.equal(state.rest, "");
});

test("oversized frames raise protocol errors instead of silent buffering", () => {
  const big = { type: "request", id: "x", method: "artifact.read", params: { blob: "y".repeat(MAX_FRAME_BYTES) } };
  assert.throws(() => encodeFrame(big), /MAX_FRAME_BYTES/);
  assert.throws(() => decodeFrames("x".repeat(MAX_FRAME_BYTES + 1), {}), /MAX_FRAME_BYTES/);
  assert.throws(() => decodeFrames("{broken json\n", {}), /bad_message|invalid JSON/);
});

test("resumeDecision: apply/duplicate/gap/epoch-resync are distinguishable", () => {
  const ev = (epoch, seq) => ({ channel: "runtime", epoch, seq });
  assert.equal(resumeDecision(ev(1, 5), { epoch: 1, cursor: 4 }), "apply");
  assert.equal(resumeDecision(ev(1, 4), { epoch: 1, cursor: 4 }), "duplicate"); // re-delivery
  assert.equal(resumeDecision(ev(1, 9), { epoch: 1, cursor: 4 }), "resync"); // lost window
  assert.equal(resumeDecision(ev(2, 0), { epoch: 1, cursor: 4 }), "resync"); // epoch bump
  assert.equal(resumeDecision(ev(1, 0), null), "resync"); // fresh subscribe needs snapshot
});
