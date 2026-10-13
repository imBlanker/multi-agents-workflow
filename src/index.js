// Lightweight Core entrypoint. Optional backends are loaded only after selection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControl } from './control.js';
import { readSettings } from './settings.js';
import { isEnabled } from './integrations.js';
import { stateError } from './atomic-state.js';

function parse(argv) {
  const args = [], flags = {};
  const booleans = new Set(['json', 'dry-run', 'no-trellis', 'trellis', 'force', 'yes', 'help', 'version', 'mawf-only', 'no-apply-templates']);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value.startsWith('-')) {
      const [key, inline] = value.replace(/^-+/, '').split(/=(.*)/s);
      flags[key] = inline !== undefined ? inline : !booleans.has(key) && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else args.push(value);
  }
  return { args, flags };
}
const OPTIONAL = {
  inventory: 'inventory', watchdog: 'watchdog', advise: 'cross-host-advise', routing: 'cc-switch.routing',
  review: 'codex-plugin-cc', knowledge: 'knowledge', bridge: 'workspace-bridge', companion: 'workspace-companion',
  observer: 'observer', archify: 'archify', 'archify-registry': 'archify',
};
function failure(error, json) {
  const result = { schemaVersion: 1, ok: false, allowed: false, reasonCode: error.code ?? 'COMMAND_FAILED', reason: error.message };
  (json ? process.stdout : process.stderr).write((json ? JSON.stringify(result) : `mawf: ${result.reason}`) + '\n');
  return 1;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { args, flags } = parse(argv);
  const command = args[0], rest = args.slice(1);
  try {
    if (command === 'mode' || command === 'integrations' || (command === 'config' && rest[0] === 'settings')) return runControl(command, rest, flags);
    if (command === 'version' || flags.version || flags.v) {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      process.stdout.write(flags.json ? JSON.stringify({ schemaVersion: 1, ok: true, version: pkg.version }) + '\n' : `mawf ${pkg.version}\n`); return 0;
    }
    if (!command || command === 'help' || flags.help) {
      process.stdout.write('mawf — Core planning and optional host execution\nCommands: init, plan, config settings, mode, integrations, doctor, models, run, task, cost, guard, acquire, release, install, update, upgrade, uninstall\nOptional: inventory, advise, watchdog, routing, review, knowledge, bridge, companion, components, observer, archify\nUse --project PATH and --json. Enable integrations explicitly; no automatic upstream download.\n'); return 0;
    }
    if (['acquire', 'release', 'guard'].includes(command)) return await (await import('./task-cli.js')).runTaskCompatibility(command, flags);
    if (command === 'run') return await (await import('./run-cli.js')).runExecution(rest, flags);
    if (command === 'autoresearch') return await (await import('./autoresearch/cli.js')).runAutoresearch(rest, flags);
    if (command === 'adapter') return await (await import('./adapters/cli.js')).runAdapter(rest, flags);
    if (command === 'task') return await (await import('./task-cli.js')).runTask(rest, flags);
    const project = path.resolve(typeof flags.project === 'string' ? flags.project : process.cwd());
    const settings = readSettings(project);
    let required = OPTIONAL[command];
    if (command === 'advise' && flags.pool) required = 'pool';
    if (command === 'components' && !['list', 'status', 'doctor', undefined].includes(rest[0])) required = rest[1];
    const deferredBridgeSelection = command === 'bridge' && rest[0] === 'serve' && typeof flags.project !== 'string';
    if (required && !deferredBridgeSelection && !isEnabled(settings, required)) throw stateError('INTEGRATION_DISABLED', `${required} is disabled; use mawf integrations enable ${required} --project ${project}`);
    if (['pricing', 'usage', 'approve-model'].includes(command)) return await (await import('./pricing-cli.js')).runPricing(command, rest, flags);
    if (['init', 'plan', 'doctor', 'models', 'inventory', 'install', 'uninstall', 'update', 'upgrade', 'components', 'migrate', 'add-agent', 'remove-agent'].includes(command)) {
      return await (await import('./core-cli.js')).runCore(command, rest, flags, deps);
    }
    if (['advise', 'observer', 'watchdog', 'routing', 'review'].includes(command)) return await (await import('./optional-cli.js')).runOptional(command, rest, flags);
    if (command === 'knowledge') return await (await import('./knowledge/cli.js')).runKnowledge(rest, flags);
    if (command === 'bridge' && ['install-helper', 'status'].includes(rest[0]) && rest[1] && !isEnabled(settings, 'workspace-ssh')) throw stateError('INTEGRATION_DISABLED', 'workspace-ssh is disabled');
    if (command === 'bridge') return await (await import('./workspace/cli.js')).runBridge(rest, flags);
    if (command === 'companion') return await (await import('./companion/serve.js')).runCompanionServe(rest, flags);
    if (command === 'session') return await (await import('./workspace/sessions.js')).runSession(rest, flags);
    if (command === 'archify') return await (await import('./archify.js')).runArchify(argv.slice(1));
    if (command === 'archify-registry') return await (await import('./archify-registry.js')).runArchifyRegistry(rest, flags);
    // Transitional compatibility handlers remain available; v1 execution and
    // cost commands are integrated in their dedicated work packages.
    const selectedContext = await (await import('./context.js')).loadContext(project, { dbPath: flags.db });
    return await (await import('./legacy-cli.js')).main(argv, { ...deps, selectedContext });
  } catch (error) { return failure(error, flags.json); }
}
// Preserve named lifecycle seams while allowing selected lazy adapters.
export async function repairMawOverlays(project, deps = {}) { return (await import('./core-cli.js')).repairSelectedOverlays(project, deps); }
export async function runUpdateLifecycle(opts = {}, deps = {}) { return (await import('./core-cli.js')).updateLifecycle(opts, deps); }
export async function runUpgradeLifecycle(opts = {}, deps = {}) { return (await import('./core-cli.js')).upgradeLifecycle(opts, deps); }
