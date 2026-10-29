import * as linux from "./linux.js";
import * as windows from "./windows.js";

// Preserve the previous POSIX behavior on other OSes without certifying them.
export const platformFor = (os = process.platform) => os === "win32" ? windows : linux;
export const { findExecutable, run, projectProcessAlive, portOwner, dshLaunch, commandText, sessionSlugs, pythonCommand, tarCommand } = platformFor();

/** execFileSync-compatible throwing wrapper for consumers that expect stdout. */
export function execFile(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    const error = result.error || new Error(`${command} exited with status ${result.status}`);
    Object.assign(error, { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    throw error;
  }
  return result.stdout;
}

// Checkout, path-spelling and file-sharing conventions that differ on Windows.
export const { checkoutVariants, realpath, comparablePath, retryTransient } = platformFor();
export const { nativeInvocation } = platformFor();
// Explicit Windows controlled-execution capability, consumed only after native
// platform admission; the helper module has no import-time process side effects.
export { jobHelper, windowsStartIdentity, spawnWindowsJob, windowsLaunch, windowsJobStopped, stopWindowsJob, recoverWindowsSandbox } from './windows-process.js';
