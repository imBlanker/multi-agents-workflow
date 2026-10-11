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
function write(root, rel, value) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof value === "string" ? value : JSON.stringify(value));
}

test("marker is explicit, wins over leftover Trellis and fails closed", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".trellis"));
  assert.equal(workspaceLayout(root).native, true);
  for (const content of ["{", '{}', '{"version":2,"backend":"mawf","trellis":false}', '{"version":1,"backend":"mawf","trellis":true}']) {
    write(root, ".mawf/workspace.json", content);
    assert.throws(() => workspaceLayout(root), /workspace marker/);
    let called = false;
    assert.throws(() => runUpdateLifecycle({ project: root }, { updateMaw: () => { called = true; } }), /workspace marker/);
    assert.equal(called, false);
  }
  fs.unlinkSync(path.join(root, ".mawf/workspace.json"));
  assert.equal(workspaceLayout(root).native, false);
});

test("native lifecycle cannot invoke Trellis, including upgrade without templates", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".trellis"));
  let repairs = 0;
  const deps = {
    updateMaw: () => ({}), upgradeMaw: () => ({ ok: true }),
    repairOverlays: () => { repairs++; return { ok: true }; },
    runTrellis: () => assert.fail("must not invoke/download Trellis"),
  };
  assert.equal(runUpdateLifecycle({ project: root }, deps).ok, true);
  for (const opts of [{}, { dryRun: true }, { applyTemplates: false }]) {
    const result = runUpgradeLifecycle({ project: root, ...opts }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.trellisUpgrade.skipped, true);
  }
  assert.equal(repairs, 2);
  assert.equal(applyGrillSwap(root).applied, false);
  const repair = repairMawOverlays(root, {
    writeManagedBlocks() {}, readRegistry: () => ({}), resolveWatchList: () => [{ dir: root }],
    grillSwapStatus: () => assert.fail("must not inspect native grill wrapper"),
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

test("native upgrade CLI reports skip rather than upgraded Trellis", (t) => {
  const root = fixture(t);
  const lines = [];
  const codeBefore = process.exitCode;
  try {
    main(["upgrade", "--project", root], {
      migrateLegacyMawDirs: () => [], out: text => lines.push(text),
      runUpgradeLifecycle: () => ({ ok: true, maw: { ok: true, mode: "test" }, trellisUpgrade: { ok: true, skipped: true } }),
    });
    assert.match(lines.join("\n"), /Trellis lifecycle disabled/);
    assert.doesNotMatch(lines.join("\n"), /trellis CLI: upgraded|partially succeeded/);
    assert.equal(process.exitCode, codeBefore);
  } finally { process.exitCode = codeBefore; }
});


test("native init honors marker without --no-trellis and doctor does not request Trellis", (t) => {
  const root = fixture(t);
  const home = fixture(t, false);
  const db = path.join(home, "fixture.db");
  makeFixtureDb(db);
  const env = fixtureEnv(home, { CC_SWITCH_DB: db, TRELLIS_BIN: process.execPath });
  const result = spawnSync(process.execPath, [BIN, "init", "--project", root, "-u", "fixture", "--allow-pricey", "--no-watchdog"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native MAWF workspace: initialized/);
  assert.doesNotMatch(result.stdout, /chained automatically|trellis init:/);
  assert.equal(fs.existsSync(path.join(root, ".trellis")), false);
  const logDir = path.join(root, ".mawf/logs");
  assert.ok(!fs.existsSync(logDir) || !fs.readdirSync(logDir).some(f => f.startsWith("trellis-init-")));
  const doctor = spawnSync(process.execPath, [BIN, "doctor", "--project", root], { env, encoding: "utf8", timeout: 15000 });
  assert.match(doctor.stdout, /native MAWF; Trellis lifecycle disabled/);
  assert.doesNotMatch(doctor.stdout, /trellis \(next-step init\)|trellis-brainstorm/);
});
