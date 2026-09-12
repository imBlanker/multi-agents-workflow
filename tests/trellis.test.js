import { setHome } from "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectTrellis, mawManagedFiles, snapshotFiles, detectConflicts, applyConflictChoice, trellisPlatformFlags, buildTrellisLaunchSpec, runTrellisInit, buildTrellisCommandSpec, runTrellisCommand } from "../src/trellis.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(path.join(project, ".mawf", "agents"), { recursive: true });
fs.mkdirSync(path.join(project, ".mawf", "runtime"), { recursive: true });
fs.writeFileSync(path.join(project, ".mawf", "plan.md"), "v1\n");
fs.writeFileSync(path.join(project, ".mawf", "agents", "orchestrator.md"), "v1\n");
fs.writeFileSync(path.join(project, ".mawf", "runtime", "state.json"), "{}"); // runtime excluded

test("detectTrellis honors an isolated fixture executable", () => {
  const fixture = path.join(tmp, "trellis-fixture");
  fs.writeFileSync(fixture, "fixture");
  const previous = process.env.TRELLIS_BIN;
  try {
    process.env.TRELLIS_BIN = fixture;
    assert.deepEqual(detectTrellis(), { via: "env", bin: fixture, args: [] });
  } finally {
    if (previous === undefined) delete process.env.TRELLIS_BIN;
    else process.env.TRELLIS_BIN = previous;
  }
});

test("mawManagedFiles lists .mawf files but excludes runtime/logs", () => {
  const files = mawManagedFiles(project);
  assert.ok(files.some((f) => f.endsWith("plan.md")));
  assert.ok(files.some((f) => f.endsWith("orchestrator.md")));
  assert.ok(!files.some((f) => f.includes("runtime")));
});

test("snapshotFiles hashes MAW files", () => {
  const snap = snapshotFiles(project);
  assert.ok(snap[path.join(project, ".mawf", "plan.md")]);
  assert.equal(typeof snap[path.join(project, ".mawf", "plan.md")], "string");
});

test("detectConflicts: no change -> empty", () => {
  const before = snapshotFiles(project);
  const after = snapshotFiles(project);
  assert.equal(detectConflicts(before, after).length, 0);
});

test("detectConflicts: modified file detected", () => {
  const before = snapshotFiles(project);
  fs.writeFileSync(path.join(project, ".mawf", "plan.md"), "v2-changed-by-trellis\n");
  const after = snapshotFiles(project);
  const c = detectConflicts(before, after);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "modified");
  assert.ok(c[0].file.endsWith("plan.md"));
});

test("detectConflicts: removed file detected", () => {
  const f = path.join(project, ".mawf", "agents", "orchestrator.md");
  const before = snapshotFiles(project);
  fs.unlinkSync(f);
  const after = snapshotFiles(project);
  const c = detectConflicts(before, after);
  assert.ok(c.some((x) => x.kind === "removed" && x.file.endsWith("orchestrator.md")));
});

test("applyConflictChoice returns the chosen disposition", () => {
  assert.match(applyConflictChoice("maw").applied, /regenerate/i);
  assert.match(applyConflictChoice("trellis").applied, /kept/i);
  assert.match(applyConflictChoice("rerun").applied, /re-running/i);
});

test("trellisPlatformFlags: pi host -> --pi (empty home, no ~/.claude)", () => {
  const restoreHome = setHome(tmp); // tmp has no .claude
  try {
    assert.deepEqual(trellisPlatformFlags("pi"), ["--pi"]);
  } finally { restoreHome?.(); }
});

test("trellisPlatformFlags: pi host with ~/.claude present -> --pi --claude", () => {
  let restoreHome;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-pi-"));
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  try {
    restoreHome = setHome(d);
    assert.deepEqual(trellisPlatformFlags("pi"), ["--pi", "--claude"]);
  } finally { restoreHome?.(); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test("trellisPlatformFlags: dsh host -> --dsh (+ --claude when ~/.claude present)", () => {
  let restoreHome;
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-dsh-"));
  try {
    restoreHome = setHome(bare); // no .claude
    assert.deepEqual(trellisPlatformFlags("dsh"), ["--dsh"]);
    fs.mkdirSync(path.join(bare, ".claude"), { recursive: true });
    assert.deepEqual(trellisPlatformFlags("dsh"), ["--dsh", "--claude"]);
  } finally { restoreHome?.(); try { fs.rmSync(bare, { recursive: true, force: true }); } catch {} }
});

test("trellisPlatformFlags: claude/codex/unknown keep --claude --codex", () => {
  assert.deepEqual(trellisPlatformFlags("claude-code"), ["--claude", "--codex"]);
  assert.deepEqual(trellisPlatformFlags("codex"), ["--claude", "--codex"]);
  assert.deepEqual(trellisPlatformFlags(""), ["--claude", "--codex"]);
});

test("interactive launch inherits the terminal and leaves Trellis choices to its TUI", () => {
  const spec = buildTrellisLaunchSpec({
    user: "Alice Example",
    hostApp: "dsh",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    detection: { via: "path", bin: "trellis-fixture", args: [] },
  });
  assert.equal(spec.interactive, true);
  assert.equal(spec.stdio, "inherit");
  assert.deepEqual(spec.args, ["init", "-u", "Alice Example"]);
  assert.ok(!spec.args.includes("-y"));
  assert.ok(!spec.args.some((arg) => ["--pi", "--dsh", "--claude", "--codex"].includes(arg)));
});

test("redirected stdin or stdout keeps deterministic non-interactive arguments and pipes", () => {
  const restoreHome = setHome(tmp);
  try {
    for (const [stdinIsTTY, stdoutIsTTY] of [[false, true], [true, false], [false, false]]) {
      const spec = buildTrellisLaunchSpec({
        user: "alice",
        hostApp: "pi",
        stdinIsTTY,
        stdoutIsTTY,
        detection: { via: "path", bin: "trellis-fixture", args: [] },
      });
      assert.equal(spec.interactive, false);
      assert.deepEqual(spec.stdio, ["pipe", "pipe", "pipe"]);
      assert.deepEqual(spec.args, ["init", "-u", "alice", "-y", "--pi"]);
    }
  } finally { restoreHome?.(); }
});

test("interactive npx fallback keeps npx --yes but omits Trellis -y", () => {
  const spec = buildTrellisLaunchSpec({
    user: "alice",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    detection: { via: "npx", bin: null, args: ["--yes", "@mindfoldhq/trellis@latest"] },
  });
  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["--yes", "@mindfoldhq/trellis@latest", "init", "-u", "alice"]);
});

test("lifecycle specs preserve update interaction policy and never leak MAWF flags", () => {
  const detection = { via: "path", bin: "trellis-fixture", args: [] };
  const interactive = buildTrellisCommandSpec({ command: "update", stdinIsTTY: true, stdoutIsTTY: true, detection });
  assert.deepEqual(interactive.args, ["update"]);
  assert.equal(interactive.stdio, "inherit");
  const redirected = buildTrellisCommandSpec({ command: "update", stdinIsTTY: false, stdoutIsTTY: true, detection });
  assert.deepEqual(redirected.args, ["update", "--skip-all"]);
  assert.deepEqual(redirected.stdio, ["pipe", "pipe", "pipe"]);
  const dry = buildTrellisCommandSpec({ command: "update", dryRun: true, stdinIsTTY: false, stdoutIsTTY: false, detection });
  assert.deepEqual(dry.args, ["update", "--dry-run"]);
  assert.equal(dry.stdio, "inherit");
  const upgrade = buildTrellisCommandSpec({ command: "upgrade", detection });
  assert.deepEqual(upgrade.args, ["upgrade"]);
  assert.equal(upgrade.stdio, "inherit");
});

test("generic lifecycle runner preserves structured nonzero/signal/error evidence", () => {
  const detection = { via: "npx", bin: null, args: ["--yes", "@mindfoldhq/trellis@latest"] };
  const calls = [];
  const result = runTrellisCommand({
    project: tmp, command: "upgrade", dryRun: true, detection,
    runner: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 1, signal: "SIGTERM", stdout: "out", stderr: "err", error: new Error("stopped") };
    },
  });
  assert.deepEqual(calls[0].args, ["--yes", "@mindfoldhq/trellis@latest", "upgrade", "--dry-run"]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("Trellis logs capture child diagnostics only in non-interactive mode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const detection = { via: "path", bin: "trellis-fixture", args: [] };
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, signal: null, stdout: "fixture stdout", stderr: "fixture stderr" };
  };
  const interactive = runTrellisInit({ project: root, user: "alice", stdinIsTTY: true, stdoutIsTTY: true, detection, runner });
  const interactiveLog = fs.readFileSync(interactive.logPath, "utf8");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.match(interactiveLog, /mode: interactive/);
  assert.match(interactiveLog, /# finished: code=0, signal=none, error=none/);
  assert.doesNotMatch(interactiveLog, /fixture stdout|fixture stderr/);

  const nonInteractive = runTrellisInit({ project: root, user: "alice", stdinIsTTY: true, stdoutIsTTY: false, detection, runner });
  const nonInteractiveLog = fs.readFileSync(nonInteractive.logPath, "utf8");
  assert.deepEqual(calls[1].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.match(nonInteractiveLog, /mode: non-interactive/);
  assert.match(nonInteractiveLog, /fixture stdout/);
  assert.match(nonInteractiveLog, /fixture stderr/);
});

test("Trellis launch errors, signals, and timeout metadata are not successes", (t) => {
  const detection = { via: "path", bin: "trellis-fixture", args: [] };
  for (const fixture of [
    { status: null, signal: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) },
    { status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    { status: 0, signal: "SIGTERM" },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-fail-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = runTrellisInit({ project: root, user: "alice", nonInteractive: true, detection, runner: () => ({ ...fixture, stdout: "", stderr: "" }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, fixture.status);
    assert.equal(result.signal, fixture.signal);
    assert.equal(result.error?.code, fixture.error?.code);
    assert.match(fs.readFileSync(result.logPath, "utf8"), new RegExp(fixture.error?.code || fixture.signal));
  }
});

test("interactive conflict resume reuses inherited stdio and launch arguments", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maw-tr-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managed = path.join(root, ".mawf", "plan.md");
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, "before\n");
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    fs.writeFileSync(managed, `changed-${calls.length}\n`);
    return { status: 0, signal: null, stdout: "", stderr: "" };
  };
  const result = runTrellisInit({
    project: root,
    user: "alice",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    detection: { via: "path", bin: "trellis-fixture", args: [] },
    runner,
    promptReader: () => "r",
  });
  assert.equal(result.resumed, true);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, calls[0].args);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[1].options.stdio, "inherit");
  assert.match(fs.readFileSync(result.logPath, "utf8"), /# resume finished: code=0, signal=none, error=none/);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
