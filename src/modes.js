import { stateError } from './atomic-state.js';

const registry = new Map([
  ['dynamic', { id: 'dynamic', kind: 'dynamic', displayName: 'dynamic', version: 1, hostRequirements: { anyAvailable: true }, rolePolicy: { inherited: true }, planGenerator: 'existing-dynamic-planner' }],
  ['fixed-1', { id: 'fixed-1', kind: 'fixed', displayName: 'fixed mode 1', version: 1, hostRequirements: { primary: 'claude-code' }, rolePolicy: { orchestrator: 'delegate-only', implementerWritesTests: false, minIndependentHackers: 1, requireRealUserPath: true, stopAfterSameCauseFailures: 2 }, planGenerator: 'fixed-1-policy' }],
]);
export function listModes() { return structuredClone([...registry.values()]); }
export function getMode(id) {
  const normalized = id === 'fixed' ? 'fixed-1' : id;
  const mode = registry.get(normalized);
  if (!mode) throw stateError('UNKNOWN_MODE', `Unknown mode ${id}; available: ${[...registry.keys()].join(', ')}`);
  return structuredClone(mode);
}
export function modePolicy(id) { return getMode(id).rolePolicy; }
export function createModePlan(id, context = {}) {
  const mode = getMode(id);
  if (mode.id === 'dynamic') {
    if (typeof context.dynamicPlanner !== 'function') throw stateError('PLANNER_REQUIRED', 'dynamic requires the existing planner entrypoint');
    return context.dynamicPlanner(context);
  }
  return { mode, phases: ['implement', 'autoresearch-if-applicable', 'advisor-if-triggered', 'freeze-candidate', 'independent-hack', 'repair-if-needed', 'deliver'], rolePolicy: mode.rolePolicy, scheduler: context.settings?.scheduler ?? { targetConcurrency: 3, maxConcurrency: 6 }, executionStatus: 'plan_only' };
}
