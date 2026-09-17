#!/usr/bin/env node
// @ts-check
// A20 packed-install gate (stabilization §16): pack the real tarball, install
// it into an isolated temp dir, and smoke the INSTALLED package from an
// unrelated cwd. Repeatable; exits non-zero on any failure.
//
// Usage: node scripts/test-packed-install.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`A20 FAIL: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`A20: ${msg}`);

// 1. pack
step("npm pack…");
const pack = spawnSync("npm", ["pack", "--json"], { cwd: repo, encoding: "utf8", shell: process.platform === "win32" });
if (pack.status !== 0) fail(`npm pack exited ${pack.status}`);
let tarballName;
try {
  const info = JSON.parse(pack.stdout);
  // npm >=7 array shape vs npm 12 object-keyed shape
  const entry = Array.isArray(info) ? info[0] : info[Object.keys(info)[0]];
  tarballName = entry?.filename;
} catch {
  tarballName = (pack.stdout.match(/multi-agents-workflow-[\d.]+(?:-[\w.]+)?\.tgz/) ?? [])[0];
}
if (!tarballName) fail("could not determine tarball filename");
const tarball = path.join(repo, tarballName);
if (!fs.existsSync(tarball)) fail(`tarball missing: ${tarball}`);
step(`packed ${tarballName}`);

// 2. tarball content audit (never rely on the files array by eye)
step("auditing tarball contents…");
const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
if (list.status !== 0) fail("tar -tzf failed");
const files = list.stdout.split("\n").filter(Boolean);
const mustContain = [
  "package/bin/mawf.js",
  "package/src/knowledge/store.js",
  "package/src/workspace/ssh.js",
  "package/src/components/registry.js",
  "package/src/archify.js",
  "package/defaults/components.lock.json",
  "package/skills/mawf-decision/SKILL.md",
  "package/skills/mawf-compound/SKILL.md",
  "package/skills/mawf-knowledge/SKILL.md",
  "package/skills/mawf-archify/SKILL.md",
  "package/skills/NOTICE-MAWF-INTEGRATIONS.md",
];
for (const need of mustContain) {
  if (!files.includes(need)) fail(`tarball lacks required file: ${need}`);
}
step(`${files.length} files audited, all required entries present`);

// 3. isolated install (source tree is NOT on the resolution path)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-a20-"));
try {
  step(`installing into ${tmp}…`);
  const inst = spawnSync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: tmp, encoding: "utf8", shell: process.platform === "win32",
  });
  if (inst.status !== 0) fail(`isolated install failed: ${(inst.stderr || inst.stdout).slice(-400)}`);
  const pkgDir = path.join(tmp, "node_modules", "multi-agents-workflow");
  const mawf = path.join(pkgDir, "bin", "mawf.js");
  for (const p of [mawf, path.join(pkgDir, "vendor", "notes-board", "board.html"), path.join(pkgDir, "vendor", "notes-board", "NOTICE.md")]) {
    if (!fs.existsSync(p)) fail(`installed package lacks: ${p}`);
  }
  step("isolated install OK, resources present");

  // 4. run the INSTALLED cli from an unrelated cwd
  const run = (args) => {
    const r = spawnSync(process.execPath, [mawf, ...args], { cwd: tmp, encoding: "utf8" });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  step("mawf version…");
  if (run(["version"]).code !== 0) fail("mawf version failed from installed package");
  step("mawf knowledge status…");
  if (run(["knowledge", "status"]).code !== 0) fail("mawf knowledge status failed from installed package");
  step("mawf components status…");
  if (run(["components", "status"]).code !== 0) fail("mawf components status failed from installed package");
  step("archify adapter no-engine error path…");
  const noEngine = run(["archify", "doctor"]);
  if (noEngine.code !== 3) fail(`expected exit 3 for missing engine, got ${noEngine.code}`);
  if (!/not installed/.test(noEngine.out)) fail("no-engine diagnostic missing");
  step("knowledge verify on a fresh project…");
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const v = spawnSync(process.execPath, [mawf, "knowledge", "verify"], { cwd: proj, encoding: "utf8" });
  if (v.status !== 0) fail("knowledge verify failed on a fresh empty project");
  console.log(`A20 PASS (${tmp} can be discarded)`);
} finally {
  fs.rmSync(tarball, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
