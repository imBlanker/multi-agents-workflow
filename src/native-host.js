// Claude host capability probe and real headless entrypoint. Account summaries
// are allowlisted; OAuth is not treated as unlimited free usage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findExecutable, execFile } from './platform/index.js';
import { isEnabled } from './integrations.js';
import { processIdentity, stateError, assertSafePath, writeAtomic } from './atomic-state.js';
import { runtimeStatus, acquireTask, claimLocalLaunch, bindJob, heartbeat, recordAdapterState, reportResult, releaseLease, markCancelPending, backendStopped, acceptCandidate, evaluateObservedSelection, recordNativeBilling, settleControlledHostChildren, markLaunchFailed } from './runtime.js';
import { signalKnownBackend } from './local-runtime.js';
import { storeNativeRequest, validateNativeDescription } from './native-request.js';
export function nativeHostCapability(settings, project) {
  const selected = isEnabled(settings, 'host.claude-code');
  const base = { host: 'claude-code', selected, installed: false, authenticated: 'unknown', compatible: 'unknown', ready: false, verificationStatus: 'unverified', actualBillingMode: 'unknown', actualProvider: null };
  if (!selected) return { ...base, reasonCode: 'HOST_NOT_SELECTED' };
  const binary = findExecutable('claude'); if (!binary) return { ...base, reasonCode: 'HOST_UNAVAILABLE' };
  let auth;
  // The platform facade also starts npm's claude.cmd, which Node refuses to spawn directly on Windows.
  try { auth = JSON.parse(execFile(binary, ['auth', 'status', '--json'], { cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })); } catch { return { ...base, binary, installed: true, reasonCode: 'AUTHENTICATION_UNVERIFIED' }; }
  const method = auth.authMethod || auth.method || null;
  const billing = ['claude.ai', 'oauth'].includes(method) ? 'subscription' : ['api_key', 'apiKey', 'api-key'].includes(method) ? 'api' : 'unknown';
  return { ...base, binary, installed: true, authenticated: auth.loggedIn === true, compatible: true, authMethod: method, apiProvider: auth.apiProvider || null, actualProvider: auth.apiProvider === 'firstParty' ? 'anthropic' : null, actualBillingMode: billing, reasonCode: auth.loggedIn ? 'BILLING_AND_MODEL_POLICY_REQUIRED' : 'HOST_NOT_AUTHENTICATED', limitations: ['Authentication does not prove subscription quota or paid usage coverage', 'Existing unrelated host plugins/hooks may load', 'Main orchestrator delegation restriction is policy_only'] };
}
export function enforceNativeBilling(capability, selection) {
  if (capability.authenticated !== true) throw stateError('HOST_AUTHENTICATION_UNVERIFIED', 'Claude is not verified authenticated');
  if (capability.actualBillingMode === 'unknown') throw stateError('BILLING_IDENTITY_UNVERIFIED', 'The current Claude authentication mechanism does not establish billing mode');
  if (selection.billingMode !== capability.actualBillingMode) throw stateError('BILLING_IDENTITY_MISMATCH', 'Requested billing mode differs from the existing Claude account; MAWF will not change account or relabel OAuth as API');
  if (!capability.actualProvider || selection.providerId !== capability.actualProvider) throw stateError('PROVIDER_IDENTITY_UNVERIFIED', 'Requested provider is not proven by the current native host account');
}
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A native session runs every Bash command, its subagents' included, in Claude
// Code's sandbox: no network, no unsandboxed retry, and no writes to the MAWF
// state root or package. Edit deny rules keep the file tools out of both. Only
// Core's own run/task calls leave the sandbox, so Core alone writes the ledger,
// receipts and events, and the session cannot rewrite the Core it runs. The
// boolean keys pin the sandbox's weakening switches against user settings.
export const NATIVE_SANDBOX_TOOLS = Object.freeze(['bwrap', 'socat']);
export function nativeSandboxPolicy({ packageRoot, stateRoot }) {
  const entries = [`${packageRoot}/plugin/../bin/mawf.js`, `${packageRoot}/bin/mawf.js`];
  const core = entries.flatMap(file => ['run', 'task'].flatMap(command => [`node "${file}" ${command} *`, `node '${file}' ${command} *`, `node ${file} ${command} *`]));
  const sealed = [stateRoot, packageRoot];
  return {
    settings: { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, enableWeakerNestedSandbox: false, allowNestedUserNamespaces: false, excludedCommands: core, filesystem: { disabled: false, denyWrite: sealed }, network: { allowAllUnixSockets: false } } },
    // Claude Code checks file tools against Edit(path) rules only; `//` anchors an absolute path.
    disallowedTools: sealed.map(root => `Edit(/${root}/**)`),
  };
}
export function workspaceInsidePackage(workspace, packageRoot = PACKAGE_ROOT) {
  const relative = path.relative(path.resolve(packageRoot), path.resolve(workspace));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function nativeLaunchArgs({ requestRef, packageRoot, stateRoot, modeId, allowedTools, modelId }) {
  const sandbox = nativeSandboxPolicy({ packageRoot, stateRoot });
  return ['-p', `/mawf:run --request-ref ${requestRef}`, '--plugin-dir', path.join(packageRoot, 'plugin'), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--include-hook-events', '--permission-mode', modeId === 'fixed-1' ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--tools', 'default', '--settings', JSON.stringify(sandbox.settings), '--allowedTools', ...allowedTools, '--disallowedTools', ...sandbox.disallowedTools, ...(modeId === 'fixed-1' ? ['--agent', 'mawf:mawf-fixed-orchestrator'] : []), '--model', modelId];
}
export async function executeNative(opts) {
  if (process.platform !== 'linux') return { ok: false, reasonCode: 'NATIVE_PROCESS_CONTROL_UNSUPPORTED', reason: 'This native process-tree controller is verified only for Linux' };
  const missing = NATIVE_SANDBOX_TOOLS.filter(name => !findExecutable(name));
  if (missing.length) return { ok: false, reasonCode: 'NATIVE_SANDBOX_UNAVAILABLE', reason: `Native runs need the Claude Code Bash sandbox, which needs bubblewrap and socat; missing: ${missing.join(', ')}` };
  validateNativeDescription(opts.description || '');
  const state = runtimeStatus(opts), task = state.task;
  if (workspaceInsidePackage(task.workspace)) return { ok: false, reasonCode: 'NATIVE_WORKSPACE_INSIDE_PACKAGE', reason: 'The native sandbox keeps the MAWF package read-only, so the workspace cannot be inside it; run an installed MAWF package outside the workspace' };
  const capability = nativeHostCapability(state.run.snapshot.settings, task.workspace);
  enforceNativeBilling(capability, task.selection);
  recordNativeBilling(opts, capability);
  const reserved = acquireTask({ ...opts, controllerProcess: processIdentity() });
  if (!reserved.allowed || reserved.action !== 'start') return { ...reserved, capability };
  const identity = { ...opts, stateRoot: reserved.stateRoot, leaseId: reserved.leaseId, token: reserved.fencingToken };
  const claim = claimLocalLaunch(identity); if (claim.action !== 'start') return claim;
  const directory = path.join(reserved.stateRoot, 'runs', task.runId, 'native'); assertSafePath(directory); fs.mkdirSync(directory, { recursive: true });
  const deadlineAt = Date.parse(reserved.lease.startedAt) + task.maxDurationMs;
  const requestRef = storeNativeRequest(identity, state, opts.description || '');
  // Slash-command allowed-tools only cover the invoking turn; a background notification starts a new
  // main turn. Re-grant exactly run.md's allowed-tools for the session so later turns match the first.
  const allowedTools = fs.readFileSync(path.join(PACKAGE_ROOT, 'plugin', 'commands', 'run.md'), 'utf8').match(/^allowed-tools:\s*(.+)$/m)?.[1].split(',').map(tool => tool.trim()).filter(Boolean) || [];
  if (!allowedTools.length) throw stateError('NATIVE_COMMAND_TOOLS_MISSING', 'plugin/commands/run.md must declare allowed-tools');
  const argv = nativeLaunchArgs({ requestRef, packageRoot: PACKAGE_ROOT, stateRoot: identity.stateRoot, modeId: state.run.snapshot.modeId, allowedTools, modelId: task.selection.modelId });
  const child = spawn(capability.binary, argv, { cwd: task.workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: { ...process.env, MAWF_NATIVE_RUN_CONTEXT: JSON.stringify({ project: state.run.snapshot.authorityProject, runId: task.runId, stateRoot: identity.stateRoot, controllerLeaseId: identity.leaseId }) } });
  const outputPath = path.join(directory, 'host-events.jsonl');
  let buffer = '', total = 0, interval, deadline, resultEvent = null, mainSessionId = null, cancelling = false;
  const cancel = async () => { if (cancelling) return; cancelling = true; markCancelPending(identity); const lease = runtimeStatus(identity).leases.find(item => item.leaseId === identity.leaseId); signalKnownBackend(lease, 'SIGTERM'); await delay(1000); if (!backendStopped(lease).stopped) signalKnownBackend(lease, 'SIGKILL'); };
  const scrub = value => { if (Array.isArray(value)) return value.filter(item => item?.type !== 'thinking').map(scrub); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['thinking', 'signature', 'apiKey', 'api_key', 'authorization', 'access_token'].includes(key)).map(([key, entry]) => [key, scrub(entry)])); return value; };
  child.stdout.on('data', chunk => {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) { void cancel(); return; }
    buffer += chunk.toString('utf8');
    let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue; let event; try { event = JSON.parse(line); } catch { continue; }
      const clean = scrub(event); fs.appendFileSync(outputPath, JSON.stringify(clean) + '\n', { mode: 0o600 });
      if (event.type === 'system' && event.subtype === 'init') { mainSessionId = event.session_id || null; const selectionGate = evaluateObservedSelection(identity, { modelId: event.model || null, providerId: capability.actualProvider }); if (!selectionGate.allowed) void cancel(); recordAdapterState(identity, { status: 'running', sessionId: mainSessionId, actualModel: event.model || null, actualProvider: capability.actualProvider, selectionGate, capability, transport: 'claude_stream_json', pluginPaths: (event.plugins || []).map(plugin => ({ name: plugin.name, path: plugin.path })), slashCommands: event.slash_commands || [], outputPath }); }
      if (event.type === 'result') resultEvent = clean;
    }
  });
  child.stderr.on('data', chunk => { if (total < 32 * 1024 * 1024) fs.appendFileSync(path.join(directory, 'stderr.log'), chunk.toString().replace(/(?:Bearer\s+|api[_-]?key\s*[:=]\s*)[^\s"']+/gi, '[REDACTED]').slice(0, 8192), { mode: 0o600 }); });
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  child.once('spawn', () => { bindJob({ ...identity, process: processIdentity(child.pid), processGroup: child.pid, jobId: `claude-process:${child.pid}` });
    const keeperFile = path.join(directory, 'deadline.json'); writeAtomic(keeperFile, { identity, deadlineAt });
    const keeper = spawn(process.execPath, [fileURLToPath(new URL('./native-deadline.js', import.meta.url)), keeperFile], { detached: true, stdio: 'ignore' }); keeper.unref();
    recordAdapterState(identity, { deadlineAt: new Date(deadlineAt).toISOString(), deadlineKeeperPid: keeper.pid, deadlineKeeper: 'independent_of_cli_controller' });
    interval = setInterval(() => { try { const lease = runtimeStatus(identity).leases.find(item => item.leaseId === identity.leaseId); if (lease.cancelRequestedAt) void cancel(); else heartbeat(identity); } catch { void cancel(); } }, 1000); deadline = setTimeout(() => { void cancel(); }, Math.max(1, deadlineAt - Date.now())); });
  const exit = await new Promise(resolve => { child.once('error', error => resolve({ code: null, error: error.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearInterval(interval); clearTimeout(deadline); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if (exit.error && !child.pid) return { ...markLaunchFailed({ ...identity, error: { code: 'NATIVE_SPAWN_FAILED', message: exit.error } }), ok: false, produced: false, reasonCode: 'NATIVE_SPAWN_FAILED' };
  if (runtimeStatus(identity).leases.find(item => item.leaseId === identity.leaseId)?.status === 'released') return { ok: false, reasonCode: 'NATIVE_CANCELLED_OR_DEADLINE', outputPath, resourcesReleased: true };
  const produced = exit.code === 0 && resultEvent && resultEvent.is_error !== true;
  reportResult({ ...identity, status: produced ? 'produced' : 'failed', result: { ...exit, outputPath, sessionId: mainSessionId, costCoverage: { basis: 'unknown', amountUsd: null, clientEstimateUsd: resultEvent?.total_cost_usd ?? null, paymentVerified: false }, hostResult: resultEvent, enforcementLevel: 'registered_host_process_and_host_managed_children' } });
  for (let wait = 0; wait < 20 && !backendStopped(runtimeStatus(identity).leases.find(item => item.leaseId === identity.leaseId)).stopped; wait++) await delay(100);
  settleControlledHostChildren({ ...identity, controllerLeaseId: identity.leaseId });
  const released = releaseLease(identity);
  const run = runtimeStatus({ project: opts.project, runId: opts.runId }).run;
  const acceptance = released.ok && run.candidate ? acceptCandidate({ project: opts.project, stateRoot: identity.stateRoot, runId: opts.runId }) : null;
  return { ...released, ...nativeExecutionOutcome({ produced, released, run: runtimeStatus({ project: opts.project, stateRoot: identity.stateRoot, runId: opts.runId }).run, acceptance }), hostSessionId: mainSessionId, outputPath, acceptance, produced: !!produced, capability };
}
export function nativeExecutionOutcome({ produced, released, run, acceptance }) {
  const policy = run.snapshot.acceptancePolicy || run.snapshot.settings.verification;
  const acceptanceRequired = policy.minIndependentHackers > 0 || policy.requireRealUserPath || policy.requireCounterexamples || policy.requiredCapabilities?.length > 0;
  const successful = !!produced && released.ok !== false && !['cancelled', 'failed', 'blocked', 'queued', 'running', 'cancel_pending'].includes(run.status) && (!acceptanceRequired || acceptance?.status === 'accepted');
  return { ok: successful, status: run.status, lifecycleReasonCode: released.reasonCode, reasonCode: run.status === 'cancelled' ? 'NATIVE_CANCELLED' : !produced || run.status === 'failed' ? 'NATIVE_FAILED' : released.ok === false ? released.reasonCode : acceptanceRequired && acceptance?.status !== 'accepted' ? 'ACCEPTANCE_REQUIRED' : acceptance?.status === 'accepted' ? 'ACCEPTED' : 'PRODUCED' };
}
