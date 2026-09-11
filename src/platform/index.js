import * as linux from "./linux.js";
import * as windows from "./windows.js";

// Preserve the previous POSIX behavior on other OSes without certifying them.
export const platformFor = (os = process.platform) => os === "win32" ? windows : linux;
export const { findExecutable, run, projectProcessAlive, portOwner, dshLaunch, commandText, sessionSlugs, pythonCommand } = platformFor();

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
