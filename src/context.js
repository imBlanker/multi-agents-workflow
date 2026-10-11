import { resolvePiAgentRoot } from './util.js';
// Selection-first context. Native storage and planning do not require a host.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSettings } from './settings.js';
import { isEnabled } from './integrations.js';
import { findExecutable } from './platform/index.js';

export function selectedHost(settings) {
  const names = ['claude-code', 'codex', 'pi', 'dsh'];
  const preferred = process.env.MAW_HOST;
  if (names.includes(preferred)) names.sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : 0);
  const app = names.find(name => isEnabled(settings, `host.${name}`)) ?? 'unknown';
  const homeDir = app === 'unknown' ? '' : app === 'pi' ? resolvePiAgentRoot() : app === 'dsh' ? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) : path.join(os.homedir(), app === 'claude-code' ? '.claude' : '.codex');
  const binary = app === 'unknown' ? null : findExecutable(app === 'claude-code' ? 'claude' : app);
  return { app, homeDir, binary, selected: app !== 'unknown', installed: !!binary,
    authenticated: 'unknown', ready: 'unknown', hasSubagents: app === 'claude-code' || app === 'codex' || app === 'dsh',
    hasMultiAgent: app === 'claude-code' || app === 'dsh', hasDynamicWorkflow: app === 'claude-code' || app === 'dsh', hasGraphWorkflow: false,
    codexPluginInstalled: isEnabled(settings, "codex-plugin-cc") && (fs.existsSync(settings.integrations["codex-plugin-cc"].options.path || path.join(os.homedir(), ".claude", "plugins", "marketplaces", "openai-codex"))), codexBinary: app === 'codex' ? binary : null,
    piDir: isEnabled(settings, 'host.pi') ? resolvePiAgentRoot() : null,
    dshHome: isEnabled(settings, 'host.dsh') ? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) : '',
    skillsDirs: [], agentsDirs: [], commandsDirs: [], extensionsDirs: [], detected: binary ? [`Selected ${app}: ${binary}`] : [] };
}

export async function loadContext(project, opts = {}) {
  const settings = readSettings(project);
  const host = selectedHost(settings);
  const cc = { dbPath: '', impl: 'none', allProviders: [], currentProviders: {}, modelPricing: {}, appTypes: [], settings: {}, schemaVersion: 0, schemaSupported: true };
  const selected = id => isEnabled(settings, id);
  if (selected('cc-switch.models') || selected('cc-switch.pricing')) {
    const adapter = await import('./ccswitch.js');
    Object.assign(cc, adapter.readCcSwitch({ dbPath: opts.dbPath, models: selected('cc-switch.models'), pricing: selected('cc-switch.pricing') }));
    if (selected('cc-switch.usage') && cc.dbPath) cc.quota = adapter.readProviderQuota({ dbPath: cc.dbPath });
  }
  if (selected('host.pi')) {
    const adapter = await import('./piprovider.js');
    const managed = selected('cc-switch.models') && (await import('./ccswitch.js')).piManagedByCcSwitch(cc);
    if (managed) adapter.enrichPiDbRowsWithModelsJson(cc, host.piDir);
    else adapter.mergePiIntoCc(cc, adapter.readPiAsCc({ piDir: host.piDir, ccSwitch: { modelPricing: cc.modelPricing }, readMcp: selected('pi-mcp-adapter') }));
  }
  if (selected('host.dsh')) {
    const { readDshAsCc } = await import('./dshprovider.js');
    const dsh = readDshAsCc({ dshHome: host.dshHome, ccSwitch: { modelPricing: cc.modelPricing }, readLocalPricing: selected('cc-switch.pricing') });
    if (dsh) { cc.allProviders.push(...dsh.allProviders); Object.assign(cc.currentProviders, dsh.currentProviders); Object.assign(cc.modelPricing, dsh.modelPricing); }
  }
  // Explicit declarations contain model metadata only. Never emit API secrets.
  for (const model of settings.models ?? []) {
    const appType = model.adapter === 'claude-code' ? 'claude' : model.adapter ?? 'claude';
    const row = { id: model.providerId, name: model.providerId, app_type: appType, is_current: true, models: [model.modelId], settingsConfig: { models: [{ id: model.modelId }] }, settings_config: { model: model.modelId }, cost_multiplier: 1 };
    cc.allProviders.push(row); cc.currentProviders[appType] = row;
  }
  cc.appTypes = [...new Set(cc.allProviders.map(row => row.app_type))];
  // Subscription coverage is not inferred by reading authentication payloads.
  return { settings, host, cc, codexPlan: null };
}
