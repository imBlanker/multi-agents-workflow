import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("tests", name));

const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...tests], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
