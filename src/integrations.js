// Metadata is inert: listing/selecting an integration never loads its backend.
import { stateError } from './atomic-state.js';
import { updateSettings } from './settings.js';

const rows = [
  ['host.claude-code', 'Claude Code native execution', [], 'user-installed Claude Code'],
  ['host.codex', 'Codex native execution', [], 'user-installed Codex'],
  ['host.pi', 'Pi native execution', [], 'user-installed Pi'],
  ['host.dsh', 'dsh native execution', [], 'user-installed dsh'],
  ['trellis', 'Trellis lifecycle/workspace', [], '@mindfoldhq/trellis'],
  ['cc-switch.models', 'local model discovery', [], 'farion1231/cc-switch'],
  ['cc-switch.pricing', 'local pricing', [], 'farion1231/cc-switch'],
  ['cc-switch.usage', 'local usage estimates', [], 'farion1231/cc-switch'],
  ['cc-switch.routing', 'routing management', [], 'farion1231/cc-switch'],
  ['cc-switch.profile-sync', 'project profile synchronization', ['cc-switch.models'], 'farion1231/cc-switch'],
  ['cc-switch.backup', 'local database snapshot', [], 'farion1231/cc-switch'],
  ['pricing.models-dev', 'remote pricing cache', [], 'https://models.dev/api.json'],
  ['pricing.cc-switch-upstream', 'pinned upstream price export', [], 'farion1231/cc-switch'],
  ['pi-plugin-cc', 'Pi companion jobs', ['host.claude-code', 'host.pi'], 'https://github.com/Kagandi/pi-plugin-cc'],
  ['codex-plugin-cc', 'Codex companion advisor jobs', ['host.claude-code', 'host.codex'], 'https://github.com/imBlanker/codex-plugin-cc'],
  ['pi-subagents-lite', 'Pi subagents', ['host.pi'], 'recorded component source'],
  ['pi-mcp-adapter', 'Pi MCP adapter', ['host.pi'], 'recorded component source'],
  ['autoresearch.pi', 'bounded Pi optimization', ['host.pi'], 'https://github.com/davebcn87/pi-autoresearch'],
  ['autoresearch.claude', 'Claude optimization candidate', ['host.claude-code'], 'https://github.com/uditgoenka/autoresearch'],
  ['archify', 'architecture artifacts', [], 'vendored archify'],
  ['notes-board', 'notes board', [], 'vendored notes-board'],
  ['trellis-card', 'workspace card', [], 'recorded component source'],
  ['trellis-tracker', 'remote upstream tracking', [], 'npm/GitHub upstream metadata'],
  ['compound', 'compound knowledge skills', [], 'bundled optional skill'],
  ['compound-references', 'compound reference assets', ['compound'], 'bundled optional assets'],
  ['decision', 'decision support / domain-modeling', [], 'bundled optional skill'],
  ['grill', 'grilling / grill-with-docs', [], 'bundled optional skill'],
  ['knowledge', 'knowledge commands and hooks', [], 'MAWF optional enhancement'],
  ['pool', 'plugin pool advice', ['inventory'], 'MAWF optional enhancement'],
  ['inventory', 'cross-host inventory', [], 'MAWF optional enhancement'],
  ['cross-host-advise', 'host advice', ['inventory'], 'MAWF optional enhancement'],
  ['watchdog', 'budget observer registration', [], 'MAWF optional enhancement'],
  ['observer', 'feedback observer', [], 'MAWF optional enhancement'],
  ['workspace-bridge', 'workspace transport', [], 'MAWF optional enhancement'],
  ['workspace-companion', 'workspace HTTP companion', [], 'MAWF optional enhancement'],
  ['workspace-ssh', 'SSH helper', ['workspace-bridge'], 'system ssh'],
  ['workspace-runtime-tmux', 'tmux session runtime', [], 'system tmux'],
  ['dsh.web', 'dsh web enhancement', ['host.dsh'], 'user-installed dsh'],
  ['dsh.mcp', 'dsh MCP enhancement', ['host.dsh'], 'user-installed dsh'],
  ['dsh.presets', 'dsh preset assets', ['host.dsh'], 'bundled optional assets'],
  ['dsh.plugin-inventory', 'dsh plugin inventory', ['host.dsh', 'inventory'], 'user-installed dsh'],
  ['agent-browser', 'browser plugin pool entry', ['pool'], 'recorded pool source'],
  ['codebase-memory-mcp', 'codebase memory pool entry', ['pool'], 'recorded pool source'],
  ['codegraph', 'codegraph pool entry', ['pool'], 'recorded pool source'],
];
export const INTEGRATIONS = Object.freeze(rows.map(([id, capability, requires, source]) => Object.freeze({
  id, capabilities: Object.freeze([capability]), requires: Object.freeze(requires), optional: Object.freeze([]),
  managedPaths: Object.freeze([`.mawf/settings.json#integrations.${id}`]),
  preservedData: Object.freeze(['upstream configuration', 'credentials', 'user files', '.trellis and symbolic links', 'independent knowledge', 'active run snapshots']),
  source, ref: null, defaultEnabled: false,
})));
export function listIntegrations() { return structuredClone(INTEGRATIONS); }
export function getIntegration(id) {
  const integration = INTEGRATIONS.find(item => item.id === id);
  if (!integration) throw stateError('UNKNOWN_INTEGRATION', `Unknown integration ${id}; use integrations list`);
  return structuredClone(integration);
}
export function isEnabled(settings, id) { getIntegration(id); return settings?.integrations?.[id]?.enabled === true; }
export function capabilityStatus(settings, id) {
  getIntegration(id);
  const selected = isEnabled(settings, id);
  return { id, selected, enabled: selected, installed: 'unknown', discovered: 'unknown', authenticated: 'unknown', compatible: 'unknown', ready: 'unknown', verificationStatus: 'not_run', reason: selected ? 'Selected; no target capability probe has run' : 'Not selected; no backend or authentication data read', probedAt: null };
}
export function disableImpact(settings, id) {
  const metadata = getIntegration(id);
  return { id, selected: isEnabled(settings, id), affectedCapabilities: metadata.capabilities,
    dependents: INTEGRATIONS.filter(item => item.requires.includes(id) && isEnabled(settings, item.id)).map(item => item.id),
    managedPaths: metadata.managedPaths, configChanges: [{ path: `integrations.${id}.enabled`, from: isEnabled(settings, id), to: false }],
    preservedData: metadata.preservedData, appliesTo: 'new_top_level_runs', activeRuns: 'Existing snapshots retain their selection',
    alternative: 'Enable a suitable native host or continue configuration and planning without execution', reversible: true };
}
export function setIntegration(project, id, enabled) {
  getIntegration(id);
  return updateSettings(project, settings => {
    settings.integrations[id] = { ...settings.integrations[id], enabled };
    return settings;
  });
}
