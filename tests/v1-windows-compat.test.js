// Windows behaviour of the v1 core: the same project, file and launcher must behave
// as on Linux through the platform facade. POSIX keeps its exact previous semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as windows from "../src/platform/windows.js";
import * as linux from "../src/platform/linux.js";
import * as discovery from "../src/adapters/discovery.js";
import { readStrict, writeAtomic, assertSafePath } from "../src/atomic-state.js";
import { createRun, addTask, runtimeStatus } from "../src/runtime.js";
import { nativeHostCapability } from "../src/native-host.js";
import { validateEvidence, bindDeclaredEvidence, candidateIdentity } from "../src/verification.js";
import { workspaceLayout } from "../src/workspace/backend.js";
import { defaultSettings } from "../src/settings.js";

const isWin = process.platform === "win32";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const tmp = (t, prefix = "mawf-win-compat-") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const isolateHome = (t, dir) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = path.join(dir, "home");
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
};
const prependPath = (t, dir) => {
  const saved = process.env.PATH;
  process.env.PATH = dir + path.delimiter + saved;
  t.after(() => { process.env.PATH = saved; });
};
// Another process holds `file` open for `ms` (Windows sharing); resolves once it is open.
const holdOpen = (file, ms) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready');setTimeout(()=>fs.closeSync(fd),Number(process.argv[2]))", file, String(ms)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  child.once("error", reject);
  child.stdout.once("data", () => resolve({ closed: new Promise((done) => child.once("close", done)) }));
});
const lowerDrive = (file) => file[0].toLowerCase() + file.slice(1);
const upperBase = (dir) => path.join(path.dirname(dir), path.basename(dir).toUpperCase());
// The 8.3 short spelling of an existing path, or "" where the volume has none.
const shortPath = (file) => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p = $env:MAWF_TEST_PATH; $f = New-Object -ComObject Scripting.FileSystemObject; if (Test-Path -LiteralPath $p -PathType Container) { $f.GetFolder($p).ShortPath } else { $f.GetFile($p).ShortPath }"], { encoding: "utf8", windowsHide: true, env: { ...process.env, MAWF_TEST_PATH: file } });
  return r.status === 0 ? r.stdout.trim() : "";
};
// Every Windows spelling of one existing path: drive/segment case, separators, long and 8.3 names.
const spellings = (file) => isWin ? [...new Set([file, lowerDrive(file), path.join(upperBase(path.dirname(file)), path.basename(file).toUpperCase()), file.replaceAll("\\", "/"), fs.realpathSync.native(file), shortPath(file)].filter(Boolean))] : [file];

test("POSIX adapter keeps byte-exact checkouts, path spellings and single-attempt file operations", () => {
  const bytes = Buffer.from("a\r\nb\n");
  assert.deepEqual(linux.checkoutVariants(bytes), [bytes]);
  assert.equal(linux.comparablePath("/Tmp/Mixed Case"), "/Tmp/Mixed Case");
  let calls = 0;
  assert.throws(() => linux.retryTransient(() => { calls++; throw Object.assign(new Error("held"), { code: "EPERM" }); }), { code: "EPERM" });
  assert.equal(calls, 1);
});

test("Windows adapter offers the committed LF bytes of a CRLF checkout and nothing else", () => {
  const lf = Buffer.from("line 1\nline 2\n"), crlf = Buffer.from("line 1\r\nline 2\r\n");
  assert.deepEqual(windows.checkoutVariants(lf), [lf]);
  assert.deepEqual(windows.checkoutVariants(crlf).map(String), [String(crlf), String(lf)]);
  const binary = Buffer.from([0xff, 0x0d, 0x0a, 0x80, 0x0d]);
  assert.deepEqual([...windows.checkoutVariants(binary)[1]], [0xff, 0x0a, 0x80, 0x0d]);
});

test("Windows adapter retries only sharing violations, within a bound", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let calls = 0;
    assert.equal(windows.retryTransient(() => { if (++calls < 3) throw Object.assign(new Error(code), { code }); return "done"; }, { waitMs: 1 }), "done");
    assert.equal(calls, 3);
  }
  let calls = 0;
  assert.throws(() => windows.retryTransient(() => { calls++; throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, { waitMs: 1 }), { code: "ENOENT" });
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(() => windows.retryTransient(() => { calls++; throw Object.assign(new Error("held"), { code: "EPERM" }); }, { attempts: 4, waitMs: 1 }), { code: "EPERM" });
  assert.equal(calls, 4);
});

test("Windows adapter compares one on-disk spelling of a path", { skip: !isWin }, (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "File.json"), "{}");
  const spelled = windows.comparablePath(path.join(dir, "File.json"));
  assert.equal(windows.comparablePath(path.join(lowerDrive(dir), "FILE.JSON")), spelled);
  assert.equal(windows.comparablePath(path.join(upperBase(dir), "file.json")), spelled);
  assert.equal(windows.comparablePath(path.join(dir, "missing", "..", "File.json").replaceAll("\\", "/")), spelled);
  for (const spelling of spellings(path.join(dir, "File.json"))) assert.equal(windows.comparablePath(spelling), spelled, spelling);
  assert.notEqual(windows.comparablePath(path.join(dir, "Other.json")), spelled);
  // os.tmpdir() can be an 8.3 spelling (C:\Users\RUNNER~1 on CI); the native path is canonical.
  assert.equal(windows.realpath(lowerDrive(dir)), fs.realpathSync.native(dir));
});

test("pinned companion digests accept a CRLF checkout of the same bytes only on Windows", () => {
  const lf = Buffer.from("export const run = () => 1;\n"), crlf = Buffer.from("export const run = () => 1;\r\n");
  const pinned = sha256(lf);
  assert.equal(discovery.scriptDigestMatches(lf, pinned), true);
  assert.equal(discovery.scriptDigestMatches(crlf, pinned), isWin);
  assert.equal(discovery.scriptDigestMatches(Buffer.from("export const run = () => 2;\r\n"), pinned), false);
});

test("atomic replace succeeds while another process briefly holds the target open", async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "ledger.json");
  writeAtomic(file, { revision: 1 });
  const { closed } = await holdOpen(file, 250);
  writeAtomic(file, { revision: 2 });
  await closed;
  assert.deepEqual(readStrict(file), { revision: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["ledger.json"]);
});

test("a state file deleted while another process holds it reads as absent", async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, ".ledger.claim-1.json");
  fs.writeFileSync(file, "{}");
  const { closed } = await holdOpen(file, 250);
  fs.unlinkSync(file);
  assert.equal(readStrict(file, "absent"), "absent");
  await closed;
});

test("one Windows project has one runtime state root whatever the spelling of its path", { skip: !isWin }, async (t) => {
  const dir = tmp(t);
  isolateHome(t, dir);
  const project = path.join(dir, "Project");
  fs.mkdirSync(project);
  const created = await createRun({ project, runId: "r1" });
  const variants = spellings(project);
  for (const spelling of variants) {
    const status = runtimeStatus({ project: spelling, runId: "r1" });
    assert.equal(status.stateRoot, created.stateRoot, spelling);
    assert.equal(addTask({ project: spelling, runId: "r1", taskId: `t-${crypto.randomUUID()}`, adapter: "local-process", command: [process.execPath, "-v"] }).ok, true, spelling);
  }
  assert.equal(Object.keys(runtimeStatus({ project, runId: "r1" }).run.tasks).length, variants.length);
});

function fakeLauncher(dir, name, entrySource, style) {
  const entry = path.join(dir, "node_modules", `fake-${name}`, "cli.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, entrySource);
  if (!isWin) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
    return;
  }
  const npmShim = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-${name}\\cli.js" %*`, ""];
  // A custom launcher (like Claude Code's npm claude.cmd, which starts claude.exe) runs through cmd.exe.
  const custom = ["@echo off", "rem custom launcher", `"${process.execPath}" "%~dp0node_modules\\fake-${name}\\cli.js" %*`, ""];
  fs.writeFileSync(path.join(dir, `${name}.cmd`), (style === "npm" ? npmShim : custom).join("\r\n"));
}

for (const style of ["npm", "custom"]) {
  test(`Claude capability probe runs an installed ${style} claude launcher`, (t) => {
    const dir = tmp(t);
    const bin = path.join(dir, "bin");
    fakeLauncher(bin, "claude", `if (process.argv.slice(2).join(" ") === "auth status --json") process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); else process.exit(2);`, style);
    prependPath(t, bin);
    const settings = defaultSettings();
    settings.integrations["host.claude-code"] = { enabled: true, options: {} };
    const capability = nativeHostCapability(settings, dir);
    assert.equal(capability.installed, true);
    assert.equal(capability.authenticated, true, capability.reasonCode);
    assert.equal(capability.actualBillingMode, "subscription");
    assert.equal(capability.actualProvider, "anthropic");
    assert.equal(capability.reasonCode, "BILLING_AND_MODEL_POLICY_REQUIRED");
  });
}

function evidenceFixture(t) {
  const dir = tmp(t);
  const workspace = path.join(dir, "Product"), outside = path.join(dir, "Evidence");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const candidate = { candidateId: "cand-1", commitSha: null, diffHash: "d", effectiveConfigHash: "e", scope: ["."], implementerActorIds: ["author-1"], workspace, createdAt: new Date(Date.now() - 60000).toISOString() };
  const run = (adapter) => ({ runId: "run-1", snapshot: { modeId: "dynamic", modeVersion: 1, configRevision: 0 }, tasks: { "hacker-1": { taskId: "hacker-1", verificationTarget: "cand-1", actorId: "hacker-1", attempt: 1, currentLeaseId: "lease-1", status: "produced", adapter, selection: null, adapterState: null } } });
  const ledger = (extra = {}) => ({ leases: { "lease-1": { leaseId: "lease-1", runId: "run-1", actorId: "hacker-1", status: "released", sessionId: "job-1", jobId: "job-1", ...extra } } });
  const record = (rawPath) => ({ runId: "run-1", candidateId: "cand-1", commitSha: null, diffHash: "d", effectiveConfigHash: "e", modeId: "dynamic", modeVersion: 1, configRevision: 0, scope: ["."], implementerActorIds: ["author-1"], requirementId: "R1", scenarioId: "S1", hackerActorId: "hacker-1", hackerTaskId: "hacker-1", attempt: 1, sessionId: "job-1", model: "not_applicable", adapter: "local-process", expectedBehavior: "x", observedBehavior: "y", entrypoint: "z", enforcementLevel: "e", verdict: "passed", kind: "real_user_path", oracleSource: { kind: "real_observation", reference: "test" }, oracleVersion: "1", exactSteps: ["step"], environment: {}, controlledInputs: {}, counterexamples: [], scopeLimitations: [], degradations: [], costCoverage: {}, capabilities: ["windows"], rawOutputs: [{ path: rawPath, sha256: sha256(fs.readFileSync(rawPath)) }], timestamps: { startedAt: new Date(Date.now() - 30000).toISOString(), finishedAt: new Date(Date.now() - 10000).toISOString() } });
  return { dir, workspace, outside, candidate, run, ledger, record };
}

test("evidence stored inside the product is refused for every spelling of its path", (t) => {
  const f = evidenceFixture(t);
  const inside = path.join(f.workspace, "evidence.json"), elsewhere = path.join(f.outside, "evidence.json");
  fs.writeFileSync(inside, '{"raw":"inside"}'); fs.writeFileSync(elsewhere, '{"raw":"outside"}');
  for (const spelling of spellings(inside)) assert.throws(() => validateEvidence(f.run("local-process"), f.candidate, f.record(spelling), f.ledger()), { code: "EVIDENCE_PRODUCT_OVERLAP" }, spelling);
  assert.equal(validateEvidence(f.run("local-process"), f.candidate, f.record(elsewhere), f.ledger()).rawOutputs[0].path, elsewhere);
  const runtimeEvidence = path.join(f.workspace, ".mawf", "runtime", "evidence", "raw.json");
  fs.mkdirSync(path.dirname(runtimeEvidence), { recursive: true }); fs.writeFileSync(runtimeEvidence, '{"raw":"runtime"}');
  assert.equal(validateEvidence(f.run("local-process"), f.candidate, f.record(isWin ? lowerDrive(runtimeEvidence) : runtimeEvidence), f.ledger()).rawOutputs.length, 1);
});

test("a native Hacker's declared evidence file matches its own path spellings and exact bytes only", (t) => {
  const f = evidenceFixture(t);
  const file = path.join(f.outside, "evidence.json");
  fs.writeFileSync(file, '{"raw":"declared"}');
  const receipt = path.join(f.dir, "receipt.jsonl");
  const declare = (declared) => fs.writeFileSync(receipt, JSON.stringify({ type: "tool_result", text: `done\nMAWF_EVIDENCE ${sha256(fs.readFileSync(file))} ${declared}\n` }) + "\n");
  const bind = (input = file) => bindDeclaredEvidence(f.run("host-managed"), { hackerTaskId: "hacker-1" }, f.ledger({ hostCompletion: { receiptPath: receipt, sha256: sha256(fs.readFileSync(receipt)) } }), input);
  for (const declared of spellings(file)) {
    declare(declared);
    assert.equal(bind().sha256, sha256(fs.readFileSync(file)), declared);
  }
  const other = path.join(f.outside, "other.json");
  fs.writeFileSync(other, '{"raw":"declared"}');
  declare(file);
  assert.throws(() => bind(other), { code: "HACKER_EVIDENCE_UNDECLARED" });
  fs.appendFileSync(file, " ");
  assert.throws(() => bind(), { code: "HACKER_EVIDENCE_MODIFIED" });
});

test("Windows junctions are refused like symbolic links in state paths, native storage and candidate scopes", { skip: !isWin }, (t) => {
  const dir = tmp(t);
  const outside = path.join(dir, "outside"), ws = path.join(dir, "ws");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  for (const sub of [".mawf", "docs", "src"]) fs.mkdirSync(path.join(ws, sub), { recursive: true });
  fs.writeFileSync(path.join(ws, ".mawf", "workspace.json"), JSON.stringify({ version: 1, backend: "mawf", trellis: false }));
  fs.writeFileSync(path.join(ws, "src", "a.txt"), "a");
  // A junction needs no privilege on Windows, so it is the link an escape would use there.
  fs.symlinkSync(outside, path.join(ws, "docs", "plans"), "junction");
  fs.symlinkSync(outside, path.join(ws, "src", "escape"), "junction");
  assert.throws(() => workspaceLayout(ws), /symlink/);
  assert.throws(() => assertSafePath(path.join(ws, "src", "escape", "state.json")), { code: "UNSAFE_PATH" });
  const run = { snapshot: { workspace: ws, effectiveConfigHash: "h" } };
  assert.throws(() => candidateIdentity(run, { scope: ["src/escape/secret.txt"] }), { code: "UNSAFE_PATH" });
  assert.deepEqual(candidateIdentity(run, { scope: ["src"] }).files.map((file) => `${file.kind}:${file.path}`), ["file:src/a.txt", "symlink:src/escape"]);
});
