import { runtimeStatus, authorityProject } from './runtime.js';
// Core CLI boundary: no global migration, host scan, database or auth reads.
import path from 'node:path';
import { readSettings, updateSettings } from './settings.js';
import { listModes, getMode } from './modes.js';
import { listIntegrations, capabilityStatus, disableImpact, setIntegration } from './integrations.js';
import { stateError } from './atomic-state.js';

function merge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw stateError('INVALID_SETTINGS', 'Settings patch must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype', 'schemaVersion', 'configRevision', 'revision'].includes(key)) throw stateError('INVALID_SETTINGS', `Cannot patch reserved field ${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value)) target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    else target[key] = value;
  }
  return target;
}
function status(settings, project, stateRoot) {
  const runtime = runtimeStatus({ project, stateRoot });
  const activeRuns = (runtime.runs || []).filter(run => !["accepted", "cancelled"].includes(run.status)).map(run => ({ runId: run.runId, status: run.status, modeId: run.snapshot.modeId, modeVersion: run.snapshot.modeVersion, configRevision: run.snapshot.configRevision, rolePolicy: run.snapshot.rolePolicy, capabilityStatus: run.snapshot.capabilityStatus, degradations: run.degradations || [], enforcementLevel: "registered_jobs_only" }));
  const mode = getMode(settings.mode.id);
  return { defaultMode: mode.id, modeId: mode.id, modeVersion: mode.version, displayName: mode.displayName,
    configRevision: settings.configRevision, activeRuns, runtimeStatus: 'integrated', stateRoot: runtime.stateRoot, activeLeaseCount: runtime.activeCount,
    capabilityStatus: listIntegrations().filter(item => settings.integrations[item.id]?.enabled).map(item => capabilityStatus(settings, item.id)),
    degradations: activeRuns.flatMap(run => run.degradations), enforcementLevel: 'registered_jobs_only', reason: 'Only new top-level runs use the current default; existing run snapshots are retained' };
}
export function runControl(command, args, flags = {}) {
  try {
    const project = authorityProject(path.resolve(typeof flags.project === 'string' ? flags.project : process.cwd()));
    let result;
    if (command === 'mode') {
      const action = args[0] ?? 'status';
      if (action === 'list') result = { modes: listModes() };
      else if (action === 'status') result = status(readSettings(project), project, flags["state-root"]);
      else {
        const mode = getMode(action);
        const settings = updateSettings(project, draft => {
          draft.mode = { id: mode.id, version: mode.version };
          if (mode.id === 'fixed-1') {
            draft.implementation = { writesTests: false };
            draft.verification.minIndependentHackers = Math.max(1, draft.verification.minIndependentHackers);
            draft.verification.requireRealUserPath = true;
          } else delete draft.implementation;
        });
        result = { ...status(settings, project, flags["state-root"]), appliesTo: 'new_top_level_runs', message: '仅新主任务生效 / Only new top-level runs use this mode; existing snapshots are retained' };
      }
    } else if (command === 'integrations') {
      const action = args[0] ?? 'list';
      const settings = readSettings(project);
      if (action === 'list') result = { configRevision: settings.configRevision, integrations: listIntegrations().map(item => ({ ...item, ...capabilityStatus(settings, item.id) })) };
      else if (action === 'enable' || action === 'disable') {
        if (!args[1]) throw stateError('INTEGRATION_REQUIRED', 'Specify an integration ID');
        const impact = disableImpact(settings, args[1]);
        if (flags['dry-run']) result = { dryRun: true, impact: action === 'disable' ? impact : { ...impact, configChanges: [{ path: `integrations.${args[1]}.enabled`, from: impact.selected, to: true }] }, configRevision: settings.configRevision };
        else {
          const changed = setIntegration(project, args[1], action === 'enable');
          result = { configRevision: changed.configRevision, integration: capabilityStatus(changed, args[1]), ...(action === 'disable' ? { impact } : {}), appliesTo: 'new_top_level_runs', message: 'Selection updated; enabling does not install, authenticate or start an integration' };
        }
      } else throw stateError('UNKNOWN_ACTION', 'Use integrations list, enable ID or disable ID');
    } else if (command === 'config') {
      let settings = readSettings(project);
      if (flags.set !== undefined) {
        if (typeof flags.set !== 'string') throw stateError('INVALID_SETTINGS', '--set requires a JSON object');
        const patch = JSON.parse(flags.set);
        settings = updateSettings(project, draft => merge(draft, patch), flags['expected-revision'] === undefined ? {} : { expectedRevision: Number(flags['expected-revision']) });
      }
      result = { settings, configRevision: settings.configRevision };
    }
    const response = { schemaVersion: 1, ok: true, reasonCode: 'OK', ...result };
    process.stdout.write(flags.json ? JSON.stringify(response) + '\n' : JSON.stringify(response, null, 2) + '\n');
    return 0;
  } catch (error) {
    const response = { schemaVersion: 1, ok: false, reasonCode: error.code ?? (error instanceof SyntaxError ? 'INVALID_JSON' : 'CONTROL_ERROR'), reason: error.message };
    if (flags.json) process.stdout.write(JSON.stringify(response) + '\n');
    else process.stderr.write(`mawf: ${response.reason}\n`);
    return 1;
  }
}
