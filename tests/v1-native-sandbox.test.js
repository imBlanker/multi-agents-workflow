// The native controller's sandbox contract: which paths a Claude Code session can
// write and which Core calls leave the sandbox. The live check is in
// docs/V1_EXECUTION.md; these checks need no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { nativeSandboxPolicy, nativeLaunchArgs, workspaceInsidePackage, executeNative } from "../src/native-host.js";
import { validateEvidence } from "../src/verification.js";
import { runExecution } from "../src/run-cli.js";
import { setIntegration } from "../src/integrations.js";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const packageRoot = "/opt/mawf", stateRoot = "/work/app/.mawf/runtime";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const tmp = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mawf-sandbox-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const swapEnv = (t, values) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
};
// The values of a variadic CLI flag: everything up to the next flag.
const flagValues = (argv, flag) => {
  const start = argv.indexOf(flag) + 1, end = argv.findIndex((arg, index) => index >= start && arg.startsWith("--"));
  return argv.slice(start, end === -1 ? undefined : end);
};

test("the native sandbox fails closed and keeps the state root and package read-only", () => {
  const { settings, disallowedTools } = nativeSandboxPolicy({ packageRoot, stateRoot });
  const sandbox = settings.sandbox;
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true, "a missing sandbox stops the session instead of running Bash unsandboxed");
  assert.equal(sandbox.allowUnsandboxedCommands, false, "no dangerouslyDisableSandbox retry");
  assert.equal(sandbox.autoAllowBashIfSandboxed, false);
  for (const weakening of ["enableWeakerNestedSandbox", "allowNestedUserNamespaces"]) assert.equal(sandbox[weakening], false, weakening);
  assert.equal(sandbox.filesystem.disabled, false);
  assert.equal(sandbox.network.allowAllUnixSockets, false);
  assert.deepEqual(sandbox.filesystem.denyWrite, [stateRoot, packageRoot]);
  assert.equal(sandbox.filesystem.allowWrite, undefined, "MAWF widens no write path");
  assert.equal(sandbox.network.allowedDomains, undefined, "MAWF opens no network domain");
  // Claude Code matches file tools against Edit(path) rules only; `//` anchors at the filesystem root.
  assert.deepEqual(disallowedTools, [`Edit(/${stateRoot}/**)`, `Edit(/${packageRoot}/**)`]);
  assert.ok(disallowedTools.every((rule) => rule.startsWith("Edit(//")));
});

test("only Core run and task calls of the package entry leave the sandbox", () => {
  const excluded = nativeSandboxPolicy({ packageRoot, stateRoot }).settings.sandbox.excludedCommands;
  assert.equal(excluded.length, 12, "two entry spellings, two commands, three quotings");
  for (const pattern of excluded) assert.match(pattern, /^node (["']?)\/opt\/mawf\/(?:plugin\/\.\.\/)?bin\/mawf\.js\1 (?:run|task) \*$/);
  // run.md's Core entry, as the host expands it, is covered for both commands.
  const runMd = fs.readFileSync(path.join(PACKAGE, "plugin", "commands", "run.md"), "utf8");
  assert.ok(runMd.includes('`node "${CLAUDE_PLUGIN_ROOT}/../bin/mawf.js"`'));
  for (const command of ["run", "task"]) assert.ok(excluded.includes(`node "${packageRoot}/plugin/../bin/mawf.js" ${command} *`), command);
  // run.md asks for no other Core command, which would stay sandboxed and fail to record state.
  const other = /^(?:mode|integrations|config|adapter|autoresearch|install|uninstall|update|upgrade|init|advise|components|knowledge|bridge|companion|session|archify|plan|doctor|inventory|cost)\s/;
  assert.deepEqual([...runMd.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((span) => other.test(span)), []);
});

test("launch arguments hand Claude Code the sandbox settings and Edit denials", () => {
  const { settings, disallowedTools } = nativeSandboxPolicy({ packageRoot, stateRoot });
  const fixed = nativeLaunchArgs({ requestRef: "ref-1", packageRoot, stateRoot, modeId: "fixed-1", allowedTools: ["Bash", "Read"], modelId: "model-1" });
  assert.deepEqual(JSON.parse(flagValues(fixed, "--settings")[0]), settings);
  assert.deepEqual(flagValues(fixed, "--allowedTools"), ["Bash", "Read"]);
  assert.deepEqual(flagValues(fixed, "--disallowedTools"), disallowedTools);
  assert.deepEqual(flagValues(fixed, "--permission-mode"), ["acceptEdits"]);
  assert.deepEqual(flagValues(fixed, "--agent"), ["mawf:mawf-fixed-orchestrator"]);
  assert.deepEqual(flagValues(fixed, "--model"), ["model-1"]);
  assert.deepEqual(fixed.slice(0, 2), ["-p", "/mawf:run --request-ref ref-1"]);
  const dynamic = nativeLaunchArgs({ requestRef: "ref-1", packageRoot, stateRoot, modeId: "dynamic", allowedTools: ["Bash"], modelId: "model-1" });
  assert.deepEqual(flagValues(dynamic, "--permission-mode"), ["dontAsk"]);
  assert.equal(dynamic.includes("--agent"), false);
  assert.deepEqual(flagValues(dynamic, "--disallowedTools"), disallowedTools);
});

test("a workspace inside the MAWF package is refused; a package inside the workspace is not", () => {
  assert.equal(workspaceInsidePackage(packageRoot, packageRoot), true);
  assert.equal(workspaceInsidePackage(`${packageRoot}/examples/app`, packageRoot), true);
  assert.equal(workspaceInsidePackage("/opt/mawf-app", packageRoot), false);
  assert.equal(workspaceInsidePackage("/opt", packageRoot), false);
  assert.equal(workspaceInsidePackage("/work/app", "/work/app/node_modules/mawf"), false);
  assert.equal(workspaceInsidePackage(path.join(PACKAGE, "tests")), true, "defaults to this package");
});

test("native launch refuses without bubblewrap and socat before touching run state", { skip: process.platform !== "linux" }, async (t) => {
  const dir = tmp(t);
  swapEnv(t, { PATH: path.join(dir, "empty-path") });
  const result = await executeNative({ project: dir, runId: "run-1", taskId: "task-1" });
  assert.equal(result.reasonCode, "NATIVE_SANDBOX_UNAVAILABLE");
  assert.match(result.reason, /bwrap, socat/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("native launch stays refused outside Linux", { skip: process.platform === "linux" }, async () => {
  assert.equal((await executeNative({ project: os.tmpdir(), runId: "run-1", taskId: "task-1" })).reasonCode, "NATIVE_PROCESS_CONTROL_UNSUPPORTED");
});

test("Hacker evidence under the workspace's .mawf/evidence is outside product scope", (t) => {
  const workspace = path.join(tmp(t), "product");
  fs.mkdirSync(workspace);
  const candidate = { candidateId: "cand-1", commitSha: null, diffHash: "d", effectiveConfigHash: "e", scope: ["."], implementerActorIds: ["author-1"], workspace, createdAt: new Date(Date.now() - 60000).toISOString() };
  const run = { runId: "run-1", snapshot: { modeId: "dynamic", modeVersion: 1, configRevision: 0 }, tasks: { "hacker-1": { taskId: "hacker-1", verificationTarget: "cand-1", actorId: "hacker-1", attempt: 1, currentLeaseId: "lease-1", status: "produced", adapter: "local-process", selection: null, adapterState: null } } };
  const ledger = { leases: { "lease-1": { leaseId: "lease-1", runId: "run-1", actorId: "hacker-1", status: "released", sessionId: "job-1", jobId: "job-1" } } };
  const record = (rawPath) => ({ runId: "run-1", candidateId: "cand-1", commitSha: null, diffHash: "d", effectiveConfigHash: "e", modeId: "dynamic", modeVersion: 1, configRevision: 0, scope: ["."], implementerActorIds: ["author-1"], requirementId: "R1", scenarioId: "S1", hackerActorId: "hacker-1", hackerTaskId: "hacker-1", attempt: 1, sessionId: "job-1", model: "not_applicable", adapter: "local-process", expectedBehavior: "x", observedBehavior: "y", entrypoint: "z", enforcementLevel: "e", verdict: "passed", kind: "real_user_path", oracleSource: { kind: "real_observation", reference: "test" }, oracleVersion: "1", exactSteps: ["step"], environment: {}, controlledInputs: {}, counterexamples: [], scopeLimitations: [], degradations: [], costCoverage: {}, capabilities: ["sandbox"], rawOutputs: [{ path: rawPath, sha256: sha256(fs.readFileSync(rawPath)) }], timestamps: { startedAt: new Date(Date.now() - 30000).toISOString(), finishedAt: new Date(Date.now() - 10000).toISOString() } });
  const write = (...segments) => { const file = path.join(workspace, ...segments); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `{"raw":"${segments.join("/")}"}`); return file; };
  const evidence = write(".mawf", "evidence", "run-1", "hacker-1", "1", "raw.json");
  assert.equal(validateEvidence(run, candidate, record(evidence), ledger).rawOutputs[0].path, evidence);
  for (const product of [write("raw.json"), write(".mawf", "inputs", "run-1", "raw.json"), write("src", ".mawf-evidence", "raw.json")]) {
    assert.throws(() => validateEvidence(run, candidate, record(product), ledger), { code: "EVIDENCE_PRODUCT_OVERLAP" }, product);
  }
});

test("run prepare names a session-writable input directory outside the state root", async (t) => {
  const dir = tmp(t), project = path.join(dir, "project"), bin = path.join(dir, "bin");
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const fake = path.join(bin, "fake-claude.cjs");
  fs.writeFileSync(fake, `if (process.argv.slice(2).join(" ") === "auth status --json") process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); else process.exit(2);`);
  if (isWin) fs.writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  swapEnv(t, { HOME: path.join(dir, "home"), USERPROFILE: path.join(dir, "home"), PATH: bin + path.delimiter + process.env.PATH });
  setIntegration(project, "host.claude-code", true);
  const chunks = [], write = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code;
  try { code = await runExecution(["prepare"], { project, "host-managed": true, task: "probe the input directory", json: true }); }
  finally { process.stdout.write = write; }
  const out = JSON.parse(chunks.join(""));
  assert.equal(code, 0, out.reasonCode);
  assert.equal(out.inputDirectory, path.join(project, ".mawf", "inputs", out.runId));
  assert.ok(fs.statSync(out.inputDirectory).isDirectory());
  assert.ok(path.relative(out.stateRoot, out.inputDirectory).startsWith(".."), "the input directory is not inside the state root");
});
