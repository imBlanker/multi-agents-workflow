import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("tests", name));

// Own one temporary tree for the complete invocation, including fixtures that
// fail before registering their cleanup. Never scan/delete the caller's TEMP.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-suite-'));
const home = path.join(temporary, 'home'); fs.mkdirSync(home);
let code = 1;
try {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...tests], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, HOME: home, USERPROFILE: home },
  });
  if (result.error) throw result.error;
  code = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(code);
