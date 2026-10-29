// Explicit native-Windows tool boundary: the host has no direct shell/file tools.
// Model commands enter AppContainer; only named Core management argv leave it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { spawnWindowsJob, jobHelper } from './platform/index.js';
import { comparablePath } from './platform/index.js';

export const CORE_ACTIONS = new Set(['run prepare', 'run queue', 'run next', 'run respec', 'task bind', 'task heartbeat', 'task result', 'task host-complete', 'task candidate', 'task evidence', 'task accept', 'task acceptance', 'task status', 'task list']);
const within = (root, file) => { const r = comparablePath(root), f = comparablePath(file); return f === r || f.startsWith(r + path.sep); };
export function assertWindowsToolLocations(workspace) {
  if (within(workspace, os.tmpdir()) || within(workspace, path.dirname(jobHelper()))) throw new Error('Native Windows TEMP and privileged helper storage must be outside the writable workspace');
}
export function validateCoreArgs(args, policy) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !CORE_ACTIONS.has(args.slice(0, 2).join(' '))) throw new Error('Only named Core management operations are allowed');
  const flags = new Set(['project', 'state-root', 'run-id', 'json', 'task-id', 'lease-id', 'token', 'actor-id', 'attempt', 'job-id', 'session-id', 'resolved-model', 'progress', 'waiting-external', 'status', 'result-json', 'native-receipt', 'workspace', 'scope-json', 'artifacts-json', 'input', 'request-ref', 'host-managed']);
  const booleans = new Set(['json', 'waiting-external', 'native-receipt', 'host-managed']);
  const seen = new Set(), normalized = args.slice(0, 2);
  for (let i = 2; i < args.length; i++) {
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(args[i]);
    if (!match || !flags.has(match[1]) || seen.has(match[1])) throw new Error('Unknown, alternate or duplicate Core flag');
    const key = match[1]; seen.add(key);
    if (booleans.has(key)) { if (match[2] !== undefined) throw new Error('Boolean flags take no value'); normalized.push(`--${key}`); continue; }
    const value = match[2] ?? args[++i];
    if (value === undefined || value.startsWith('-')) throw new Error('Core flag requires a literal value');
    const expected = { project: policy.project, 'state-root': policy.stateRoot, 'run-id': policy.runId, 'request-ref': policy.requestRef };
    if (Object.hasOwn(expected, key) && value !== expected[key]) throw new Error('Core calls must target this registered run');
    if (['input', 'workspace'].includes(key) && !within(policy.workspace, path.resolve(policy.workspace, value))) throw new Error('Core file paths must remain inside the run workspace');
    if (!['project', 'state-root', 'run-id'].includes(key)) normalized.push(`--${key}`, value);
  }
  return [...normalized, '--project', policy.project, '--state-root', policy.stateRoot, '--run-id', policy.runId, ...(seen.has('json') ? [] : ['--json'])];
}
export function shellEnvironment(policy) {
  const env = {};
  const onDisk = value => path.isAbsolute(value) && fs.existsSync(value) ? fs.realpathSync.native(value) : value;
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = onDisk(process.env[key]);
  // PowerShell inside AppContainer cannot expand 8.3 aliases through ancestors
  // it cannot read. Resolve all paths in the trusted parent before launch.
  return { ...env, HOME: onDisk(policy.workspace), TEMP: onDisk(policy.temp), TMP: onDisk(policy.temp), PATH: policy.commandPaths.map(onDisk).join(path.delimiter), NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main' };
}
function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', bytes = 0;
    const capture = channel => chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return;
      if (channel === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', capture('out')); child.stderr.on('data', capture('err'));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, truncated: bytes > 8 * 1024 * 1024 }));
  });
}
export async function runWindowsTool(name, input, policy) {
  assertWindowsToolLocations(policy.workspace);
  if (name === 'core') {
    const args = validateCoreArgs(input.args, policy);
    return collect(spawn(policy.nodePath, [policy.entry, ...args], { cwd: policy.workspace, env: { ...process.env, MAWF_NATIVE_RUN_CONTEXT: JSON.stringify(policy.context) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }));
  }
  if (name !== 'shell' || typeof input.command !== 'string' || !input.command || input.command.length > 65536 || input.command.includes('\0')) throw new Error('Invalid Windows shell input');
  const cwd = fs.realpathSync.native(path.resolve(policy.workspace, input.cwd || '.'));
  if (!within(policy.workspace, cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Shell cwd must remain inside the run workspace');
  const maxDurationMs = Math.min(120000, policy.deadlineAt - Date.now());
  if (maxDurationMs <= 0) throw new Error('Native run deadline expired');
  const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); New-PSDrive -Name mawf -PSProvider FileSystem -Root $env:MAWF_SHELL_CWD | Out-Null; Set-Location mawf:\\; ";
  return collect(spawnWindowsJob([policy.shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(prelude + input.command, 'utf16le').toString('base64')], {
    cwd, directory: policy.controlDirectory, maxDurationMs, env: { ...shellEnvironment(policy), MAWF_SHELL_CWD: cwd },
    sandbox: policy.sandbox,
  }));
}

export const WINDOWS_TOOLS = [
  { name: 'core', description: 'Run a named MAWF Core management operation with an argv array, starting with run/task and the subcommand. No shell syntax. The current project/run/state root are enforced.', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'], additionalProperties: false } },
  { name: 'shell', description: 'Run a PowerShell command inside native Windows AppContainer with no network. Use this for reading, writing, editing and testing workspace files. The ledger, MAWF package and interpreters are read-only. cwd is workspace-relative.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'], additionalProperties: false } },
];
