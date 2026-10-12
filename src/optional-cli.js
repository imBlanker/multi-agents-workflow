import { deriveTaskProfile } from './task-profile.js';
import { parseYamlSubset } from './util.js';
import fs from 'node:fs';
import path from 'node:path';
import { readSettings } from './settings.js';
import { isEnabled } from './integrations.js';
import { stateError } from './atomic-state.js';
import { selectedHost } from './context.js';
export async function runOptional(command, args, flags) {
  const project = path.resolve(flags.project || process.cwd());
  const settings = readSettings(project);
  const emit = value => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: value.ok !== false, ...value }, null, flags.json ? 0 : 2) + '\n'); return value.ok === false ? 1 : 0; };
  if (command === 'routing') {
    const adapter = await import('./ccswitch.js');
    return emit(flags.fix ? adapter.applyRouting({ dbPath: flags.db, fix: true }) : adapter.routingPolicy(adapter.readRouting({ dbPath: flags.db })));
  }
  if (command === 'observer') {
    const adapter = await import('./observer.js');
    if (args[0] === 'install') return emit(adapter.installObserver({ projectDir: project, hostApp: flags.host || 'claude' }));
    if (args[0] === 'uninstall') return emit(adapter.uninstallObserver({ hostApp: flags.host || 'claude' }));
    if (args[0] === 'emit') return emit(adapter.emitEvent(fs.readFileSync(0, 'utf8'), { projectDir: project }));
    return emit({ spool: adapter.spoolPath(project), selected: true });
  }
  if (command === 'review') {
    const adapter = await import('./codex.js');
    return emit(await adapter.runReview({ project, cwd: project, task: flags.task || args.join(' '), prompt: flags.prompt || args.join(' '), scope: flags.scope || 'uncommitted', model: flags.model, effort: flags.effort }));
  }
  if (command === 'watchdog') {
    const adapter = await import('./watchdog/scan.js');
    const scan = async () => emit(await adapter.scanOnce({ projectDir: typeof flags.project === 'string' ? project : undefined, dbPath: flags.db, dispatch: true, dryRun: flags['dry-run'] === true, settings }));
    if (flags.once) return scan();
    await scan();
    const interval = Number(flags.interval) || 15;
    if (!Number.isFinite(interval) || interval <= 0) throw stateError('INVALID_INTERVAL', 'watchdog interval must be positive minutes');
    let running = false;
    const timer = setInterval(async () => { if (running) return; running = true; try { await scan(); } catch (error) { process.stderr.write(error.message + '\n'); } finally { running = false; } }, interval * 60000);
    process.once('SIGINT', () => { clearInterval(timer); });
    process.once('SIGTERM', () => { clearInterval(timer); });
    return 0;
  }
  if (command === 'advise') {
    if (flags['check-fresh']) {
      const adapter = await import('./advise.js');
      const freshness = adapter.checkFreshness(path.join(project, '.mawf', 'runtime', 'advise-state.json'));
      if (flags.json) return emit({ freshness });
      process.stdout.write(freshness + '\n'); return 0;
    }
    const inventory = await (await import('./inventory.js')).scanInventory({ projectDir: project, settings, probe: !!flags.verify });
    if (flags.pool) {
      const adapter = await import('./pool.js');
      const catalog = adapter.loadCatalog(flags.catalog);
      const poolState = adapter.readPoolState(project);
      const stageInfo = adapter.deriveStages(project);
      const stageCtx = stageInfo ? stageInfo.stages.find(stage => (poolState.stages[stage.id]?.judgments || []).length < 2) || stageInfo.stages.at(-1) : null;
      const profile = flags.task ? { text: flags.task, domain: flags.domain || '' } : deriveTaskProfile(project);
      let cfg = {};
      try { cfg = parseYamlSubset(fs.readFileSync(path.join(project, '.mawf', 'config.yaml'), 'utf8')).pool || {}; } catch {}
      const result = adapter.judgePool({ catalog, pool: inventory.pool || adapter.detectPool(inventory, catalog), profile, stageCtx, poolState, cfg });
      const verdicts = Object.fromEntries(result.verdicts.map(item => [item.component, { verdict: item.verdict, low: item.low === true }]));
      const state = adapter.recordJudgment(project, stageCtx, verdicts, new Date().toISOString());
      const count = stageCtx ? (state.stages[stageCtx.id]?.judgments || []).length : 0;
      if (flags.json) return emit({ ...result, state });
      process.stdout.write(adapter.renderPool(result, stageCtx ? { judgments: count, needed: 2 } : undefined) + '\n'); return 0;
    }
    const adapter = await import('./advise.js');
    const result = adapter.adviseTask({ projectDir: project, inventory, currentHost: selectedHost(settings).app, task: flags.task, domain: flags.domain, difficulty: Number(flags.difficulty) || undefined });
    if (flags.json) return emit(result);
    process.stdout.write(adapter.renderAdvise(result) + '\n'); return 0;
  }
  throw stateError('UNKNOWN_COMMAND', `Unknown optional command ${command}`);
}
