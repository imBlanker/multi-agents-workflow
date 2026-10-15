import { resolvePrice } from './pricing.js';
import { checkPriceGate } from './pricegate.js';
import { selectModelForRole } from './modelcap.js';
import { isEnabled } from './integrations.js';
import { findExecutable } from './platform/index.js';
import { modePolicy } from './modes.js';
export function fixedPlan(context = {}) {
  const settings = context.settings;
  const cc = context.ccSwitch || {};
  const policy = modePolicy('fixed-1', settings);
  const roles = ['orchestrator', 'implementer', 'researcher', 'advisor', 'autoresearch', ...Array.from({ length: policy.minIndependentHackers }, (_, index) => index ? `hacker-${index + 1}` : 'hacker')];
  const tasks = { orchestrator: 'Define precise specs, delegate, review evidence, and continually dispatch ready independent work.', implementer: 'Implement only the assigned scope; produce a candidate and hand it to an independent Hacker. Do not write tests.', researcher: 'Read-only investigation; return source evidence and verified command recipes.', advisor: 'Provide independent read-only advice at specified triggers; do not modify product code.', autoresearch: 'Run only an applicable bounded experiment with a frozen metric; independent correctness comes from the Hacker.', hacker: 'Independently exercise counterexamples and a real user path on the frozen candidate; report raw evidence.' };
  const agents = roles.map(role => {
    const base = role.replace(/-\d+$/, '');
    const choice = selectModelForRole({ role: base === 'hacker' ? 'reviewer' : base, appType: 'claude', cc }) || { providerId: null, model: '', billingMode: 'unknown' };
    const price = resolvePrice(choice.model, { ...cc.pricingContext, modelPricing: cc.modelPricing, providerId: choice.providerId, costMultiplier: choice.costMultiplier ?? 1 });
    const billingMode = (settings.models || []).find(model => model.providerId === choice.providerId && model.modelId === choice.model)?.billingMode ?? 'unknown';
    const gate = checkPriceGate(choice.model, price, { role, providerId: choice.providerId, billingMode, settings });
    return { role, agent: 'claude-code', appType: 'claude', model: choice.model, task: tasks[base], tools: base === 'orchestrator' ? ['Read', 'Grep', 'Glob', 'Agent', 'Bash'] : ['Read', 'Grep', 'Glob', 'Bash', ...(['implementer', 'autoresearch', 'hacker'].includes(base) ? ['Edit', 'Write'] : [])], concurrency: 1,
      reviewRequired: base === 'implementer' || base === 'autoresearch', costRateLimitUsdPerMin: settings.cost.perAgentLimitUsdPerMin ?? 5,
      modelChoice: { ...choice, billingMode, price, priceGate: gate }, rolePolicy: policy, enforcementLevel: 'policy_only' };
  });
  const degradations = [['pi-plugin-cc', 'Pi Hacker'], ['codex-plugin-cc', 'Codex advisor']].map(([id, name]) => ({ requestedCapability: name, reason: isEnabled(settings, id) ? 'Capability has not been proven ready' : 'Integration not selected', actualAdapter: null, actualActor: null, actualModel: null,
    proposedFallback: { adapter: 'claude-code', independentInstanceRequired: true }, lostGuarantees: [`No verified ${name} participation`], retainedGuarantees: ['Independent Hacker and real-user-path acceptance remain required'], timestamp: new Date().toISOString(), affectedTasks: [], status: 'proposed_not_executed' }));
  const installed = isEnabled(settings, 'host.claude-code') && !!findExecutable('claude');
  return { name: 'fixed-mode-1', primary: 'fixed-1', selected: ['fixed-1'], mode: { id: 'fixed-1', version: 1 }, createdAt: new Date().toISOString(), rationale: ['Fixed role and acceptance policy; dynamic architecture scoring does not remove these phases'],
    hostApp: 'claude-code', hostCapabilities: [], rolePolicy: policy, agents, groups: [{ label: 'implement', parallel: true, agents: ['implementer', 'researcher'] }, { label: 'optional-bounded-optimization', parallel: false, agents: ['autoresearch'] }, { label: 'triggered-advice', parallel: false, agents: ['advisor'] }, { label: 'independent-acceptance', parallel: true, agents: roles.filter(role => role.startsWith('hacker')) }],
    phases: ['queue-snapshot', 'spec', 'implement', 'autoresearch-if-applicable', 'advisor-if-triggered', 'freeze-candidate', 'independent-hack', 'repair-if-needed', 'deliver'],
    reviewPoints: [{ by: 'independent-hacker', scope: 'candidate-and-real-user-path', label: 'acceptance required' }], loops: [],
    cost: { perAgentLimitUsdPerMin: settings.cost.perAgentLimitUsdPerMin ?? 5, totalLimitUsdPerMin: settings.cost.totalLimitUsdPerMin ?? 10, maxConcurrency: settings.scheduler.maxConcurrency, sources: ['selected-pricing-providers'] },
    codex: { enabled: isEnabled(settings, 'codex-plugin-cc'), when: ['key-design', 'two-same-cause-failures', 'high-risk-counterexample'], reviewScopes: ['read-only-advice'] },
    priceGate: { thresholds: { inputPerM: 2, outputPerM: 10 }, blockedRoles: agents.filter(agent => agent.modelChoice.priceGate.blocked).map(agent => ({ role: agent.role, model: agent.model, gate: agent.modelChoice.priceGate })) },
    scheduler: settings.scheduler, verification: policy.verification, implementation: { writesTests: false }, degradations,
    execution: { available: false, installed, authenticated: 'unknown', status: installed ? 'requires_host_execution_verification' : 'unavailable', reason: installed ? 'Planning is complete; authenticated host execution is verified separately' : 'fixed mode 1 requires an explicitly selected available Claude Code primary host; use mode dynamic for other hosts' } };
}
