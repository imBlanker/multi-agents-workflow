import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWindowsTool, validateCoreArgs } from '../src/windows-native-tools.js';
import { windowsNativeArgs } from '../src/windows-native.js';

test('Windows native host exposes only broker tools and keeps Core argv scoped', () => {
  const policy = { project: 'project', stateRoot: 'ledger', runId: 'run' };
  assert.throws(() => validateCoreArgs(['task', 'dispatch'], policy));
  assert.throws(() => validateCoreArgs(['run', 'prepare', '--project=other'], policy));
  assert.throws(() => validateCoreArgs(['task', 'status', '--run-id', 'other'], policy));
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
  const workspace = path.join(root, 'workspace'), controlDirectory = path.join(root, 'control'), bin = path.join(root, 'git', 'usr', 'bin');
  for (const dir of [workspace, controlDirectory, bin]) fs.mkdirSync(dir, { recursive: true });
  const policy = { workspace, controlDirectory, shell: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), temp: workspace, commandPaths: [bin], deadlineAt: Date.now() + 15000,
    sandbox: { read: [path.join(root, 'git')], write: [workspace], denyWrite: [controlDirectory, bin], journalDirectory: controlDirectory } };
  const result = await runWindowsTool('shell', { command: `Set-Content -LiteralPath artifact.txt -Value 'native shell' -NoNewline; [Console]::Write('done')` }, policy);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(workspace, 'artifact.txt')), true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(workspace, 'artifact.txt'), 'utf8'), 'native shell');
  assert.equal(result.stdout, 'done');
  await assert.rejects(runWindowsTool('shell', { command: 'true', cwd: '..' }, policy), /inside/);
});
