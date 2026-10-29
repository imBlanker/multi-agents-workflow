// Capture an observed Claude completion event without asking the model to
// reconstruct a receipt. Other host schemas still use explicit receipt files.
import fs from 'node:fs';
import path from 'node:path';
import { assertSafePath, stateError } from './atomic-state.js';

export function captureNativeReceipt({ stateRoot, runId, lease, controller }) {
  const missing = message => stateError('NATIVE_RECEIPT_UNAVAILABLE', message);
  if (!lease.jobId || !lease.hostLaunch?.toolUseId || !lease.hostLaunch?.hostSessionId
    || controller?.adapter !== 'claude-native' || controller.currentLeaseId !== lease.controllerLeaseId) throw missing('A bound native Agent and its original controller are required');
  const directory = assertSafePath(path.join(stateRoot, 'runs', runId, 'native'));
  const source = path.join(directory, 'host-events.jsonl');
  if (controller.adapterState?.outputPath !== source) throw missing('No registered native event stream for this controller');
  assertSafePath(source);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd), limit = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw missing('Native event stream must be a bounded regular file');
    const buffer = Buffer.alloc(limit + 1); let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > limit) throw missing('Native event stream exceeds its size limit');
    bytes = buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
  const matches = [];
  // Ignore an unfinished final line while the registered host is still writing.
  const lines = bytes.toString('utf8').split('\n'); lines.pop();
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'task_notification' && event.status === 'completed'
      && event.task_id === lease.jobId && event.tool_use_id === lease.hostLaunch.toolUseId
      && event.session_id === lease.hostLaunch.hostSessionId) matches.push(line + '\n');
  }
  if (!matches.length || new Set(matches).size !== 1) throw missing('Wait for one unambiguous completed native Agent event matching job/tool/session identities');
  const raw = matches[0];
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw missing('Native completion receipt exceeds its size limit');
  const file = assertSafePath(path.join(directory, 'receipts', `${lease.leaseId}.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let output;
  try { output = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.readFileSync(assertSafePath(file), 'utf8') !== raw) throw missing('Existing receipt differs from the native completion event');
    return file;
  }
  try { fs.writeFileSync(output, raw); fs.fsyncSync(output); }
  finally { fs.closeSync(output); }
  return file;
}
