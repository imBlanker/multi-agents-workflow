// Synchronous, dependency-free persistence shared by configuration and runtime.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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
      if (fs.lstatSync(cursor).isSymbolicLink()) throw stateError('UNSAFE_PATH', `State path contains a symbolic link: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}

export function readStrict(file, fallback) {
  assertSafePath(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
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
    fs.renameSync(temporary, file);
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

export function withLock(root, key, fn, opts = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw stateError('INVALID_LOCK_KEY', 'Lock key must be a plain identifier');
  if (fn?.constructor?.name === 'AsyncFunction') throw stateError('ASYNC_LOCK_CALLBACK', 'withLock requires a synchronous callback');
  assertSafePath(root);
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.${key}.lock`);
  const owner = { ...processIdentity(), token: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try { writeAtomic(path.join(lock, 'owner.json'), owner); }
      catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readStrict(path.join(lock, 'owner.json'), null);
      if (Date.now() >= deadline) throw stateError('STATE_LOCKED', `State lock ${key} is held or its owner cannot be confirmed; state was not changed`);
      if (previous && processAlive(previous) === false) {
        const recovery = path.join(lock, 'recovery');
        try {
          fs.mkdirSync(recovery);
          const current = readStrict(path.join(lock, 'owner.json'), null);
          if (current?.token === previous.token && processAlive(current) === false) fs.rmSync(lock, { recursive: true, force: true });
          else fs.rmdirSync(recovery);
        } catch (recoveryError) { if (!['EEXIST', 'ENOENT'].includes(recoveryError.code)) throw recoveryError; }
        continue;
      }
      if (Date.now() >= deadline) throw stateError('STATE_LOCKED', `State lock ${key} is held or its owner cannot be confirmed; state was not changed`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw stateError('ASYNC_LOCK_CALLBACK', 'withLock requires a synchronous callback');
    return result;
  } finally {
    const current = readStrict(path.join(lock, 'owner.json'), null);
    if (current?.token === owner.token) fs.rmSync(lock, { recursive: true, force: true });
  }
}
