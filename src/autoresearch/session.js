// Bounded, persistent Pi extension sessions. Worktree isolation is version
// isolation, not a credential/filesystem security sandbox.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpc } from '../adapters/pi-rpc.js';
import { findExecutable } from '../platform/index.js';
import { isEnabled } from '../integrations.js';
import { stateError, assertSafePath, readStrict, writeAtomic, processIdentity } from '../atomic-state.js';
import { acquireTask, claimLocalLaunch, runtimeStatus, recordAdapterState, bindJob, heartbeat, markCancelPending, reportResult, releaseLease, backendStopped, evaluateObservedSelection, markLaunchFailed } from '../runtime.js';
import { signalKnownBackend } from '../local-runtime.js';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function inside(root, relative) { const target = path.resolve(root, relative); if (!relative || path.isAbsolute(relative) || !target.startsWith(path.resolve(root) + path.sep)) throw stateError('EXPERIMENT_PATH_ESCAPE', 'Experiment scope must be relative to its worktree'); assertSafePath(target); return target; }
function fileHash(file) { assertSafePath(file); return sha(fs.readFileSync(file)); }
function current(opts) { const state = runtimeStatus(opts); const lease = state.leases.find(row => row.leaseId === state.task?.currentLeaseId); if (!state.task || state.task.adapter !== 'autoresearch.pi') throw stateError('AUTORESEARCH_TASK_REQUIRED', 'Create an autoresearch.pi task first'); return { ...state, lease }; }
export function validateContract(value) {
  if (!value || typeof value !== 'object') throw stateError('INVALID_EXPERIMENT', 'An experiment contract is required');
  for (const name of ['objective', 'stopCondition', 'keepRule', 'sourceRepo', 'worktree', 'extensionPath']) if (typeof value[name] !== 'string' || !value[name].trim()) throw stateError('INVALID_EXPERIMENT', `Contract ${name} is required`);
  if (!value.metric?.name || !value.metric?.unit || !['lower', 'higher'].includes(value.metric.direction) || !Number.isFinite(value.baseline)) throw stateError('NOT_APPLICABLE', 'A reliable metric, unit, direction and measured numeric baseline are required');
  if (!Array.isArray(value.scope) || !value.scope.length || !value.scope.every(item => typeof item === 'string')) throw stateError('INVALID_EXPERIMENT', 'Explicit file scope is required');
  if (!Number.isSafeInteger(value.maxIterations) || value.maxIterations < 2 || value.maxIterations > 100 || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1000 || value.maxDurationMs > 3600000) throw stateError('INVALID_EXPERIMENT_BOUND', 'Use 2..100 iterations and a 1s..1h time limit');
  if (!value.oracle?.path || !/^[a-f0-9]{64}$/.test(value.oracle.sha256 || '') || fileHash(value.oracle.path) !== value.oracle.sha256) throw stateError('ORACLE_IDENTITY_MISMATCH', 'Independent oracle must exist and match its frozen SHA256');
  for (const file of value.scope) inside(value.worktree, file);
  return structuredClone(value);
}
function extensionInfo(entry) {
  assertSafePath(entry);
  let directory = path.dirname(path.resolve(entry));
  while (directory !== path.dirname(directory)) {
    const manifest = readStrict(path.join(directory, 'package.json'), null);
    if (manifest?.name === 'pi-autoresearch') return { path: path.resolve(entry), version: manifest.version, nodeEngine: manifest.engines?.node || null, source: manifest.repository?.url || manifest.repository || null, sha256: fileHash(entry), packageRoot: directory };
    directory = path.dirname(directory);
  }
  throw stateError('EXTENSION_SOURCE_UNVERIFIED', 'Explicit extension must belong to a versioned pi-autoresearch package');
}
function protectedSnapshot(worktree, contract) {
  const tracked = git(worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
  const required = ['.auto/measure.sh', '.auto/checks.sh', '.auto/config.json', '.auto/prompt.md'];
  const files = [...new Set([...tracked.filter(file => !contract.scope.includes(file)), ...required])];
  return Object.fromEntries(files.map(relative => [relative, fileHash(inside(worktree, relative))]));
}
function unchanged(request) {
  try {
  if (fileHash(request.contract.oracle.path) !== request.contract.oracle.sha256) return { ok: false, file: request.contract.oracle.path, reason: 'oracle_changed' };
  if (fileHash(request.extension.path) !== request.extension.sha256) return { ok: false, file: request.extension.path, reason: 'extension_changed' };
  for (const [relative, expected] of Object.entries(request.protectedFiles)) {
    try { if (fileHash(inside(request.workspace, relative)) !== expected) return { ok: false, file: relative, reason: 'protected_file_changed' }; }
    catch { return { ok: false, file: relative, reason: 'protected_file_missing_or_unsafe' }; }
  }
  return { ok: true };
  } catch { return { ok: false, reason: 'protected_material_missing_or_unsafe' }; }
}
function logEntries(workspace) {
  const file = path.join(workspace, '.auto', 'log.jsonl');
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.length > 8 * 1024 * 1024) throw stateError('EXPERIMENT_LOG_LIMIT', 'Experiment log exceeded 8 MiB');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function startExperiment(opts) {
  const state = current(opts), task = state.task;
  if (!isEnabled(state.run.snapshot.settings, 'autoresearch.pi')) throw stateError('INTEGRATION_DISABLED', 'autoresearch.pi is disabled in the run snapshot');
  const contract = validateContract(readStrict(path.resolve(opts.contractFile)));
  if (Number(process.versions.node.split('.')[0]) < 22) throw stateError('EXTENSION_NODE_UNSUPPORTED', 'This selected pi-autoresearch extension requires Node >=22; Core still supports Node >=20.17');
  const extension = extensionInfo(contract.extensionPath);
  if (extension.version !== '1.9.0' || !String(extension.source).includes('davebcn87/pi-autoresearch')) throw stateError('EXTENSION_VERSION_UNVERIFIED', 'Only the explicitly inspected pi-autoresearch 1.9.0 protocol is supported');
  const binary = findExecutable('pi'); if (!binary) throw stateError('PI_UNAVAILABLE', 'Selected Pi executable is unavailable');
  if (task.workspace !== path.resolve(contract.worktree)) throw stateError('WORKSPACE_MISMATCH', 'Task workspace must be the dedicated contract worktree');
  if (contract.maxDurationMs > task.maxDurationMs) throw stateError('EXPERIMENT_BOUND_MISMATCH', 'Experiment duration exceeds task duration');
  if (!opts.actorId && !task.actorId) throw stateError('ACTOR_REQUIRED', 'Use a distinct experiment actor');
  const reservation = acquireTask({ ...opts, controllerProcess: processIdentity() });
  if (!reservation.allowed || reservation.action !== 'start') return reservation;
  const identity = { ...opts, stateRoot: reservation.stateRoot, leaseId: reservation.leaseId, token: reservation.fencingToken };
  const directory = path.join(reservation.stateRoot, 'runs', task.runId, 'experiments', task.taskId, `attempt-${reservation.lease.attempt}`);
  assertSafePath(directory); fs.mkdirSync(directory, { recursive: true });
  try {
    assertSafePath(contract.worktree);
    if (fs.existsSync(contract.worktree)) throw stateError('WORKTREE_ALREADY_EXISTS', 'Experiment creates an exclusive new worktree; existing paths are never reset or reused');
    const baseCommit = git(contract.sourceRepo, ['rev-parse', 'HEAD']);
    const branch = `mawf-auto-${crypto.randomUUID()}`;
    git(contract.sourceRepo, ['worktree', 'add', '-b', branch, path.resolve(contract.worktree), baseCommit]);
    const configured = readStrict(path.join(contract.worktree, '.auto', 'config.json'));
    if (configured?.maxIterations !== contract.maxIterations || configured?.workingDir && path.resolve(contract.worktree, configured.workingDir) !== path.resolve(contract.worktree)) throw stateError('EXPERIMENT_CONFIG_MISMATCH', 'Existing experiment config must match iteration bound and worktree');
    const request = { identity, contract, extension, binary, directory, workspace: path.resolve(contract.worktree), baseCommit, branch, sessionId: crypto.randomUUID(), sessionDir: path.join(directory, 'sessions'), protectedFiles: protectedSnapshot(contract.worktree, contract) };
    writeAtomic(path.join(directory, 'request.json'), request);
    recordAdapterState(identity, { status: 'starting', requestFile: path.join(directory, 'request.json'), contractHash: sha(JSON.stringify(contract)), baseCommit, branch, workspace: request.workspace, extension, sessionId: request.sessionId, requested: task.selection, actualModel: null, actualProvider: null, permissionEnforcement: 'worktree_and_policy_only' });
    const fd = fs.openSync(path.join(directory, 'supervisor.log'), 'wx', 0o600);
    let child;
    try { child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), path.join(directory, 'request.json')], { detached: true, cwd: request.workspace, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
    child.unref();
    return { ok: true, action: 'experiment_supervisor_started', leaseId: reservation.leaseId, fencingToken: reservation.fencingToken, supervisorPid: child.pid, worktree: request.workspace, sessionId: request.sessionId, stateRoot: reservation.stateRoot, reasonCode: 'STARTING' };
  } catch (error) { recordAdapterState(identity, { status: 'preparation_failed', error: { code: error.code, message: error.message } }); markLaunchFailed({ ...identity, error: { code: error.code, message: error.message } }); throw error; }
}
export async function cancelExperiment(opts) {
  const state = current(opts), lease = state.lease;
  if (!lease) throw stateError('LEASE_REQUIRED', 'Experiment has not started');
  if (opts.leaseId && opts.leaseId !== lease.leaseId || opts.token && opts.token !== lease.fencingToken) throw stateError('STALE_LEASE', 'Cancellation targets an older attempt');
  if (lease.status === 'released') return { ok: true, alreadyReleased: true, task: state.task };
  const identity = { ...opts, leaseId: lease.leaseId, token: lease.fencingToken };
  markCancelPending(identity);
  // The connected supervisor performs extension-off/clear-queue/abort first.
  for (let wait = 0; wait < 40; wait++) { const observed = current(opts); if (observed.lease.status === 'released') return { ok: true, cancelled: true, task: observed.task }; await delay(100); }
  const signals = [signalKnownBackend(current(opts).lease, 'SIGTERM')]; await delay(700);
  if (!backendStopped(current(opts).lease).stopped) { signals.push(signalKnownBackend(current(opts).lease, 'SIGKILL')); await delay(300); }
  return { ...releaseLease(identity), signals };
}
export function experimentStatus(opts) {
  const state = current(opts);
  return { ok: true, status: state.task.status, task: state.task, lease: state.lease, experiment: state.task.adapterState || null, resume: { supported: false, reason: 'Session files are preserved; exact interrupted loop resume has not yet been independently verified' } };
}
export async function superviseExperiment(request) {
  const { identity, contract, workspace } = request;
  const claimed = claimLocalLaunch(identity); if (claimed.action !== 'start') return claimed;
  const task = claimed.task;
  const argv = ['--mode', 'rpc', '--no-extensions', '-e', request.extension.path, '--no-skills', '--no-prompt-templates', '--session-id', request.sessionId, '--session-dir', request.sessionDir, '--provider', task.selection.providerId, '--model', task.selection.modelId];
  const events = path.join(request.directory, 'rpc-events.jsonl');
  let bytes = 0, settled = false, activated = false, terminalReason = null, protocolError = null;
  const rpc = new PiRpc(request.binary, argv, workspace, event => {
    // Record protocol facts, not arbitrary tool/auth output.
    const summary = { at: new Date().toISOString(), type: event.type, command: event.command, id: event.id, success: event.success, disposition: event.disposition };
    const line = JSON.stringify(summary) + '\n'; if (bytes < 2 * 1024 * 1024) { fs.appendFileSync(events, line, { mode: 0o600 }); bytes += line.length; }
    if (event.type === 'agent_start') settled = false;
    if (event.type === 'agent_settled' && activated) settled = true;
  });
  rpc.on('protocol-error', error => { protocolError = error; });
  // Stderr may include provider diagnostics: retain bounded, redacted facts.
  rpc.on('stderr', data => { const text = data.toString().replace(/(?:Bearer\s+|api[_-]?key\s*[:=]\s*)[^\s"']+/gi, '[REDACTED]'); if (bytes < 2 * 1024 * 1024) { fs.appendFileSync(path.join(request.directory, 'stderr.log'), text.slice(0, 8192), { mode: 0o600 }); bytes += data.length; } });
  let outcome = 'failed', stopSteps = [];
  try {
    await new Promise((resolve, reject) => { rpc.child.once('spawn', resolve); rpc.child.once('error', reject); });
    bindJob({ ...identity, process: processIdentity(rpc.child.pid), processGroup: rpc.child.pid, jobId: `pi-rpc:${request.sessionId}`, sessionId: request.sessionId });
    const commands = await rpc.request('get_commands');
    const command = commands.data?.commands?.find(entry => entry.name === 'autoresearch' && entry.source === 'extension');
    if (!command || path.resolve(command.path || command.sourceInfo?.path || '') !== request.extension.path) throw stateError('EXTENSION_NOT_LOADED', 'RPC did not report the exact selected autoresearch extension command');
    const initial = await rpc.request('get_state');
    if (initial.data?.sessionId !== request.sessionId || !initial.data?.sessionFile) throw stateError('SESSION_ID_MISMATCH', 'Pi did not bind the exact persistent session');
    const observed = { providerId: initial.data?.model?.provider || null, modelId: initial.data?.model?.id || null };
    const policy = evaluateObservedSelection(identity, observed);
    recordAdapterState(identity, { actualModel: observed.modelId, actualProvider: observed.providerId, sessionFile: initial.data.sessionFile, extensionLoaded: true, actualSelectionGate: policy, status: 'ready_to_activate' });
    if (!policy.allowed || !observed.providerId || !observed.modelId) throw stateError('ACTUAL_SELECTION_DENIED', `Observed model selection is not authorized: ${policy.reasonCode}`);
    if (!unchanged(request).ok) throw stateError('EXPERIMENT_TAMPERED', 'Contract protected material changed before activation');
    const activatedAt = Date.now(), deadline = activatedAt + contract.maxDurationMs;
    activated = true;
    const activation = await rpc.request('prompt', { message: `/autoresearch ${contract.objective} Follow .auto/prompt.md exactly; modify only ${contract.scope.join(', ')}; stop at ${contract.maxIterations} total iterations.` });
    recordAdapterState(identity, { status: 'running', activationResponse: { success: activation.success, disposition: activation.data?.disposition || activation.disposition || null }, deadline: new Date(deadline).toISOString() });
    while (true) {
      heartbeat(identity);
      const check = unchanged(request);
      if (!check.ok) { terminalReason = { reasonCode: 'EXPERIMENT_TAMPERED', ...check }; break; }
      if (protocolError) throw protocolError;
      if (rpc.closed) throw stateError('RPC_EXITED', 'Pi exited before experiment settlement');
      const state = current(identity);
      if (state.lease.cancelRequestedAt) { terminalReason = { reasonCode: 'CANCEL_REQUESTED' }; break; }
      if (Date.now() >= deadline) { terminalReason = { reasonCode: 'EXPERIMENT_DEADLINE' }; break; }
      const log = logEntries(workspace);
      const experiments = log.filter(entry => ['keep', 'discard', 'crash', 'checks_failed'].includes(entry.status));
      if (experiments.length >= contract.maxIterations || settled) {
        const final = await rpc.request('get_state');
        if (!final.data?.isStreaming && !final.data?.pendingMessageCount) {
          const diff = git(workspace, ['diff', '--name-only', request.baseCommit, 'HEAD']).split('\n').filter(Boolean);
          const drift = diff.filter(file => !contract.scope.includes(file));
          const uncommitted = git(workspace, ['status', '--porcelain']);
          const sufficient = !uncommitted && experiments.length >= 2 && experiments.some(entry => ['keep', 'discard'].includes(entry.status));
          outcome = sufficient && !drift.length ? 'produced' : 'failed';
          terminalReason = { reasonCode: drift.length ? 'EXPERIMENT_SCOPE_DRIFT' : sufficient ? 'EXPERIMENT_PRODUCED_REQUIRES_HACK' : 'NO_VALID_EXPERIMENT', experiments, changedFiles: diff, uncommitted, head: git(workspace, ['rev-parse', 'HEAD']), baseline: contract.baseline, metric: contract.metric };
          break;
        }
      }
      await delay(300);
    }
  } catch (error) { terminalReason = { reasonCode: error.code || 'EXPERIMENT_ERROR', reason: error.message }; }
  finally {
    stopSteps = await rpc.stop();
    for (let wait = 0; wait < 20 && !rpc.closed; wait++) await delay(100);
    const lease = current(identity).lease;
    if (!rpc.closed) { signalKnownBackend(lease, 'SIGTERM'); await delay(500); }
    if (!backendStopped(current(identity).lease).stopped) { signalKnownBackend(current(identity).lease, 'SIGKILL'); await delay(200); }
  }
  const protection = unchanged(request);
  if (!protection.ok) { outcome = 'failed'; terminalReason = { reasonCode: 'EXPERIMENT_TAMPERED', ...protection }; }
  const report = { outcome, ...terminalReason, protectedMaterial: protection, stopSteps, worktree: workspace, baseCommit: request.baseCommit, sessionId: request.sessionId, extension: request.extension, independentAcceptance: false, limitations: ['Worktree is not an OS sandbox', 'Protected material is checked periodically and after completion; external independent oracle is still required', 'Exact interrupted-session resume is unverified'] };
  writeAtomic(path.join(request.directory, 'result.json'), report);
  const state = current(identity);
  if (state.lease.status === 'released') return { ok: false, reasonCode: 'ALREADY_CANCELLED', report };
  recordAdapterState(identity, { status: outcome, resultPath: path.join(request.directory, 'result.json'), report });
  reportResult({ ...identity, status: outcome, result: report });
  return { ...releaseLease(identity), report };
}
