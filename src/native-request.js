// Short, run-scoped transport for the native Slash handshake. This is an
// integrity/identity check in shared runtime storage, not an OS trust boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertSafePath, stateError, writeAtomic } from './atomic-state.js';
import { runtimeStatus, recordAdapterState } from './runtime.js';

const MAX_BYTES = 256 * 1024;
const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => stateError('INVALID_NATIVE_REQUEST', message);
function validateRequest(request) {
  const fields = ['schemaVersion', 'requestRef', 'runId', 'project', 'stateRoot', 'nativeControllerTaskId', 'controllerLeaseId', 'task'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.schemaVersion !== 1
    || Object.keys(request).some(key => !fields.includes(key))
    || !fields.slice(1).every(key => typeof request[key] === 'string')
    || !referencePattern.test(request.requestRef)
    || !['runId', 'nativeControllerTaskId', 'controllerLeaseId'].every(key => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(request[key]))
    || !path.isAbsolute(request.project) || !path.isAbsolute(request.stateRoot)
    || Buffer.byteLength(JSON.stringify(request, null, 2)) + 1 > MAX_BYTES) throw invalid('Expected a bounded schemaVersion 1 native request');
  return request;
}
function requestPath(root, runId, ref) {
  return assertSafePath(path.join(root, 'runs', runId, 'native', `request-${ref}.json`));
}
export function validateNativeDescription(description) {
  if (typeof description !== 'string' || Buffer.byteLength(description) > MAX_BYTES / 2 || Buffer.byteLength(JSON.stringify(description)) > MAX_BYTES - 4096) throw invalid('Native task text must be a string of at most 128 KiB');
}
export function storeNativeRequest(identity, state, description) {
  validateNativeDescription(description);
  const request = validateRequest({ schemaVersion: 1, requestRef: crypto.randomUUID(), runId: state.run.runId,
    project: state.run.snapshot.authorityProject, stateRoot: identity.stateRoot,
    nativeControllerTaskId: state.task.taskId, controllerLeaseId: identity.leaseId, task: description });
  const file = requestPath(request.stateRoot, request.runId, request.requestRef);
  writeAtomic(file, request);
  recordAdapterState(identity, { nativeRequest: { ref: request.requestRef, sha256: digest(fs.readFileSync(file)) } });
  return request.requestRef;
}
export function readNativeRequest(ref, flags, contextText = process.env.MAWF_NATIVE_RUN_CONTEXT) {
  if (typeof ref !== 'string' || !referencePattern.test(ref)) throw invalid('Native request reference must be a UUID');
  let context;
  try { context = JSON.parse(contextText); } catch { throw invalid('A registered native run context is required'); }
  if (!context || typeof context !== 'object' || !['project', 'stateRoot', 'runId', 'controllerLeaseId'].every(key => typeof context[key] === 'string' && context[key])
    || !path.isAbsolute(context.project) || !path.isAbsolute(context.stateRoot)) throw invalid('Invalid native run context');
  const state = runtimeStatus(context);
  const lease = state.leases.find(item => item.leaseId === context.controllerLeaseId);
  const controller = lease && state.run?.tasks[lease.taskId];
  if (!controller || controller.adapter !== 'claude-native' || !controller.coordinationOnly
    || controller.currentLeaseId !== lease.leaseId || lease.status !== 'running' || lease.cancelRequestedAt
    || state.run.snapshot.authorityProject !== context.project || state.stateRoot !== context.stateRoot
    || controller.adapterState?.nativeRequest?.ref !== ref) throw invalid('Request must belong to the current running native controller');
  const file = requestPath(state.stateRoot, state.run.runId, ref);
  // Open without following links and bound the read even if the file grows.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw invalid('Native request must be a regular file of at most 256 KiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > MAX_BYTES) throw invalid('Native request exceeds 256 KiB');
    bytes = buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
  if (digest(bytes) !== controller.adapterState.nativeRequest.sha256) throw invalid('Native request content differs from the registered controller request');
  let request;
  try { request = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('Native request is not valid JSON'); }
  validateRequest(request);
  if (request.requestRef !== ref || request.runId !== state.run.runId || request.project !== context.project
    || request.stateRoot !== state.stateRoot || request.nativeControllerTaskId !== controller.taskId
    || request.controllerLeaseId !== lease.leaseId) throw invalid('Native request identity does not match its run/controller/lease');
  if (flags.task !== undefined || flags['request-base64'] !== undefined
    || flags['run-id'] !== undefined && flags['run-id'] !== request.runId
    || flags.project !== undefined && path.resolve(flags.project) !== request.project
    || flags['state-root'] !== undefined && path.resolve(flags['state-root']) !== request.stateRoot) throw invalid('Do not override a registered native request');
  return request;
}
