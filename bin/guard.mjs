// Node-only hook: no grep, shell pipeline, or platform-specific cwd expansion.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function checkGuard(input, { runner = spawnSync, cli = fileURLToPath(new URL("./mawf.js", import.meta.url)), cwd = process.cwd() } = {}) {
  try {
    const payload = input.trim() ? JSON.parse(input) : {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (payload.cwd !== undefined && (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd))) return false;
    const result = runner(process.execPath, [cli, "guard", "--project", payload.cwd || cwd], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    return !result.error && result.status === 0 && /^ALLOW(?:\s|$)/m.test(result.stdout || "");
  } catch { return false; }
}

export function main() {
  let allowed = false;
  try { allowed = checkGuard(fs.readFileSync(0, "utf8")); } catch {}
  if (!allowed) {
    process.stderr.write("MAW cost guard: deny (limit reached or guard unavailable). See `mawf cost`.\n");
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
