import { stateError } from './atomic-state.js';
import { candidateAuthors } from './verification.js';

// Apply the frozen fixed-role policy before queue validation and persistence.
// Dynamic custom roles retain their existing meaning unless explicitly verifying.
export function normalizeQueueTask(run, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw stateError('INVALID_RUN_SPEC', 'Each queued task must be an object');
  const item = { ...input };
  if (item.writesProduct !== undefined && typeof item.writesProduct !== 'boolean') throw stateError('INVALID_WRITES_PRODUCT', `${item.taskId}: writesProduct must be boolean when supplied`);
  const fixedHacker = run.snapshot.modeId === 'fixed-1' && /^hacker(?:-\d+)?$/.test(item.role || '');
  const explicitVerification = item.verificationOf !== undefined;
  if (!fixedHacker && !explicitVerification) return item;
  if (item.writesProduct === true) throw stateError('VERIFICATION_PRODUCT_WRITE_FORBIDDEN', `${item.taskId}: verification tasks cannot write product files; writesProduct must be false or omitted`);
  if (!run.candidate) throw stateError('CANDIDATE_REQUIRED', `${item.taskId}: freeze an integrated candidate before queueing independent verification`);
  if (explicitVerification && item.verificationOf !== run.candidate.candidateId) throw stateError('VERIFICATION_TARGET_CONFLICT', `${item.taskId}: verificationOf must equal the currently frozen candidate ${run.candidate.candidateId}`);
  if (item.actorId && candidateAuthors(run).includes(item.actorId)) throw stateError('AUTHOR_CANNOT_VERIFY', `${item.taskId}: use a fresh non-author actor for independent verification`);
  item.writesProduct = false;
  item.verificationOf = run.candidate.candidateId;
  return item;
}

export function fixedVerificationHandoff(run) {
  if (run.snapshot.modeId !== 'fixed-1' || !run.candidate) return {};
  const candidate = run.candidate;
  let taskId = 'hack-candidate', suffix = 1;
  while (Object.hasOwn(run.tasks, taskId)) taskId = `hack-candidate-${suffix++}`;
  return {
    hackerQueueExample: { tasks: [{ taskId, role: 'hacker',
      prompt: 'Independently check the frozen candidate against the original user oracle, including counterexamples and the real user path. Read the supplied verification contract. Write raw output and evidence JSON outside product scope, then return their paths; the coordinator registers evidence after your job completes and releases.',
      expectedMinutes: 1, scope: [], dependsOn: Object.values(run.tasks).filter(task => !task.verificationTarget && !task.coordinationOnly).map(task => task.taskId),
      workspace: candidate.workspace, selection: 'inherit', writesProduct: false, verificationOf: candidate.candidateId }] },
    verificationLifecycle: 'Adapt only the concrete oracle and evidence output directory in the prompt; Core supplies the real lease at run next. Dispatch a fresh Hacker, bind actual agentId, record produced, host-complete --native-receipt, then coordinator registers returned evidence files. Do not fabricate lease tokens or submit evidence while the Hacker is active.'
  };
}
