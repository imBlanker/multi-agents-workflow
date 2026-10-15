import { readSettings } from '../settings.js';
import { authorityProject } from '../runtime.js';
import { stateError } from '../atomic-state.js';
import { discoverAdapter } from './discovery.js';
export async function runAdapter(args, flags) {
  const action = args[0] || 'discover';
  const opts = { project: flags.project, stateRoot: flags['state-root'], runId: flags['run-id'], taskId: flags['task-id'], leaseId: flags['lease-id'], token: flags.token, actorId: flags['actor-id'], attempt: flags.attempt === undefined ? undefined : Number(flags.attempt), launchKey: flags['launch-key'], path: flags.path, promptFile: flags['prompt-file'], effort: flags.effort, write: flags.write === true };
  let result;
  if (['discover', 'probe'].includes(action)) result = { ok: true, capability: discoverAdapter(flags.adapter, readSettings(authorityProject(flags.project)), { path: flags.path }) };
  else if (action === 'resume') result = { ok: false, reasonCode: 'RESUME_UNSUPPORTED', reason: 'Upstream resume-last cannot prove exact MAWF job/session continuity; use status/result to reconcile the existing attempt' };
  else {
    const adapter = await import('./companion.js');
    if (action === 'start') result = await adapter.startCompanion(opts);
    else if (action === 'cancel') result = await adapter.cancelCompanion(opts);
    else if (action === 'status' || action === 'result') result = await adapter.observeCompanion(opts, action === 'result');
    else throw stateError('UNKNOWN_ADAPTER_ACTION', 'Use adapter discover/probe/start/status/result/cancel/resume');
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }, null, flags.json ? 0 : 2) + '\n');
  return result.ok === false || result.allowed === false ? 1 : 0;
}
