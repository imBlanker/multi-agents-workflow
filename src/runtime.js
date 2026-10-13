import { ChildProcess } from 'node:child_process';
// Shared, fenced runtime ledger. A reservation is permission to start once,
// never evidence that an unbound backend did not start.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLock, readStrict, writeAtomic, assertSafePath, processIdentity, processAlive, stateError } from './atomic-state.js';
import { readSettings, settingsPath } from './settings.js';
import { getMode, modePolicy } from './modes.js';
import { listIntegrations, capabilityStatus } from './integrations.js';
import { loadContext } from './context.js';
import { resolvePrice } from './pricing.js';
import { evaluateSelection } from './cost-policy.js';

const ACTIVE = new Set(['reserved', 'launching', 'running', 'waiting_external', 'cancel_pending', 'orphaned']);
const TERMINAL_TASK = new Set(['cancelled', 'failed', 'produced', 'awaiting_acceptance', 'accepted', 'blocked']);
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
function identifier(value, label) {
  if (['__proto__', 'constructor', 'prototype'].includes(value) || typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw stateError('INVALID_ID', `${label} must be a plain identifier (1-128 characters)`);
  return value;
}
function canonical(directory) {
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
}
export function authorityProject(project = process.cwd()) {
  const projectRoot = canonical(project);
  let ancestor = projectRoot;
  while (true) {
    try {
      const gitFile = path.join(ancestor, '.git');
      if (fs.statSync(gitFile).isFile()) {
        const match = fs.readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
        if (match) {
          const gitDir = path.resolve(ancestor, match[1]);
          const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
          if (path.basename(common) === '.git') return canonical(path.join(path.dirname(common), path.relative(ancestor, projectRoot)));
        }
      }
      return projectRoot;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return projectRoot;
    ancestor = parent;
  }
}
export function resolveStateRoot(project = process.cwd(), explicit) {
  return explicit ? canonical(explicit) : path.join(authorityProject(project), '.mawf', 'runtime');
}

const ledgerPath = root => path.join(root, 'ledger.json');
export function legacyOccupancy(root) {
  const state = readStrict(path.join(root, 'concurrency.json'), undefined);
  if (state === undefined) return 0;
  if (!state || typeof state !== 'object' || !state.running || typeof state.running !== 'object' || Array.isArray(state.running)) throw stateError('INVALID_LEGACY_STATE', 'Legacy concurrency state is malformed; admissions are blocked');
  return Object.keys(state.running).length;
}
function legacyStatus(root) { try { return { legacyActiveCount: legacyOccupancy(root) }; } catch (error) { return { legacyActiveCount: null, legacyStateError: { reasonCode: error.code, reason: error.message } }; } }
function rejectLegacyActive(root) {
  const count = legacyOccupancy(root);
  if (count) throw stateError('LEGACY_ACTIVE_RECORDS', `${count} legacy reservations have unverified process ownership. Preserve and reconcile the old records before v1 admission; existing v1 cancellation/release remain available`);
}

function validateLedger(ledger, root) {
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const states = new Set(['queued', ...ACTIVE, ...TERMINAL_TASK]);
  if (!object(ledger) || ledger.schemaVersion !== 1 || ledger.stateRoot !== root || !object(ledger.runs) || !object(ledger.leases) || !object(ledger.launches) || !Array.isArray(ledger.events) || !Number.isSafeInteger(ledger.revision) || typeof ledger.authorityProject !== 'string' || !path.isAbsolute(ledger.authorityProject)) throw stateError('INVALID_RUNTIME_STATE', 'Runtime ledger is malformed; no empty fallback is permitted');
  if (!object(ledger.policy) || !Number.isSafeInteger(ledger.policy.maxConcurrency) || ledger.policy.maxConcurrency < 1 || !Number.isSafeInteger(ledger.policy.configRevision)) throw stateError('INVALID_RUNTIME_STATE', 'Invalid authoritative concurrency policy');
  for (const [id, run] of Object.entries(ledger.runs)) {
    identifier(id, 'runId');
    if (!object(run) || !object(run.snapshot) || !object(run.tasks)) throw stateError('INVALID_RUNTIME_STATE', 'Malformed run');
    const { snapshotHash, ...snapshotBody } = run.snapshot;
    if (run.runId !== id || !states.has(run.status) || run.snapshot.stateRoot !== root || run.snapshot.authorityProject !== ledger.authorityProject ||
      hash(snapshotBody) !== snapshotHash || hash(run.snapshot.settings) !== run.snapshot.settingsHash || run.snapshot.modeId !== run.snapshot.settings.mode.id || run.snapshot.modeVersion !== run.snapshot.settings.mode.version ||
      !Number.isSafeInteger(run.snapshot.maxConcurrency) || run.snapshot.maxConcurrency < 1) throw stateError('INVALID_RUNTIME_STATE', 'Run snapshot or identity is invalid');
    for (const [taskId, task] of Object.entries(run.tasks)) {
      identifier(taskId, 'taskId');
      if (!object(task) || task.taskId !== taskId || task.runId !== id || !states.has(task.status) || !Number.isSafeInteger(task.attempt) || task.attempt < 1 || !Number.isSafeInteger(task.generation) || task.generation < 0 || task.modeId !== run.snapshot.modeId || task.modeVersion !== run.snapshot.modeVersion || task.configRevision !== run.snapshot.configRevision) throw stateError('INVALID_RUNTIME_STATE', 'Task identity/status is invalid');
      if (task.currentLeaseId !== null) {
        const lease = ledger.leases[task.currentLeaseId];
        if (!object(lease) || lease.runId !== id || lease.taskId !== taskId || lease.attempt !== task.attempt || lease.generation !== task.generation) throw stateError('INVALID_RUNTIME_STATE', 'Task/lease association is broken');
      } else if (ACTIVE.has(task.status)) throw stateError('INVALID_RUNTIME_STATE', 'Active task has no lease');
    }
  }
  for (const [id, lease] of Object.entries(ledger.leases)) {
    const task = ledger.runs[lease?.runId]?.tasks?.[lease?.taskId];
    if (!object(lease) || lease.leaseId !== id || !task || typeof lease.fencingToken !== 'string' || !Number.isSafeInteger(lease.generation) || lease.generation < 1 || !Number.isSafeInteger(lease.attempt) || (!ACTIVE.has(lease.status) && lease.status !== 'released') || lease.stateRoot !== root ||
      ACTIVE.has(lease.status) && task.currentLeaseId !== id) throw stateError('INVALID_RUNTIME_STATE', 'Lease identity/status is invalid');
  }
  for (const [key, launch] of Object.entries(ledger.launches)) {
    const lease = ledger.leases[launch?.leaseId];
    if (!lease || key !== hash(lease.launchKey) || launch.runId !== lease.runId || launch.taskId !== lease.taskId || launch.attempt !== lease.attempt) throw stateError('INVALID_RUNTIME_STATE', 'Launch index is invalid');
  }
  return ledger;
}

function readLedger(root, missing = false) {
  const result = readStrict(ledgerPath(root), undefined);
  if (result === undefined) { if (missing) return null; throw stateError('RUNTIME_NOT_FOUND', 'No runtime ledger; create a run first'); }
  return validateLedger(result, root);
}
function event(ledger, type, fields = {}) { ledger.events.push({ sequence: ledger.events.length ? ledger.events.at(-1).sequence + 1 : 1, at: now(), type, ...fields }); if (ledger.events.length > 5000) ledger.events.splice(0, ledger.events.length - 5000); }
function transaction(opts, fn) {
  const root = resolveStateRoot(opts.project, opts.stateRoot);
  assertSafePath(root);
  return withLock(root, 'ledger', () => {
    const ledger = readLedger(root);
    const result = fn(ledger, root);
    ledger.revision++;
    validateLedger(ledger, root);
    writeAtomic(ledgerPath(root), ledger);
    return { schemaVersion: 1, ok: result.ok !== false, stateRoot: root, ...copy(result) };
  });
}
function taskFor(ledger, runId, taskId) {
  const run = ledger.runs[identifier(runId, 'runId')];
  if (!run) throw stateError('RUN_NOT_FOUND', `Unknown run ${runId}`);
  const task = run.tasks[identifier(taskId, 'taskId')];
  if (!task) throw stateError('TASK_NOT_FOUND', `Unknown task ${taskId}`);
  return { run, task };
}
function fenced(ledger, opts, allowReleased = false) {
  const lease = ledger.leases[identifier(opts.leaseId, 'leaseId')];
  if (!lease || lease.fencingToken !== (opts.fencingToken ?? opts.token)) throw stateError('STALE_LEASE', 'Lease ID/token does not identify this attempt');
  const { run, task } = taskFor(ledger, lease.runId, lease.taskId);
  if (task.currentLeaseId !== lease.leaseId || task.attempt !== lease.attempt) throw stateError('STALE_LEASE', 'A newer attempt owns this task');
  if (!allowReleased && lease.status === 'released') throw stateError('LEASE_RELEASED', 'This lease has already been released');
  return { run, task, lease };
}
function resourcePolicy(ledger, settings, project) {
  if (canonical(project) !== ledger.authorityProject) return;
  if (ledger.policy.maxConcurrency !== settings.scheduler.maxConcurrency || ledger.policy.configRevision !== settings.configRevision) {
    ledger.policy = { maxConcurrency: settings.scheduler.maxConcurrency, configRevision: settings.configRevision, updatedAt: now(), appliesTo: 'new_admissions' };
    event(ledger, 'resource_policy_changed', { policy: ledger.policy });
  }
}

export async function createRun(opts) {
  const workspace = canonical(opts.workspace || opts.project || process.cwd());
  const root = resolveStateRoot(opts.project, opts.stateRoot);
  const project = readLedger(root, true)?.authorityProject || authorityProject(opts.project);
  const runId = identifier(opts.runId || crypto.randomUUID(), 'runId');
  for (let retry = 0; retry < 3; retry++) {
    const settings = readSettings(project);
    const context = await loadContext(project, { settings });
    const pricing = { modelPricing: context.cc.modelPricing, priceRecords: context.cc.pricingContext.priceRecords, models: context.models };
    const result = withLock(path.dirname(settingsPath(project)), 'settings', () => {
      const current = readSettings(project);
      if (hash(current) !== hash(settings)) return null;
      return withLock(root, 'ledger', () => {
        rejectLegacyActive(root);
        const ledger = readLedger(root, true) || { schemaVersion: 1, stateRoot: root, authorityProject: project, revision: 0, policy: { maxConcurrency: settings.scheduler.maxConcurrency, configRevision: settings.configRevision, updatedAt: now(), appliesTo: 'new_admissions' }, runs: {}, leases: {}, launches: {}, events: [] };
        if (ledger.runs[runId]) return { schemaVersion: 1, ok: true, created: false, stateRoot: root, run: copy(ledger.runs[runId]) };
        const maxConcurrency = opts.maxConcurrency ?? settings.scheduler.maxConcurrency;
        if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw stateError('INVALID_RUN_CAP', 'Run concurrency must be a positive integer');
        const mode = getMode(settings.mode.id);
        const snapshot = { schemaVersion: 1, runId, stateRoot: root, project, authorityProject: project, workspace, modeId: mode.id, modeVersion: mode.version, configRevision: settings.configRevision,
          rolePolicy: modePolicy(mode.id, settings), integrationSelection: copy(settings.integrations), capabilityStatus: listIntegrations().map(item => capabilityStatus(settings, item.id)),
          settings: copy(settings), settingsHash: hash(settings), pricingHash: hash(pricing), maxConcurrency,
          effectiveConfigHash: hash({ settings, pricing }), createdAt: now() };
        snapshot.snapshotHash = hash(snapshot);
        const run = { runId, status: 'queued', snapshot, actorId: opts.actorId || 'unreported', tasks: {}, createdAt: snapshot.createdAt };
        const directory = path.join(root, 'runs', runId);
        writeAtomic(path.join(directory, 'pricing.json'), pricing);
        writeAtomic(path.join(directory, 'snapshot.json'), snapshot);
        ledger.runs[runId] = run;
        resourcePolicy(ledger, settings, project);
        event(ledger, 'run_created', { runId, modeId: snapshot.modeId, configRevision: snapshot.configRevision });
        ledger.revision++;
        writeAtomic(ledgerPath(root), validateLedger(ledger, root));
        return { schemaVersion: 1, ok: true, created: true, stateRoot: root, run: copy(run) };
      });
    });
    if (result) return result;
  }
  throw stateError('CONFIGURATION_BUSY', 'Settings changed repeatedly while queuing the run; no run was created');
}
export function addTask(opts) {
  return transaction(opts, ledger => {
    const run = ledger.runs[identifier(opts.runId, 'runId')];
    if (!run) throw stateError('RUN_NOT_FOUND', 'Create the parent run first');
    const taskId = identifier(opts.taskId, 'taskId');
    if (run.tasks[taskId]) throw stateError('TASK_EXISTS', 'Task IDs are not overwritten');
    const adapter = opts.adapter || 'host-managed';
    if (!['local-process', 'host-managed'].includes(adapter)) throw stateError('ADAPTER_UNSUPPORTED', 'This runtime slice supports local-process and explicit host-managed reservations');
    if (adapter === 'local-process') {
      if (opts.modelId || opts.providerId || opts.billingMode) throw stateError('LOCAL_MODEL_IDENTITY_CONFLICT', 'Non-model local commands cannot relabel a model request as free');
      if (opts.command?.[0] && /^(claude|codex|pi|dsh)(?:\.exe|\.cmd)?$/i.test(path.basename(opts.command[0]))) throw stateError('MODEL_RUNNER_REQUIRES_ADAPTER', 'Known model runners require the model adapter and shared price gate');
      if (!Array.isArray(opts.command) || !opts.command.length || !opts.command.every(value => typeof value === 'string') || JSON.stringify(opts.command).length > 65536) throw stateError('INVALID_COMMAND', 'Local process requires an explicit argv array');
      if (/(--api[-_]key|authorization[=:]|bearer\s+)/i.test(JSON.stringify(opts.command))) throw stateError('CREDENTIAL_IN_COMMAND', 'Use the existing environment credential mechanism, not recorded credential arguments');
    }
    const duration = opts.maxDurationMs ?? 3600000;
    if (!Number.isSafeInteger(duration) || duration < 1) throw stateError('INVALID_DURATION', 'maxDurationMs must be a positive integer');
    const task = { taskId, runId: run.runId, role: opts.role || 'worker', adapter, status: 'queued', attempt: 1, generation: 0, currentLeaseId: null,
      modeId: run.snapshot.modeId, modeVersion: run.snapshot.modeVersion, configRevision: run.snapshot.configRevision, createdAt: now(),
      effectiveRolePolicy: copy(run.snapshot.rolePolicy), roleOverrides: copy(run.snapshot.settings.roleOverrides[opts.role || 'worker'] || {}),
      actorId: opts.actorId || null, workspace: canonical(opts.workspace || run.snapshot.workspace || run.snapshot.project), maxDurationMs: duration,
      command: adapter === 'local-process' ? [...opts.command] : null,
      selection: adapter === 'host-managed' ? { role: opts.role || 'worker', providerId: opts.providerId ?? null, modelId: opts.modelId ?? null, billingMode: opts.billingMode ?? 'unknown', costMultiplier: opts.costMultiplier ?? 1 } : null,
      costKind: adapter === 'local-process' ? 'non_model_process' : 'model', enforcementLevel: adapter === 'local-process' ? 'registered_local_processes' : 'host_managed', limitations: ['Unregistered processes and external billing are outside this ledger'] };
    run.tasks[taskId] = task;
    run.status = Object.values(ledger.leases).some(lease => lease.runId === run.runId && ACTIVE.has(lease.status)) ? 'running' : 'queued';
    event(ledger, 'task_created', { runId: run.runId, taskId, modeId: task.modeId });
    return { task };
  });
}
function pricingFor(root, run) {
  const pricing = readStrict(path.join(root, 'runs', run.runId, 'pricing.json'));
  if (!pricing || hash(pricing) !== run.snapshot.pricingHash) throw stateError('SNAPSHOT_DRIFT', 'Immutable run pricing snapshot has changed');
  return pricing;
}
function admission(task, run, root) {
  if (task.adapter === 'local-process') return { schemaVersion: 1, ok: true, allowed: true, reasonCode: 'NON_MODEL_PROCESS', basis: 'not_applicable', enforcementLevel: 'registered_local_processes', limitations: ['No model call is made by this adapter; subprocess-initiated external costs remain out of band'] };
  const prices = pricingFor(root, run);
  const price = resolvePrice(task.selection.modelId, { settings: run.snapshot.settings, modelPricing: prices.modelPricing, priceRecords: prices.priceRecords,
    providerId: task.selection.providerId, costMultiplier: task.selection.costMultiplier });
  const decision = evaluateSelection({ ...task.selection, price, runId: run.runId, taskId: task.taskId }, run.snapshot.settings);
  const reliesOnBounds = run.snapshot.settings.pricing.unknownPricePolicy === 'bounded' && (!decision.priceKnown || !task.selection.providerId || task.selection.billingMode === 'unknown');
  if (decision.allowed && reliesOnBounds && task.adapter === 'host-managed') return { ...decision, ok: false, allowed: false, reasonCode: 'BOUNDED_ADAPTER_UNSUPPORTED', reason: 'This host-managed adapter cannot yet confirm timed cancellation; bounded unknown-price execution is unavailable' };
  return decision;
}
export function acquireTask(opts) {
  const root = resolveStateRoot(opts.project, opts.stateRoot);
  const preliminary = readLedger(root);
  const authority = preliminary.authorityProject;
  return withLock(path.dirname(settingsPath(authority)), 'settings', () => {
    const currentSettings = readSettings(authority);
    return transaction({ ...opts, stateRoot: root }, (ledger, directory) => {
      rejectLegacyActive(directory);
      resourcePolicy(ledger, currentSettings, authority);
      const { run, task } = taskFor(ledger, opts.runId, opts.taskId);
      const attempt = opts.attempt ?? task.attempt;
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw stateError('INVALID_ATTEMPT', 'Attempt must be a positive integer');
      const launchKey = opts.launchKey || `${run.runId}:${task.taskId}:${attempt}`;
      if (typeof launchKey !== 'string' || !launchKey || launchKey.length > 512) throw stateError('INVALID_LAUNCH_KEY', 'A bounded launch key is required');
      const launchHash = hash(launchKey);
      const existing = ledger.launches[launchHash];
      if (existing) {
        if (existing.runId !== run.runId || existing.taskId !== task.taskId || existing.attempt !== attempt) throw stateError('LAUNCH_KEY_CONFLICT', 'Launch key is already bound to another task/attempt');
        const lease = ledger.leases[existing.leaseId];
        return { allowed: true, action: 'observe', leaseId: lease.leaseId, fencingToken: lease.fencingToken, lease, reasonCode: 'LAUNCH_REPLAY' };
      }
      if (task.currentLeaseId && ACTIVE.has(ledger.leases[task.currentLeaseId]?.status)) return { ok: false, allowed: false, action: 'deny', reasonCode: 'TASK_ALREADY_ACTIVE', reason: 'Previous attempt still owns resources' };
      if (attempt !== task.attempt && !(attempt === task.attempt + 1 && ['failed', 'cancelled', 'blocked'].includes(task.status))) throw stateError('INVALID_ATTEMPT', 'A retry must follow a stopped terminal attempt and increment by one');
      if (attempt === task.attempt && TERMINAL_TASK.has(task.status)) throw stateError('TASK_TERMINAL', 'Terminal tasks require an explicit next attempt');
      if (task.actorId && opts.actorId && task.actorId !== opts.actorId && attempt === task.attempt) throw stateError('ACTOR_CONFLICT', 'Changing the actor requires an explicit new attempt');
      const decision = admission(task, run, directory);
      if (!decision.allowed) return { ok: false, allowed: false, action: 'deny', ...decision };
      const active = Object.values(ledger.leases).filter(lease => ACTIVE.has(lease.status));
      const riskBounded = task.adapter !== 'local-process' && run.snapshot.settings.pricing.unknownPricePolicy === 'bounded' && (!decision.priceKnown || !task.selection.providerId || task.selection.billingMode === 'unknown');
      const bounds = riskBounded ? run.snapshot.settings.pricing.bounds : null;
      if (bounds && (!bounds.maxDurationMs || task.maxDurationMs > bounds.maxDurationMs)) return { ok: false, allowed: false, action: 'deny', reasonCode: 'BOUNDED_DURATION_REQUIRED', reason: 'This adapter cannot enforce an iteration-only bound; supply a task duration within the configured bound' };
      if (active.length >= Math.min(ledger.policy.maxConcurrency, bounds?.maxConcurrency ?? Infinity) || active.filter(lease => lease.runId === run.runId).length >= run.snapshot.maxConcurrency) return { ok: false, allowed: false, action: 'deny', reasonCode: 'CONCURRENCY_LIMIT', reason: 'Project or run concurrency cap reached', running: active.length, projectCap: ledger.policy.maxConcurrency, runCap: run.snapshot.maxConcurrency };
      if (opts.controllerProcess && processAlive(opts.controllerProcess) !== true) throw stateError('OWNER_IDENTITY_UNVERIFIED', 'Controller PID/start identity could not be verified');
      if (task.generation >= Number.MAX_SAFE_INTEGER) throw stateError('GENERATION_EXHAUSTED', 'Cannot allocate another fencing generation');
      const actor = opts.actorId || task.actorId || 'unreported';
      if (task.actorId && task.actorId !== actor) event(ledger, 'task_reassigned', { runId: run.runId, taskId: task.taskId, from: task.actorId, to: actor, attempt });
      if (attempt !== task.attempt) {
        task.attemptHistory ||= [];
        task.attemptHistory.push({ attempt: task.attempt, generation: task.generation, leaseId: task.currentLeaseId, status: task.status, actorId: task.actorId, result: task.result ?? null });
        delete task.result;
      }
      task.actorId = actor; task.actorIds = [...new Set([...(task.actorIds || []), actor])];
      task.attempt = attempt; task.generation++;
      const lease = { leaseId: crypto.randomUUID(), fencingToken: `${task.generation}:${crypto.randomUUID()}`, generation: task.generation,
        runId: run.runId, taskId: task.taskId, attempt, launchKey, actorId: opts.actorId || task.actorId || 'unreported', role: task.role, adapter: task.adapter,
        stateRoot: directory, controllerProcess: opts.controllerProcess ?? null, ownerProcess: null, jobId: null, sessionId: null, processGroup: null,
        status: 'reserved', startedAt: now(), heartbeatAt: now(), progressAt: null, launchState: 'permission_issued', decision, resourcePolicy: copy(ledger.policy) };
      task.currentLeaseId = lease.leaseId; task.status = 'reserved'; run.status = 'running';
      ledger.leases[lease.leaseId] = lease; ledger.launches[launchHash] = { runId: run.runId, taskId: task.taskId, attempt, leaseId: lease.leaseId };
      event(ledger, 'lease_reserved', { runId: run.runId, taskId: task.taskId, leaseId: lease.leaseId, generation: lease.generation });
      return { allowed: true, action: 'start', reasonCode: 'RESERVED', leaseId: lease.leaseId, fencingToken: lease.fencingToken, lease };
    });
  });
}
export function linuxProcess(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { ...processIdentity(pid), state: fields[0], parentPid: Number(fields[1]), processGroup: Number(fields[2]) };
  } catch { return null; }
}
export function bindJob(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts);
    if (lease.jobId && task.adapter === 'host-managed') {
      if (lease.jobId !== opts.jobId || lease.sessionId !== (opts.sessionId ?? null)) throw stateError('JOB_ALREADY_BOUND', 'Lease is already bound to another host job/session');
      return { lease, bound: false, reasonCode: 'BIND_REPLAY' };
    }
    if (lease.ownerProcess) {
      if (lease.ownerProcess.pid !== opts.process?.pid || lease.ownerProcess.startIdentity !== opts.process?.startIdentity) throw stateError('JOB_ALREADY_BOUND', 'Lease is already bound to another process');
      return { lease, bound: false, reasonCode: 'BIND_REPLAY' };
    }
    if (task.adapter !== 'local-process') {
      if (!opts.jobId) throw stateError('JOB_ID_REQUIRED', 'Host-managed bindings need an actual job/session identity');
      lease.jobId = opts.jobId; lease.sessionId = opts.sessionId ?? null; lease.status = task.status = lease.cancelRequestedAt ? 'cancel_pending' : 'running'; lease.launchState = 'host_bound';
      event(ledger, 'host_job_bound', { leaseId: lease.leaseId, jobId: lease.jobId });
      return { lease, bound: true, enforcementLevel: 'host_managed', stopVerification: 'adapter_required' };
    }
    const identity = opts.process;
    if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) throw stateError('PROCESS_IDENTITY_REQUIRED', 'Local bind needs PID and start identity');
    const actual = processIdentity(identity.pid); const alive = processAlive({ ...actual, startIdentity: identity.startIdentity });
    const observed = linuxProcess(identity.pid);
    if (observed && observed.startIdentity !== identity.startIdentity || alive === null || alive === true && actual.startIdentity !== identity.startIdentity) throw stateError('PROCESS_IDENTITY_UNVERIFIED', 'Backend process identity could not be verified');
    if (opts.processGroup !== undefined && opts.processGroup !== null) {
      const observed = linuxProcess(identity.pid);
      if (opts.processGroup !== identity.pid || observed && observed.processGroup !== opts.processGroup) throw stateError('UNSAFE_PROCESS_GROUP', 'Only the backend-created process group may be tracked');
    }
    lease.ownerProcess = { ...actual, startIdentity: identity.startIdentity ?? null };
    lease.processGroup = opts.processGroup ?? (linuxProcess(identity.pid)?.processGroup === identity.pid ? identity.pid : null); lease.jobId = opts.jobId || `process:${identity.pid}:${identity.startIdentity}`; lease.sessionId = opts.sessionId ?? null;
    lease.status = task.status = lease.cancelRequestedAt ? 'cancel_pending' : 'running'; lease.launchState = 'bound'; lease.heartbeatAt = now();
    event(ledger, 'job_bound', { leaseId: lease.leaseId, jobId: lease.jobId });
    return { bound: true, lease };
  });
}
export function heartbeat(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts);
    lease.heartbeatAt = now();
    if (opts.progress !== undefined) { lease.progressAt = now(); lease.progress = String(opts.progress).slice(0, 2000); }
    if (opts.waitingExternal === true && !lease.cancelRequestedAt) lease.status = task.status = 'waiting_external';
    return { lease, reasonCode: 'HEARTBEAT_RECORDED' };
  });
}
export function reportResult(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts);
    if (!['produced', 'failed'].includes(opts.status)) throw stateError('INVALID_RESULT_STATUS', 'Authors may report produced or failed; acceptance requires independent evidence');
    task.result = { status: opts.status, output: opts.result ?? null, reportedAt: now(), attempt: lease.attempt, leaseId: lease.leaseId };
    task.status = opts.status;
    event(ledger, 'result_reported', { leaseId: lease.leaseId, status: opts.status });
    return { task, lease, resourcesRetained: true };
  });
}
export function backendStopped(lease) {
  if (!lease.ownerProcess) return { stopped: lease.launchState === 'confirmed_not_started', reason: 'Unbound launch may have started; controller exit is not backend evidence' };
  const alive = processAlive(lease.ownerProcess);
  const zombie = linuxProcess(lease.ownerProcess.pid);
  if (alive !== false && !lease.exitReceipt && !(zombie?.startIdentity === lease.ownerProcess.startIdentity && ['Z', 'X'].includes(zombie.state))) return { stopped: false, reason: alive === true ? 'Backend process is alive' : 'Backend identity is unknown' };
  if (lease.processGroup !== null) {
    if (process.platform !== 'linux') return { stopped: false, reason: 'Process-group verification unsupported on this platform' };
    try {
      process.kill(-lease.processGroup, 0);
      const members = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => linuxProcess(Number(name))).filter(info => info?.processGroup === lease.processGroup);
      if (!members.length || members.some(info => !['Z', 'X'].includes(info.state))) return { stopped: false, reason: 'Backend process group is active or cannot be resolved' };
    }
    catch (error) { if (error.code !== 'ESRCH') return { stopped: false, reason: 'Process-group state cannot be confirmed' }; }
  } else return { stopped: false, reason: 'Dedicated process-group termination is unverified' };
  return { stopped: true, reason: 'Recorded backend process and tracked group are stopped' };
}
function releaseInLedger(ledger, task, lease) {
  lease.status = 'released'; lease.releasedAt = now();
  const currentResult = task.result?.attempt === lease.attempt && task.result?.leaseId === lease.leaseId ? task.result : null;
  task.status = lease.cancelRequestedAt ? 'cancelled' : currentResult?.status ?? 'failed';
  if (!currentResult && !lease.cancelRequestedAt) task.recoveryReason = 'backend_stopped_without_current_attempt_result';
  event(ledger, 'lease_released', { leaseId: lease.leaseId, taskStatus: task.status });
  const run = ledger.runs[lease.runId];
  const tasks = Object.values(run.tasks);
  if (tasks.length && tasks.every(item => TERMINAL_TASK.has(item.status))) {
    run.status = tasks.some(item => item.status === 'failed') ? 'failed' : tasks.some(item => item.status === 'blocked') ? 'blocked' : tasks.every(item => item.status === 'cancelled') ? 'cancelled' : tasks.some(item => ['produced', 'awaiting_acceptance', 'accepted'].includes(item.status)) ? 'produced' : 'blocked';
  }
}
export function releaseLease(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts, true);
    if (lease.status === 'released') return { released: false, alreadyReleased: true, lease, reasonCode: 'ALREADY_RELEASED' };
    const stopped = backendStopped(lease);
    if (!stopped.stopped) return { ok: false, released: false, reasonCode: 'STOP_UNCONFIRMED', reason: stopped.reason, lease };
    releaseInLedger(ledger, task, lease);
    return { released: true, lease, task, reasonCode: 'RELEASED' };
  });
}
export function runtimeStatus(opts = {}) {
  const root = resolveStateRoot(opts.project, opts.stateRoot);
  const ledger = readLedger(root, true);
  if (!ledger) return { schemaVersion: 1, ok: true, stateRoot: root, runs: [], leases: [], activeCount: 0, ...legacyStatus(root), reasonCode: 'EMPTY_RUNTIME' };
  const run = opts.runId ? ledger.runs[identifier(opts.runId, 'runId')] : undefined;
  if (opts.runId && !run) throw stateError('RUN_NOT_FOUND', 'Unknown run');
  return { schemaVersion: 1, ok: true, stateRoot: root, policy: copy(ledger.policy), revision: ledger.revision,
    ...(run ? { run: copy(run), ...(opts.taskId ? { task: copy(taskFor(ledger, opts.runId, opts.taskId).task) } : {}) } : { runs: Object.values(ledger.runs).map(copy) }),
    leases: Object.values(ledger.leases).filter(lease => !opts.runId || lease.runId === opts.runId).map(copy),
    activeCount: Object.values(ledger.leases).filter(lease => ACTIVE.has(lease.status)).length, ...legacyStatus(root), enforcementLevel: 'registered_jobs_only' };
}
export function resumeRun(opts) {
  return transaction(opts, ledger => {
    const run = ledger.runs[identifier(opts.runId, 'runId')];
    if (!run) throw stateError('RUN_NOT_FOUND', 'Unknown run');
    const outcomes = [];
    for (const task of Object.values(run.tasks)) {
      const lease = ledger.leases[task.currentLeaseId];
      if (!lease || !ACTIVE.has(lease.status)) continue;
      const stopped = backendStopped(lease);
      if (stopped.stopped) { releaseInLedger(ledger, task, lease); outcomes.push({ taskId: task.taskId, action: 'released_stopped' }); }
      else if (!lease.ownerProcess || processAlive(lease.controllerProcess) === false) { lease.status = task.status = 'orphaned'; outcomes.push({ taskId: task.taskId, action: 'observe', reason: stopped.reason }); }
      else outcomes.push({ taskId: task.taskId, action: 'observe', reason: 'Existing backend retained; no duplicate launch' });
    }
    event(ledger, 'run_resumed', { runId: run.runId, outcomes });
    return { run, outcomes, resumedSession: false, reasonCode: 'RECONCILED_NO_RELAUNCH' };
  });
}
export function markLaunchFailed(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts);
    if (lease.ownerProcess || lease.launchState !== 'launching') throw stateError('LAUNCH_STATE_CONFLICT', 'Only the local adapter can settle a failed spawn before binding');
    lease.launchState = 'confirmed_not_started'; task.result = { status: 'failed', error: opts.error, reportedAt: now(), attempt: lease.attempt, leaseId: lease.leaseId };
    releaseInLedger(ledger, task, lease); return { lease, task };
  });
}
export function claimLocalLaunch(opts) {
  return transaction(opts, ledger => {
    const { run, task, lease } = fenced(ledger, opts);
    if (task.adapter !== 'local-process') throw stateError('ADAPTER_UNSUPPORTED', 'Only the local process adapter can launch here');
    if (lease.cancelRequestedAt || lease.status === 'cancel_pending') return { action: 'observe', lease, task, reasonCode: 'CANCEL_PENDING' };
    if (lease.launchState !== 'permission_issued') return { action: 'observe', lease, task };
    lease.launchState = 'launching'; lease.status = task.status = 'launching'; lease.controllerProcess = processIdentity();
    event(ledger, 'local_launch_claimed', { leaseId: lease.leaseId });
    return { action: 'start', lease, task, run };
  });
}
export function markCancelPending(opts) {
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts, true);
    if (lease.status === 'released') return { alreadyReleased: true, lease, task };
    const owner = lease.ownerProcess && linuxProcess(lease.ownerProcess.pid);
    if (owner && owner.startIdentity === lease.ownerProcess.startIdentity && lease.processGroup === owner.processGroup) {
      lease.knownGroupProcesses = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => linuxProcess(Number(name))).filter(info => info?.processGroup === lease.processGroup).map(info => ({ pid: info.pid, startIdentity: info.startIdentity }));
    }
    lease.cancelRequestedAt ??= now(); lease.status = task.status = 'cancel_pending';
    event(ledger, 'cancel_requested', { leaseId: lease.leaseId }); return { lease, task };
  });

}

export async function requestCancel(opts) { return (await import("./local-runtime.js")).cancelLocal(opts); }

// Only an actual ChildProcess exit object from this controller can establish
// completion before /proc binding. No CLI flag accepts a self-stamped receipt.
export function observeLocalExit(opts, child) {
  if (!(child instanceof ChildProcess) || !Number.isSafeInteger(child.pid) || child.exitCode === null && child.signalCode === null) throw stateError('EXIT_RECEIPT_REQUIRED', 'The local adapter needs an actual ChildProcess terminal event');
  return transaction(opts, ledger => {
    const { task, lease } = fenced(ledger, opts, true);
    if (task.adapter !== 'local-process' || lease.controllerProcess?.pid !== process.pid || processAlive(lease.controllerProcess) !== true || JSON.stringify(child.spawnargs) !== JSON.stringify(task.command)) throw stateError('EXIT_RECEIPT_MISMATCH', 'Exit event does not identify this controlled launch');
    if (lease.status === 'released') return { lease, alreadyReleased: true };
    if (lease.ownerProcess && lease.ownerProcess.pid !== child.pid) throw stateError('EXIT_RECEIPT_MISMATCH', 'Exit PID differs from the bound backend');
    lease.ownerProcess ??= { ...processIdentity(child.pid), startIdentity: null };
    lease.processGroup ??= process.platform === 'linux' ? child.pid : null;
    lease.jobId ??= `process:${child.pid}:observed-exit`;
    lease.exitReceipt = { source: 'core-local-child-exit', pid: child.pid, at: now(), exitCode: child.exitCode, signal: child.signalCode };
    event(ledger, 'backend_exit_observed', { leaseId: lease.leaseId, ...lease.exitReceipt });
    return { lease };
  });
}
export function queryAdmission(opts = {}) {
  const root = resolveStateRoot(opts.project, opts.stateRoot);
  const ledger = readLedger(root, true);
  if (!ledger) return { schemaVersion: 1, ok: true, allowed: false, admission: false, stateRoot: root, reasonCode: 'RUNTIME_NOT_FOUND', reason: 'Create a run/task before requesting admission', activeCount: 0 };
  const active = Object.values(ledger.leases).filter(lease => ACTIVE.has(lease.status));
  const legacy = legacyOccupancy(root);
  if (legacy) return { schemaVersion: 1, ok: true, allowed: false, admission: false, stateRoot: root, reasonCode: 'LEGACY_ACTIVE_RECORDS', legacyActiveCount: legacy, activeCount: active.length };
  if (!opts.runId || !opts.taskId) return { schemaVersion: 1, ok: true, allowed: false, admission: false, stateRoot: root, reasonCode: 'TASK_CONTEXT_REQUIRED', reason: 'An unbound guard query cannot authorize a model or reserve a slot', activeCount: active.length, policy: ledger.policy };
  const { run, task } = taskFor(ledger, opts.runId, opts.taskId);
  const settings = readSettings(ledger.authorityProject);
  const decision = admission(task, run, root);
  const bound = task.adapter !== 'local-process' && run.snapshot.settings.pricing.unknownPricePolicy === 'bounded' ? run.snapshot.settings.pricing.bounds : null;
  const cap = Math.min(settings.scheduler.maxConcurrency, bound?.maxConcurrency ?? Infinity);
  const terminal = TERMINAL_TASK.has(task.status);
  const available = !terminal && active.length < cap && active.filter(lease => lease.runId === run.runId).length < run.snapshot.maxConcurrency && !ACTIVE.has(ledger.leases[task.currentLeaseId]?.status);
  return { schemaVersion: 1, ok: true, ...decision, allowed: decision.allowed && available, admission: false, stateRoot: root,
    reasonCode: terminal ? 'TASK_TERMINAL' : decision.allowed && !available ? 'CONCURRENCY_LIMIT' : decision.reasonCode, activeCount: active.length, projectCap: cap, runCap: run.snapshot.maxConcurrency };
}
