import fs from 'node:fs';
import { completeHostTask, freezeCandidate, submitEvidence, acceptCandidate, acceptanceStatus, createRun, addTask, acquireTask, bindJob, heartbeat, reportResult, releaseLease, resumeRun, runtimeStatus, queryAdmission } from './runtime.js';
import { dispatchLocal, cancelLocal } from './local-runtime.js';
import { processIdentity, stateError } from './atomic-state.js';
const numeric = (flags, name) => {
  if (flags[name] === undefined) return undefined;
  if (typeof flags[name] !== 'string' || !Number.isSafeInteger(Number(flags[name]))) throw stateError('INVALID_NUMBER', `--${name} needs an integer`);
  return Number(flags[name]);
};
export async function runTask(args, flags) {
  const command = args[0] || 'list';
  const opts = { project: flags.project, stateRoot: flags['state-root'], runId: flags['run-id'], taskId: flags['task-id'], leaseId: flags['lease-id'], token: flags.token,
    role: flags.role, actorId: flags['actor-id'], attempt: numeric(flags, 'attempt'), launchKey: flags['launch-key'] };
  let result;
  if (command === 'create') result = await createRun({ ...opts, maxConcurrency: numeric(flags, 'max-concurrency'), requiredCapabilities: flags['required-capabilities'] ? String(flags['required-capabilities']).split(',') : undefined });
  else if (command === 'add') result = addTask({ ...opts, adapter: flags.adapter, command: flags['command-json'] ? JSON.parse(flags['command-json']) : undefined,
    verificationOf: flags['verification-of'], workspace: flags.workspace, maxDurationMs: numeric(flags, 'max-duration-ms'), modelId: flags.model, providerId: flags.provider, billingMode: flags.billing,
    costMultiplier: flags.multiplier === undefined ? undefined : Number(flags.multiplier) });
  else if (command === 'acquire' || command === 'dispatch') {
    let controllerProcess = null;
    const pid = numeric(flags, 'owner-pid');
    if (pid !== undefined) {
      controllerProcess = { ...processIdentity(pid), startIdentity: flags['owner-start-identity'] ?? null };
      if (!controllerProcess.startIdentity) throw stateError('OWNER_IDENTITY_REQUIRED', 'Provide --owner-start-identity for the persistent controller');
    }
    result = command === 'dispatch' ? await dispatchLocal({ ...opts, controllerProcess }) : acquireTask({ ...opts, controllerProcess });
  } else if (command === 'bind') {
    const pid = numeric(flags, 'pid');
    result = bindJob({ ...opts, process: pid === undefined ? undefined : { ...processIdentity(pid), startIdentity: flags['start-identity'] ?? null },
      processGroup: numeric(flags, 'process-group'), jobId: flags['job-id'], sessionId: flags['session-id'], observedModel: flags['resolved-model'] });
  } else if (command === 'heartbeat') result = heartbeat({ ...opts, progress: flags.progress, waitingExternal: flags['waiting-external'] === true });
  else if (command === 'result') result = reportResult({ ...opts, status: flags.status, result: flags['result-json'] ? JSON.parse(flags['result-json']) : null });
  else if (command === 'cancel') result = await cancelLocal({ ...opts, graceMs: numeric(flags, 'grace-ms') });
  else if (command === 'host-complete') result = completeHostTask({ ...opts, jobId: flags['job-id'], sessionId: flags['session-id'], receiptFile: flags['receipt-file'], nativeReceipt: flags['native-receipt'] === true });
  else if (command === 'release') result = releaseLease(opts);
  else if (command === 'resume') result = resumeRun(opts);
  else if (command === 'candidate') result = freezeCandidate({ ...opts, workspace: flags.workspace, scope: flags['scope-json'] ? JSON.parse(flags['scope-json']) : undefined, artifacts: flags['artifacts-json'] ? JSON.parse(flags['artifacts-json']) : undefined });
  else if (command === 'evidence') { if (!flags.input) throw stateError('EVIDENCE_INPUT_REQUIRED', 'Use --input FILE'); result = submitEvidence(opts, JSON.parse(fs.readFileSync(flags.input, 'utf8'))); }
  else if (command === 'accept') result = acceptCandidate(opts);
  else if (command === 'acceptance') result = acceptanceStatus(opts);
  else if (command === 'guard') result = queryAdmission(opts);
  else if (command === 'list' || command === 'status') result = runtimeStatus(opts);
  else throw stateError('UNKNOWN_TASK_ACTION', 'Use task create/list/status/add/acquire/dispatch/bind/heartbeat/result/cancel/release/resume');
  process.stdout.write(JSON.stringify({ schemaVersion: 1, reasonCode: result.reasonCode || 'OK', ...result }, null, flags.json ? 0 : 2) + '\n');
  return result.ok === false || result.allowed === false ? 1 : 0;
}

export async function runTaskCompatibility(command, flags) {
  const mapped = { ...flags, 'task-id': flags['task-id'] || flags.id };
  if (command === 'acquire' && (!mapped['run-id'] || !mapped['task-id'])) throw stateError('TASK_CONTEXT_REQUIRED', 'Use acquire --run-id RUN --task-id TASK (or --id TASK) for an existing task; unsafe implicit legacy registration is retired');
  if (command === 'release') {
    if (!mapped.token) throw stateError('LEASE_TOKEN_REQUIRED', 'Release requires --token from the exact acquire response');
    if (!mapped['lease-id'] && mapped['run-id'] && mapped['task-id']) mapped['lease-id'] = runtimeStatus({ project: flags.project, stateRoot: flags['state-root'], runId: mapped['run-id'], taskId: mapped['task-id'] }).task.currentLeaseId;
    if (!mapped['lease-id']) throw stateError('LEASE_ID_REQUIRED', 'Provide --lease-id, or the exact run/task association');
  }
  if (command === 'guard' && !flags.json) {
    const result = queryAdmission({ project: flags.project, stateRoot: flags['state-root'], runId: mapped['run-id'], taskId: mapped['task-id'] });
    process.stdout.write(`${result.allowed ? 'ALLOW' : 'DENY'} query: ${result.reasonCode}; this is not a reservation, acquire is required\n`);
    return 0;
  }
  return runTask([command], mapped);
}
