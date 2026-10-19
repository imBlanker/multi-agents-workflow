// Real local non-model process backend. Isolation is a working directory and
// dedicated process group, not a filesystem/network sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity, processAlive, stateError, assertSafePath } from './atomic-state.js';
import { acquireTask, claimLocalLaunch, bindJob, heartbeat, reportResult, releaseLease, markCancelPending, markLaunchFailed, runtimeStatus, linuxProcess, backendStopped, observeLocalExit } from './runtime.js';

function currentLease(opts) {
  const status = runtimeStatus(opts);
  return status.leases.find(lease => lease.leaseId === opts.leaseId);
}
export function signalKnownBackend(lease, signal) {
  if (!lease.ownerProcess) return { sent: false, reason: 'No backend binding; launch may be running elsewhere' };
  if (process.platform !== 'linux') return { sent: false, reason: 'Identity-safe process-tree signaling is unsupported on this platform' };
  const actual = linuxProcess(lease.ownerProcess.pid);
  if (actual && actual.startIdentity !== lease.ownerProcess.startIdentity) return { sent: false, reason: 'PID was reused; the new process must not be signaled' };
  const liveWitness = actual?.startIdentity === lease.ownerProcess.startIdentity || (lease.knownGroupProcesses || []).some(identity => { const current = linuxProcess(identity.pid); return current && current.startIdentity === identity.startIdentity && current.processGroup === lease.processGroup && !['Z', 'X'].includes(current.state); });
  if (!liveWitness) return { sent: false, reason: 'No live recorded process establishes process-group ownership; cancellation remains pending' };
  if (lease.processGroup === null) return { sent: false, reason: 'No dedicated process group; descendant-safe cancellation is unverified' };
  try { process.kill(-lease.processGroup, signal); return { sent: true, signal }; }
  catch (error) { return { sent: false, reason: error.code }; }
}
export async function cancelLocal(opts) {
  const graceMs = opts.graceMs ?? 1500;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30000) throw stateError('INVALID_CANCEL_BOUND', 'Cancellation grace must be 0..30000ms');
  const pending = markCancelPending(opts);
  if (pending.alreadyReleased) return { ...pending, cancelled: pending.task.status === 'cancelled', reasonCode: 'ALREADY_RELEASED' };
  if (pending.lease.adapter !== 'local-process') return { ...pending, ok: false, cancelled: false, reasonCode: 'CANCEL_UNSUPPORTED', reason: 'Host adapter must confirm backend cancellation; reservation retained' };
  const signals = [];
  if (!backendStopped(pending.lease).stopped) signals.push(signalKnownBackend(pending.lease, 'SIGTERM'));
  const until = Date.now() + graceMs;
  while (!backendStopped(pending.lease).stopped && Date.now() < until) await delay(40);
  if (!backendStopped(pending.lease).stopped) {
    signals.push(signalKnownBackend(pending.lease, 'SIGKILL'));
    const killUntil = Date.now() + 1500;
    while (!backendStopped(pending.lease).stopped && Date.now() < killUntil) await delay(40);
  }
  const released = releaseLease(opts);
  return { ...released, cancelled: released.released === true || released.alreadyReleased === true, signals, reasonCode: released.ok ? 'CANCELLED' : 'STOP_UNCONFIRMED' };
}
export async function dispatchLocal(opts) {
  const reserved = acquireTask({ ...opts, controllerProcess: processIdentity() });
  if (!reserved.allowed || reserved.action === 'observe') return reserved;
  const identity = { ...opts, stateRoot: reserved.stateRoot, leaseId: reserved.leaseId, token: reserved.fencingToken };
  const launch = claimLocalLaunch(identity);
  if (launch.action !== 'start') return { ...reserved, action: 'observe' };
  const task = launch.task;
  const directory = path.join(reserved.stateRoot, 'runs', task.runId, 'output', task.taskId);
  const stdoutPath = path.join(directory, `attempt-${task.attempt}.stdout`), stderrPath = path.join(directory, `attempt-${task.attempt}.stderr`);
  let outFd, errFd;
  try {
    assertSafePath(directory);
    fs.mkdirSync(directory, { recursive: true });
    outFd = fs.openSync(stdoutPath, 'wx', 0o600);
    errFd = fs.openSync(stderrPath, 'wx', 0o600);
  } catch (error) {
    if (outFd !== undefined) fs.closeSync(outFd);
    if (errFd !== undefined) fs.closeSync(errFd);
    markLaunchFailed({ ...identity, error: { code: error.code, message: error.message } });
    throw error;
  }
  const maxOutputBytes = 8 * 1024 * 1024;
  const counts = { stdout: 0, stderr: 0, truncated: false };
  let child;
  try { child = spawn(task.command[0], task.command.slice(1), { cwd: task.workspace, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
  catch (error) { fs.closeSync(outFd); fs.closeSync(errFd); markLaunchFailed({ ...identity, error: { code: error.code, message: error.message } }); throw error; }
  const capture = (channel, fd) => chunk => { const bytes = Math.min(chunk.length, Math.max(0, maxOutputBytes - counts[channel])); if (bytes) fs.writeSync(fd, chunk.subarray(0, bytes)); counts[channel] += bytes; if (bytes < chunk.length) counts.truncated = true; };
  child.stdout.on('data', capture('stdout', outFd)); child.stderr.on('data', capture('stderr', errFd));
  return await new Promise(resolve => {
    let interval, deadline, settled = false, spawnError = null, cancelling = false;
    const cancel = async () => { if (cancelling || settled) return; cancelling = true; try { await cancelLocal(identity); } catch {} };
    child.once('spawn', () => {
      try {
        const process = processIdentity(child.pid);
        bindJob({ ...identity, process, processGroup: process.platform === 'linux' ? child.pid : null });
        interval = setInterval(() => {
          try {
            const lease = currentLease(identity);
            if (lease?.cancelRequestedAt) { void cancel(); return; }
            heartbeat(identity);
          } catch { void cancel(); }
        }, 1000);
        deadline = setTimeout(() => { void cancel(); }, task.maxDurationMs);
      } catch (error) {
        if (linuxProcess(child.pid)) { spawnError = error; void cancel(); }
        // A very fast child can exit before /proc binding. Its actual close
        // event below supplies a scoped exit receipt; it is not 'not started'.
      }
    });
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      if (settled) return; settled = true;
      clearInterval(interval); clearTimeout(deadline);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      fs.closeSync(outFd); fs.closeSync(errFd);
      let result;
      try {
        if (spawnError && !child.pid) result = markLaunchFailed({ ...identity, error: { code: spawnError.code, message: spawnError.message } });
        else {
          observeLocalExit(identity, child);
          const lease = currentLease(identity);
          if (lease?.status === 'released') result = { schemaVersion: 1, ok: true, lease, reasonCode: 'ALREADY_SETTLED' };
          else {
            const output = { exitCode: code, signal, stdoutPath, stderrPath, truncated: counts.truncated, adapter: 'local-process', costKind: 'non_model_process' };
            if (!lease?.cancelRequestedAt) reportResult({ ...identity, status: code === 0 && !spawnError ? 'produced' : 'failed', result: output });
            result = releaseLease(identity);
            result.output = output;
          }
        }
      } catch (error) { result = { schemaVersion: 1, ok: false, reasonCode: error.code || 'FINALIZATION_FAILED', reason: error.message, leaseId: reserved.leaseId, resourcesMayRemainReserved: true }; }
      const finalTask = result.task || runtimeStatus({ ...identity, runId: task.runId, taskId: task.taskId }).task;
      resolve({ ...result, ok: result.ok !== false && finalTask.status === 'produced', reasonCode: finalTask.status === 'produced' ? 'PRODUCED' : finalTask.status === 'cancelled' ? 'TASK_CANCELLED' : 'TASK_FAILED', status: finalTask.status, action: 'started', leaseId: reserved.leaseId, fencingToken: reserved.fencingToken });
    });
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  });
}
