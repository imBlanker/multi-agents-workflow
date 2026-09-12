import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as windows from "../src/platform/windows.js";
import * as linux from "../src/platform/linux.js";
import { platformFor, run, execFile, findExecutable } from "../src/platform/index.js";
import { buildTrellisCommandSpec, buildTrellisLaunchSpec } from "../src/trellis.js";

test("facade selects explicit adapters and retains POSIX fallback", () => {
  assert.equal(platformFor("win32"), windows);
  assert.equal(platformFor("linux"), linux);
  assert.equal(platformFor("darwin"), linux);
});

test("native launch preserves whitespace, Unicode, quotes and shell metacharacters", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf 空 格-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "echo args.cjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const args = ["a b", "中文", 'a"b', "x\ny", "& | < > ^ ! %PATH% $(echo nope)", "", "trailing\\"];
  const result = run(process.execPath, [script, ...args], { encoding: "utf8", cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(findExecutable(process.execPath), process.execPath);
});

test("launch retains missing-command, nonzero and timeout failures", () => {
  assert.ok(run("mawf-command-that-does-not-exist-8317", []).error);
  const result = run(process.execPath, ["-e", "process.stderr.write('failure');process.exit(7)"], { encoding: "utf8" });
  assert.equal(result.status, 7);
  assert.equal(result.stderr, "failure");
  assert.throws(() => execFile(process.execPath, ["-e", "process.exit(7)"]), (err) => err.status === 7);
  assert.equal(run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 100 }).error.code, "ETIMEDOUT");
});

test("Windows discovery honors PATH/PATHEXT case-insensitively", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf lookup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, "probe.CMD");
  fs.writeFileSync(exe, "@echo off\r\n");
  assert.equal(windows.findExecutable("probe", { env: { Path: dir, PathExt: ".EXE;.CMD" } }), exe);
  assert.equal(windows.findExecutable("missing", { env: { Path: dir } }), null);
});

test("Linux lookup respects executable permissions", { skip: process.platform === "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf lookup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, "probe");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(linux.findExecutable("probe", { paths: [dir] }), null);
  fs.chmodSync(exe, 0o755);
  assert.equal(linux.findExecutable("probe", { paths: [dir] }), exe);
});

test("port probes parse fixtures without spawning shell pipelines", () => {
  assert.equal(windows.parsePortOwner("  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    4312\r\n", 3080), "4312");
  assert.equal(windows.parsePortOwner(" TCP 127.0.0.1:13080 0.0.0.0:0 LISTENING 88", 3080), null);
  assert.equal(windows.portOwner(3080, () => ({ status: 1, stdout: "" })), null);
  assert.equal(linux.portOwner(3080, (bin) => bin === "lsof" ? { status: 1 } : { status: 0, stdout: 'LISTEN 0 128 127.0.0.1:3080 0.0.0.0:* users:(("dsh",pid=42,fd=1))' }), "42");
});

test("Windows process path is data in environment, never script source", () => {
  const project = 'C:\\项目 space\\a"; throw "bad';
  assert.equal(windows.projectProcessAlive(project, (bin, args, opts) => {
    assert.equal(bin, "powershell.exe");
    assert.equal(opts.env.MAWF_PROCESS_PROJECT, project);
    assert.ok(!args.at(-1).includes(project));
    return { status: 0, stdout: "yes\r\n" };
  }), true);
});

test("Windows generic batch arguments preserve literal metacharacters", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf 批处理-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "echo.cjs");
  const shim = path.join(dir, "echo.cmd");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ["a b", "中文", "a&b", "!keep!", "%PATH%", "", "x^y", "trailing\\"];
  const r = windows.run(shim, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  assert.deepEqual(JSON.parse(r.stdout), args);
  assert.equal(windows.run(shim, ['a"b']).error.code, "EINVAL");
});


test("npm Node shim bypasses cmd for quoted and multiline prompts", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf npm shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "entry.cjs");
  fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const shim = path.join(dir, "tool.cmd");
  fs.writeFileSync(shim, '@echo off\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\entry.cjs" %*\r\n');
  const args = ['quoted "text"', "multi\nline", "%PATH% & !", "trailing\\", ""];
  const result = windows.run(shim, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("Windows npm shim executes interactive Trellis argv without shell rewriting", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf trellis shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "entry.cjs");
  fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const shim = path.join(dir, "trellis.cmd");
  fs.writeFileSync(shim, '@echo off\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\entry.cjs" %*\r\n');
  const spec = buildTrellisLaunchSpec({ user: "Alice Example", stdinIsTTY: true, stdoutIsTTY: true, detection: { via: "path", bin: shim, args: [] } });
  assert.equal(spec.stdio, "inherit");
  const result = windows.run(spec.command, spec.args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), ["init", "-u", "Alice Example"]);
});

test("Windows npm shim carries Trellis update and upgrade argv without shell rewriting", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf trellis lifecycle shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "entry.cjs");
  fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const shim = path.join(dir, "trellis.cmd");
  fs.writeFileSync(shim, '@echo off\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\entry.cjs" %*\r\n');
  const detection = { via: "path", bin: shim, args: [] };
  const specs = [
    buildTrellisCommandSpec({ command: "update", stdinIsTTY: false, stdoutIsTTY: false, detection }),
    buildTrellisCommandSpec({ command: "upgrade", stdinIsTTY: true, stdoutIsTTY: true, detection }),
  ];
  assert.deepEqual(specs.map((spec) => [spec.args, spec.stdio]), [
    [["update", "--skip-all"], ["pipe", "pipe", "pipe"]],
    [["upgrade"], "inherit"],
  ]);
  for (const spec of specs) {
    const result = windows.run(spec.command, spec.args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), spec.args);
  }
});

test("Linux direct adapter carries Trellis lifecycle argv and stdio contract", { skip: process.platform === "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf trellis lifecycle linux-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "trellis");
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 });
  const detection = { via: "path", bin: executable, args: [] };
  const specs = [
    buildTrellisCommandSpec({ command: "update", stdinIsTTY: false, stdoutIsTTY: false, detection }),
    buildTrellisCommandSpec({ command: "update", stdinIsTTY: true, stdoutIsTTY: true, detection }),
    buildTrellisCommandSpec({ command: "upgrade", stdinIsTTY: false, stdoutIsTTY: false, detection }),
  ];
  assert.deepEqual(specs.map((spec) => [spec.args, spec.stdio]), [
    [["update", "--skip-all"], ["pipe", "pipe", "pipe"]],
    [["update"], "inherit"],
    [["upgrade"], "inherit"],
  ]);
  for (const spec of specs) {
    const result = linux.run(spec.command, spec.args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout), spec.args);
  }
});


test("Windows shim recognition does not bypass comments, custom programs, or Node flags", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf shim semantics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "entry.cjs"), "console.log(JSON.stringify(process.execArgv))");
  const shim = path.join(dir, "tool.cmd");
  fs.writeFileSync(shim, '@echo off\r\nREM node "%~dp0\\entry.cjs" %*\r\necho custom\r\n');
  assert.equal(windows.run(shim, [], { encoding: "utf8" }).stdout.trim(), "custom");
  fs.writeFileSync(shim, '@echo off\r\nREM node\r\nSET "_prog=mawf-definitely-missing-program"\r\n"%_prog%" "%~dp0\\entry.cjs" %*\r\n');
  assert.notEqual(windows.run(shim, [], { encoding: "utf8" }).status, 0); // a missing custom program must not be mistaken for a Node shim
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" --no-warnings "%~dp0\\entry.cjs" %*\r\n`);
  assert.deepEqual(JSON.parse(windows.run(shim, [], { encoding: "utf8" }).stdout), ["--no-warnings"]);
});


test("custom batch setup is preserved instead of bypassed as an npm shim", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf setup shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "entry.cjs"), "console.log(process.env.MAWF_WRAPPER_FLAG || 'missing')");
  const shim = path.join(dir, "tool.cmd");
  fs.writeFileSync(shim, '@echo off\r\nSET "MAWF_WRAPPER_FLAG=kept"\r\nnode "%~dp0\\entry.cjs" %*\r\n');
  const result = windows.run(shim, [], { encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "kept");
});
