// @ts-check
// P4.2 integration proof: `mawf bridge serve` as a REAL subprocess speaking
// NDJSON over stdio against a fixture project (Trellis tasks/spec + knowledge
// store via store.create + docs/architecture artifacts).
//
// Asserts (dispatch P4.2 part 1):
// - hello_ok carries the stable machineId (resolved from <home>/.mawf/bridge/machine-id)
// - project.tasks returns the demo task; per-instance epoch increments
// - knowledge.search finds the decision doc via a Chinese keyword (CJK bigrams)
// - artifact.read returns sha256 matching fs content
// - `..`, absolute and symlink escapes are rejected with structured
//   workspace_unauthorized errors and NO file content (contract §12.1)
// - stdout carries protocol frames only (every line must JSON.parse)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

import { fixtureEnv } from "./fixtures/test-env.mjs";
import { KnowledgeStore, contentHash } from "../src/knowledge/store.js";
import { CAPABILITIES, PROTOCOL_VERSION } from "../src/workspace/protocol.js";
import { createProviders, KNOWLEDGE_BODY_MAX_BYTES } from "../src/workspace/providers.js";
import { machineIdPath } from "../src/workspace/cli.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mawf.js");
const MACHINE_ID = "0123456789abcdef-fixture-machine";

// ----------------------------------------------------------------- fixture
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maw-bridge-serve-"));
const homeDir = path.join(tmpRoot, "home");
const fixture = path.join(tmpRoot, "proj");
const outsideSecret = path.join(tmpRoot, "outside-secret.md");

const TASK_DIR = path.join(fixture, ".trellis", "tasks", "09-17-demo");
fs.mkdirSync(TASK_DIR, { recursive: true });
fs.writeFileSync(path.join(TASK_DIR, "task.json"), JSON.stringify({
  name: "09-17-demo",
  title: "Demo integration task",
  status: "in_progress",
  priority: "P2",
  updatedAt: "2026-09-22T08:00:00Z",
}));
fs.writeFileSync(path.join(TASK_DIR, "prd.md"), "# Demo PRD\n\nBody stays on the server.\n");
fs.writeFileSync(path.join(TASK_DIR, "implement.jsonl"), [
  JSON.stringify({ _example: "seed row without a file field" }),
  JSON.stringify({ file: "src/workspace/providers.js" }),
  JSON.stringify({ file: "tests/workspace-bridge-serve.test.js" }),
  JSON.stringify({ file: "src/workspace/providers.js" }), // duplicate edge → deduped
].join("\n") + "\n");

fs.mkdirSync(path.join(fixture, ".trellis", "spec", "backend"), { recursive: true });
fs.writeFileSync(path.join(fixture, ".trellis", "spec", "backend", "x.md"), "# backend spec\n");
fs.mkdirSync(path.join(fixture, ".trellis", "spec", "empty-dir"), { recursive: true });

fs.mkdirSync(path.join(fixture, "docs", "architecture"), { recursive: true });
const OK_HTML = "<!doctype html><html><body><h1>ok architecture</h1></body></html>\n";
fs.writeFileSync(path.join(fixture, "docs", "architecture", "ok.html"), OK_HTML);
fs.writeFileSync(path.join(fixture, "docs", "architecture", "skip.txt"), "wrong extension — never listed\n");

// Knowledge doc THROUGH store.create() so sidecars (sourceTask) are exercised.
const DECISION_TEXT = `# Agent Note: 桥接协议选型

Status: implemented

## Problem

Card 面板与远端 helper 需要一致的只读数据通道。

## Decision

采用 NDJSON 帧协议，由 mawf bridge serve 提供类型化只读 RPC。

## Consequences

大产物需要分块与摘要校验。

## Alternatives considered

- 复用 Tauri IPC：跨 SSH 不可行，已否决。
`;
const store = KnowledgeStore.open(fixture);
store.create("decision", "implemented/architecture/2026-09-22-demo.md", DECISION_TEXT, { sourceTask: "09-17-demo" });

fs.writeFileSync(outsideSecret, "TOP SECRET — must never be readable through the bridge\n");
// symlink escape vector: artifact path inside root pointing OUTSIDE the root
fs.symlinkSync(outsideSecret, path.join(fixture, "docs", "architecture", "evil.html"));

// Pre-provision the stable machine id so the handshake assertion is exact.
fs.mkdirSync(path.dirname(machineIdPath(homeDir)), { recursive: true });
fs.writeFileSync(machineIdPath(homeDir), MACHINE_ID + "\n", { mode: 0o600 });

// ------------------------------------------------------------- stdio client

/**
 * Spawn `mawf bridge serve --project <fixture>` and speak NDJSON to it.
 * Every stdout line must parse as JSON — this is the protocol-only proof.
 */
function startServe(extraArgs = []) {
  const lazy = extraArgs.includes("--lazy");
  const argList = lazy ? ["bridge", "serve"] : ["bridge", "serve", "--project", fixture];
  const child = spawn(process.execPath, [BIN, ...argList], {
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
    // Windows reliability: child kill/exit events are flaky on CI runners —
    // end stdin (graceful server exit), then double-kill, and NEVER wait for
    // the exit event unbounded.
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already dead */ }
    try { child.kill("SIGKILL"); } catch { /* not on win32 */ }
    await new Promise((res) => {
      const t = setTimeout(res, 3000);
      child.once("exit", () => { clearTimeout(t); res(); });
    });
  };
  return { child, send, request, awaitMsg, close, stderrText: () => stderr.join("") };
}

async function handshake(b) {
  b.send({ type: "hello", v: PROTOCOL_VERSION, clientId: "serve-test", capabilities: Object.values(CAPABILITIES) });
  return b.awaitMsg((m) => m.type === "hello_ok", "hello_ok");
}

const errOf = (r) => r?.error ?? {};

// ------------------------------------------------------------------ tests

test("serve: handshake carries stable machineId; describe/list identity is exact", async () => {
  const b = startServe();
  try {
    const hello = await handshake(b);
    assert.equal(hello.accepted, true);
    assert.equal(hello.serverId, "mawf-bridge");
    assert.equal(hello.machineId, MACHINE_ID, "hello_ok carries the file-provisioned machine id");
    for (const cap of ["project.read", "knowledge.read", "artifact.read", "artifact.chunked", "terminal.metadata"]) {
      assert.ok(hello.capabilities.includes(cap), `capability ${cap} offered`);
    }
    const desc = await b.request("d1", "workspace.describe");
    assert.equal(desc.ok, true);
    assert.equal(desc.result.machineId, MACHINE_ID);
    assert.equal(desc.result.protocolVersion, 1);
    assert.equal(desc.result.root, fs.realpathSync(fixture));
    assert.equal(desc.result.label, `local:${fs.realpathSync(fixture)}`);
    const list = await b.request("d2", "project.list");
    assert.deepEqual(list.result.projects, [{ id: path.basename(fixture), hasTrellis: true }]);
    const term = await b.request("d3", "terminal.snapshot");
    assert.equal(term.ok, true);
    assert.equal(typeof term.result.available, "boolean", "tmux metadata is fail-open, never a crash");
    assert.ok(Array.isArray(term.result.panes ?? []), "panes array present when available");
  } finally {
    await b.close();
  }
});

test("serve: project.tasks/task.get/specs/relations read the Trellis surface", async () => {
  const b = startServe();
  try {
    await handshake(b);
    const t1 = await b.request("t1", "project.tasks");
    assert.equal(t1.ok, true);
    assert.ok(Number.isInteger(t1.result.epoch) && t1.result.epoch >= 1, "epoch is an in-memory incrementing integer");
    const demo = t1.result.tasks.find((x) => x.id === "09-17-demo");
    assert.ok(demo, "demo task listed");
    assert.equal(demo.title, "Demo integration task");
    assert.equal(demo.status, "in_progress");
    assert.equal(demo.priority, "P2");
    const t2 = await b.request("t2", "project.tasks");
    assert.equal(t2.result.epoch, t1.result.epoch + 1, "epoch increments per server instance");
    const g = await b.request("t3", "task.get", { id: "09-17-demo" });
    assert.equal(g.ok, true);
    assert.equal(g.result.task.title, "Demo integration task");
    assert.equal(g.result.hasPrd, true);
    assert.equal(g.result.hasDesign, false);
    assert.equal(g.result.hasImplement, false);
    const specs = await b.request("t4", "project.specs");
    const backend = specs.result.specs.find((s) => s.name === "backend");
    assert.deepEqual(backend, { name: "backend", filled: true });
    const empty = specs.result.specs.find((s) => s.name === "empty-dir");
    assert.deepEqual(empty, { name: "empty-dir", filled: false });
    const rel = await b.request("t5", "project.relations");
    const group = rel.result.groups.find((x) => x.task === "09-17-demo");
    assert.ok(group, "relations group for demo task");
    assert.deepEqual(group.files, [
      "src/workspace/providers.js",
      "tests/workspace-bridge-serve.test.js",
    ], "file: edges extracted, seed rows skipped, duplicates deduped");
  } finally {
    await b.close();
  }
});

test("serve: knowledge.search finds the doc via Chinese keyword; get carries hash+sidecar", async () => {
  const b = startServe();
  try {
    await handshake(b);
    const s = await b.request("k1", "knowledge.search", { q: "桥接" });
    assert.equal(s.ok, true);
    assert.ok(s.result.candidates.length >= 1, "CJK bigram search matches the decision title");
    const top = s.result.candidates[0];
    assert.match(top.path, /implemented\/architecture\/2026-09-22-demo\.md$/);
    assert.equal(top.provenance?.sourceTask, "09-17-demo", "sidecar provenance flows through the index");
    const get = await b.request("k2", "knowledge.get", { path: top.path });
    assert.equal(get.ok, true);
    assert.equal(get.result.truncated, false);
    assert.equal(get.result.hash, contentHash(DECISION_TEXT));
    assert.equal(get.result.title, "桥接协议选型");
    assert.match(get.result.text, /NDJSON 帧协议/);
  } finally {
    await b.close();
  }
});

test("serve: artifact read/chunk/receipt deliver digests matching fs content", async () => {
  const b = startServe();
  try {
    await handshake(b);
    const listing = await b.request("a0", "artifact.list");
    const rels = listing.result.artifacts.map((a) => a.rel);
    assert.ok(rels.includes("docs/architecture/ok.html"));
    assert.ok(!rels.some((r) => r.endsWith(".txt")), "non-allowlisted extensions never listed");
    const read = await b.request("a1", "artifact.read", { rel: "docs/architecture/ok.html" });
    assert.equal(read.ok, true);
    const expectedSha = (await crypto.subtle.digest("SHA-256", Buffer.from(OK_HTML, "utf8")));
    const expectedHex = [...new Uint8Array(expectedSha)].map((x) => x.toString(16).padStart(2, "0")).join("");
    assert.equal(read.result.sha256, expectedHex, "sha256 matches fs content");
    assert.equal(read.result.bytes, Buffer.byteLength(OK_HTML));
    assert.equal(read.result.text, OK_HTML);
    const receipt = await b.request("a2", "artifact.receipt", { rel: "docs/architecture/ok.html" });
    assert.deepEqual(receipt.result, { rel: "docs/architecture/ok.html", sha256: expectedHex, bytes: Buffer.byteLength(OK_HTML) });
    const c1 = await b.request("a3", "artifact.chunk", { rel: "docs/architecture/ok.html", offset: 0, length: 4 });
    assert.equal(c1.result.done, false);
    const c2 = await b.request("a4", "artifact.chunk", { rel: "docs/architecture/ok.html", offset: 4, length: 1_000_000 });
    assert.equal(c2.result.done, true);
    assert.equal(c2.result.sha256, expectedHex);
    const joined = Buffer.concat([Buffer.from(c1.result.data, "base64"), Buffer.from(c2.result.data, "base64")]);
    assert.deepEqual([...joined], [...Buffer.from(OK_HTML, "utf8")], "chunks reassemble to the exact file bytes");
  } finally {
    await b.close();
  }
});

test("serve: escapes are rejected with workspace_unauthorized and NO content", async () => {
  const b = startServe();
  try {
    await handshake(b);
    for (const [i, rel] of [
      "../../etc/passwd", // .. escape outside the root
      "/etc/passwd", // absolute path
      "../outside-secret.md", // .. escape to an EXISTING file outside the root
      "docs/architecture/evil.html", // symlink escape (fixture symlink → outsideSecret)
    ].entries()) {
      const r = await b.request(`x${i}`, "artifact.read", { rel });
      assert.equal(r.ok, false, `escape rejected: ${rel}`);
      assert.equal(errOf(r).code, "provider_failed");
      assert.equal(errOf(r).providerCode, "workspace_unauthorized", rel);
      assert.equal(r.result, undefined, "no file content on rejection");
      assert.match(errOf(r).message, /workspace root|absolute/);
    }
    const badTask = await b.request("x9", "task.get", { id: "../outside-secret.md" });
    assert.equal(badTask.ok, false);
    assert.equal(errOf(badTask).providerCode, "not_found", "task ids are single-segment");
  } finally {
    await b.close();
  }
});

test("bridge machine-id subcommand: stable across calls, provisions the file", () => {
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "maw-bridge-id-"));
  const run = () => execFileSync(process.execPath, [BIN, "bridge", "machine-id"], {
    env: fixtureEnv(freshHome), encoding: "utf8",
  });
  const first = run().trim();
  assert.match(first, /^[0-9a-f-]{36}$/, "provisioned id is a UUID");
  assert.equal(fs.readFileSync(machineIdPath(freshHome), "utf8").trim(), first);
  assert.equal(run().trim(), first, "second call returns the SAME id (stable)");
  fs.rmSync(freshHome, { recursive: true, force: true, maxRetries: 3 });
});

// ------------------------------------------------- in-process provider units

test("providers: knowledge.get truncates bodies above 64KB with truncated flag", async () => {
  const big = "很".repeat(70_000); // 210KB utf8 > 64KB budget
  const bigText = `# Agent Note: 大文档截断

Status: implemented

## Problem

${big}

## Decision

正文超过 64KB 时必须截断。

## Consequences

truncated 标志必须为 true。

## Alternatives considered

- 全量返回：超过帧预算，已否决。
`;
  store.create("decision", "implemented/architecture/2026-09-22-big.md", bigText, {});
  const providers = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });
  const got = await providers.knowledge.get({ path: "implemented/architecture/2026-09-22-big.md" });
  assert.equal(got.truncated, true);
  assert.ok(Buffer.byteLength(got.text, "utf8") <= KNOWLEDGE_BODY_MAX_BYTES, "returned body never exceeds 64KB");
  assert.equal(got.hash, contentHash(bigText), "hash covers the FULL content");
  assert.equal(got.lifecycle, "implemented");
});

test("providers: authorization rejects empty/NUL/escaping rels at the source", async () => {
  const providers = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });
  const unauthorized = (p) =>
    providers.artifact.receipt(p).then(
      () => { throw new Error(`expected rejection for ${JSON.stringify(p)}`); },
      (e) => e,
    );
  for (const p of [{ rel: "" }, { rel: ".\0hidden" }, { rel: "../outside-secret.md" }, { rel: "/etc/passwd" }]) {
    const e = await unauthorized(p);
    assert.equal(e.code, "workspace_unauthorized", JSON.stringify(p));
  }
  const missing = await unauthorized({ rel: "docs/architecture/nope.html" });
  assert.equal(missing.code, "not_found");
  // staying inside via .. is legitimate (realpath + containment, not a naive .. ban)
  const ok = await providers.artifact.receipt({ rel: "docs/../docs/architecture/ok.html" });
  assert.equal(ok.rel, "docs/architecture/ok.html");
  // per-instance epoch: a NEW provider set restarts its own counter
  const fresh = createProviders({ projectDir: fixture, store, machineId: MACHINE_ID });
  const e1 = await fresh.project.tasks();
  assert.equal(e1.epoch, 1);
});

test("onWorkspace: hello root builds providers; invalid/relative roots refuse the hello (§8.1)", async () => {
  // lazy mode: no --project; the root arrives via the hello (stdin, §8.1)
  const b = startServe(["--lazy"]);
  const ws = { refVersion: 1, endpoint: { kind: "ssh", host: "x" }, root: fixture };
  b.send({ type: "hello", v: PROTOCOL_VERSION, clientId: "onws", capabilities: ["project.read"], workspaces: [ws] });
  const hello = await b.awaitMsg((m) => m.type === "hello_ok", "hello_ok");
  assert.equal(hello.accepted, true, JSON.stringify(hello));
  const r = await b.request("r1", "project.tasks", {});
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 140));
  assert.ok(Array.isArray(r.result.tasks));
  await b.close();

  // invalid root (exists but no .trellis) -> hello refused with structured reason
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-no-trellis-"));
  const c = startServe(["--lazy"]);
  c.send({ type: "hello", v: PROTOCOL_VERSION, clientId: "onws2", capabilities: [], workspaces: [{ refVersion: 1, endpoint: { kind: "ssh", host: "x" }, root: emptyDir }] });
  const refused = await c.awaitMsg((m) => m.type === "hello_ok", "refused hello");
  assert.equal(refused.accepted, false);
  assert.match(refused.error?.message ?? "", /workspace rejected/);
  await c.close();

  // relative root -> refused without touching the filesystem
  const d = startServe(["--lazy"]);
  d.send({ type: "hello", v: PROTOCOL_VERSION, clientId: "onws3", capabilities: [], workspaces: [{ refVersion: 1, endpoint: { kind: "ssh", host: "x" }, root: "relative/path" }] });
  const refused2 = await d.awaitMsg((m) => m.type === "hello_ok", "refused hello (relative)");
  assert.equal(refused2.accepted, false);
  await d.close();
});
