import { startExperiment, cancelExperiment, experimentStatus } from './session.js';
import { stateError } from '../atomic-state.js';
export async function runAutoresearch(args, flags) {
  const action = args[0] || 'status';
  const opts = { project: flags.project, stateRoot: flags['state-root'], runId: flags['run-id'], taskId: flags['task-id'], actorId: flags['actor-id'], leaseId: flags['lease-id'], token: flags.token, attempt: flags.attempt === undefined ? undefined : Number(flags.attempt), launchKey: flags['launch-key'], contractFile: flags.contract };
  let result;
  if (action === 'start') result = await startExperiment(opts);
  else if (action === 'cancel') result = await cancelExperiment(opts);
  else if (['status', 'result'].includes(action)) result = experimentStatus(opts);
  else if (action === 'resume') result = { ok: false, reasonCode: 'RESUME_UNSUPPORTED', reason: 'Persistent session/log/worktree are retained; exact interrupted loop resume is not yet independently verified and is not simulated' };
  else throw stateError('UNKNOWN_EXPERIMENT_ACTION', 'Use autoresearch start/status/result/cancel/resume');
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }, null, flags.json ? 0 : 2) + '\n');
  return result.ok === false || result.allowed === false ? 1 : 0;
}
