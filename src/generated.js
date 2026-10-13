// Immutable generation directories plus one atomic pointer; projections are
// compatibility views and never the authoritative settings/run snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLock, readStrict, writeAtomic, assertSafePath, stateError } from './atomic-state.js';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = (root, rel) => { const target = path.resolve(root, rel); if (!target.startsWith(path.resolve(root) + path.sep)) throw stateError('GENERATION_PATH_ESCAPE', 'Generated path escapes its root'); assertSafePath(target); return target; };
export function publishGeneration(project, plan, context, opts, render) {
  const explicit = !!opts.outDir;
  const root = explicit ? path.resolve(opts.outDir) : path.join(project, '.mawf', 'generated');
  const views = explicit ? root : path.join(project, '.mawf');
  return withLock(root, 'generation', () => {
    const id = `generation-${Date.now()}-${crypto.randomUUID()}`;
    const directory = path.join(root, 'generations', id);
    const old = readStrict(path.join(root, 'current.json'), null);
    let generated;
    try { generated = render(project, plan, context, { ...opts, outDir: directory, materializePi: false }); }
    catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
    const files = generated.files.filter(file => typeof file === 'string' && file.startsWith(directory + path.sep)).map(file => ({ path: path.relative(directory, file), sha256: sha(fs.readFileSync(file)) }));
    const manifest = { schemaVersion: 1, generationId: id, configRevision: plan.configRevision, modeId: plan.mode?.id || 'dynamic', files, createdAt: new Date().toISOString() };
    const owned = new Map((old?.projectionFiles || []).map(file => [file.path, file.sha256]));
    const projected = [];
    const current = new Set(files.map(file => file.path));
    const warnings = [...generated.warnings];
    const migrationOwned = new Set();
    const migration = context.pricingContext?.settings?.migrations?.legacyV1;
    if (migration?.backupDir) for (const entry of readStrict(path.join(migration.backupDir, 'manifest.json'), { records: [] }).records) if (entry.type === 'file') migrationOwned.add(entry.rel);
    for (const file of files) {
      if (file.path.startsWith('runtime' + path.sep)) continue;
      const target = safe(views, file.path);
      if (fs.existsSync(target) && (!owned.has(file.path) || sha(fs.readFileSync(target)) !== owned.get(file.path)) && !migrationOwned.has(file.path)) { warnings.push(`Preserved unowned compatibility file ${target}; current generation is ${directory}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(directory, file.path), target); projected.push(file);
      if (!explicit) { const stable = safe(root, file.path); fs.mkdirSync(path.dirname(stable), { recursive: true }); fs.copyFileSync(path.join(directory, file.path), stable); }
    }
    for (const previous of old?.projectionFiles || []) {
      if (current.has(previous.path) || previous.path.startsWith('runtime' + path.sep)) continue;
      for (const projection of explicit ? [views] : [views, root]) {
        const target = safe(projection, previous.path);
        if (fs.existsSync(target) && sha(fs.readFileSync(target)) === previous.sha256) fs.unlinkSync(target);
      }
    }
    const piFiles = [];
    if (!explicit) {
      const piOwned = new Map((old?.piFiles || []).map(file => [file.path, file.sha256]));
      for (const file of opts.piViews || []) {
        const target = safe(project, file.path);
        if (fs.existsSync(target) && (!piOwned.has(file.path) || sha(fs.readFileSync(target)) !== piOwned.get(file.path))) { warnings.push(`Preserved unowned Pi agent ${target}`); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content);
        piFiles.push({ path: file.path, sha256: sha(file.content) });
      }
      for (const previous of old?.piFiles || []) {
        if ((opts.piViews || []).some(file => file.path === previous.path)) continue;
        const target = safe(project, previous.path);
        if (fs.existsSync(target) && sha(fs.readFileSync(target)) === previous.sha256) fs.unlinkSync(target);
      }
    }
    manifest.piFiles = piFiles;
    manifest.projectionFiles = projected;
    writeAtomic(path.join(directory, 'manifest.json'), manifest);
    writeAtomic(path.join(root, 'current.json'), manifest);
    return { dir: root, generationDir: directory, generationId: id, files: files.map(file => path.join(directory, file.path)), warnings, compatibilityViews: views, settingsUnchanged: true };
  });
}
export function readGeneratedPlan(project) {
  const root = path.join(project, '.mawf', 'generated');
  const current = readStrict(path.join(root, 'current.json'), null);
  if (!current) return readStrict(path.join(project, '.mawf', 'workflow.json'), null);
  if (!/^generation-[a-zA-Z0-9-]+$/.test(current.generationId)) throw stateError('INVALID_GENERATION', 'Invalid generation identity');
  const file = safe(root, path.join('generations', current.generationId, 'workflow.json'));
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== current.files.find(entry => entry.path === 'workflow.json')?.sha256) throw stateError('GENERATION_DRIFT', 'The selected generated plan changed');
  return JSON.parse(bytes);
}
