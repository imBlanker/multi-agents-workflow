import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { candidatesForAppType } from './modelcap.js';
import { isEnabled } from './integrations.js';

// Native config files may contain credentials; only these model metadata fields
// leave this function. Existence/configuration is not authentication evidence.
export function readSelectedNativeModels(settings) {
  const models = [];
  if (isEnabled(settings, 'host.claude-code')) {
    const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    try {
      const config = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
      const modelId = config.model ?? config.env?.ANTHROPIC_MODEL;
      if (typeof modelId === 'string' && modelId) models.push({ providerId: null, modelId, adapter: 'claude-code', billingMode: 'unknown', sourceId: 'claude-native-config' });
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  if (isEnabled(settings, 'host.codex')) {
    const root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    try {
      const top = fs.readFileSync(path.join(root, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
      const modelId = top.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m)?.[1];
      const providerId = top.match(/^\s*model_provider\s*=\s*["']([^"'\r\n]+)["']/m)?.[1] || null;
      if (modelId) models.push({ providerId, modelId, adapter: 'codex', billingMode: 'unknown', sourceId: 'codex-native-config' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return models;
}
export function normalizedModels(context) {
  const models = new Map();
  for (const appType of context.cc.appTypes ?? []) for (const candidate of candidatesForAppType(context.cc, appType)) {
    const adapter = appType === 'claude' ? 'claude-code' : appType;
    const declared = (context.settings.models ?? []).find(model => model.modelId === candidate.model && model.providerId === candidate.providerId && model.adapter === adapter);
    const key = JSON.stringify([candidate.providerId, candidate.model, adapter]);
    models.set(key, { providerId: candidate.providerId ?? null, modelId: candidate.model, adapter, billingMode: declared?.billingMode ?? 'unknown', configured: true,
      authenticated: 'unknown', compatible: 'unknown', ready: 'unknown', sourceId: declared ? 'project-declaration' : 'selected-model-provider', costMultiplier: candidate.costMultiplier,
      capabilityEvidence: candidate.isCurrent ? 'configured current selection, not a successful request' : 'configured model entry', verificationStatus: 'not_run' });
  }
  return [...models.values()];
}
