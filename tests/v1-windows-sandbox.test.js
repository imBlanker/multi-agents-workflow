import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnWindowsJob, recoverWindowsSandbox, windowsStartIdentity } from '../src/platform/windows-process.js';

test('native AppContainer permits workspace writes and denies sealed writes and outbound sockets', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-appcontainer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const workspace = path.join(root, 'workspace'), sealed = path.join(workspace, 'ledger'), bin = path.join(root, 'bin'), control = path.join(root, 'control');
  for (const dir of [workspace, sealed, bin, control]) fs.mkdirSync(dir, { recursive: true });
  const node = path.join(bin, 'node.exe'); fs.copyFileSync(process.execPath, node);
  const source = `const fs=require('fs'),net=require('net');
    const result={};
    for(const [key,target] of Object.entries(${JSON.stringify({ allowed: path.join(workspace, 'ok'), sealed: path.join(sealed, 'no'), interpreter: path.join(bin, 'no'), outside: path.join(control, 'no') })})) {
      try { fs.writeFileSync(target,'test');result[key]='wrote'; } catch(e) { result[key]=e.code; }
    }
    const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(2000);
    socket.on('connect',()=>{result.network='connected';socket.destroy();});
    socket.on('error',e=>{result.network=e.code;});socket.on('timeout',()=>{result.network='timeout';socket.destroy();});
    socket.on('close',()=>console.log(JSON.stringify(result)));`;
  const child = spawnWindowsJob([node, '-e', source], { cwd: workspace, directory: control, maxDurationMs: 10000,
    sandbox: { read: [bin], write: [workspace], denyWrite: [sealed, bin], journalDirectory: control }, env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: bin, TEMP: workspace, TMP: workspace } });
  let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, error); const result = JSON.parse(output);
  assert.equal(result.allowed, 'wrote');
  for (const key of ['sealed', 'interpreter', 'outside']) assert.notEqual(result[key], 'wrote', JSON.stringify({ key, result, actualSealedWrite: fs.existsSync(path.join(sealed, 'no')) }));
  assert.equal(result.network, 'EACCES');
  assert.equal(fs.existsSync(path.join(sealed, 'no')), false);
});

test('interrupted AppContainer helper leaves a recoverable ACL journal and no child', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-appcontainer-recover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const workspace = path.join(root, 'workspace'), sealed = path.join(workspace, 'ledger'), bin = path.join(root, 'bin'), control = path.join(root, 'control');
  for (const dir of [workspace, sealed, bin, control]) fs.mkdirSync(dir, { recursive: true });
  const node = path.join(bin, 'node.exe'); fs.copyFileSync(process.execPath, node);
  const policy = { read: [bin], write: [workspace], denyWrite: [sealed, bin], journalDirectory: control };
  const recovery = path.join(control, 'recovery.json'); fs.writeFileSync(recovery, JSON.stringify(policy));
  const sddl = dir => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[IO.Directory]::GetAccessControl($env:MAWF_ACL_PATH).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MAWF_ACL_PATH: dir } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const before = [sddl(workspace), sddl(sealed), sddl(bin)];
  const env = Object.fromEntries(['SystemRoot', 'SystemDrive', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].map(key => [key, process.env[key]]));
  const child = spawnWindowsJob([node, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], { cwd: workspace, directory: control, maxDurationMs: 10000, sandbox: policy, env });
  const closed = once(child, 'close'); let output = ''; child.stdout.on('data', b => output += b);
  for (let i=0; !output.trim() && child.exitCode === null && i<100; i++) await delay(50);
  assert.match(output.trim(), /^\d+$/);
  child.kill('SIGKILL'); await closed;
  recoverWindowsSandbox(recovery);
  assert.deepEqual([sddl(workspace), sddl(sealed), sddl(bin)], before);
  assert.equal(windowsStartIdentity(Number(output.trim())), null);
  assert.deepEqual(fs.readdirSync(control).filter(name => name.endsWith('.acl.json')), []);
});
