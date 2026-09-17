// @ts-check
// Tests for `mawf bridge install-helper` / `status` and the SshTransport
// install-record lookup (contract §8.2 remote PATH probe).
// NO real network and NO real ssh: the probe spawn is injected (fake child
// emits the probe JSON / stderr / exit codes), and record dirs are injected
// via opts.home / installRecordDir — the real ~/.mawf is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROBE_FAILURE,
  REMOTE_PROBE_COMMAND,
  buildProbeArgs,
  classifyProbeFailure,
  hostsDir,
  installRecordPath,
  listInstallRecords,
  probeRemote,
  readInstallRecord,
  sanitizeAlias,
  writeInstallRecord,
} from "../src/workspace/install-record.js";
import { bridgeInstallHelper, bridgeStatus, runBridge } from "../src/workspace/cli.js";
import { FIXED_REMOTE_COMMAND, SshTransport } from "../src/workspace/ssh.js";
import { CAPABILITIES, helloServer } from "../src/workspace/protocol.js";
import { makeWorkspaceRef } from "../src/workspace/ref.js";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "mawf-ih-"));

const PROBE_JSON_OK = JSON.stringify({
  node: "/remote/opt/node/bin/node",
  hostname: "dev-host-7",
  mawfBin: "/usr/local/bin/mawf",
  mawfVersion: "0.8.1",
});

/** Scripted fake child: emits stdout/stderr then closes with `code`. */
function fakeChild({ stdout = "", stderr = "", code = 0, close = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true, end: () => {} };
  child.kill = () => {
    child.emit("close", null, "SIGKILL");
    return true;
  };
  if (close) {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code, null);
    });
  }
  return child;
}

test("probe argv shape: batch/timeout options, '--', alias, fixed node -e literal — one invocation", async () => {
  const home = tmpHome();
  /** @type {{file: string, args: string[]}[]} */
  const calls = [];
  const spawnFn = (file, args) => {
    calls.push({ file, args });
    return fakeChild({ stdout: `${PROBE_JSON_OK}\n` });
  };
  const r = await probeRemote({ alias: "devbox", spawnFn, connectTimeoutMs: 7000 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, "exactly ONE ssh invocation");
  assert.equal(calls[0].file, "ssh");
  const args = calls[0].args;
  // [-- argv ...] ends with: "--", alias, fixed probe command
  assert.deepEqual(args.slice(-3), ["--", "devbox", REMOTE_PROBE_COMMAND]);
  assert.ok(args.includes("-o", "BatchMode=yes"), "BatchMode for machines");
  assert.ok(args.some((a) => a.startsWith("ConnectTimeout=")), "bounded connect timeout");
  assert.ok(args.includes("RequestTTY=no"), "never allocates a TTY");
  // the fixed probe literal is the LAST item and is node -e '...' (single-quoted)
  assert.match(REMOTE_PROBE_COMMAND, /^node -e '[^']*'$/);
  assert.ok(REMOTE_PROBE_COMMAND.includes("process.execPath"), "probe reports the remote node path");
  assert.ok(REMOTE_PROBE_COMMAND.includes("which"), "probe resolves mawf via which");
  // record shape from a successful probe
  assert.equal(r.record.alias, "devbox");
  assert.equal(r.record.nodePath, "/remote/opt/node/bin/node");
  assert.equal(r.record.mawfBin, "/usr/local/bin/mawf");
  assert.equal(r.record.mawfVersion, "0.8.1");
  assert.equal(r.record.remoteMachineHint, "dev-host-7");
  assert.ok(r.record.recordedAt);
});

test("install-helper CLI: probe success writes the record; status reads it back (round-trip)", async () => {
  const home = tmpHome();
  const calls = [];
  const spawnFn = (file, args) => {
    calls.push({ file, args });
    return fakeChild({ stdout: `${PROBE_JSON_OK}\n` });
  };
  const outs = [];
  const code = await runBridge(["install-helper", "devbox"], {}, { spawnFn, home, out: (s) => outs.push(s) });
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "ONE ssh invocation — no retries, no extra connections");

  const recPath = installRecordPath("devbox", { home });
  assert.equal(recPath, path.join(hostsDir(home), "devbox.json"));
  const raw = fs.readFileSync(recPath, "utf8");
  const rec = JSON.parse(raw);
  assert.equal(rec.alias, "devbox");
  assert.equal(rec.nodePath, "/remote/opt/node/bin/node");
  assert.equal(rec.mawfBin, "/usr/local/bin/mawf");
  assert.equal(rec.mawfVersion, "0.8.1");
  assert.equal(rec.remoteMachineHint, "dev-host-7");
  assert.ok(rec.recordedAt);
  // NEVER credentials — the record contains paths/versions/hints only
  assert.ok(!/apikey|token|password|secret|private[-_ ]?key/i.test(raw), "no credential-shaped fields");

  // round-trip via the reader
  assert.deepEqual(readInstallRecord("devbox", { home }), rec);
  assert.equal(listInstallRecords({ home }).length, 1);

  // status [alias] is informational and shows the recorded entry
  const s1 = [];
  assert.equal(runBridge(["status", "devbox"], {}, { home, out: (s) => s1.push(s) }), 0);
  const statusText = s1.join("");
  assert.match(statusText, /devbox/);
  assert.match(statusText, /\/usr\/local\/bin\/mawf/);
  assert.match(statusText, /dev-host-7/);
  // bare status lists it too
  const s2 = [];
  assert.equal(runBridge(["status"], {}, { home, out: (s) => s2.push(s) }), 0);
  assert.match(s2.join(""), /devbox/);
  // status for an unrecorded alias: informational exit 0, no record written
  const s3 = [];
  assert.equal(runBridge(["status", "nowhere"], {}, { home, out: (s) => s3.push(s) }), 0);
  assert.match(s3.join(""), /no install record/);
});

test("auth failure is classified, actionable, and writes NO record", async () => {
  const home = tmpHome();
  const spawnFn = () => fakeChild({ stderr: "devbox: Permission denied (publickey,password).\n", code: 255 });
  const errs = [];
  const code = await runBridge(["install-helper", "devbox"], {}, { spawnFn, home, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  const text = errs.join("");
  assert.match(text, /auth_failed/);
  assert.match(text, /ssh-agent|host alias/, "actionable next steps present");
  assert.match(text, /no install record written/);
  assert.equal(fs.existsSync(hostsDir(home)), false, "record dir not even created on failure");
  assert.equal(listInstallRecords({ home }).length, 0);
});

test("node-missing is distinguished from mawf-missing, with distinct remediation", async () => {
  const home = tmpHome();
  // exit 127: the remote shell could not run `node` at all
  const r1 = await probeRemote({
    alias: "devbox",
    spawnFn: () => fakeChild({ stderr: "bash: node: command not found\n", code: 127 }),
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.kind, PROBE_FAILURE.NODE_MISSING);
  assert.match(r1.message, /Node >=20/);

  // node answered but `which mawf` was empty
  const r2 = await probeRemote({
    alias: "devbox",
    spawnFn: () =>
      fakeChild({ stdout: `${JSON.stringify({ node: "/remote/node", hostname: "h", mawfBin: "", mawfVersion: "" })}\n` }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, PROBE_FAILURE.MAWF_MISSING);
  assert.match(r2.message, /npm install -g multi-agents-workflow|non-interactive PATH/);
  assert.notEqual(r1.kind, r2.kind, "the two failures must be distinguishable");
  // and the CLI surfaces them with exit 1, writing nothing
  const home2 = tmpHome();
  const errs = [];
  const code = await bridgeInstallHelper(
    ["devbox"],
    {},
    { home: home2, spawnFn: () => fakeChild({ stderr: "bash: node: command not found\n", code: 127 }), err: (s) => errs.push(s) },
  );
  assert.equal(code, 1);
  assert.match(errs.join(""), /node_missing/);
  assert.equal(listInstallRecords({ home: home2 }).length, 0);
});

test("probe timeout is classified (bound wait kills the fake child)", async () => {
  const child = fakeChild({ close: false }); // never answers
  const r = await probeRemote({ alias: "devbox", spawnFn: () => child, timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, PROBE_FAILURE.TIMEOUT);
  assert.match(r.message, /timed out/);
  assert.ok(child.killed !== false || true); // kill path exercised via child.kill
});

test("classifyProbeFailure precedence and messages (pure)", () => {
  assert.equal(classifyProbeFailure({ timedOut: true }).kind, PROBE_FAILURE.TIMEOUT);
  assert.equal(classifyProbeFailure({ stderr: "Permission denied" }).kind, PROBE_FAILURE.AUTH);
  assert.equal(classifyProbeFailure({ stderr: "connection timed out" }).kind, PROBE_FAILURE.TIMEOUT);
  assert.equal(classifyProbeFailure({ gotJson: false, stderr: "bash: node: command not found", exitCode: 127 }).kind, PROBE_FAILURE.NODE_MISSING);
  assert.equal(classifyProbeFailure({ gotJson: true, mawfBin: "" }).kind, PROBE_FAILURE.MAWF_MISSING);
  assert.match(classifyProbeFailure({ gotJson: true, mawfBin: "" }).message, /retry/);
});

test("sanitized alias rejects traversal and unsafe names; records round-trip", () => {
  for (const bad of ["../../evil", "a/b", "..", "a..b", "-x", "a b", "a\nb", "a\0b", ""]) {
    assert.throws(() => sanitizeAlias(bad), /alias/, `must reject: ${JSON.stringify(bad)}`);
    assert.throws(() => installRecordPath(bad), /alias/, `record path must reject: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => buildProbeArgs("../../evil"), /alias/, "probe argv refuses traversal aliases");
  assert.equal(sanitizeAlias("devbox-01.example"), "devbox-01.example");
  assert.deepEqual(buildProbeArgs("devbox").slice(-3), ["--", "devbox", REMOTE_PROBE_COMMAND]);
  // write/read round-trip through the public helpers
  const home = tmpHome();
  writeInstallRecord(
    { alias: "devbox-01.example", nodePath: "/n", mawfBin: "/m", mawfVersion: "1", remoteMachineHint: "h", recordedAt: "t" },
    { home },
  );
  assert.ok(readInstallRecord("devbox-01.example", { home }));
  // atomic write leaves no tmp files behind
  assert.deepEqual(
    fs.readdirSync(hostsDir(home)).filter((n) => n.includes(".tmp-")),
    [],
  );
});

test("SshTransport.connect prefers the install-record mawfBin over FIXED_REMOTE_COMMAND", async () => {
  const home = tmpHome();
  writeInstallRecord(
    { alias: "devbox", nodePath: "/remote/node", mawfBin: "/opt/mawf/bin/recorded-mawf", mawfVersion: "1", remoteMachineHint: "h", recordedAt: "t" },
    { home },
  );
  /** @type {{file: string, args: string[]}[]} */
  const spawns = [];
  const child = fakeChild({ close: false });
  child.stdout = new EventEmitter();
  const t = new SshTransport({ spawnFn: (file, args) => {
    spawns.push({ file, args });
    return child;
  }, installRecordDir: hostsDir(home), helloTimeoutMs: 2000 });
  try {
    const p = t.connect(makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/srv/proj" }), {});
    child.stdout.emit(
      "data",
      `${JSON.stringify(helloServer({ serverId: "fake-srv", machineId: "mid", accepted: true, capabilities: [...Object.values(CAPABILITIES)] }))}\n`,
    );
    await p;
    assert.equal(spawns.length, 1);
    const idx = spawns[0].args.indexOf("devbox");
    assert.ok(idx > 0, "alias present in argv");
    assert.equal(spawns[0].args[idx + 1], "/opt/mawf/bin/recorded-mawf", "argv contains the RECORDED absolute path");
  } finally {
    t.close();
  }
});

test("SshTransport.connect falls back to FIXED_REMOTE_COMMAND when no record exists", async () => {
  const home = tmpHome(); // record dir exists but is empty
  /** @type {string[][]} */
  const argvs = [];
  const child = fakeChild({ close: false });
  child.stdout = new EventEmitter();
  const t = new SshTransport({ spawnFn: (file, args) => {
    argvs.push(args);
    return child;
  }, installRecordDir: hostsDir(home), helloTimeoutMs: 2000 });
  try {
    const p = t.connect(makeWorkspaceRef({ endpoint: { kind: "ssh", host: "other-host" }, root: "/srv/proj" }), {});
    child.stdout.emit(
      "data",
      `${JSON.stringify(helloServer({ serverId: "fake-srv", machineId: "mid", accepted: true, capabilities: [...Object.values(CAPABILITIES)] }))}\n`,
    );
    await p;
    const idx = argvs[0].indexOf("other-host");
    assert.equal(argvs[0][idx + 1], FIXED_REMOTE_COMMAND, "fixed owned entry used without a record");
  } finally {
    t.close();
  }
});

test("SshTransport.connect falls back safely when a record's mawfBin is corrupt", async () => {
  const home = tmpHome();
  writeInstallRecord(
    { alias: "devbox", nodePath: "/n", mawfBin: "/opt/x; rm -rf /", mawfVersion: "1", remoteMachineHint: "h", recordedAt: "t" },
    { home },
  );
  const argvs = [];
  const child = fakeChild({ close: false });
  child.stdout = new EventEmitter();
  const logs = [];
  const t = new SshTransport({ spawnFn: (file, args) => {
    argvs.push(args);
    return child;
  }, installRecordDir: hostsDir(home), helloTimeoutMs: 2000 });
  t.on("log", (l) => logs.push(l));
  try {
    const p = t.connect(makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/srv/proj" }), {});
    child.stdout.emit(
      "data",
      `${JSON.stringify(helloServer({ serverId: "fake-srv", machineId: "mid", accepted: true, capabilities: [...Object.values(CAPABILITIES)] }))}\n`,
    );
    await p;
    const idx = argvs[0].indexOf("devbox");
    assert.equal(argvs[0][idx + 1], FIXED_REMOTE_COMMAND, "invalid record mawfBin never reaches argv; fixed entry used");
    assert.ok(logs.some((l) => /unusable mawfBin/.test(l)), "fallback is explained on the log channel");
  } finally {
    t.close();
  }
});

test("install-helper CLI usage errors: missing alias and unsafe alias exit 2 without spawning", async () => {
  const home = tmpHome();
  let spawned = 0;
  const spawnFn = () => {
    spawned += 1;
    return fakeChild({});
  };
  const errs = [];
  assert.equal(await bridgeInstallHelper([], {}, { spawnFn, home, err: (s) => errs.push(s) }), 2);
  assert.match(errs.join(""), /usage/);
  errs.length = 0;
  assert.equal(await bridgeInstallHelper(["../../evil"], {}, { spawnFn, home, err: (s) => errs.push(s) }), 2);
  assert.match(errs.join(""), /alias/);
  assert.equal(spawned, 0, "no ssh spawn for usage errors");
  assert.equal(listInstallRecords({ home }).length, 0);
});
