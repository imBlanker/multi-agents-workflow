// Candidate and evidence identity validation. This proves reference consistency,
// never the truth of a report or the human identity behind a declared actor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertSafePath, stateError } from './atomic-state.js';
import { comparablePath } from './platform/index.js';
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const git = (root, argv) => { try { return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const EXCLUDED = new Set(['.git', '.mawf', '.trellis', 'node_modules', '.venv', '__pycache__']);
function inside(root, relative) { const target = path.resolve(root, relative); if (target !== root && !target.startsWith(root + path.sep)) throw stateError('CANDIDATE_PATH_ESCAPE', 'Scope/artifact path escapes the candidate'); assertSafePath(path.dirname(target)); return target; }
function inventory(root, scopes) {
  const files = new Map(); let count = 0, bytes = 0;
  function visit(target, explicit = false) {
    const rel = path.relative(root, target).split(path.sep).join('/');
    if (!explicit && rel.split('/').some(name => EXCLUDED.has(name))) return;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) { files.set(rel, { path: rel, kind: 'symlink', sha256: digest(fs.readlinkSync(target)) }); return; }
    if (stat.isDirectory()) { for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name)); return; }
    if (!stat.isFile()) throw stateError('CANDIDATE_SPECIAL_FILE', `Unsupported candidate file ${rel}`);
    if (++count > 50000 || (bytes += stat.size) > 512 * 1024 * 1024) throw stateError('CANDIDATE_TOO_LARGE', 'Narrow scope/artifacts; candidate exceeds bounded snapshot limits');
    files.set(rel, { path: rel, kind: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: digest(fs.readFileSync(target)) });
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !scope || path.isAbsolute(scope)) throw stateError('INVALID_CANDIDATE_SCOPE', 'Use nonempty relative scope paths');
    const target = inside(root, scope);
    if (path.relative(root, target).split(path.sep).some(name => EXCLUDED.has(name))) throw stateError('EXCLUDED_CANDIDATE_SCOPE', 'Runtime/evidence/dependency caches are not product scope');
    visit(target, true);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function candidateIdentity(run, opts = {}) {
  const workspace = fs.realpathSync(path.resolve(opts.workspace || run.snapshot.workspace));
  const scope = [...new Set(opts.scope || ['.'])].sort();
  const artifacts = [...new Set(opts.artifacts || [])].sort();
  const files = inventory(workspace, [...scope, ...artifacts]);
  if (!files.length) throw stateError('EMPTY_CANDIDATE', 'Candidate scope contains no product files');
  const commitSha = git(workspace, ['rev-parse', 'HEAD']);
  const diff = commitSha ? git(workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...scope, ...artifacts]) : null;
  if (commitSha && diff === null) throw stateError('CANDIDATE_DIFF_UNAVAILABLE', 'Cannot hash the dirty candidate diff');
  const identity = { schemaVersion: 1, commitSha, diffHash: digest(diff || ''), contentHash: digest(files), effectiveConfigHash: run.snapshot.effectiveConfigHash, scope, artifacts };
  return { ...identity, candidateId: digest(identity), workspace, files };
}
export function candidateAuthors(run) {
  const authors = new Set();
  for (const task of Object.values(run.tasks)) {
    // Verification status is registered against an already frozen candidate,
    // rather than inferred from an easily relabelled role/model string.
    if (task.verificationTarget || task.coordinationOnly) continue;
    for (const actor of [task.actorId, ...(task.actorIds || []), ...(task.attemptHistory || []).map(item => item.actorId)]) if (actor && actor !== 'unreported') authors.add(actor);
  }
  return [...authors].sort();
}
export function checkCandidateCurrent(run, candidate) {
  const current = candidateIdentity(run, candidate);
  if (current.candidateId !== candidate.candidateId) throw stateError('CANDIDATE_DRIFT', 'Product files, dirty changes, artifacts or effective configuration changed after freezing');
  if (digest(candidateAuthors(run)) !== digest(candidate.implementerActorIds)) throw stateError('CANDIDATE_AUTHOR_DRIFT', 'Author/attempt identity changed; freeze a new candidate with its complete author set');
  return current;
}
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw stateError('INVALID_EVIDENCE', `${field} is required`); }
export function validateEvidence(run, candidate, record, ledger) {
  if (!record || typeof record !== 'object') throw stateError('INVALID_EVIDENCE', 'Evidence must be a JSON object');
  // A real user path has no attempted counterexamples of its own; an omitted list is empty.
  if (record.kind === 'real_user_path' && record.counterexamples === undefined) record = { ...record, counterexamples: [] };
  for (const field of ['requirementId', 'scenarioId', 'hackerActorId', 'hackerTaskId', 'sessionId', 'model', 'adapter', 'expectedBehavior', 'observedBehavior', 'entrypoint', 'enforcementLevel']) requiredString(record[field], field);
  if (!['passed', 'failed', 'blocked', 'unverified'].includes(record.verdict) || !['counterexamples', 'real_user_path'].includes(record.kind)) throw stateError('INVALID_EVIDENCE', 'Evidence needs an explicit verdict and counterexamples/real_user_path kind');
  if (record.runId !== run.runId || record.candidateId !== candidate.candidateId || record.commitSha !== candidate.commitSha || record.diffHash !== candidate.diffHash || record.effectiveConfigHash !== candidate.effectiveConfigHash || record.modeId !== run.snapshot.modeId || record.modeVersion !== run.snapshot.modeVersion || record.configRevision !== run.snapshot.configRevision || digest(record.scope) !== digest(candidate.scope)) throw stateError('EVIDENCE_IDENTITY_MISMATCH', 'Evidence does not describe the exact candidate, configuration, scope and run');
  if (digest([...new Set(record.implementerActorIds || [])].sort()) !== digest(candidate.implementerActorIds)) throw stateError('EVIDENCE_AUTHOR_MISMATCH', 'Evidence omits or changes candidate author identities');
  const task = run.tasks[record.hackerTaskId];
  const lease = task && ledger.leases[task.currentLeaseId];
  if (!task || task.verificationTarget !== candidate.candidateId || task.actorId !== record.hackerActorId || task.attempt !== record.attempt || !lease || lease.status !== 'released' || task.status !== 'produced') throw stateError('UNVERIFIED_HACKER_JOB', 'Evidence requires a completed, released verification job for this exact candidate and actor/attempt');
  if (candidate.implementerActorIds.includes(record.hackerActorId)) throw stateError('AUTHOR_CANNOT_VERIFY', 'An author cannot verify their own candidate, even under another role or model');
  if (lease.hostCompletion && digest(fs.readFileSync(lease.hostCompletion.receiptPath)) !== lease.hostCompletion.sha256) throw stateError('HOST_RECEIPT_DRIFT', 'The bound native tool-return receipt changed');
  const sessionId = lease.sessionId || lease.jobId;
  if (!sessionId || sessionId !== record.sessionId) throw stateError('HACKER_SESSION_MISMATCH', 'Evidence must name the actual bound session/job instance');
  const authorSessions = Object.values(ledger.leases).filter(item => item.runId === run.runId && candidate.implementerActorIds.includes(item.actorId)).flatMap(item => [item.sessionId, item.jobId]).filter(Boolean);
  const reused = Object.values(ledger.leases).some(item => item.leaseId !== lease.leaseId && (item.sessionId || item.jobId) === sessionId);
  if (reused || authorSessions.includes(sessionId)) throw stateError('HACKER_SESSION_REUSED', 'The verification job reused an author session');
  if (record.adapter !== task.adapter || record.model !== (task.adapterState?.actualModel || task.selection?.modelId || 'not_applicable')) throw stateError('HACKER_EXECUTOR_MISMATCH', 'Evidence executor differs from its bound job');
  if (!record.oracleSource || !['user_requirement', 'external_protocol', 'independent_calculation', 'real_observation', 'real_payment'].includes(record.oracleSource.kind)) throw stateError('ORACLE_REQUIRED', 'A meaningful independent oracle is required; source matching, exit code, file existence and HTTP status are only probes');
  requiredString(record.oracleSource.reference, 'oracleSource.reference'); requiredString(record.oracleVersion, 'oracleVersion');
  if (!Array.isArray(record.exactSteps) || !record.exactSteps.length || !record.exactSteps.every(item => typeof item === 'string' && item.trim()) || !record.environment || record.controlledInputs === undefined || !Array.isArray(record.counterexamples) || !Array.isArray(record.scopeLimitations) || !Array.isArray(record.degradations) || !record.costCoverage) throw stateError('INCOMPLETE_EVIDENCE', 'Exact steps, inputs, environment, counterexamples, limits, degradations and cost coverage must be recorded');
  if (record.kind === 'counterexamples' && !record.counterexamples.length) throw stateError('COUNTEREXAMPLES_REQUIRED', 'Counterexample evidence must describe the attempted counterexamples');
  if (!Array.isArray(record.capabilities) || !record.capabilities.length || !record.capabilities.every(item => typeof item === 'string' && item.trim())) throw stateError('CAPABILITY_SCOPE_REQUIRED', 'Name the capabilities covered by this evidence');
  if (record.kind === 'real_user_path' && record.verdict === 'passed' && record.environment.simulated === true) throw stateError('SIMULATED_REAL_PATH', 'A simulated path cannot establish a real user path');
  if (!Array.isArray(record.rawOutputs) || !record.rawOutputs.length) throw stateError('RAW_EVIDENCE_REQUIRED', 'Evidence needs raw output references and hashes');
  const outputs = record.rawOutputs.map(item => {
    if (!item?.path || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw stateError('RAW_EVIDENCE_REQUIRED', 'Each raw output needs its file path and SHA256');
    const absolute = path.resolve(item.path); assertSafePath(absolute);
    const spelled = comparablePath(absolute);
    const mawfData = ['runtime', 'evidence'].some(name => spelled.startsWith(comparablePath(path.join(candidate.workspace, '.mawf', name)) + path.sep));
    if (spelled.startsWith(comparablePath(candidate.workspace) + path.sep) && !mawfData) throw stateError('EVIDENCE_PRODUCT_OVERLAP', 'Independent evidence must be stored outside product scope');
    const bytes = fs.readFileSync(absolute);
    if (!bytes.length || digest(bytes) !== item.sha256) throw stateError('RAW_EVIDENCE_DRIFT', 'Raw output is missing, empty or changed');
    return { path: absolute, sha256: item.sha256 };
  });
  const startedAt = Date.parse(record.timestamps?.startedAt), finishedAt = Date.parse(record.timestamps?.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt || startedAt < Date.parse(candidate.createdAt) || finishedAt > Date.now() + 300000) throw stateError('EVIDENCE_TIME_MISMATCH', 'Evidence must be produced after freezing and have valid timestamps');
  const modelBasis = task.adapter === 'local-process' ? 'not_applicable' : task.adapterState?.actualModel ? 'observed' : 'requested';
  if (record.modelBasis && record.modelBasis !== modelBasis) throw stateError('MODEL_PROVENANCE_MISMATCH', 'Evidence model basis conflicts with backend observation');
  return { ...structuredClone(record), modelBasis, requestedModel: task.selection?.modelId || null, observedModel: task.adapterState?.actualModel || null, observedModelReason: task.adapterState?.actualModel ? null : task.adapter === 'local-process' ? 'non_model_process' : 'backend_did_not_expose_actual_model', rawOutputs: outputs, evidenceId: digest(record), recordedAt: new Date().toISOString(), validationLevel: 'identity_and_reference_consistency_not_semantic_truth' };
}
// A native Hacker declares each final evidence file in its own return text, which
// the host records in the Core-captured receipt. Registration accepts only those
// exact bytes, so a coordinator cannot repair or rewrite independent evidence.
const DECLARED = /MAWF_EVIDENCE\s+([a-f0-9]{64})\s+([^\s`'"]+)/g;
function receiptText(bytes) {
  const strings = [];
  const walk = value => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  for (const line of bytes.toString('utf8').split('\n')) { try { walk(JSON.parse(line)); } catch { strings.push(line); } }
  return strings.join('\n');
}
export function bindDeclaredEvidence(run, record, ledger, inputFile) {
  const task = run.tasks[record?.hackerTaskId], lease = task && ledger.leases[task.currentLeaseId];
  if (task?.adapter !== 'host-managed') return null;
  if (!inputFile || !lease?.hostCompletion?.receiptPath) throw stateError('HACKER_EVIDENCE_UNDECLARED', 'Native Hacker evidence must come from a file declared in its completed host receipt');
  const receipt = fs.readFileSync(lease.hostCompletion.receiptPath);
  if (digest(receipt) !== lease.hostCompletion.sha256) throw stateError('HOST_RECEIPT_DRIFT', 'The bound native tool-return receipt changed');
  const absolute = path.resolve(inputFile), spelled = comparablePath(absolute);
  const declared = [...receiptText(receipt).matchAll(DECLARED)].filter(match => comparablePath(path.resolve(match[2])) === spelled);
  if (!declared.length) throw stateError('HACKER_EVIDENCE_UNDECLARED', 'The Hacker did not declare this evidence file as MAWF_EVIDENCE <sha256> <path> in its return');
  const sha256 = digest(fs.readFileSync(absolute));
  if (!declared.some(match => match[1] === sha256)) throw stateError('HACKER_EVIDENCE_MODIFIED', 'Evidence bytes differ from the hash the Hacker declared; register its original file or dispatch a new Hacker');
  return { path: absolute, sha256, source: 'native_receipt_declaration', receiptSha256: lease.hostCompletion.sha256 };
}
export function acceptanceDecision(run, candidate, ledger) {
  try { checkCandidateCurrent(run, candidate); } catch (error) { return { allowed: false, reasonCode: error.code, reason: error.message }; }
  const policy = run.snapshot.acceptancePolicy || { ...run.snapshot.settings.verification, requiredCapabilities: [] };
  const all = (run.evidence || []).filter(item => item.candidateId === candidate.candidateId);
  const verified = [];
  for (const record of all) {
    try { validateEvidence(run, candidate, record, ledger); verified.push(record); }
    catch (error) { return { allowed: false, reasonCode: error.code, reason: error.message }; }
  }
  if (verified.some(item => item.verdict !== 'passed')) return { allowed: false, reasonCode: 'BLOCKING_COUNTEREXAMPLE', reason: 'Failed, blocked or unverified evidence remains for this candidate' };
  const hackers = [...new Set(verified.map(item => item.hackerActorId))];
  if (hackers.length < policy.minIndependentHackers) return { allowed: false, reasonCode: 'INDEPENDENT_HACKERS_REQUIRED', expected: policy.minIndependentHackers, actual: hackers.length };
  if (policy.requireCounterexamples && !verified.some(item => item.kind === 'counterexamples')) return { allowed: false, reasonCode: 'COUNTEREXAMPLES_REQUIRED' };
  if (policy.requireRealUserPath && !verified.some(item => item.kind === 'real_user_path')) return { allowed: false, reasonCode: 'REAL_USER_PATH_REQUIRED' };
  const capabilities = new Set(verified.flatMap(item => item.capabilities));
  const missing = (policy.requiredCapabilities || []).filter(item => !capabilities.has(item));
  if (missing.length) return { allowed: false, reasonCode: 'CAPABILITY_EVIDENCE_MISSING', missing };
  return { allowed: true, reasonCode: 'ACCEPTANCE_REQUIREMENTS_MET', hackerActorIds: hackers, evidenceIds: verified.map(item => item.evidenceId), validationLevel: 'identity_and_reference_consistency_not_semantic_truth' };
}
