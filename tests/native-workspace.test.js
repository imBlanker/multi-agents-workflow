import { fixtureEnv } from "./fixtures/test-env.mjs";
import { makeFixtureDb } from "./fixtures/make-db.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workspaceLayout } from "../src/workspace/backend.js";
import { recordSession } from "../src/workspace/sessions.js";
import { createProviders, RUNTIME_POLL_MS } from "../src/workspace/providers.js";
import { main, runUpdateLifecycle, runUpgradeLifecycle, repairMawOverlays } from "../src/index.js";
import { setIntegration } from "../src/integrations.js";
import { applyGrillSwap } from "../src/grillswap.js";
import { buildPhaseBPrompt } from "../src/watchdog/dispatch.js";

const BIN = fileURLToPath(new URL("../bin/mawf.js", import.meta.url));
function fixture(t, native = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".mawf"));
  if (native) fs.writeFileSync(path.join(root, ".mawf/workspace.json"), JSON.stringify({ version: 1, backend: "mawf", trellis: false }));
  return root;
}
/** Core commands emit one JSON object on stdout; capture it around `fn`. */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { return { value: await fn(), text: chunks.join("") }; }
  finally { process.stdout.write = original; }
}
function write(root, rel, value) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof value === "string" ? value : JSON.stringify(value));
}

test("marker is explicit, wins over leftover Trellis and fails closed", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".trellis"));
  assert.equal(workspaceLayout(root).native, true);
  for (const content of ["{", '{}', '{"version":2,"backend":"mawf","trellis":false}', '{"version":1,"backend":"mawf","trellis":true}']) {
    write(root, ".mawf/workspace.json", content);
    assert.throws(() => workspaceLayout(root), /workspace marker/);
    let called = false;
    // the lifecycle seams return promises in v1, so the refusal is a rejection
    await assert.rejects(runUpdateLifecycle({ project: root }, { updateMaw: () => { called = true; } }), /workspace marker/);
    assert.equal(called, false);
  }
  fs.unlinkSync(path.join(root, ".mawf/workspace.json"));
  assert.equal(workspaceLayout(root).native, false);
});

test("native lifecycle cannot invoke Trellis, including upgrade without templates", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".trellis"));
  // the native marker keeps its lifecycle opt-out even against a conflicting
  // Trellis selection (docs/V1_CORE.md), so both are selected here.
  for (const id of ["trellis", "grill", "cross-host-advise"]) setIntegration(root, id, true);
  let repairs = 0;
  const deps = {
    updateMaw: () => ({}), upgradeMaw: () => ({ ok: true }),
    repairOverlays: () => { repairs++; return { ok: true }; },
    runTrellis: () => assert.fail("must not invoke/download Trellis"),
  };
  assert.equal((await runUpdateLifecycle({ project: root }, deps)).ok, true);
  for (const opts of [{}, { dryRun: true }, { applyTemplates: false }]) {
    const result = await runUpgradeLifecycle({ project: root, ...opts }, deps);
    assert.equal(result.ok, true);
    // v1 records the skip as a stage and fabricates no Trellis result
    assert.equal(result.stages.find((s) => s.stage === "trellis upgrade").skipped, true);
    assert.equal(result.trellisUpgrade, null);
  }
  assert.equal(repairs, 2);
  assert.equal(applyGrillSwap(root).applied, false);
  const repair = await repairMawOverlays(root, {
    writeManagedBlocks() {}, readRegistry: () => ({}), resolveWatchList: () => [{ dir: root }],
    applyGrillSwap: () => assert.fail("must not inspect native grill wrapper"),
  });
  assert.equal(repair.ok, true);
  const prompt = buildPhaseBPrompt({ incident: { projectDir: root }, trellis: true });
  assert.match(prompt, /docs\/plans/);
  assert.doesNotMatch(prompt, /task\.py/);
});

test("native providers retain IDs, spec names, relations and historical artifact bytes", async (t) => {
  const root = fixture(t);
  write(root, "docs/plans/task-one/task.json", { name: "task-one", title: "One", status: "in_progress" });
  write(root, "docs/plans/task-one/prd.md", "acceptance");
  write(root, "docs/plans/task-one/implement.jsonl", '{"file":"docs/engineering/specs/api.md"}\n');
  write(root, "docs/engineering/specs/api.md", "contract");
  write(root, "docs/history/tasks/old/prd.md", "history");
  write(root, ".trellis/tasks/ignored/task.json", { title: "old" });
  const p = createProviders({ projectDir: root, store: {}, machineId: "m" });
  assert.deepEqual((await p.project.list()).projects, [{ id: path.basename(root), hasTrellis: false, backend: "mawf", hasWorkspace: true }]);
  assert.deepEqual((await p.project.tasks()).tasks.map(x => x.id), ["task-one"]);
  assert.equal((await p.project.get({ id: "task-one" })).hasPrd, true);
  assert.deepEqual((await p.project.specs()).specs, [{ name: "api.md", filled: true }]);
  assert.deepEqual((await p.project.relations()).groups[0].files, ["docs/engineering/specs/api.md"]);
  const arts = (await p.artifact.list()).artifacts;
  assert.ok(arts.some(x => x.rel === "docs/history/tasks/old/prd.md"));
  assert.ok(!arts.some(x => x.rel.startsWith(".trellis")));
  await assert.rejects(p.artifact.read({ rel: "../outside.md" }), /escapes/);
});

test("native producer drives snapshots, stop state and subscription events", async (t) => {
  const root = fixture(t);
  const p = createProviders({ projectDir: root, store: {}, machineId: "m" });
  assert.deepEqual((await p.runtime.snapshot()).sessions, []);
  recordSession(root, "start", { id: "codex-one", platform: "codex", task: "task-one" }, "2026-10-12T00:00:00Z");
  let state = await p.runtime.snapshot();
  assert.equal(state.sessions[0].currentTask, "task-one");
  assert.equal(state.sessions[0].status, "active");
  assert.equal(state.epoch, 1);
  let resolveEvent;
  const event = new Promise(resolve => { resolveEvent = resolve; });
  const server = {
    clientId: "native-client", closed: false, ownTimer: timer => timer, disownTimer() {},
    channelCursor: () => ({ cursor: -1 }), event: (channel, payload) => ({ channel, payload }),
    pushFrame: frame => resolveEvent(frame),
  };
  await p.runtime.subscribe({}, { server });
  t.after(() => p.runtime.unsubscribe({}, { server }));
  recordSession(root, "stop", { id: "codex-one" }, "2026-10-12T00:01:00Z");
  let timeout;
  const frame = await Promise.race([event, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("missing runtime event")), RUNTIME_POLL_MS * 3); })]).finally(() => clearTimeout(timeout));
  assert.equal(frame.channel, "runtime");
  assert.equal(frame.payload.sessions[0].status, "stopped");
  await p.runtime.unsubscribe({}, { server });
  state = await p.runtime.snapshot();
  assert.equal(state.sessions[0].status, "stopped");
  assert.equal(state.sessions[0].endedAt, "2026-10-12T00:01:00Z");
  assert.throws(() => recordSession(root, "heartbeat", { id: "codex-one" }), /stopped/);
  assert.throws(() => recordSession(root, "start", { id: "../escape" }), /session id/);
  assert.equal(fs.readdirSync(path.join(root, ".mawf/runtime/sessions")).length, 1);
});

test("session CLI accepts hook input, handles end and rejects malformed input", (t) => {
  const root = fixture(t);
  const cli = (input) => spawnSync(process.execPath, [BIN, "session", "hook", "--stdin", "--project", root, "--platform", "claude", "--json"], { input, encoding: "utf8" });
  const start = cli(JSON.stringify({ session_id: "real-session", hook_event_name: "SessionStart" }));
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).status, "active");
  const end = cli(JSON.stringify({ session_id: "real-session", hook_event_name: "SessionEnd" }));
  assert.equal(end.status, 0, end.stderr);
  assert.equal(JSON.parse(end.stdout).status, "stopped");
  assert.equal(cli("{").status, 1);
  assert.equal(cli(JSON.stringify({ session_id: "real-session", hook_event_name: "unknown" })).status, 1);
});

test("native storage rejects symlink escapes", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  const outside = fixture(t, false);
  fs.mkdirSync(path.join(root, "docs"));
  fs.symlinkSync(outside, path.join(root, "docs/plans"));
  assert.throws(() => workspaceLayout(root), /symlink/);
});


test("bridge hello accepts native marker without .trellis and refuses malformed marker", (t) => {
  const root = fixture(t);
  // a workspace chosen at handshake rechecks its own selection, so the
  // transport must be selected for that root (docs/V1_CORE.md).
  setIntegration(root, "workspace-bridge", true);
  write(root, "docs/plans/t/task.json", { title: "native task" });
  const hello = { type: "hello", v: 1, clientId: "native-test", capabilities: ["project.read"], workspaces: [{ refVersion: 1, endpoint: { kind: "ssh", host: "fixture" }, root }] };
  const request = { type: "request", id: "tasks", method: "project.tasks", params: {} };
  const run = () => spawnSync(process.execPath, [BIN, "bridge", "serve", "--machine-id", "native-machine"], { input: `${JSON.stringify(hello)}\n${JSON.stringify(request)}\n`, encoding: "utf8", timeout: 15000 });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  let frames = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames[0].accepted, true, result.stdout);
  assert.equal(frames.find(f => f.id === "tasks").result.tasks[0].id, "t");
  write(root, ".mawf/workspace.json", "{}");
  result = run();
  frames = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames[0].accepted, false);
});

test("native upgrade CLI reports skip rather than upgraded Trellis", async (t) => {
  const root = fixture(t);
  setIntegration(root, "trellis", true);
  const { value, text } = await captureStdout(() => main(["upgrade", "--project", root], {
    migrateLegacyMawDirs: () => [],
    upgradeMaw: () => ({ ok: true, output: [], mode: "test" }),
    repairOverlays: () => ({ ok: true, repaired: 0 }),
    runTrellis: () => assert.fail("must not invoke Trellis in a native workspace"),
  }));
  assert.equal(value, 0);
  const report = JSON.parse(text);
  const stage = report.stages.find((s) => s.stage === "trellis upgrade");
  assert.equal(stage.skipped, true);
  assert.match(stage.reason, /Not selected or native workspace/);
  assert.equal(report.trellisUpgrade, null, "no Trellis result is fabricated");
  assert.doesNotMatch(text, /trellis CLI: upgraded|partially succeeded/);
});


test("native init honors marker without --no-trellis and doctor does not request Trellis", (t) => {
  const root = fixture(t);
  const home = fixture(t, false);
  const db = path.join(home, "fixture.db");
  makeFixtureDb(db);
  const env = fixtureEnv(home, { CC_SWITCH_DB: db, TRELLIS_BIN: process.execPath });
  // TRELLIS_BIN points at a real executable: even a discoverable Trellis must
  // not be chained, because the native marker is the authority.
  const result = spawnSync(process.execPath, [BIN, "init", "--project", root, "-u", "fixture", "--no-watchdog"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.project, root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".mawf/workspace.json"), "utf8")).trellis, false);
  assert.ok(!report.stages.some((s) => s.integration === "trellis"), "no Trellis stage ran");
  assert.equal(fs.existsSync(path.join(root, ".trellis")), false);
  const logDir = path.join(root, ".mawf/logs");
  assert.ok(!fs.existsSync(logDir) || !fs.readdirSync(logDir).some(f => f.startsWith("trellis-init-")));
  const doctor = JSON.parse(spawnSync(process.execPath, [BIN, "doctor", "--project", root], { env, encoding: "utf8", timeout: 15000 }).stdout);
  assert.equal(doctor.checks.find((c) => c.name === "storage").detail, "native MAWF");
  assert.ok(!doctor.capabilities.some((c) => c.id === "trellis" && c.selected), "Trellis is not requested");
  assert.ok(!doctor.checks.some((c) => /trellis/i.test(c.name)));
});
