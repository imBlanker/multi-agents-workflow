import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { nativeInvocation } from './windows.js';

const source = fileURLToPath(new URL('./windows-job.cs', import.meta.url));
const sandboxSource = fileURLToPath(new URL('./windows-sandbox.cs', import.meta.url));
let binary;
let selfIdentity;
const launches = new WeakMap();
function invoke(args) {
  const result = spawnSync(jobHelper(), args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr?.trim() || 'Windows process observation failed');
  return result.stdout.trim();
}
export function jobHelper() {
  if (process.platform !== 'win32') throw new Error('Windows helper requires Windows');
  if (binary && fs.existsSync(binary)) return binary;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-windows-helper-'));
  // Helpers are never compiled into the product/workspace being executed.
  fs.mkdirSync(directory, { recursive: true });
  // Compile a private image each process, avoiding trust in a shared cached binary.
  const temporary = path.join(directory, `windows-job-${process.pid}-${crypto.randomUUID()}.exe`);
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${temporary}`, source, sandboxSource], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(`Windows helper compilation failed: ${result.stdout} ${result.stderr}`);
  binary = temporary;
  process.once('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); } catch {} });
  return binary;
}
export function windowsStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && selfIdentity) return selfIdentity;
  try { const value = invoke(['identity', String(pid)]); if (!/^\d+$/.test(value)) return null; if (pid === process.pid) selfIdentity = value; return value; } catch { return null; }
}
export function spawnWindowsJob(command, { cwd, directory, maxDurationMs, env = process.env, sandbox }) {
  const helper = jobHelper();
  const parentStart = windowsStartIdentity(process.pid);
  if (!parentStart) throw new Error('Windows controller start identity unavailable');
  const jobName = `Local\\mawf-${crypto.randomUUID()}`;
  const request = path.join(directory, `job-${crypto.randomUUID()}.json`);
  const invocation = nativeInvocation(command[0], command.slice(1));
  fs.writeFileSync(request, JSON.stringify({ command: invocation, cwd, jobName, parentPid: process.pid, parentStart, deadlineUnixMs: Date.now() + maxDurationMs, ...(sandbox ? { sandbox, childEnv: env } : {}) }), { flag: 'wx' });
  const child = spawn(helper, ['run', request], { cwd, env: sandbox ? process.env : env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  launches.set(child, { command: [...command], jobName });
  child.once('close', () => { try { fs.unlinkSync(request); } catch {} });
  return child;
}
export function windowsLaunch(child) { return launches.get(child); }
export function recoverWindowsSandbox(policyFile) { invoke(['recover', policyFile]); }
export function windowsJobStopped(lease) {
  if (!lease.windowsJob || !lease.ownerProcess) return { stopped: false, reason: 'No Windows Job Object binding' };
  try {
    const count = invoke(['query', lease.windowsJob, String(lease.ownerProcess.pid), lease.ownerProcess.startIdentity || '']);
    return { stopped: count === '0', active: /^\d+$/.test(count) && Number(count) > 0, reason: count === '0' ? 'Windows Job Object has no remaining processes' : 'Windows Job Object is active' };
  } catch { return { stopped: false, reason: 'Windows Job Object state could not be verified' }; }
}
export function stopWindowsJob(lease) {
  if (!lease.windowsJob || !lease.ownerProcess?.startIdentity) return { sent: false, reason: 'No Windows Job Object binding' };
  try { invoke(['stop', lease.windowsJob, String(lease.ownerProcess.pid), lease.ownerProcess.startIdentity]); return { sent: true, signal: 'TerminateJobObject' }; }
  catch (error) { return { sent: false, reason: error.message }; }
}
