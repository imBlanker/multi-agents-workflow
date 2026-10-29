import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ADAPTERS, discoverAdapter } from './discovery.js';
import { acquireTask, claimLocalLaunch, runtimeStatus, bindJob, heartbeat, reportResult, releaseLease, markCancelPending, markLaunchFailed, recordAdapterState, backendStopped, linuxProcess } from '../runtime.js';
import { processIdentity, stateError, writeAtomic, assertSafePath } from '../atomic-state.js';
import { signalKnownBackend } from '../local-runtime.js';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const redact = value => String(value).replace(/(?:Bearer\s+|(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*)[^\s"']+/gi, '[REDACTED_CREDENTIAL]');
export function companionCommand(descriptor, action, argv, cwd) {
  if (digest(fs.readFileSync(descriptor.companion)) !== descriptor.companionSha256) throw stateError('ADAPTER_DRIFT', 'Companion changed since selection; create a new reviewed attempt');
  let stdout;
  try { stdout = execFileSync(process.execPath, [descriptor.companion, action, ...argv, '--cwd', cwd, '--json'], { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAUDE_PLUGIN_ROOT: descriptor.pluginRoot }, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw stateError(error.code === 'ETIMEDOUT' ? 'COMPANION_TIMEOUT' : 'COMPANION_EXIT', redact(error.stderr || error.message).slice(0, 8192)); }
  try { const result = JSON.parse(stdout); if (!result || typeof result !== 'object') throw Error(); return result; }
  catch { throw stateError('COMPANION_INVALID_RESPONSE', 'Companion did not return a nonempty JSON object'); }
}
export function preflightPi(descriptor, selection, effort, cwd) {
  let observed;
  try { observed = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./pi-probe-worker.js', import.meta.url)), descriptor.binary, cwd, selection.modelId, effort], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw stateError('PI_IDENTITY_UNVERIFIED', 'Pi failed a no-prompt identity resolution with the exact companion model/effort argv'); }
  if (observed.providerId !== selection.providerId || observed.modelId !== selection.modelId || observed.isStreaming) throw stateError('PI_PROVIDER_MODEL_MISMATCH', `Requested ${selection.providerId}/${selection.modelId}, but Pi resolved ${observed.providerId}/${observed.modelId}; no prompt was sent`);
  return observed;
}
const snapshot = opts => runtimeStatus({ ...opts, runId: opts.runId, taskId: opts.taskId });
function owned(opts) {
  const state = snapshot(opts), task = state.task;
  if (!task || !ADAPTERS[task.adapter]) throw stateError('ADAPTER_TASK_REQUIRED', 'An existing selected companion task is required');
  const lease = state.leases.find(item => item.leaseId === task.currentLeaseId);
  if (!lease) throw stateError('LEASE_REQUIRED', 'Start this adapter task first');
  if (opts.leaseId && opts.leaseId !== lease.leaseId || opts.token && opts.token !== lease.fencingToken) throw stateError('STALE_LEASE', 'Adapter operation targets a stale lease');
  return { ...state, task, lease, identity: { ...opts, stateRoot: state.stateRoot, leaseId: lease.leaseId, token: lease.fencingToken } };
}
export async function startCompanion(opts) {
  const state = snapshot(opts), task = state.task;
  if (!task || !ADAPTERS[task.adapter]) throw stateError('ADAPTER_TASK_REQUIRED', 'Create a model task with the explicit companion adapter first');
  if (process.platform === 'win32') return { ok: false, reasonCode: 'COMPANION_PROCESS_CONTROL_UNSUPPORTED', reason: 'External background companions do not expose a Windows Job Object; use the native Claude controller or a local-process task' };
  if (task.adapter === 'pi-plugin-cc' && ['advisor', 'researcher'].includes(task.role)) throw stateError('ROLE_PERMISSION_UNSUPPORTED', 'This Pi companion does not enforce read-only tool access; use a verified read-only adapter for this role');
  const descriptor = discoverAdapter(task.adapter, state.run.snapshot.settings, { path: opts.path });
  if (!descriptor.compatible) return { ok: false, reasonCode: descriptor.reasonCode, capability: descriptor };
  if (!opts.actorId && !task.actorId) throw stateError('ACTOR_REQUIRED', 'Use an explicit independent actor identity');
  const effort = opts.effort || 'low';
  if (!ADAPTERS[task.adapter].efforts.includes(effort) || task.adapter === 'pi-plugin-cc' && ['none', 'off'].includes(effort)) throw stateError('EFFORT_UNSUPPORTED', 'Effort must be supported by both companion and underlying runner');
  if (!opts.promptFile || !fs.statSync(opts.promptFile).isFile()) throw stateError('PROMPT_REQUIRED', 'Use --prompt-file with a concrete dispatch specification');
  let auth = null;
  if (task.adapter === 'codex-plugin-cc') {
    try { auth = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./auth-probe-worker.js', import.meta.url)), descriptor.pluginRoot, task.workspace], { encoding: 'utf8', timeout: 20000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch { throw stateError('PROVIDER_PREFLIGHT_UNVERIFIED', 'Codex app-server provider preflight failed; no model request was launched'); }
    if (!auth.provider || auth.provider !== task.selection.providerId) return { ok: false, reasonCode: 'PROVIDER_MISMATCH', configuredProvider: auth.provider || null, requestedProvider: task.selection.providerId, reason: 'The companion cannot override provider; authorization must match the existing app-server provider' };
    descriptor.authentication = auth;
  }
  if (task.adapter === 'pi-plugin-cc') descriptor.identityPreflight = preflightPi(descriptor, task.selection, effort, task.workspace);
  const prompt = fs.readFileSync(opts.promptFile, 'utf8');
  if (!prompt.trim() || Buffer.byteLength(prompt) > 1024 * 1024) throw stateError('INVALID_PROMPT', 'Prompt must be nonempty and at most 1 MiB');
  const reserved = acquireTask({ ...opts, controllerProcess: processIdentity() });
  if (!reserved.allowed || reserved.action !== 'start') return reserved;
  const identity = { ...opts, stateRoot: reserved.stateRoot, leaseId: reserved.leaseId, token: reserved.fencingToken };
  const directory = path.join(reserved.stateRoot, 'runs', task.runId, 'adapter', task.taskId, `attempt-${reserved.lease.attempt}`);
  try {
    assertSafePath(directory); fs.mkdirSync(directory, { recursive: true });
    const promptFile = path.join(directory, 'prompt.txt'); fs.writeFileSync(promptFile, prompt, { mode: 0o600, flag: 'wx' });
    const request = { identity, descriptor, promptFile, promptHash: digest(prompt), effort, write: opts.write === true, workspace: task.workspace, maxDurationMs: task.maxDurationMs, requested: task.selection, directory };
    writeAtomic(path.join(directory, 'request.json'), request);
    recordAdapterState(identity, { descriptor, requestFile: path.join(directory, 'request.json'), requested: task.selection, actualModel: null, actualProvider: null, status: 'starting', freshSession: true, permissionEnforcement: 'upstream_requested_not_verified' });
    const fd = fs.openSync(path.join(directory, 'supervisor.log'), 'wx', 0o600);
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(new URL('./companion-worker.js', import.meta.url)), path.join(directory, 'request.json')], { detached: true, stdio: ['ignore', fd, fd], cwd: task.workspace }); }
    finally { fs.closeSync(fd); }
    child.unref();
    return { ok: true, action: 'supervisor_started', leaseId: reserved.leaseId, fencingToken: reserved.fencingToken, supervisorPid: child.pid, runId: task.runId, taskId: task.taskId, stateRoot: reserved.stateRoot, status: 'starting', readiness: 'unverified_until_result' };
  } catch (error) { markLaunchFailed({ ...identity, error: { code: error.code, message: error.message } }); throw error; }
}
export async function cancelCompanion(opts) {
  const current = owned(opts), { task, lease, identity } = current;
  if (lease.status === 'released') return { ok: true, alreadyReleased: true, task };
  const pending = markCancelPending(identity);
  const state = task.adapterState;
  let upstream = null;
  if (state?.jobId) {
    try { upstream = companionCommand(state.descriptor, 'cancel', [state.jobId], task.workspace); }
    catch (error) { recordAdapterState(identity, { cancelError: { code: error.code, message: error.message } }); }
  }
  const signals = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const live = owned(identity).lease;
    if (backendStopped(live).stopped) break;
    signals.push(signalKnownBackend(live, signal));
    const until = Date.now() + 1200;
    while (!backendStopped(owned(identity).lease).stopped && Date.now() < until) await delay(50);
  }
  // The upstream payload is retained but never substitutes for process evidence.
  let released = releaseLease(identity);
  for (let retry = 0; !released.ok && retry < 10; retry++) { await delay(100); released = releaseLease(identity); }
  return { ...released, cancelled: released.released === true, upstream, signals, reasonCode: released.ok ? 'CANCELLED' : 'STOP_UNCONFIRMED' };
}
export async function observeCompanion(opts, wantResult = false) {
  const current = owned(opts), { task, lease, identity } = current;
  const state = task.adapterState;
  if (!state?.jobId) return { ok: true, task, lease, status: task.status, reasonCode: 'LAUNCH_PENDING_OR_UNRESOLVED' };
  const observed = companionCommand(state.descriptor, wantResult ? 'result' : 'status', [state.jobId], task.workspace);
  const job = observed.job;
  if (!job || job.id !== state.jobId) throw stateError('JOB_ID_MISMATCH', 'Companion returned a different or missing job identity');
  return { ok: true, task, lease, upstream: observed, status: job.status, actualModel: null, actualProvider: null, sessionId: job.threadId || state.sessionId || null };
}
export async function superviseCompanion(request) {
  const { identity, descriptor } = request;
  const claimed = claimLocalLaunch(identity);
  if (claimed.action !== 'start') return claimed;
  const task = claimed.task;
  let jobId;
  try {
    if (task.adapter === 'pi-plugin-cc') {
      try { recordAdapterState(identity, { identityPreflight: preflightPi(descriptor, task.selection, request.effort, task.workspace) }); }
      catch (error) { markLaunchFailed({ ...identity, error: { code: error.code, message: error.message } }); return { ok: false, reasonCode: error.code, reason: error.message, promptSent: false }; }
    }
    const argv = ['--background', '--fresh', '--model', task.selection.modelId, '--effort', request.effort, '--prompt-file', request.promptFile, ...(request.write ? ['--write'] : [])];
    const launched = companionCommand(descriptor, 'task', argv, task.workspace);
    jobId = launched.jobId;
    if (typeof jobId !== 'string' || !jobId) throw stateError('MISSING_JOB_ID', 'Start response did not identify a job; reservation retained');
    recordAdapterState(identity, { jobId, status: launched.status || 'queued', launchResponse: launched });
    const deadline = Date.now() + task.maxDurationMs;
    while (true) {
      const current = owned(identity);
      if (current.lease.status === 'released') return { ok: true, reasonCode: 'ALREADY_RELEASED' };
      if (current.lease.cancelRequestedAt || Date.now() >= deadline) return await cancelCompanion(identity);
      const observed = companionCommand(descriptor, 'status', [jobId], task.workspace);
      const job = observed.job;
      if (!job || job.id !== jobId) throw stateError('JOB_ID_MISMATCH', 'Status did not identify the launched job');
      if (!current.lease.ownerProcess && Number.isSafeInteger(job.pid) && linuxProcess(job.pid)) bindJob({ ...identity, process: processIdentity(job.pid), processGroup: linuxProcess(job.pid)?.processGroup === job.pid ? job.pid : null, jobId, sessionId: job.threadId || null });
      recordAdapterState(identity, { jobId, sessionId: job.threadId || null, status: job.status, observedAt: new Date().toISOString(), actualModel: null, actualProvider: null, resolvedSelectionCoverage: 'upstream_companion_does_not_expose_resolved_provider_or_reroutes' });
      heartbeat(identity);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        const result = companionCommand(descriptor, 'result', [jobId], task.workspace);
        const content = result.storedJob?.rawOutput || result.storedJob?.stdout || result.storedJob?.result;
        const produced = job.status === 'completed' && (typeof content === 'string' ? content.trim().length > 0 : content && typeof content === 'object');
        writeAtomic(path.join(request.directory, 'result.json'), result);
        recordAdapterState(identity, { authenticated: produced ? true : 'unknown', verificationStatus: produced ? 'real_task_result_observed' : 'real_task_failed', capabilityEvidence: { jobId, pluginRef: descriptor.ref, companionSha256: descriptor.companionSha256, freshRequested: true, resultNonempty: !!produced, stopConfirmation: 'pending_process_check' } });
        reportResult({ ...identity, status: produced ? 'produced' : 'failed', result: { adapter: task.adapter, jobId, sessionId: job.threadId || null, resultPath: path.join(request.directory, 'result.json'), actualModel: null, actualProvider: null, requested: task.selection, upstreamStatus: job.status, reason: produced ? 'nonempty_upstream_result' : 'upstream_failed_or_empty_result' } });
        for (let wait = 0; wait < 30 && !backendStopped(owned(identity).lease).stopped; wait++) await delay(100);
        return releaseLease(identity);
      }
      await delay(500);
    }
  } catch (error) {
    try { recordAdapterState(identity, { status: 'unresolved', error: { code: error.code || 'ADAPTER_ERROR', message: redact(error.message) }, jobId: jobId || null }); } catch {}
    // A failed or timed-out launch response cannot prove no job started.
    return { ok: false, reasonCode: error.code || 'ADAPTER_ERROR', reason: redact(error.message), resourcesRetained: true };
  }
}
