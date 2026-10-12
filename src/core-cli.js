import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSettings, updateSettings, settingsPath } from './settings.js';
import { isEnabled, listIntegrations, capabilityStatus, setIntegration } from './integrations.js';
import { writeAtomic, readStrict, stateError } from './atomic-state.js';
import { loadContext, selectedHost } from './context.js';
import { workspaceLayout } from './workspace/backend.js';

const emit = (value, flags) => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ...value }, null, flags.json ? 0 : 2) + '\n'); return value.ok === false ? 1 : 0; };
const enabled = (project, id) => isEnabled(readSettings(project), id);

export async function repairSelectedOverlays(project, deps = {}) {
  const settings = readSettings(project);
  const errors = []; let repaired = 0;
  if (isEnabled(settings, 'cross-host-advise')) {
    try { (deps.writeManagedBlocks || (await import('./injectblock.js')).writeManagedBlocks)(project); }
    catch (error) { errors.push({ operation: 'managed blocks', message: error.message }); }
  }
  const projects = new Set([project]);
  if (isEnabled(settings, 'watchdog')) {
    const registry = await import('./watchdog/registry.js');
    for (const row of (deps.resolveWatchList || registry.resolveWatchList)((deps.readRegistry || registry.readRegistry)(), {})) projects.add(row.dir);
  }
  for (const dir of projects) {
    if (!enabled(dir, 'grill') || !enabled(dir, 'trellis') || workspaceLayout(dir).native) continue;
    try {
      const adapter = await import('./grillswap.js');
      const result = (deps.applyGrillSwap || adapter.applyGrillSwap)(dir);
      if (result.applied) repaired++;
    } catch (error) { errors.push({ operation: 'grill overlay', target: dir, message: error.message }); }
  }
  return { ok: !errors.length, repaired, errors };
}

async function selectedInventory(project, settings, flags = {}) {
  const adapter = await import('./inventory.js');
  return adapter.scanInventory({ projectDir: project, settings, probe: !!flags.verify, dbPath: flags.db });
}

async function optionalInit(project, settings, flags, context) {
  const stages = [];
  if (isEnabled(settings, 'cc-switch.backup')) stages.push({ integration: 'cc-switch.backup', ...(await import('./backup.js')).snapshotCcSwitch({ dbPath: flags.db }) });
  if (isEnabled(settings, 'cc-switch.profile-sync')) {
    const cc = await import('./ccswitch.js');
    stages.push({ integration: 'cc-switch.profile-sync', ...cc.createProjectProfile({ name: `MAWF: ${path.basename(project)}`, user: flags.u || flags.user || '', hostApp: context.host.app, dbPath: flags.db, enabled: true }) });
  }
  if (isEnabled(settings, 'cc-switch.routing')) {
    const cc = await import('./ccswitch.js');
    stages.push({ integration: 'cc-switch.routing', ...(flags['fix-routing'] ? cc.applyRouting({ dbPath: flags.db, fix: true }) : cc.routingPolicy(cc.readRouting({ dbPath: flags.db }))) });
  }
  if (isEnabled(settings, 'watchdog') && !flags['no-watchdog']) stages.push({ integration: 'watchdog', ...(await import('./watchdog/registry.js')).registerProject(project) });
  if (isEnabled(settings, 'inventory')) writeAtomic(path.join(project, '.mawf', 'inventory.json'), await selectedInventory(project, settings));
  if (isEnabled(settings, 'trellis') && !workspaceLayout(project).native) {
    const adapter = await import('./trellis.js');
    const detection = adapter.detectTrellis();
    if (!detection.bin) stages.push({ integration: 'trellis', ok: false, reasonCode: 'UNAVAILABLE', reason: detection.reason, install: detection.install });
    else if (context.host.app === 'unknown') stages.push({ integration: 'trellis', ok: false, reasonCode: 'HOST_REQUIRED', reason: 'Select the target host before Trellis init; automatic upstream host detection is disabled' });
    else stages.push({ integration: 'trellis', ...adapter.runTrellisInit({ project, user: flags.u || flags.user || 'mawf-user', hostApp: context.host.app, selectedHosts: ["claude-code", "codex", "pi", "dsh"].filter(host => isEnabled(settings, `host.${host}`)), detection, nonInteractive: true }) });
  }
  stages.push({ integration: 'selected-overlays', ...await repairSelectedOverlays(project) });
  return stages;
}

export async function updateLifecycle(opts = {}, deps = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const settings = readSettings(project); const stages = [];
  const maw = deps.updateMaw ? await deps.updateMaw({ ...opts, project, settings }) : (await import('./selected-install.js')).installSelected({ ...opts, project, settings });
  stages.push({ stage: 'mawf update', ok: maw.ok !== false, result: maw });
  if (maw.ok === false) return { ok: false, project, stages, maw };
  let trellis = null;
  if (!opts.mawfOnly && isEnabled(settings, 'trellis') && !workspaceLayout(project).native) {
    const adapter = deps.runTrellis ? null : await import('./trellis.js');
    trellis = await (deps.runTrellis || adapter.runTrellisCommand)({ ...opts, project, command: 'update' }); stages.push(trellis);
  } else stages.push({ stage: 'trellis update', ok: true, skipped: true, reason: 'Not selected or native workspace' });
  const overlay = opts.dryRun ? { ok: true, skipped: true } : await (deps.repairOverlays || repairSelectedOverlays)(project);
  stages.push({ stage: 'mawf overlay repair', ...overlay });
  return { ok: trellis?.ok !== false && overlay.ok !== false, project, stages, maw, trellis, overlay };
}
export async function upgradeLifecycle(opts = {}, deps = {}) {
  const project = path.resolve(opts.project || process.cwd());
  const settings = readSettings(project);
  const maw = await (deps.upgradeMaw || (await import('./upgrade.js')).upgrade)({ ...opts, project, settings });
  const stages = [{ stage: 'mawf upgrade', ok: maw.ok, result: maw }];
  if (!maw.ok) return { ok: false, project, maw, stages };
  let trellisUpgrade = null;
  if (!opts.mawfOnly && isEnabled(settings, 'trellis') && !workspaceLayout(project).native) {
    trellisUpgrade = await (deps.runTrellis || (await import('./trellis.js')).runTrellisCommand)({ ...opts, project, command: 'upgrade' }); stages.push(trellisUpgrade);
  } else stages.push({ stage: 'trellis upgrade', ok: true, skipped: true, reason: 'Not selected or native workspace' });
  const overlay = !opts.dryRun && opts.applyTemplates !== false ? await (deps.repairOverlays || repairSelectedOverlays)(project) : null;
  if (overlay) stages.push({ stage: 'mawf overlay repair', ...overlay });
  return { ok: trellisUpgrade?.ok !== false && overlay?.ok !== false, project, maw, stages, trellisUpgrade, overlay };
}

export async function runCore(command, args, flags = {}, deps = {}) {
  const project = path.resolve(typeof flags.project === 'string' ? flags.project : process.cwd());
  let settings = readSettings(project);
  if (command === 'init') {
    if (flags.host) {
      const host = flags.host === 'claude' ? 'claude-code' : flags.host;
      settings = setIntegration(project, `host.${host}`, true);
    }
    if (flags.trellis && !flags['no-trellis']) settings = setIntegration(project, 'trellis', true);
    if (flags['no-trellis']) settings = setIntegration(project, 'trellis', false);
    if (!fs.existsSync(settingsPath(project))) settings = updateSettings(project, draft => draft);
    // Preserve an existing explicit marker byte-for-byte. New unselected
    // workspaces use native storage, without deleting legacy data.
    const marker = path.join(project, '.mawf', 'workspace.json');
    if (!fs.existsSync(marker) && !isEnabled(settings, 'trellis')) writeAtomic(marker, { version: 1, backend: 'mawf', trellis: false });
    workspaceLayout(project);
  }
  if (command === 'init' || command === 'plan') {
    const ctx = await loadContext(project, { dbPath: flags.db });
    const { planWorkflow, inferSignals } = await import('./planner.js');
    const { probeProject } = await import('./probe.js');
    const { generateConfigs } = await import('./configgen.js');
    const signals = { ...inferSignals(probeProject(project)), description: flags.description || path.basename(project),
      ...(flags['task-type'] ? { taskType: flags['task-type'] } : {}), ...(flags.parallel ? { parallelizableSubtasks: Number(flags.parallel) } : {}),
      ...(flags['max-iter'] ? { maxIterations: Number(flags['max-iter']) } : {}), ...(flags.hitl ? { needHITL: true } : {}), ...(flags.persistence ? { needPersistence: true } : {}),
      ...(flags.risk ? { risk: flags.risk } : {}), ...(flags.context ? { contextNeed: flags.context } : {}), ...(flags.value ? { valuePerRun: flags.value } : {}) };
    const plan = planWorkflow(signals, { host: ctx.host, ccSwitch: ctx.cc, codexPlan: null,
      cost: { maxConcurrency: settings.scheduler.maxConcurrency, perAgentLimitUsdPerMin: Number(flags['per-agent-limit']) || 1, totalLimitUsdPerMin: Number(flags['total-limit']) || 3 } });
    plan.mode = settings.mode; plan.configRevision = settings.configRevision;
    const generated = generateConfigs(project, plan, ctx.cc, { ...(flags.out ? { outDir: path.resolve(flags.out) } : {}), materializePi: isEnabled(settings, 'pi-subagents-lite') && !flags.out });
    const stages = command === 'init' ? await optionalInit(project, settings, flags, ctx) : [];
    const execution = ctx.host.app === 'unknown' ? { available: false, reason: 'No execution host selected; configuration and planning remain available' } : { selectedHost: ctx.host.app, installed: ctx.host.installed, authenticated: 'unknown', ready: 'unknown' };
    return emit({ ok: !stages.some(stage => stage.ok === false), project, modeId: settings.mode.id, configRevision: settings.configRevision, plan, generated, stages, execution }, flags);
  }
  if (command === 'doctor') return emit(await (await import('./selected-doctor.js')).diagnoseSelected(project, settings), flags);
  if (command === 'models') {
    const context = await loadContext(project, { dbPath: flags.db });
    return emit({ ok: true, models: context.models, providerCount: context.cc.allProviders.length, host: context.host.app, authenticated: 'unknown' }, flags);
  }
  if (command === 'inventory') {
    const inventory = await selectedInventory(project, settings, flags);
    if (!flags['dry-run']) (await import('./inventory.js')).writeInventoryArtifacts(project, inventory);
    return emit({ ok: true, inventory }, flags);
  }
  if (command === 'components') {
    if (['list', 'status', 'doctor', undefined].includes(args[0])) return emit({ ok: true, components: listIntegrations().filter(item => ['archify', 'notes-board', 'trellis-card', 'compound-references'].includes(item.id)).map(item => ({ ...item, ...capabilityStatus(settings, item.id) })) }, flags);
    return await (await import('./components/cli.js')).runComponents(args, flags);
  }
  if (command === 'uninstall') return emit((await import('./selected-install.js')).uninstallSelected({ project, dryRun: flags['dry-run'] }), flags);
  if (command === 'install') return emit((await import('./selected-install.js')).installSelected({ project, settings, force: flags.force, dryRun: flags['dry-run'] }), flags);
  if (command === 'update') return emit(await updateLifecycle({ project, settings, force: flags.force, dryRun: flags['dry-run'], mawfOnly: flags['mawf-only'] }, deps), flags);
  if (command === 'upgrade') return emit(await upgradeLifecycle({ project, dryRun: flags['dry-run'], applyTemplates: !flags['no-apply-templates'], mawfOnly: flags['mawf-only'], tag: flags.tag }, deps), flags);
  throw stateError('UNKNOWN_COMMAND', `Unknown Core command ${command}`);
}
