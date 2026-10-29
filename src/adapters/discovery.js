// Metadata-only discovery. No model process is launched by discovery or probe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isEnabled } from '../integrations.js';
import { findExecutable, checkoutVariants } from '../platform/index.js';
import { stateError } from '../atomic-state.js';
export const ADAPTERS = Object.freeze({
  'codex-plugin-cc': { source: 'https://github.com/imBlanker/codex-plugin-cc', ref: 'd6a979b35741f3654c6f0f64cea0642104e9105b', version: '0.2.0', scriptSha256: '18b39fd37e12ba2e0c5e4088216b233e85d4d8f5072f986c07e9916d484c06fd', plugin: 'codex', script: 'codex-companion.mjs', binary: 'codex', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  'pi-plugin-cc': { source: 'https://github.com/Kagandi/pi-plugin-cc', ref: 'a8c4db32fbd5b3b3a028b1dcb95cbba60c4cc07e', version: '1.2.0', scriptSha256: '639673c435c7e428e7414410d272abc206d1ea069b27c14a0e934cef48836220', plugin: 'pi', script: 'pi-companion.mjs', binary: 'pi', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
});
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// A pin names the committed bytes; a Windows checkout may hold them with CRLF.
export const scriptDigestMatches = (bytes, sha256) => checkoutVariants(bytes).some(variant => crypto.createHash('sha256').update(variant).digest('hex') === sha256);
const file = target => { try { return fs.statSync(target).isFile(); } catch { return false; } };
function git(directory, args) { try { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }
const normalizeSource = value => (typeof value === 'string' ? value : '').replace(/^git@github.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
function locate(root, adapter) {
  const resolved = path.resolve(root);
  const candidates = [resolved, path.join(resolved, 'scripts', adapter.script), path.join(resolved, 'plugins', adapter.plugin, 'scripts', adapter.script)];
  return candidates.find(candidate => path.basename(candidate) === adapter.script && file(candidate)) || null;
}
export function discoverAdapter(id, settings, opts = {}) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw stateError('ADAPTER_UNSUPPORTED', `Unknown adapter ${id}`);
  const selected = isEnabled(settings, id);
  const base = { id, selected, source: adapter.source, discovered: false, installed: false, authenticated: 'unknown', compatible: false, ready: false, verificationStatus: 'unverified', actualModel: null, actualProvider: null, permissionEnforcement: 'unverified', resume: { supported: false, reason: 'Exact persisted thread/session resume has not been verified' } };
  if (!selected) return { ...base, reasonCode: 'INTEGRATION_DISABLED' };
  const setting = settings.integrations[id]?.options || {};
  const explicit = opts.path || setting.path;
  const home = opts.claudeDir || path.join(os.homedir(), '.claude');
  const candidates = explicit ? [{ root: explicit, origin: 'explicit' }] : [];
  if (!explicit) {
    const installed = json(path.join(home, 'plugins', 'installed_plugins.json'));
    for (const [name, entries] of Object.entries(installed?.plugins || {})) if (name.split('@')[0] === adapter.plugin) for (const entry of Array.isArray(entries) ? entries : [entries]) if (entry.installPath) candidates.push({ root: entry.installPath, origin: 'host-install-metadata', metadata: entry });
    for (const root of setting.compatiblePaths || []) candidates.push({ root, origin: 'registered-compatible' });
    const marketplace = path.join(home, 'plugins', 'marketplaces');
    try { for (const name of fs.readdirSync(marketplace).slice(0, 100)) candidates.push({ root: path.join(marketplace, name), origin: 'bounded-marketplace-probe' }); } catch {}
  }
  let rejected;
  for (const candidate of candidates) {
    const companion = locate(candidate.root, adapter);
    if (!companion) continue;
    const pluginRoot = path.dirname(path.dirname(companion));
    const manifest = json(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const source = git(pluginRoot, ['remote', 'get-url', 'origin']) || candidate.metadata?.source || setting.source || null;
    const ref = git(pluginRoot, ['rev-parse', 'HEAD']) || candidate.metadata?.gitCommitSha || null;
    const sourceVerified = normalizeSource(source) === normalizeSource(adapter.source);
    const bytes = fs.readFileSync(companion);
    const code = bytes.toString('utf8');
    const versionVerified = manifest?.version === adapter.version && scriptDigestMatches(bytes, adapter.scriptSha256) && (!ref || ref === adapter.ref);
    const protocol = ['task', 'status', 'result', 'cancel'].every(command => code.includes(`case "${command}"`) || code.includes(`case '${command}'`));
    const capabilities = { start: protocol, status: protocol, result: protocol, cancel: protocol, resume: false, fresh: code.includes('fresh'), explicitModel: code.includes('model'), background: code.includes('background') };
    const binary = findExecutable(adapter.binary);
    const result = { ...base, discovered: true, installed: true, companion, pluginRoot, origin: candidate.origin, source, expectedSource: adapter.source, sourceVerified, ref, version: manifest?.version || null, permissionEnforcement: id === 'pi-plugin-cc' ? 'unsupported_read_only' : 'upstream_sandbox_requested_not_runtime_verified', companionSha256: crypto.createHash('sha256').update(bytes).digest('hex'), binary, capabilities,
      supportedRef: adapter.ref, versionVerified, compatible: !!(sourceVerified && versionVerified && protocol && capabilities.fresh && capabilities.explicitModel && capabilities.background && binary), reasonCode: !sourceVerified ? 'SOURCE_UNVERIFIED' : !versionVerified ? 'VERSION_UNVERIFIED' : !binary ? 'BINARY_UNAVAILABLE' : !protocol ? 'PROTOCOL_UNSUPPORTED' : 'REQUIRES_REAL_EXECUTION', limitations: ['Discovery does not prove authentication or tool enforcement', 'Requested model is not evidence of the resolved model', 'Resume-last cannot establish an exact fresh independent session'] };
    if (result.compatible || explicit) return result;
    rejected ||= result;
  }
  return rejected || { ...base, reasonCode: explicit ? 'EXPLICIT_PATH_NOT_FOUND' : 'PLUGIN_NOT_FOUND' };
}
