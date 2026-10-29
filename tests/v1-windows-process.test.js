import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnWindowsJob, windowsLaunch, windowsStartIdentity, windowsJobStopped, stopWindowsJob } from '../src/platform/windows-process.js';
import { createRun, addTask, runtimeStatus } from '../src/runtime.js';
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
