import { resolvePrice } from './pricing.js';
import { checkPriceGate } from './pricegate.js';
export function applyRoleOverrides(plan, settings, context) {
  const modeId = settings.mode.id;
  const scoped = settings.modeOverrides?.[modeId] || {};
  const overrides = Object.fromEntries([...new Set([...Object.keys(settings.roleOverrides || {}), ...Object.keys(scoped.roleOverrides || {})])].map(role => [role, { ...(settings.roleOverrides?.[role] || {}), ...(scoped.roleOverrides?.[role] || {}) }]));
  const disabled = new Set(scoped.disabledRoles || settings.disabledRoles || []);
  const mandatory = role => modeId === 'fixed-1' && ['orchestrator', 'implementer', 'hacker'].includes(role.replace(/-\d+$/, ''));
  plan.agents = plan.agents.filter(agent => !disabled.has(agent.role) || mandatory(agent.role));
  for (const [role, extra] of Object.entries({ ...(settings.customAgents || {}), ...(scoped.customAgents || {}) })) {
    if (!disabled.has(role) && !plan.agents.some(agent => agent.role === role)) plan.agents.push({ role, agent: plan.hostApp === 'unknown' ? 'claude-code' : plan.hostApp, appType: ['pi', 'dsh', 'codex'].includes(plan.hostApp) ? plan.hostApp : 'claude', model: '', tools: ['Read', 'Bash'], task: 'Complete the assigned scope.', concurrency: 1, costRateLimitUsdPerMin: plan.cost.perAgentLimitUsdPerMin, reviewRequired: true, ...extra });
  }
  for (const agent of plan.agents) {
    const override = overrides[agent.role] || {};
    for (const key of ['model', 'task', 'tools', 'concurrency', 'costRateLimitUsdPerMin', 'providerId', 'billingMode', 'appType', 'agent']) if (override[key] !== undefined) agent[key] = structuredClone(override[key]);
    if (modeId === 'fixed-1' && agent.role === 'orchestrator') { agent.agent = 'claude-code'; agent.appType = 'claude'; }
    const providerId = override.providerId ?? agent.providerId ?? agent.modelChoice?.providerId ?? null;
    const configured = context.models.find(model => model.providerId === providerId && model.modelId === agent.model);
    const billingMode = override.billingMode ?? agent.billingMode ?? configured?.billingMode ?? agent.modelChoice?.billingMode ?? 'unknown';
    const price = resolvePrice(agent.model, { ...context.cc.pricingContext, modelPricing: context.cc.modelPricing, providerId, costMultiplier: configured?.costMultiplier ?? agent.modelChoice?.costMultiplier ?? 1 });
    agent.modelChoice = { ...(agent.modelChoice || {}), providerId, model: agent.model, billingMode, price, priceGate: checkPriceGate(agent.model, price, { role: agent.role, providerId, billingMode, settings }) };
  }
  const assigned = new Set(plan.groups.flatMap(group => group.agents));
  const extra = plan.agents.filter(agent => !assigned.has(agent.role)).map(agent => agent.role);
  if (extra.length) plan.groups.splice(Math.max(0, plan.groups.findIndex(group => ['synthesize', 'independent-acceptance'].includes(group.label))), 0, { label: 'custom-roles', parallel: true, agents: extra });
  for (const group of plan.groups) group.agents = group.agents.filter(role => plan.agents.some(agent => agent.role === role));
  plan.priceGate.blockedRoles = plan.agents.filter(agent => agent.modelChoice.priceGate.blocked).map(agent => ({ role: agent.role, model: agent.model, provider: agent.modelChoice.providerId, gate: agent.modelChoice.priceGate }));
  plan.scheduler = structuredClone(settings.scheduler);
  return plan;
}
