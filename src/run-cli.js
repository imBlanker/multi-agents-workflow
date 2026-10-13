import { observedParentSelection, inheritNativeSelection } from './native-selection.js';
// Real execution entrypoints and a ready-work queue. Guide output is explicit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings.js';
import { loadContext } from './context.js';
import { createModePlan } from './modes.js';
import { applyRoleOverrides } from './role-overrides.js';
import { planWorkflow } from './planner.js';
import { readGeneratedPlan } from './generated.js';
import { stateError, readStrict, writeAtomic, withLock } from './atomic-state.js';
import { authorityProject, createRun, addTask, runtimeStatus, acquireTask, frozenRunPricing, respecTask, recordNativeBilling, nativeAgentType } from './runtime.js';
import { nativeHostCapability, enforceNativeBilling, executeNative } from './native-host.js';
const id = () => crypto.randomUUID();
function planFor(run, pricing) {
  const settings = run.snapshot.settings;
  const cc = { modelPricing: pricing.modelPricing || {}, allProviders: [], currentProviders: {}, appTypes: [], pricingContext: { settings, priceRecords: pricing.priceRecords || [] } };
  const context = { settings, ccSwitch: cc, host: { app: 'claude-code' }, signals: { taskType: 'coding', parallelizableSubtasks: settings.scheduler.targetConcurrency, risk: 'medium', contextNeed: 'large', valuePerRun: 'medium', maxIterations: 5 }, cost: { maxConcurrency: settings.scheduler.maxConcurrency, perAgent: settings.cost.perAgentLimitUsdPerMin || 5, total: settings.cost.totalLimitUsdPerMin || 10 }, dynamicPlanner: ctx => planWorkflow(ctx.signals, ctx) };
  return applyRoleOverrides(createModePlan(settings.mode.id, context), settings, { cc, models: pricing.models || [] });
}
function executionFile(root, runId) { return path.join(root, 'runs', runId, 'execution.json'); }
function overlap(a, b) { return a.some(left => b.some(right => left === '.' || right === '.' || left === right || left.startsWith(right + '/') || right.startsWith(left + '/'))); }
async function prepare(opts) {
  const project = authorityProject(opts.project);
  const made = await createRun({ project, stateRoot: opts.stateRoot, runId: opts.runId, actorId: opts.actorId || `coordinator-${id()}`, requiredCapabilities: opts.requiredCapabilities });
  const run = made.run, capability = nativeHostCapability(run.snapshot.settings, project);
  if (!capability.selected || !capability.installed || capability.authenticated !== true) return { ok: false, reasonCode: capability.reasonCode, run, capability, alternative: 'mawf mode dynamic or configure the explicitly selected Claude host; no mode switch was performed' };
  const nativeParent = opts.nativeControllerTaskId && run.tasks[opts.nativeControllerTaskId];
  const nativeSelection = observedParentSelection(nativeParent);
  const nativeExecution = { controllerTaskId: opts.nativeControllerTaskId || null, selectionMode: 'inherit', observedSelection: nativeSelection, queueExample: { tasks: [{ taskId: 'implement-1', role: 'implementer', prompt: 'Concrete owned scope and expected result', expectedMinutes: 1, scope: ['artifact.txt'], dependsOn: [], selection: 'inherit' }] }, reasonCode: nativeSelection ? 'PARENT_SELECTION_OBSERVED' : 'NATIVE_PARENT_SELECTION_REQUIRED' };
  const plan = planFor(run, frozenRunPricing({ project, runId: run.runId }));
  const file = executionFile(made.stateRoot, run.runId);
  if (opts.nativeControllerTaskId) { const previous = readStrict(file, null); if (previous) writeAtomic(file, { ...previous, nativeControllerTaskId: opts.nativeControllerTaskId, mainSessionBillingCoverage: 'registered_native_controller' }); }
  if (!readStrict(file, null)) writeAtomic(file, { schemaVersion: 1, runId: run.runId, description: opts.description || '', createdAt: new Date().toISOString(), tasks: {}, hostManaged: true, mainSessionBillingCoverage: opts.nativeControllerTaskId ? 'registered_native_controller' : 'existing_host_session_out_of_band', capability, plan });
  return { ok: true, runId: run.runId, stateRoot: made.stateRoot, modeId: run.snapshot.modeId, configRevision: run.snapshot.configRevision, acceptancePolicy: run.snapshot.acceptancePolicy, nativeExecution, scheduler: run.snapshot.settings.scheduler, capability, plan, action: 'host_dispatch_required', enforcementLevel: 'host_managed', message: 'Use run queue and run next, then actually invoke native Agent/Task; producing this response did not launch a child' };
}
async function queue(opts, spec) {
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) throw stateError('INVALID_RUN_SPEC', 'Spec requires a nonempty tasks array');
  const state = runtimeStatus(opts), run = state.run;
  const file = executionFile(state.stateRoot, run.runId);
  const plan = readStrict(file)?.plan || planFor(run, frozenRunPricing(opts));
  const names = new Set(spec.tasks.map(task => task.taskId));
  if (names.size !== spec.tasks.length) throw stateError('DUPLICATE_TASK', 'Queue IDs must be unique');
  for (const item of spec.tasks) {
    if (typeof item.taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(item.taskId) || typeof item.prompt !== 'string' || !item.prompt.trim()) throw stateError('INVALID_RUN_SPEC', 'Each task requires a plain taskId and concrete prompt');
    if (!Number.isFinite(item.expectedMinutes) || item.expectedMinutes <= 0 || !Array.isArray(item.scope) || !Array.isArray(item.dependsOn) || item.writesProduct !== false && !item.scope.length) throw stateError('INVALID_RUN_SPEC', 'Each task needs expectedMinutes, scope and dependsOn arrays');
    for (const dependency of item.dependsOn) if (!names.has(dependency) && !run.tasks[dependency]) throw stateError('MISSING_DEPENDENCY', `Unknown dependency ${dependency}`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(name) { if (visiting.has(name)) throw stateError('DEPENDENCY_CYCLE', 'Queue has a dependency cycle'); if (visited.has(name)) return; visiting.add(name); for (const dependency of spec.tasks.find(task => task.taskId === name)?.dependsOn || []) if (names.has(dependency)) visit(dependency); visiting.delete(name); visited.add(name); }
  for (const name of names) visit(name);
  return withLock(state.stateRoot, 'execution-queue', () => {
    const execution = readStrict(file, { schemaVersion: 1, runId: run.runId, tasks: {}, plan });
    const controllerTask = execution.nativeControllerTaskId && runtimeStatus(opts).run.tasks[execution.nativeControllerTaskId];
    const parentSelection = observedParentSelection(controllerTask);
    // Validate all selections before adding any task. Null/empty plan placeholders
    // mean inherit; a concrete conflicting field is never silently discarded.
    const prepared = spec.tasks.map(item => {
      const role = plan.agents.find(agent => agent.role === item.role);
      const scoped = run.snapshot.settings.modeOverrides?.[run.snapshot.modeId] || {};
      const override = { ...(run.snapshot.settings.customAgents?.[item.role] || {}), ...(scoped.customAgents?.[item.role] || {}), ...(run.snapshot.settings.roleOverrides?.[item.role] || {}), ...(scoped.roleOverrides?.[item.role] || {}) };
      if ((item.adapter || 'host-managed') === 'host-managed') inheritNativeSelection({ modelId: override.model, providerId: override.providerId, billingMode: override.billingMode }, parentSelection);
      const selection = (item.adapter || 'host-managed') === 'host-managed'
        ? inheritNativeSelection(item.selection, parentSelection)
        : item.selection || { modelId: role?.model, providerId: role?.modelChoice?.providerId, billingMode: role?.modelChoice?.billingMode };
      return { item, selection };
    });
    const created = [];
    for (const { item, selection } of prepared) {
      const existing = runtimeStatus(opts).run.tasks[item.taskId];
      if (existing) { if (JSON.stringify(existing.dispatchSpec) !== JSON.stringify(item)) throw stateError('TASK_SPEC_CONFLICT', 'Existing task differs; use a revised stopped task spec or a new task identity'); created.push(existing); continue; }
      const controllerLease = controllerTask && runtimeStatus(opts).leases.find(lease => lease.leaseId === controllerTask.currentLeaseId);
      const inheritedDuration = controllerLease ? Math.max(1, Date.parse(controllerLease.startedAt) + controllerTask.maxDurationMs - Date.now()) : null;
      const task = addTask({ ...opts, controllerTaskId: controllerTask?.taskId, controllerLeaseId: controllerLease?.leaseId, selectionSource: (item.adapter || 'host-managed') === 'host-managed' ? 'observed_native_parent_inheritance' : 'declared_adapter_selection', taskId: item.taskId, role: item.role || 'implementer', actorId: item.actorId || `agent-${id()}`, adapter: item.adapter || 'host-managed', modelId: selection.modelId, providerId: selection.providerId, billingMode: selection.billingMode, workspace: item.workspace || run.snapshot.workspace, maxDurationMs: item.maxDurationMs || inheritedDuration || Math.ceil(item.expectedMinutes * 120000), verificationOf: item.verificationOf, dispatchSpec: item, dependsOn: item.dependsOn }).task;
      execution.tasks[item.taskId] = { prompt: item.prompt, scope: item.scope, dependsOn: item.dependsOn, expectedMinutes: item.expectedMinutes, writesProduct: item.writesProduct !== false, specHash: task.specHash };
      created.push(task);
    }
    writeAtomic(file, execution);
    return { ok: true, runId: run.runId, queued: created, action: 'queued_not_started' };
  });
}
function next(opts) {
  const state = runtimeStatus(opts), run = state.run;
  const execution = readStrict(executionFile(state.stateRoot, run.runId));
  if (!execution) throw stateError('RUN_NOT_PREPARED', 'Prepare the host execution first');
  const capability = nativeHostCapability(run.snapshot.settings, run.snapshot.workspace);
  const active = Object.values(run.tasks).filter(task => ['reserved', 'launching', 'running', 'waiting_external', 'cancel_pending', 'orphaned'].includes(task.status) && !task.coordinationOnly);
  const slots = Math.max(0, run.snapshot.settings.scheduler.targetConcurrency - active.length);
  const selected = [], blockers = [];
  for (const task of Object.values(run.tasks)) {
    if (selected.length >= slots) break;
    if (task.status !== 'queued' || !task.dispatchSpec) continue;
    if (!task.dependsOn.every(dependency => ['produced', 'accepted', 'awaiting_acceptance'].includes(run.tasks[dependency]?.status))) continue;
    const spec = task.dispatchSpec;
    if (spec.writesProduct !== false && [...active, ...selected.map(item => item.task)].some(other => other.dispatchSpec?.writesProduct !== false && overlap(spec.scope, other.dispatchSpec?.scope || ['.']))) continue;
    if (task.adapter !== 'host-managed') { selected.push({ task, action: 'adapter_start_required', command: task.adapter === 'autoresearch.pi' ? 'mawf autoresearch start' : 'mawf adapter start', lease: null }); continue; }
    const controller = task.controllerTaskId && run.tasks[task.controllerTaskId];
    if (!controller?.adapterState?.actualModel || controller.adapterState.selectionGate?.allowed !== true || task.selection.modelId !== controller.adapterState.actualModel || task.selection.providerId !== controller.adapterState.actualProvider || task.selection.billingMode !== controller.billingObservation?.billingMode) { blockers.push({ taskId: task.taskId, reasonCode: 'HOST_MODEL_UNVERIFIED', reason: 'Native Agent must explicitly inherit the observed registered parent model/provider/billing; arbitrary role overrides and unverified existing sessions cannot launch' }); continue; }
    try { enforceNativeBilling(capability, task.selection); recordNativeBilling({ ...opts, taskId: task.taskId }, capability); } catch (error) { blockers.push({ taskId: task.taskId, reasonCode: error.code, reason: error.message }); continue; }
    const reservation = acquireTask({ ...opts, taskId: task.taskId, actorId: task.actorId, launchKey: `${run.runId}:${task.taskId}:${task.attempt}` });
    if (!reservation.allowed || reservation.action !== 'start') { blockers.push({ taskId: task.taskId, ...reservation }); continue; }
    const roleName = task.role.replace(/-\d+$/, '');
    const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'agents', run.snapshot.modeId === 'fixed-1' ? `mawf-fixed-${roleName}.md` : `${roleName}.md`);
    const roleInstructions = fs.existsSync(template) ? fs.readFileSync(template, 'utf8') : '';
    selected.push({ task, action: 'invoke_native_agent_now', agentType: nativeAgentType(task, run.snapshot.modeId), modelSelection: 'inherit_via_agent_definition', lease: { leaseId: reservation.leaseId, token: reservation.fencingToken }, prompt: `${roleInstructions}\n\n${spec.prompt}\n\nMAWF_LEASE:${JSON.stringify({ project: run.snapshot.authorityProject, stateRoot: state.stateRoot, runId: run.runId, taskId: task.taskId, leaseId: reservation.leaseId, token: reservation.fencingToken })}\nRun/task/attempt: ${run.runId}/${task.taskId}/${task.attempt}. Actor: ${task.actorId}. Mode/revision: ${task.modeId}/${task.configRevision}. Workspace: ${task.workspace}. Owned scope: ${JSON.stringify(spec.scope)}. Expected minutes: ${spec.expectedMinutes}. At twice this duration report facts. Preserve other workers. ${task.verificationTarget ? 'Independent verification: never modify the product; collect counterexamples and a real user path against candidate ' + task.verificationTarget : run.snapshot.modeId === 'fixed-1' ? 'Implementation: do not create or maintain tests; produce a candidate for an independent Hacker.' : ''}\nReturn actual output paths and factual failures; no self-acceptance.` });
  }
  const waiting = Object.values(run.tasks).filter(task => task.status === 'queued').map(task => task.taskId);
  return { ok: blockers.length === 0 || selected.length > 0, runId: run.runId, dispatches: selected, blockers, waiting, activeCount: active.length, targetConcurrency: run.snapshot.settings.scheduler.targetConcurrency, refill: 'Invoke next after each completion; do not wait for a whole batch', enforcementLevel: 'host_managed' };
}
export async function runExecution(args, flags) {
  const project = path.resolve(flags.project || process.cwd());
  let request = {};
  if (flags['request-base64']) { try { request = JSON.parse(Buffer.from(flags['request-base64'], 'base64').toString('utf8')); } catch { throw stateError('INVALID_RUN_REQUEST', 'Invalid encoded run request'); } }
  const opts = { project: request.project || project, stateRoot: flags['state-root'], runId: flags['run-id'] || request.runId, taskId: flags['task-id'], actorId: flags['actor-id'], description: flags.task || request.task || args.filter(arg => !['prepare', 'queue', 'next', 'respec'].includes(arg)).join(' '), nativeControllerTaskId: request.nativeControllerTaskId, requiredCapabilities: flags['required-capabilities'] ? String(flags['required-capabilities']).split(',') : undefined };
  const action = args[0]; let result;
  if (flags.guide) { const settings = readSettings(authorityProject(project)); result = { ok: true, guide: true, mode: settings.mode, plan: readGeneratedPlan(project), executionStarted: false, steps: ['Prepare a run snapshot', 'Queue concrete independent task specifications', 'Acquire ready tasks and actually invoke Agent', 'Bind actual jobs; heartbeat; collect returns and release', 'Freeze candidate; dispatch independent Hacker; register raw evidence; accept'] }; }
  else if (action === 'queue') { if (!flags.input) throw stateError('RUN_SPEC_REQUIRED', 'Use run queue --input FILE'); result = await queue(opts, readStrict(path.resolve(flags.input))); }
  else if (action === 'next') result = next(opts);
  else if (action === 'respec') result = respecTask(opts, readStrict(path.resolve(flags.input)));
  else if (flags['host-managed'] || action === 'prepare') result = await prepare(opts);
  else {
    const prepared = await prepare(opts);
    if (!prepared.ok) result = prepared;
    else {
      const state = runtimeStatus({ project: opts.project, runId: prepared.runId });
      if (Object.values(state.run.tasks).some(task => task.coordinationOnly)) throw stateError('NATIVE_CONTROLLER_EXISTS', 'This run already has a native controller; inspect/cancel/reconcile it, or explicitly create a new top-level run rather than launching another controller implicitly');
      if (state.run.snapshot.maxConcurrency < 2) throw stateError('NATIVE_CONTROLLER_CAP_REQUIRED', 'A registered Claude controller plus at least one child requires a run concurrency cap of two');
      const role = prepared.plan.agents.find(agent => agent.role === 'orchestrator');
      const selection = { modelId: flags.model || role?.model, providerId: flags.provider || role?.modelChoice?.providerId, billingMode: flags.billing || role?.modelChoice?.billingMode || 'unknown' };
      const taskId = `native-controller-${id()}`;
      addTask({ project: opts.project, runId: prepared.runId, taskId, adapter: 'claude-native', coordinationOnly: true, role: 'orchestrator', actorId: `native-orchestrator-${id()}`, ...selection, maxDurationMs: flags['max-duration-ms'] ? Number(flags['max-duration-ms']) : 1800000 });
      result = await executeNative({ project: opts.project, runId: prepared.runId, taskId, description: opts.description });
    }
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }, null, flags.json ? 0 : 2) + '\n');
  return result.ok === false || result.allowed === false ? 1 : 0;
}
