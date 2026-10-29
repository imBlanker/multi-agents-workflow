import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobHelper, spawnWindowsJob, recoverWindowsSandbox, execFile, comparablePath } from './platform/index.js';
import { assertSafePath, writeAtomic } from './atomic-state.js';
import crypto from 'node:crypto';
import net from 'node:net';
import { shellEnvironment } from './windows-native-tools.js';

export function windowsNativePrerequisites() {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(shell)) return { ok: false, reasonCode: 'NATIVE_SANDBOX_UNAVAILABLE', reason: 'Native Windows isolation requires Windows PowerShell' };
  try { jobHelper(); } catch (error) { return { ok: false, reasonCode: 'NATIVE_SANDBOX_UNAVAILABLE', reason: error.message }; }
  return { ok: true, shell: fs.realpathSync.native(shell) };
}
export function prepareWindowsNative({ state, identity, packageRoot, shell, deadlineAt, requestRef }) {
  const workspace = state.task.workspace;
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    let gitRoot = null;
    try { gitRoot = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (gitRoot && comparablePath(gitRoot) !== comparablePath(workspace)) throw new Error('Native Windows workspace must be a Git repository/worktree root or a non-Git directory, not a nested repository subdirectory');
  }
  const controlDirectory = path.join(identity.stateRoot, 'runs', state.task.runId, 'windows');
  assertSafePath(controlDirectory); fs.mkdirSync(controlDirectory, { recursive: true });
  const temp = path.join(workspace, '.mawf', 'windows-temp', state.task.runId);
  assertSafePath(temp); fs.mkdirSync(temp, { recursive: true });
  // Host settings and repository execution hooks must not be editable by a shell.
  const protectedPaths = [path.join(workspace, '.claude'), path.join(workspace, '.git')];
  const createdProtectedDirectories = [], createdProtectedFiles = [];
  const nodePath = fs.realpathSync.native(process.execPath);
  // The broker executes trusted Core outside the sandbox. Its installed paths
  // are not granted to shell commands and need no WRITE_DAC permissions.
  const toolsDirectory = path.join(controlDirectory, 'tools');
  assertSafePath(toolsDirectory); fs.mkdirSync(toolsDirectory, { recursive: true });
  fs.copyFileSync(nodePath, path.join(toolsDirectory, 'node.exe'));
  try {
    for (const file of protectedPaths) {
      assertSafePath(file); if (fs.existsSync(file)) continue;
      if (path.basename(file) === '.git') {
        let gitDir = null;
        try { gitDir = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', workspace, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).trim(); } catch {}
        if (gitDir) throw new Error('Native Windows requires a repository/worktree root or a non-Git directory');
        const contents = '# MAWF temporary protected non-repository marker\n';
        fs.writeFileSync(file, contents, { flag: 'wx' }); createdProtectedFiles.push({ file, contents });
      } else { fs.mkdirSync(file); createdProtectedDirectories.push(file); }
    }
  const readPaths = [toolsDirectory];
  const context = { project: state.run.snapshot.authorityProject, runId: state.task.runId, stateRoot: identity.stateRoot, controllerLeaseId: identity.leaseId };
  const policy = { project: context.project, workspace, stateRoot: identity.stateRoot, runId: state.task.runId, controlDirectory, nodePath, entry: path.join(packageRoot, 'bin', 'mawf.js'), shell, temp, readPaths,
    sealed: [...new Set([identity.stateRoot, ...protectedPaths])], deadlineAt, context, requestRef, createdProtectedDirectories, createdProtectedFiles };
  policy.commandPaths = [toolsDirectory, path.dirname(shell), path.join(process.env.SystemRoot, 'System32')];
  const journalDirectory = path.join(identity.stateRoot, 'windows-acl');
  assertSafePath(journalDirectory); fs.mkdirSync(journalDirectory, { recursive: true });
  policy.sandbox = { read: policy.readPaths, write: [workspace], denyWrite: policy.sealed, journalDirectory };
  policy.recoveryFile = path.join(controlDirectory, 'recovery.json'); writeAtomic(policy.recoveryFile, policy.sandbox);
  const policyFile = path.join(controlDirectory, 'policy.json'); writeAtomic(policyFile, policy);
  const server = fileURLToPath(new URL('./windows-native-server.js', import.meta.url));
  return { policy, mcpConfig: { mcpServers: { mawf_windows: { command: nodePath, args: [server, policyFile] } } } };
  } catch (error) { cleanupWindowsPlaceholders({ createdProtectedDirectories, createdProtectedFiles }); throw error; }
}
function cleanupWindowsPlaceholders(policy) {
  for (const { file, contents } of policy.createdProtectedFiles || []) {
    assertSafePath(file);
    if (!fs.existsSync(file)) continue;
    if (fs.readFileSync(file, 'utf8') !== contents) throw new Error('Temporary Git protection changed; refusing to remove it');
    fs.unlinkSync(file);
  }
  for (const dir of policy.createdProtectedDirectories || []) {
    assertSafePath(dir);
    try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}
export function cleanupWindowsNative(policy) {
  recoverWindowsSandbox(policy.recoveryFile);
  cleanupWindowsPlaceholders(policy);
}
export function windowsNativeArgs({ requestRef, packageRoot, modeId, modelId, mcpConfig }) {
  const instructions = 'Registered native Windows MAWF run. Use mcp__mawf_windows__core for EVERY Core management call, with an args array beginning with run/task and the subcommand (never a shell prefix). Begin with run prepare --host-managed --request-ref ' + requestRef + '. Use mcp__mawf_windows__shell for all reading, writing, editing, searching and tests. Its command is Windows PowerShell syntax inside Windows AppContainer with no network. The workspace uses the mawf: PowerShell drive; use PowerShell file cmdlets with relative paths, or (Get-Location).ProviderPath for .NET paths. Native Bash/PowerShell/Read/Edit/Write tools are intentionally absent. Pass this tool contract to every child Agent. Protected ledger/package/interpreter/.claude/.git paths are read-only. Follow the original role and independent evidence requirements.';
  return ['-p', `/mawf:run --request-ref ${requestRef}`, '--plugin-dir', path.join(packageRoot, 'plugin'), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text', '--include-hook-events', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig), '--tools', 'Agent,TaskOutput,TaskStop', '--allowedTools', 'Agent', 'TaskOutput', 'TaskStop', 'mcp__mawf_windows__core', 'mcp__mawf_windows__shell', '--disallowedTools', 'Bash', 'PowerShell', 'Monitor', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'WebSearch', '--append-system-prompt', instructions, ...(modeId === 'fixed-1' ? ['--agent', 'mawf:mawf-fixed-orchestrator'] : []), '--model', modelId];
}

export async function verifyWindowsBoundary(policy, packageRoot) {
  const nonce = `.mawf-sandbox-canary-${crypto.randomUUID()}`;
  const forbidden = [policy.stateRoot, packageRoot, path.dirname(policy.nodePath), path.join(policy.workspace, '.claude')];
  let connections = 0;
  const listener = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
  const baselineConnections = connections;
  const script = `const fs=require('fs'),net=require('net');const result={denied:true};
    for(const root of ${JSON.stringify(forbidden)}){const p=require('path').join(root,${JSON.stringify(nonce)});try{fs.writeFileSync(p,'probe',{flag:'wx'});result.denied=false;fs.unlinkSync(p);}catch(e){if(!['EACCES','EPERM'].includes(e.code))result.denied=false;}}
    let pending=2;
    for(const [key,host,port] of [['loopback','127.0.0.1',${port}],['external','1.1.1.1',443]]){
      const socket=net.connect({host,port});socket.setTimeout(1500);
      socket.on('connect',()=>{result[key]='connected';socket.destroy();});socket.on('error',e=>{result[key]=e.code;});socket.on('timeout',()=>{result[key]='timeout';socket.destroy();});socket.on('close',()=>{if(--pending===0)console.log(JSON.stringify(result));});
    }`;
  let output;
  try {
    const child = spawnWindowsJob([path.join(policy.commandPaths[0], 'node.exe'), '-e', script], { cwd: policy.workspace, directory: policy.controlDirectory, maxDurationMs: Math.min(30000, policy.deadlineAt - Date.now()), env: shellEnvironment(policy), sandbox: policy.sandbox });
    output = await new Promise((resolve, reject) => {
      let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
  }
  finally { listener.close(); }
  let observed; try { observed = JSON.parse(output.stdout.trim()); } catch {}
  const loopbackBlocked = ['EACCES', 'ETIMEDOUT', 'timeout'].includes(observed?.loopback) && connections === baselineConnections;
  if (output.code !== 0 || observed?.denied !== true || observed?.external !== 'EACCES' || !loopbackBlocked) throw new Error(`Windows sandbox preflight failed: ${JSON.stringify({ code: output.code, observed, stdout: output.stdout.slice(0, 1000), stderr: output.stderr.slice(-1500) })}`);
  return { protectedWritesDenied: true, networkDenied: true, loopbackResult: observed.loopback, loopbackPositiveControl: true, modelCallMade: false };
}
