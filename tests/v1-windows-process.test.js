import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnWindowsJob, windowsLaunch, windowsStartIdentity, windowsJobStopped, stopWindowsJob } from '../src/platform/windows-process.js';
import { createRun, addTask, runtimeStatus, acquireTask, claimLocalLaunch, markLaunchFailed } from '../src/runtime.js';
import { updateSettings } from '../src/settings.js';
import { processIdentity } from '../src/atomic-state.js';
import { dispatchLocal } from '../src/local-runtime.js';
const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-win-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
test('Windows Job captures Unicode/quoted argv and fast exits without a shell', windows, async t => {
  const dir = fixture(t), args = ['空 格', 'a"b', 'x&y', '%PATH%', 'tail\\', ''];
  const child = spawnWindowsJob([process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { cwd: dir, directory: dir, maxDurationMs: 10000 });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, err); assert.deepEqual(JSON.parse(out), args);
});
test('Windows Job cancellation kills detached grandchildren and rejects wrong creation identity', windows, async t => {
  const dir = fixture(t);
  const script = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(c.pid);setInterval(()=>{},1000);`;
  const child = spawnWindowsJob([process.execPath, '-e', script], { cwd: dir, directory: dir, maxDurationMs: 15000 });
  const closed = once(child, 'close'); let output = '', err = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => err += b);
  for (let i = 0; !output.trim() && child.exitCode === null && i < 100; i++) await delay(50);
  assert.match(output.trim(), /^\d+$/, err);
  const grandchild = Number(output.trim());
  const lease = { windowsJob: windowsLaunch(child).jobName, ownerProcess: { pid: child.pid, startIdentity: windowsStartIdentity(child.pid) } };
  t.after(() => stopWindowsJob(lease));
  assert.equal(windowsJobStopped(lease).stopped, false);
  assert.equal(stopWindowsJob({ ...lease, ownerProcess: { ...lease.ownerProcess, startIdentity: '1' } }).sent, false);
  assert.notEqual(windowsStartIdentity(grandchild), null);
  assert.equal(stopWindowsJob(lease).sent, true);
  await closed;
  assert.equal(windowsStartIdentity(grandchild), null);
  assert.equal(windowsJobStopped(lease).stopped, true);
});
test('Windows local runtime produces output and releases a real fenced lease', windows, async t => {
  const project = fixture(t);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = path.join(project, 'home');
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { run } = await createRun({ project, runId: 'windows-run' });
  addTask({ project, runId: run.runId, taskId: 'fast', adapter: 'local-process', command: [process.execPath, '-e', 'console.log("produced")'], workspace: project, maxDurationMs: 10000 });
  const result = await dispatchLocal({ project, runId: run.runId, taskId: 'fast' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const status = runtimeStatus({ project, runId: run.runId, taskId: 'fast' });
  assert.equal(status.task.status, 'produced');
  assert.equal(status.leases[0].status, 'released');
});
test('Windows Job independently enforces deadlines on descendant trees', windows, async t => {
  const dir = fixture(t);
  const child = spawnWindowsJob([process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], { cwd: dir, directory: dir, maxDurationMs: 800 });
  let output = ''; child.stdout.on('data', b => output += b);
  const [code] = await once(child, 'close');
  assert.equal(code, 124);
  assert.equal(windowsStartIdentity(Number(output.trim())), null);
});
test('an empty job with a live supervisor cannot release or start after cancellation', windows, async t => {
  const root = fixture(t), workspace = path.join(root, 'workspace'), control = path.join(root, 'control');
  fs.mkdirSync(workspace); fs.mkdirSync(control);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$gate=[Threading.Mutex]::new($false,('Global\\mawf-acl-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)); $null=$gate.WaitOne(); [Console]::WriteLine('locked'); try {[Threading.Thread]::Sleep(3000)} finally {$gate.ReleaseMutex();$gate.Dispose()}"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  const marker = path.join(workspace, 'must-not-start');
  const child = spawnWindowsJob([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { cwd: workspace, directory: control, maxDurationMs: 10000,
    sandbox: { read: [], write: [workspace], denyWrite: [], journalDirectory: control }, env: { SystemRoot: process.env.SystemRoot } });
  const closed = once(child, 'close'); child.stdout.resume(); child.stderr.resume();
  const lease = { windowsJob: windowsLaunch(child).jobName, ownerProcess: { pid: child.pid, startIdentity: windowsStartIdentity(child.pid) } };
  let observation;
  for (let i=0;i<50;i++) { observation=windowsJobStopped(lease); if(observation.active===false) break; await delay(20); }
  assert.equal(observation.stopped, false);
  assert.equal(observation.active, false);
  assert.equal(stopWindowsJob(lease).sent, true);
  const [code] = await closed;
  assert.notEqual(code, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(windowsJobStopped(lease).stopped, true);
});

test('one Windows workspace admits one native controller while preserving its child queue', windows, async t => {
  const project = fixture(t);
  updateSettings(project, draft => { draft.pricing.unknownPricePolicy = 'bounded'; draft.pricing.bounds = { maxConcurrency: 2, maxDurationMs: 10000 }; });
  for (const runId of ['first', 'second']) {
    await createRun({ project, runId });
    addTask({ project, runId, taskId: 'controller', adapter: 'claude-native', coordinationOnly: true, providerId: 'fixture', modelId: 'fixture', billingMode: 'api', maxDurationMs: 10000 });
  }
  const first = acquireTask({ project, runId: 'first', taskId: 'controller', controllerProcess: processIdentity() });
  assert.equal(first.allowed, true);
  const blocked = acquireTask({ project, runId: 'second', taskId: 'controller', controllerProcess: processIdentity() });
  assert.equal(blocked.reasonCode, 'WINDOWS_NATIVE_WORKSPACE_BUSY');
  const identity = { project, runId: 'first', taskId: 'controller', leaseId: first.leaseId, token: first.fencingToken };
  claimLocalLaunch(identity); markLaunchFailed({ ...identity, error: { code: 'FIXTURE_NO_LAUNCH' } });
  const second = acquireTask({ project, runId: 'second', taskId: 'controller', controllerProcess: processIdentity() });
  assert.equal(second.allowed, true);
  const secondIdentity = { project, runId: 'second', taskId: 'controller', leaseId: second.leaseId, token: second.fencingToken };
  claimLocalLaunch(secondIdentity); markLaunchFailed({ ...secondIdentity, error: { code: 'FIXTURE_NO_LAUNCH' } });
});
