// Independent deadline keeper survives the CLI controller's death. It only
// signals a recorded live PID/start/process group and never frees an unknown job.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeStatus, markCancelPending, backendStopped, settleControlledHostChildren, releaseLease } from './runtime.js';
import { signalKnownBackend } from './local-runtime.js';
import { recoverWindowsSandbox } from './platform/windows-process.js';
const { identity, deadlineAt } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Number.isFinite(deadlineAt)) throw new Error('Invalid native deadline');
const lease = () => runtimeStatus(identity).leases.find(item => item.leaseId === identity.leaseId);
try {
  while (Date.now() < deadlineAt) { if (lease()?.status === 'released') process.exit(0); await delay(Math.min(500, deadlineAt - Date.now())); }
  const current = lease();
  if (!current || current.status === 'released') process.exit(0);
  markCancelPending(identity);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const observed = lease();
    if (backendStopped(observed).stopped) break;
    signalKnownBackend(observed, signal);
    for (let wait = 0; wait < 15 && !backendStopped(lease()).stopped; wait++) await delay(100);
  }
  settleControlledHostChildren({ ...identity, controllerLeaseId: identity.leaseId });
  const recovery = runtimeStatus(identity).task?.adapterState?.windowsRecoveryFile;
  if (recovery && backendStopped(lease()).stopped) recoverWindowsSandbox(recovery);
  releaseLease(identity);
} catch { /* Preserve reservations for manual identity-safe reconciliation. */ }
