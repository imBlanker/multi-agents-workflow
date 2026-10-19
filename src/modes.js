import { fixedPlan } from './fixed-plan.js';
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
export function modePolicy(id, settings = {}) {
  const mode = getMode(id);
  if (mode.id === 'dynamic') return { ...mode.rolePolicy, ...(settings.scheduler ? { scheduler: structuredClone(settings.scheduler) } : {}) };
  const minIndependentHackers = Math.max(1, settings.verification?.minIndependentHackers ?? 1);
  return { ...mode.rolePolicy, minIndependentHackers, requireRealUserPath: true, scheduler: structuredClone(settings.scheduler ?? { targetConcurrency: 3, maxConcurrency: 6 }),
    verification: { ...(settings.verification ?? {}), minIndependentHackers, requireRealUserPath: true }, implementation: { writesTests: false }, enforcementLevel: 'policy_only' };
}
export function createModePlan(id, context = {}) {
  const mode = getMode(id);
  if (mode.id === 'dynamic') {
    if (typeof context.dynamicPlanner !== 'function') throw stateError('PLANNER_REQUIRED', 'dynamic requires the existing planner entrypoint');
    return context.dynamicPlanner(context);
  }
  return fixedPlan(context);
}
