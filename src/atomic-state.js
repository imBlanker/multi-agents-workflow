// Synchronous, dependency-free persistence shared by configuration and runtime.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { retryTransient } from './platform/index.js';
import { windowsStartIdentity } from './platform/index.js';

export function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function processIdentity(pid = process.pid) {
  let startIdentity = null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      startIdentity = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {}
  }
  if (process.platform === 'win32') startIdentity = windowsStartIdentity(pid);
  return { pid, startIdentity, hostname: os.hostname(), platform: process.platform };
}

// null means ownership cannot safely be resolved; callers must retain the slot.
export function processAlive(identity) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.hostname !== os.hostname()) return null;
  try { process.kill(identity.pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
  const current = processIdentity(identity.pid);
  if (identity.startIdentity && current.startIdentity) return identity.startIdentity === current.startIdentity;
  return null;
}

export function assertSafePath(file) {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (retryTransient(() => fs.lstatSync(cursor)).isSymbolicLink()) throw stateError('UNSAFE_PATH', `State path contains a symbolic link: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}

export function readStrict(file, fallback) {
  assertSafePath(file);
  try { return JSON.parse(retryTransient(() => fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : fallback;
    if (error instanceof SyntaxError) throw stateError('INVALID_STATE', `Invalid JSON in ${file}: ${error.message}`);
    throw error;
  }
}

export function writeAtomic(file, value) {
  assertSafePath(file);
  const serialized = JSON.stringify(value, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertSafePath(file);
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    assertSafePath(file);
    retryTransient(() => fs.renameSync(temporary, file));
    // Windows does not support fsync on directories; rename remains atomic.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return value;
}

// Lamport bakery protocol with atomic, complete per-contender claims. Claims
// are never reused, so dead-owner reclamation cannot unlink a newer owner.
export function withLock(root, key, fn, opts = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw stateError('INVALID_LOCK_KEY', 'Lock key must be a plain identifier');
  if (fn?.constructor?.name === 'AsyncFunction') throw stateError('ASYNC_LOCK_CALLBACK', 'withLock requires a synchronous callback');
  const timeout = opts.timeoutMs ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 0) throw stateError('INVALID_LOCK_TIMEOUT', 'Lock timeout must be finite and nonnegative');
  assertSafePath(root);
  fs.mkdirSync(root, { recursive: true });
  const token = crypto.randomUUID();
  const prefix = `.${key}.claim-`;
  const claimPath = path.join(root, `${prefix}${token}.json`);
  const claim = { ...processIdentity(), token, phase: 'choosing', ticket: null, acquiredAt: new Date().toISOString() };
  const deadline = Date.now() + timeout;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
  function claims() {
    const result = [];
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(prefix) || !uuid.test(name.slice(prefix.length))) continue;
      const file = path.join(root, name);
      const other = readStrict(file, undefined);
      if (other === undefined) continue; // A concurrent release is normal.
      if (!other || typeof other !== 'object' || other.token !== name.slice(prefix.length, -5)
        || !Number.isSafeInteger(other.pid) || other.pid <= 0 || typeof other.hostname !== 'string'
        || !['choosing', 'waiting'].includes(other.phase)
        || (other.phase === 'waiting' && (!Number.isSafeInteger(other.ticket) || other.ticket < 1))
        || (other.phase === 'choosing' && other.ticket !== null)) {
        throw stateError('INVALID_STATE', `Invalid lock claim: ${file}`);
      }
      if (other.token !== token && processAlive(other) === false) {
        // A UUID claim names one process incarnation forever. Multiple readers
        // may remove this same dead claim; none can remove another incarnation.
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      result.push(other);
    }
    return result;
  }
  try {
    // writeAtomic's temporary filename is not a public claim. A crash before
    // publication leaves no ownerless claim; a crash afterward leaves identity.
    writeAtomic(claimPath, claim);
    const maximum = claims().reduce((max, other) => Math.max(max, other.ticket ?? 0), 0);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw stateError('LOCK_TICKET_OVERFLOW', 'Cannot allocate another safe lock ticket');
    claim.ticket = maximum + 1;
    claim.phase = 'waiting';
    writeAtomic(claimPath, claim);
    while (true) {
      const preceding = claims().some(other => other.token !== token && (
        other.phase === 'choosing' || other.ticket < claim.ticket ||
        (other.ticket === claim.ticket && other.token < token)
      ));
      if (!preceding) break;
      if (Date.now() >= deadline) throw stateError('STATE_LOCKED', `State lock ${key} is held or an earlier contender cannot be confirmed; state was not changed`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const result = fn();
    if (result && typeof result.then === 'function') throw stateError('ASYNC_LOCK_CALLBACK', 'withLock requires a synchronous callback');
    return result;
  } finally {
    // Only our never-reused claim is released, even after validation/timeout.
    try { retryTransient(() => fs.unlinkSync(claimPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
