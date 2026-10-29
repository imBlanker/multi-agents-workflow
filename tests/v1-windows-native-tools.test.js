import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWindowsTool, validateCoreArgs, assertWindowsToolLocations } from '../src/windows-native-tools.js';
import { windowsNativeArgs, prepareWindowsNative, cleanupWindowsNative } from '../src/windows-native.js';
import { execFileSync } from 'node:child_process';

test('Windows native host exposes only broker tools and keeps Core argv scoped', () => {
  const policy = { project: 'project', stateRoot: 'ledger', runId: 'run' };
  assert.throws(() => validateCoreArgs(['task', 'dispatch'], policy));
  assert.throws(() => validateCoreArgs(['run', 'prepare', '--project=other'], policy));
  assert.throws(() => validateCoreArgs(['task', 'status', '--run-id', 'other'], policy));
  for (const flag of ['--request-base64', '-request-base64', '---request-base64', '--request-base64=abc', '--unknown']) {
    assert.throws(() => validateCoreArgs(['run', 'prepare', flag, 'abc'], policy));
  }
  assert.throws(() => validateCoreArgs(['run', 'prepare', '--request-ref', 'other-run'], policy));
  assert.throws(() => validateCoreArgs(['run', 'next', '--json', '--json'], policy));
  assert.equal(validateCoreArgs(['task', 'status'], policy).at(-1), '--json');
  const args = windowsNativeArgs({ requestRef: 'request', packageRoot: 'C:/package', modeId: 'fixed-1', modelId: 'model', mcpConfig: {} });
  assert.equal(args[args.indexOf('--tools') + 1], 'Agent,TaskOutput,TaskStop');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('mcp__mawf_windows__shell'));
  assert.ok(args.includes('mcp__mawf_windows__core'));
});

test('Windows broker runs a real PowerShell command in AppContainer', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-win-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const workspace = path.join(root, 'workspace'), controlDirectory = path.join(root, 'control'), bin = path.join(root, 'tools');
  for (const dir of [workspace, controlDirectory, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'));
  const policy = { workspace, controlDirectory, shell: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), temp: workspace, commandPaths: [bin], deadlineAt: Date.now() + 15000,
    sandbox: { read: [bin], write: [workspace], denyWrite: [controlDirectory, bin], journalDirectory: controlDirectory } };
  const result = await runWindowsTool('shell', { command: `Set-Content -LiteralPath artifact.txt -Value 'native shell' -NoNewline; Set-Content -LiteralPath script.cjs -Value 'console.log(21*2)'; node script.cjs` }, policy);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(workspace, 'artifact.txt')), true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(workspace, 'artifact.txt'), 'utf8'), 'native shell');
  assert.equal(result.stdout.trim(), '42');
  await assert.rejects(runWindowsTool('shell', { command: 'true', cwd: '..' }, policy), /inside/);
});

test('workspace-local TEMP cannot contain privileged Windows helpers', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-win-temp-'));
  const previous = process.env.TEMP;
  t.after(() => { previous === undefined ? delete process.env.TEMP : process.env.TEMP = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.TEMP = root;
  assert.throws(() => assertWindowsToolLocations(root), /outside the writable workspace/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('temporary Git protection preserves an ancestor repository and is removed', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-win-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const repository = path.join(root, 'repo'), workspace = path.join(repository, 'subdir');
  fs.mkdirSync(workspace, { recursive: true });
  const emptyConfig = path.join(root, 'gitconfig'); fs.writeFileSync(emptyConfig, '');
  const git = args => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig } }).trim();
  git(['init', '-q']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const before = git(['-C', workspace, 'rev-parse', 'HEAD']);
  const { policy } = prepareWindowsNative({ state: { task: { workspace, runId: 'run' }, run: { snapshot: { authorityProject: workspace } } }, identity: { stateRoot: path.join(workspace, '.mawf', 'runtime'), leaseId: 'lease' }, packageRoot: root, shell: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), deadlineAt: Date.now() + 10000, requestRef: 'request' });
  assert.equal(git(['-C', workspace, 'rev-parse', 'HEAD']), before);
  cleanupWindowsNative(policy);
  assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.claude')), false);
  assert.equal(git(['-C', workspace, 'rev-parse', 'HEAD']), before);
});
