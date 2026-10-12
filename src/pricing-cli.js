import fs from 'node:fs';
import path from 'node:path';
import { readSettings } from './settings.js';
import { loadContext } from './context.js';
import { resolvePrice, estimateCost, projectRate } from './pricing.js';
import { refreshPrices, pricingStatus } from './pricing-sources.js';
import { evaluateSelection, approveSelection } from './cost-policy.js';
import { summarizeUsage } from './usage.js';
import { stateError } from './atomic-state.js';
function readEvents(file) {
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value : value.events; }
  catch { return raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
}
const number = (flags, name) => { if (flags[name] === undefined) return undefined; if (typeof flags[name] !== 'string' || !flags[name].trim()) throw stateError('INVALID_NUMBER', `--${name} requires a numeric value`); return Number(flags[name]); };
export async function runPricing(command, args, flags) {
  const project = path.resolve(flags.project || process.cwd());
  const settings = readSettings(project);
  const emit = result => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: result.ok !== false, reasonCode: result.reasonCode ?? 'OK', ...result }, null, flags.json ? 0 : 2) + '\n'); return result.ok === false ? 1 : 0; };
  if (command === 'usage') {
    if (args[0] !== 'summarize' || !flags.input) throw stateError('USAGE_INPUT_REQUIRED', 'Use usage summarize --input events.json');
    return emit({ usage: summarizeUsage(readEvents(flags.input), { runId: flags['run-id'], taskId: flags['task-id'], trustedSources: settings.cost.trustedUsageSources ?? [] }) });
  }
  const action = command === 'approve-model' ? 'approve' : args[0] ?? 'status';
  if (action === 'refresh') return emit(await refreshPrices(project, args[1], settings));
  if (action === 'status') return emit({ sources: pricingStatus(project, settings), unknownPricePolicy: settings.pricing.unknownPricePolicy });
  const context = await loadContext(project);
  const role = flags.role || 'worker';
  let configuredRole;
  if (action === 'approve' && !flags.model) {
    if (!/^[a-zA-Z0-9_-]+$/.test(role)) throw stateError('INVALID_ROLE', 'Role must be a plain identifier');
    try { configuredRole = JSON.parse(fs.readFileSync(path.join(project, '.mawf', 'agents', `${role}.json`), 'utf8')); } catch {}
  }
  const modelId = flags.model || configuredRole?.model;
  if (!modelId) throw stateError('MODEL_REQUIRED', 'Specify --model MODEL');
  const providerId = flags.provider ?? configuredRole?.providerId ?? configuredRole?.model_selection?.providerId ?? null;
  const billingMode = flags.billing ?? configuredRole?.billingMode ?? 'api';
  const price = resolvePrice(modelId, { ...context.cc.pricingContext, modelPricing: context.cc.modelPricing, providerId,
    costMultiplier: number(flags, 'multiplier') ?? context.models.find(model => model.providerId === providerId && model.modelId === modelId)?.costMultiplier ?? 1, serviceMode: flags['service-mode'] ?? 'standard', contextTokens: number(flags, 'context-tokens') });
  const usage = flags.usage ? summarizeUsage(readEvents(flags.usage), { runId: flags['run-id'], taskId: flags['task-id'], trustedSources: settings.cost.trustedUsageSources ?? [] }) : undefined;
  const selection = { role, providerId, modelId, billingMode, price, usage, runId: flags['run-id'], taskId: flags['task-id'] };
  if (action === 'resolve') return emit({ price, providerId, modelId, billingMode });
  if (action === 'estimate') return emit({ price, estimate: estimateCost(price, { input: number(flags, 'input-tokens'), output: number(flags, 'output-tokens'), cacheRead: number(flags, 'cache-read-tokens'), cacheWrite: number(flags, 'cache-write-tokens') }) });
  if (action === 'project') return emit({ price, projection: projectRate(price, { inputTokensPerMin: number(flags, 'input-per-minute'), outputTokensPerMin: number(flags, 'output-per-minute') }) });
  if (action === 'gate') return emit(evaluateSelection(selection, settings));
  if (action === 'approve') {
    if (flags.yes !== true) throw stateError('CONFIRMATION_REQUIRED', 'Approval requires explicit --yes');
    return emit(approveSelection(project, selection, { scope: flags.scope, runId: flags['run-id'] }));
  }
  throw stateError('UNKNOWN_PRICING_ACTION', 'Use pricing resolve|estimate|project|gate|status|refresh');
}
