import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { completeHostTask } from "../src/runtime.js";
import { defaultSettings } from "../src/settings.js";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonHash = (value) => hash(JSON.stringify(value));

// Seed only persisted identities: no model, discovery, authentication or process launch.
function fixture(t, native = true) {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mawf-native-receipt-")));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const stateRoot = path.join(project, ".mawf", "runtime");
  const directory = path.join(stateRoot, "runs", "run-1", "native");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, "host-events.jsonl");
  const receipt = path.join(directory, "receipts", "lease-child.json");
  const settings = defaultSettings();
  const snapshot = { stateRoot, authorityProject: project, settings, settingsHash: jsonHash(settings),
    modeId: settings.mode.id, modeVersion: settings.mode.version, configRevision: 0, maxConcurrency: 3 };
  snapshot.snapshotHash = jsonHash(snapshot);
  const identity = { runId: "run-1", attempt: 1, generation: 1, modeId: snapshot.modeId,
    modeVersion: snapshot.modeVersion, configRevision: 0 };
  const child = { ...identity, taskId: "child", adapter: "host-managed", status: "produced",
    currentLeaseId: "lease-child", controllerTaskId: native ? "controller" : null,
    result: { attempt: 1, leaseId: "lease-child", status: "produced" } };
  const controller = { ...identity, taskId: "controller", adapter: "claude-native", coordinationOnly: true,
    status: "running", currentLeaseId: "lease-controller", adapterState: { outputPath: source } };
  const lease = { leaseId: "lease-child", runId: "run-1", taskId: "child", attempt: 1, generation: 1,
    fencingToken: "child-token", stateRoot, status: "running", jobId: "agent-1", sessionId: null,
    controllerLeaseId: native ? "lease-controller" : null,
    hostLaunch: { hostSessionId: "parent-session", toolUseId: "agent-call" } };
  const tasks = { child }, leases = { "lease-child": lease };
  if (native) {
    tasks.controller = controller;
    leases["lease-controller"] = { leaseId: "lease-controller", runId: "run-1", taskId: "controller",
      attempt: 1, generation: 1, fencingToken: "controller-token", stateRoot, status: "running" };
  }
  const ledger = { schemaVersion: 1, stateRoot, authorityProject: project, revision: 0,
    policy: { maxConcurrency: 3, configRevision: 0 },
    runs: { "run-1": { runId: "run-1", status: "running", snapshot, tasks } }, leases, launches: {}, events: [] };
  const ledgerFile = path.join(stateRoot, "ledger.json");
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  const event = { type: "system", subtype: "task_notification", status: "completed", task_id: "agent-1",
    tool_use_id: "agent-call", session_id: "parent-session", summary: "Original Hacker return" };
  const raw = JSON.stringify(event) + "\n";
  fs.writeFileSync(source, raw);
  return { project, source, receipt, raw, ledgerFile,
    opts: { project, stateRoot, runId: "run-1", taskId: "child", leaseId: "lease-child", token: "child-token", jobId: "agent-1" } };
}

test("native children reject manual or omitted receipts without changing the lease or capturing a file", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.ledgerFile);
  const missing = path.join(f.project, "does-not-exist.json");
  const forged = path.join(f.project, "forged.json");
  fs.writeFileSync(forged, '{"summary":"fabricated MAWF_EVIDENCE declaration"}');
  for (const options of [{ receiptFile: forged }, { receiptFile: missing }, {},
    { nativeReceipt: false }, { nativeReceipt: "true" }, { nativeReceipt: true, receiptFile: forged },
    { nativeReceipt: true, receiptFile: "" }, { nativeReceipt: true, receiptFile: null }]) {
    assert.throws(() => completeHostTask({ ...f.opts, ...options }), { code: "NATIVE_RECEIPT_REQUIRED" });
    assert.deepEqual(fs.readFileSync(f.ledgerFile), before, "rejection preserves ledger, lease and events");
    assert.equal(fs.existsSync(f.receipt), false, "reject before Core capture writes a receipt");
  }
});

test("native receipt capture retains the exact host event and releases the child", (t) => {
  const f = fixture(t);
  const result = completeHostTask({ ...f.opts, nativeReceipt: true });
  assert.equal(result.released, true);
  assert.equal(result.lease.status, "released");
  assert.equal(result.task.status, "produced");
  assert.equal(result.lease.hostCompletion.receiptPath, f.receipt);
  assert.equal(result.lease.hostCompletion.sha256, hash(f.raw));
  assert.equal(fs.readFileSync(f.receipt, "utf8"), f.raw);
  const ledger = JSON.parse(fs.readFileSync(f.ledgerFile, "utf8"));
  assert.equal(ledger.leases["lease-child"].status, "released");
  assert.equal(ledger.leases["lease-controller"].status, "running");
});

test("missing native completion retains the reservation without falling back to a manual assertion", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "");
  const before = fs.readFileSync(f.ledgerFile);
  assert.throws(() => completeHostTask({ ...f.opts, nativeReceipt: true }), { code: "NATIVE_RECEIPT_UNAVAILABLE" });
  assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
  assert.equal(fs.existsSync(f.receipt), false);
});

test("other hosts retain manual receipts and the existing missing/conflicting option errors", (t) => {
  const f = fixture(t, false);
  const receiptFile = path.join(f.project, "other-host.json");
  const raw = '{"toolReturn":"other host completion"}\n';
  fs.writeFileSync(receiptFile, raw);
  const before = fs.readFileSync(f.ledgerFile);
  assert.throws(() => completeHostTask(f.opts), { code: "HOST_RECEIPT_REQUIRED" });
  assert.throws(() => completeHostTask({ ...f.opts, receiptFile, nativeReceipt: true }), { code: "INVALID_HOST_RECEIPT" });
  assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
  const result = completeHostTask({ ...f.opts, receiptFile });
  assert.equal(result.released, true);
  assert.equal(result.task.status, "produced");
  assert.equal(result.lease.hostCompletion.receiptPath, receiptFile);
  assert.equal(result.lease.hostCompletion.sha256, hash(raw));
});
