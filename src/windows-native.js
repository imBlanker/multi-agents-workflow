import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobHelper } from './platform/windows-process.js';
import { assertSafePath, writeAtomic } from './atomic-state.js';

export function windowsNativePrerequisites() {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(shell)) return { ok: false, reasonCode: 'NATIVE_SANDBOX_UNAVAILABLE', reason: 'Native Windows isolation requires Windows PowerShell' };
  try { jobHelper(); } catch (error) { return { ok: false, reasonCode: 'NATIVE_SANDBOX_UNAVAILABLE', reason: error.message }; }
  return { ok: true, shell: fs.realpathSync.native(shell) };
}
export function prepareWindowsNative({ state, identity, packageRoot, shell, deadlineAt }) {
  const workspace = state.task.workspace;
  const controlDirectory = path.join(identity.stateRoot, 'runs', state.task.runId, 'windows');
  assertSafePath(controlDirectory); fs.mkdirSync(controlDirectory, { recursive: true });
  const temp = path.join(workspace, '.mawf', 'windows-temp', state.task.runId);
  assertSafePath(temp); fs.mkdirSync(temp, { recursive: true });
  // Host settings and repository execution hooks must not be editable by a shell.
  const protectedPaths = [path.join(workspace, '.claude')];
  if (fs.existsSync(path.join(workspace, '.git')) && fs.statSync(path.join(workspace, '.git')).isDirectory()) protectedPaths.push(path.join(workspace, '.git'));
  for (const dir of protectedPaths) { assertSafePath(dir); fs.mkdirSync(dir, { recursive: true }); }
  const nodePath = fs.realpathSync.native(process.execPath);
  const readPaths = [...new Set([path.dirname(nodePath), packageRoot])];
  const context = { project: state.run.snapshot.authorityProject, runId: state.task.runId, stateRoot: identity.stateRoot, controllerLeaseId: identity.leaseId };
  const policy = { project: context.project, workspace, stateRoot: identity.stateRoot, runId: state.task.runId, controlDirectory, nodePath, entry: path.join(packageRoot, 'bin', 'mawf.js'), shell, temp, readPaths,
    sealed: [...new Set([identity.stateRoot, packageRoot, path.dirname(nodePath), ...protectedPaths])], deadlineAt, context };
  policy.commandPaths = [path.dirname(nodePath), path.dirname(shell), path.join(process.env.SystemRoot, 'System32')];
  const journalDirectory = path.join(identity.stateRoot, 'windows-acl');
  assertSafePath(journalDirectory); fs.mkdirSync(journalDirectory, { recursive: true });
  policy.sandbox = { read: policy.readPaths, write: [workspace, temp], denyWrite: policy.sealed, journalDirectory };
  policy.recoveryFile = path.join(controlDirectory, 'recovery.json'); writeAtomic(policy.recoveryFile, policy.sandbox);
  const policyFile = path.join(controlDirectory, 'policy.json'); writeAtomic(policyFile, policy);
  const server = fileURLToPath(new URL('./windows-native-server.js', import.meta.url));
  return { policy, mcpConfig: { mcpServers: { mawf_windows: { command: nodePath, args: [server, policyFile] } } } };
}
export function windowsNativeArgs({ requestRef, packageRoot, modeId, modelId, mcpConfig }) {
  const instructions = 'Registered native Windows MAWF run. Use mcp__mawf_windows__core for EVERY Core management call, with an args array beginning with run/task and the subcommand (never a shell prefix). Begin with run prepare --host-managed --request-ref ' + requestRef + '. Use mcp__mawf_windows__shell for all reading, writing, editing, searching and tests. Its command is Windows PowerShell syntax inside Windows AppContainer with no network. The workspace is mounted as mawf:\; use PowerShell file cmdlets with relative paths, or (Get-Location).ProviderPath for .NET paths. Native Bash/PowerShell/Read/Edit/Write tools are intentionally absent. Pass this tool contract to every child Agent. Protected ledger/package/interpreter/.claude/.git paths are read-only. Follow the original role and independent evidence requirements.';
  return ['-p', `/mawf:run --request-ref ${requestRef}`, '--plugin-dir', path.join(packageRoot, 'plugin'), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--include-hook-events', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig), '--tools', 'Agent,TaskOutput,TaskStop', '--allowedTools', 'Agent', 'TaskOutput', 'TaskStop', 'mcp__mawf_windows__core', 'mcp__mawf_windows__shell', '--disallowedTools', 'Bash', 'PowerShell', 'Monitor', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'WebSearch', '--append-system-prompt', instructions, ...(modeId === 'fixed-1' ? ['--agent', 'mawf:mawf-fixed-orchestrator'] : []), '--model', modelId];
}
