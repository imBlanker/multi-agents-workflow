// One-time, reversible import of legacy user configuration. Runtime/evidence
// are never restored, overwritten or treated as generated configuration.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSettings, updateSettings, settingsPath } from './settings.js';
import { withLock, readStrict, writeAtomic, assertSafePath, stateError } from './atomic-state.js';
import { parseYamlSubset } from './util.js';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const configHash = value => hash(JSON.stringify(value));
const tracked = ['config.yaml', 'workflow.json', 'plan.md', 'graph.json', 'agents', 'settings.json', 'workspace.json'];
function capture(source, backup, records, rel = '') {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.symlinkSync(fs.readlinkSync(source), backup); records.push({ rel, type: 'link', target: fs.readlinkSync(source) }); }
  else if (info.isDirectory()) { fs.mkdirSync(backup, { recursive: true }); records.push({ rel, type: 'directory' }); for (const name of fs.readdirSync(source)) capture(path.join(source, name), path.join(backup, name), records, path.join(rel, name)); }
  else if (info.isFile()) { const bytes = fs.readFileSync(source); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, bytes, { mode: info.mode & 0o777 }); records.push({ rel, type: 'file', sha256: hash(bytes), mode: info.mode & 0o777 }); }
}
function legacyOverrides(directory) {
  const roles = {}, approvals = [], warnings = [];
  const configFile = path.join(directory, 'config.yaml');
  const config = fs.existsSync(configFile) ? parseYamlSubset(fs.readFileSync(configFile, 'utf8')) : {};
  const agents = path.join(directory, 'agents');
  const files = fs.existsSync(agents) ? fs.readdirSync(agents) : [];
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const target = path.join(agents, file);
    if (fs.lstatSync(target).isSymbolicLink()) { warnings.push(`${file}: symbolic link retained; external content is not imported`); continue; }
    let data;
    try { data = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw stateError('INVALID_LEGACY_CONFIG', `Invalid legacy agent JSON: ${file}`); }
    const role = data.role || file.slice(0, -5);
    const override = roles[role] ||= {};
    for (const key of ['model', 'providerId', 'billingMode', 'tools', 'task', 'agent', 'concurrency']) if (data[key] !== undefined) override[key] = data[key];
    if (data.app_type !== undefined) override.appType = data.app_type;
    if (data.cost_rate_limit_usd_per_min !== undefined) override.costRateLimitUsdPerMin = data.cost_rate_limit_usd_per_min;
    if (data.price_gate?.approved) approvals.push({ role, original: data.price_gate, authority: 'historical_unbound_not_approved' });
  }
  for (const file of files.filter(name => name.endsWith('.md'))) {
    const target = path.join(agents, file);
    if (fs.lstatSync(target).isSymbolicLink()) { warnings.push(`${file}: symbolic link retained; external content is not imported`); continue; }
    const body = fs.readFileSync(target, 'utf8');
    const role = body.match(/^# Agent:\s*(.+)$/m)?.[1]?.trim() || file.slice(0, -3);
    const task = body.match(/^## Task\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]?.trim();
    if (task) (roles[role] ||= {}).task = task;
    else if (!roles[role]) roles[role] = { task: body, legacyMarkdown: true };
  }
  for (const [role, model] of Object.entries(config.models || {})) {
    const override = roles[role] ||= {};
    if (typeof model === 'string') override.model ??= model;
    else { override.model ??= model.model; if (model.app_type) override.appType ??= model.app_type; }
  }
  return { roles, approvals, warnings, scheduler: config.cost?.max_concurrency ?? config.scheduler?.max_concurrency ?? config.scheduler?.maxConcurrency };
}
export function migrateLegacyProject(project, opts = {}) {
  const directory = path.dirname(settingsPath(project));
  const settings = readSettings(project);
  if (opts.auto && fs.existsSync(path.join(directory, 'generated', 'current.json'))) return { ok: true, applied: false, reasonCode: 'V1_GENERATION_PRESENT' };
  if (settings.migrations?.legacyV1?.state === 'applied') return { ok: true, applied: false, reasonCode: 'ALREADY_MIGRATED', migration: settings.migrations.legacyV1 };
  const stateFile = path.join(directory, 'migrations', 'legacy-v1.json');
  const previous = readStrict(stateFile, null);
  if (opts.auto && previous?.state === 'rolled_back') return { ok: true, applied: false, reasonCode: 'EXPLICIT_MIGRATION_REQUIRED' };
  const sources = tracked.filter(name => !['settings.json', 'workspace.json'].includes(name) && fs.existsSync(path.join(directory, name)));
  if (!sources.length) return { ok: true, applied: false, reasonCode: 'NO_LEGACY_CONFIG' };
  const imported = legacyOverrides(directory);
  if (opts.dryRun) return { ok: true, dryRun: true, sources, importedRoles: Object.keys(imported.roles), warnings: imported.warnings };
  return withLock(directory, 'migration', () => {
    const current = readSettings(project);
    if (current.migrations?.legacyV1?.state === 'applied') return { ok: true, applied: false, reasonCode: 'ALREADY_MIGRATED', migration: current.migrations.legacyV1 };
    const id = `legacy-v1-${Date.now()}-${crypto.randomUUID()}`;
    const backupDir = path.join(directory, 'migrations', id);
    const records = [];
    for (const name of tracked) {
      const source = path.join(directory, name);
      if (fs.existsSync(source) || (() => { try { return fs.lstatSync(source).isSymbolicLink(); } catch { return false; } })()) capture(source, path.join(backupDir, 'files', name), records, name);
    }
    writeAtomic(path.join(backupDir, 'manifest.json'), { schemaVersion: 1, id, records, scope: 'Complete legacy configuration and agent files; runtime/evidence are untouched' });
    const migration = { id, state: 'applied', backupDir, appliedAt: new Date().toISOString(), source: 'legacy_user_configuration', importedRoles: Object.keys(imported.roles), warnings: imported.warnings };
    const changed = updateSettings(project, draft => {
      for (const [role, override] of Object.entries(imported.roles)) draft.roleOverrides[role] = { ...override, ...(draft.roleOverrides[role] || {}) };
      if (Number.isSafeInteger(imported.scheduler) && imported.scheduler > 0) { draft.scheduler.maxConcurrency = imported.scheduler; draft.scheduler.targetConcurrency = Math.min(draft.scheduler.targetConcurrency, imported.scheduler); }
      draft.customAgents ||= {};
      for (const [role, override] of Object.entries(imported.roles)) if (!/^(orchestrator|implementer|researcher|reviewer|advisor|autoresearch|hacker)(-\d+)?$/.test(role)) draft.customAgents[role] = { ...override, ...(draft.customAgents[role] || {}) };
      draft.legacyApprovalHistory = [...(draft.legacyApprovalHistory || []), ...imported.approvals];
      draft.migrations = { ...(draft.migrations || {}), legacyV1: migration };
    });
    writeAtomic(stateFile, { ...migration, settingsHashAfter: configHash(changed) });
    return { ok: true, applied: true, migration, configRevision: changed.configRevision };
  });
}
export function rollbackLegacyProject(project, opts = {}) {
  const directory = path.dirname(settingsPath(project));
  return withLock(directory, 'migration', () => withLock(directory, 'settings', () => {
    const stateFile = path.join(directory, 'migrations', 'legacy-v1.json');
    const migration = readStrict(stateFile, null);
    if (!migration || migration.state !== 'applied') throw stateError('MIGRATION_NOT_FOUND', 'No applied legacy migration to roll back');
    if (!opts.force && configHash(readSettings(project)) !== migration.settingsHashAfter) throw stateError('ROLLBACK_CONFLICT', 'Settings changed after migration; preserve/merge them or explicitly use --force');
    const manifest = readStrict(path.join(migration.backupDir, 'manifest.json'));
    if (!manifest || manifest.id !== migration.id || !Array.isArray(manifest.records)) throw stateError('INVALID_MIGRATION_BACKUP', 'Backup manifest is invalid');
    for (const entry of manifest.records) {
      const target = path.resolve(directory, entry.rel);
      if (!target.startsWith(directory + path.sep) || entry.rel.split(path.sep).includes('..')) throw stateError('INVALID_MIGRATION_BACKUP', 'Backup path is outside configuration');
      const source = path.join(migration.backupDir, 'files', entry.rel);
      if (entry.type === 'directory') { fs.mkdirSync(target, { recursive: true }); continue; }
      if (entry.type === 'link') { try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; } fs.symlinkSync(entry.target, target); continue; }
      assertSafePath(target);
      const bytes = fs.readFileSync(source);
      if (hash(bytes) !== entry.sha256) throw stateError('INVALID_MIGRATION_BACKUP', 'Backup file hash mismatch');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { mode: entry.mode });
    }
    if (!manifest.records.some(entry => entry.rel === 'settings.json')) fs.unlinkSync(settingsPath(project));
    const pointer = path.join(directory, 'generated', 'current.json');
    assertSafePath(pointer);
    if (fs.existsSync(pointer)) fs.unlinkSync(pointer);
    writeAtomic(stateFile, { ...migration, state: 'rolled_back', rolledBackAt: new Date().toISOString() });
    return { ok: true, rolledBack: true, backupDir: migration.backupDir, runtimePreserved: true };
  }));
}
