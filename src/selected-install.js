import { resolvePiAgentRoot } from './util.js';
// Install only selected surfaces; preserve all previously owned files when a
// selection is disabled. Disabling a project is not a global uninstall.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings.js';
import { isEnabled } from './integrations.js';
import { readStrict, writeAtomic, assertSafePath } from './atomic-state.js';
import { materializePluginAssets } from './pluginassets.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL_SKILLS = { 'mawf-archify': 'archify', 'mawf-knowledge': 'knowledge', 'mawf-compound': 'compound', 'mawf-decision': 'decision', 'mawf-grill': 'grill', vendor: 'grill' };
export function installSelected(opts = {}) {
  const settings = opts.settings || readSettings(opts.project || process.cwd());
  const root = path.join(os.homedir(), '.mawf');
  const manifestPath = path.join(root, 'installed.json');
  const old = readStrict(manifestPath, { files: [], dirs: {} });
  const written = [], copied = [], skipped = [], refreshed = [];
  const oldFiles = new Set(old.files || []);
  function copyTree(source, target, filter = () => true, nested = false) {
    if (!nested) refreshed.push({ root: target, filter });
    if (!fs.existsSync(source)) return;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!filter(entry.name)) continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) { copyTree(from, to, () => true, true); continue; }
      assertSafePath(to);
      if (fs.existsSync(to) && !oldFiles.has(to) && !opts.force) { skipped.push({ path: to, reason: 'user_owned_file_preserved' }); continue; }
      if (!opts.dryRun) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
      written.push(to);
    }
  }
  const filterSkill = name => name === 'vendor' ? isEnabled(settings, 'grill') || isEnabled(settings, 'decision') : !OPTIONAL_SKILLS[name] || isEnabled(settings, OPTIONAL_SKILLS[name]);
  const hosts = [
    ['claude-code', opts.claudeDir || old.dirs?.claudeDir || path.join(os.homedir(), '.claude'), 'claudeDir'],
    ['codex', opts.codexDir || old.dirs?.codexDir || path.join(os.homedir(), '.codex'), 'codexDir'],
    ['pi', opts.piDir || old.dirs?.piDir || resolvePiAgentRoot(), 'piDir'],
    ['dsh', opts.dshHome || old.dirs?.dshDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dshDir'],
  ];
  const dirs = { ...old.dirs };
  for (const [host, dir, key] of hosts) {
    if (!isEnabled(settings, `host.${host}`)) continue;
    dirs[key] = dir; copied.push(host);
    copyTree(path.join(PKG, 'skills'), path.join(dir, 'skills'), filterSkill);
    if (host === 'claude-code' || host === 'pi') copyTree(path.join(PKG, 'plugin', 'commands'), path.join(dir, host === 'pi' ? 'prompts' : 'commands'), name => name !== 'mawf-review.md' || isEnabled(settings, 'codex-plugin-cc'));
    if (host === 'claude-code' || host === 'codex') copyTree(path.join(PKG, 'plugin', 'agents'), path.join(dir, 'agents'));
    // The optional watchdog registers the guard hook. Merely shipping the
    // plugin/hooks directory never authorizes installing it into user hooks.
    if (host === 'claude-code' && isEnabled(settings, 'watchdog')) copyTree(path.join(PKG, 'plugin', 'hooks'), path.join(dir, 'hooks'));
  }
  // Portable assets are packaging, not host registration. Existing ownership
  // stays in the union so another host's installation is never dropped.
  if (copied.length) copyTree(path.join(PKG, 'skills'), path.join(root, 'skills'), filterSkill);
  const writtenSet = new Set(written);
  const stale = [...oldFiles].filter(file => !writtenSet.has(file) && refreshed.some(surface => {
    const relative = path.relative(surface.root, file);
    return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) && surface.filter(relative.split(path.sep)[0]);
  }));
  const removedStale = [];
  if (!opts.dryRun) for (const file of stale) {
    assertSafePath(file);
    try { fs.unlinkSync(file); removedStale.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const surface = refreshed.find(item => file.startsWith(item.root + path.sep));
    let dir = path.dirname(file);
    while (surface && dir !== surface.root && dir.startsWith(surface.root + path.sep)) {
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }
  const files = [...new Set([...oldFiles].filter(file => !stale.includes(file)).concat(written))];
  if (!opts.dryRun) {
    materializePluginAssets(written, PKG);
    writeAtomic(manifestPath, { ...old, version: JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version,
      installedAt: new Date().toISOString(), host: { app: copied.includes(process.env.MAW_HOST) ? process.env.MAW_HOST : copied.includes(old.host?.app) ? old.host.app : copied[0] || old.host?.app || 'unknown' }, dirs, files,
      selectionProject: path.resolve(opts.project || process.cwd()), configRevision: settings.configRevision });
  }
  return { ok: true, dryRun: !!opts.dryRun, copied, written, skipped, preserved: [...oldFiles].filter(file => !written.includes(file)), removedStale: opts.dryRun ? stale : removedStale, reason: 'Only explicitly selected surfaces are registered; previously owned assets remain until explicit uninstall' };
}
