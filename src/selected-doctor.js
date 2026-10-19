import fs from 'node:fs';
import path from 'node:path';
import { listIntegrations, isEnabled, capabilityStatus } from './integrations.js';
import { workspaceLayout } from './workspace/backend.js';
import { selectedHost, loadContext } from './context.js';
import { findExecutable, run } from './platform/index.js';

export async function diagnoseSelected(project, settings) {
  const layout = workspaceLayout(project);
  const checks = [{ name: 'Node.js', status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'fail', detail: process.version },
    { name: 'settings', status: 'ok', detail: `revision ${settings.configRevision}` },
    { name: 'storage', status: 'ok', detail: layout.native ? 'native MAWF' : 'legacy storage preserved; no implicit Trellis execution' }];
  const capabilities = listIntegrations().map(item => capabilityStatus(settings, item.id));
  for (const capability of capabilities.filter(item => item.selected)) {
    capability.probedAt = new Date().toISOString();
    try {
      if (capability.id.startsWith('host.')) {
        const name = capability.id.slice(5); const executable = findExecutable(name === 'claude-code' ? 'claude' : name);
        capability.discovered = capability.installed = !!executable;
        if (executable) {
          const result = run(executable, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
          capability.version = String(result.stdout || '').trim().slice(0, 200);
          capability.compatible = result.status === 0 ? 'unknown' : false;
          capability.reason = result.status === 0 ? 'Version command succeeded; execution/authentication and protocol capabilities are not yet verified' : 'Version command failed';
        } else capability.reason = 'Selected host executable unavailable';
      } else if (capability.id === 'trellis') {
        const result = (await import('./trellis.js')).detectTrellis();
        Object.assign(capability, { installed: result.installed, discovered: !!result.bin || !!result.discoveredPath, compatible: result.compatible, version: result.version ?? null, reason: result.reason || 'Pinned executable verified; project lifecycle has not been run', install: result.install });
      } else if (['cc-switch.models', 'cc-switch.pricing'].includes(capability.id)) {
        const context = await loadContext(project);
        Object.assign(capability, { installed: !!context.cc.dbPath, discovered: !!context.cc.dbPath, compatible: context.cc.dbPath ? context.cc.schemaSupported : 'unknown', schemaVersion: context.cc.schemaVersion, reason: context.cc.dbPath ? 'Selected read-only data loaded; upstream fields remain source evidence, not authentication' : 'Local cc-switch database unavailable' });
      } else if (capability.id === 'cc-switch.usage') {
        const source = (await import('./ccswitch.js')).costRate({});
        capability.reason = `Usage adapter ${source.impl}; token-price-derived cost is estimated, not measured payment`;
        capability.basis = 'estimated'; capability.coverage = 'upstream logged sessions only';
      } else if (['archify', 'notes-board', 'trellis-card', 'compound-references'].includes(capability.id)) {
        const adapter = await import('./components/registry.js');
        const entry = adapter.loadLock().components.find(item => item.name === capability.id);
        const status = adapter.componentStatus(entry);
        capability.discovered = capability.installed = !!status.installed || !!status.bundled;
        capability.sourceStatus = status; capability.reason = 'Component manifest inspected; capability readiness requires its actual verify command';
      } else if (capability.id.startsWith('pricing.')) {
        const cache = path.join(project, '.mawf', 'cache', 'pricing', `${capability.id}.json`);
        capability.discovered = fs.existsSync(cache); capability.reason = 'Cache existence only; refresh and source validation are explicit operations';
      } else capability.reason = 'Selected enhancement has no authenticated execution probe in this configuration slice; readiness remains unknown';
      checks.push({ name: capability.id, status: capability.installed === false || capability.compatible === false ? 'warn' : 'info', detail: capability.reason });
    } catch (error) { capability.reason = error.message; capability.verificationStatus = 'probe_failed'; checks.push({ name: capability.id, status: 'warn', detail: error.message }); }
  }
  return { ok: !checks.some(check => check.status === 'fail'), project, checks, capabilities, host: selectedHost(settings), enforcementLevel: 'configuration_only' };
}
