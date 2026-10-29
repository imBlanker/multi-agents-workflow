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
const tail = (r) => (r.stderr || r.stdout || r.error?.message || "").trim().slice(-400);

// Everything the gate writes (tarball, install, npm cache and logs, the CLI's
// HOME) stays in this temp dir. fail() exits through process.exit(), which
// skips finally blocks but still emits "exit", so the cleanup lives there.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-a20-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
// npm's cache, logs and the compile cache it enables on Node >= 22 (default:
// os.tmpdir()) go to tmp as well; with that fresh cache npm would check the
// registry for its own update on every run, so that is off. npm is a .cmd shim
// on Windows, which Node only starts through cmd.exe: quote each argument so
// paths with spaces survive it, but not the command name, since a quoted "npm"
// breaks %~dp0 inside npm.cmd.
const npmEnv = { ...process.env, NODE_COMPILE_CACHE: path.join(tmp, "node-compile-cache") };
const npm = (args, cwd) => {
  const argv = [...args, "--cache", path.join(tmp, "npm-cache"), "--no-update-notifier"];
  return process.platform === "win32"
    ? spawnSync(`npm ${argv.map((arg) => `"${arg}"`).join(" ")}`, { cwd, env: npmEnv, encoding: "utf8", shell: true })
    : spawnSync("npm", argv, { cwd, env: npmEnv, encoding: "utf8" });
};

// 1. pack
step("npm pack…");
const pack = npm(["pack", "--json", "--pack-destination", tmp], repo);
if (pack.status !== 0) fail(`npm pack exited ${pack.status}: ${tail(pack)}`);
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
const tarball = path.join(tmp, tarballName);
if (!fs.existsSync(tarball)) fail(`tarball missing: ${tarball}`);
step(`packed ${tarballName}`);

// 2. tarball content audit (never rely on the files array by eye)
step("auditing tarball contents…");
// Name the tarball relative to its own dir: GNU tar (first on PATH in Git
// Bash) reads the "C:" of an absolute Windows path as a remote host, and
// Windows bsdtar ends every listed name with CRLF.
const list = spawnSync("tar", ["-tzf", tarballName], { cwd: tmp, encoding: "utf8" });
if (list.status !== 0) fail(`tar -tzf failed: ${tail(list)}`);
const files = list.stdout.split(/\r?\n/).filter(Boolean);
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
for (const file of files) {
  if (/(^|\/)(\.trellis|\.mawf|\.codex|\.claude|backups?|migration-backups)(\/|$)/.test(file)
      || /^package\/docs\/history\//.test(file)) fail(`private workspace asset in tarball: ${file}`);
}
step(`${files.length} files audited, all required entries present`);

// 3. isolated install (source tree is NOT on the resolution path). --prefix
// pins it to tmp: otherwise npm installs into the nearest ancestor holding a
// package.json or node_modules, which can be the user's home folder.
step(`installing into ${tmp}…`);
const inst = npm(["install", tarball, "--prefix", tmp, "--no-audit", "--no-fund", "--loglevel=error"], tmp);
if (inst.status !== 0) fail(`isolated install failed: ${tail(inst)}`);
const pkgDir = path.join(tmp, "node_modules", "multi-agents-workflow");
const mawf = path.join(pkgDir, "bin", "mawf.js");
for (const p of [mawf, path.join(pkgDir, "vendor", "notes-board", "README.md")]) {
  if (!fs.existsSync(p)) fail(`installed package lacks: ${p}`);
}
if (!files.includes("package/vendor/notes-board/board.html")) {
  fail("vendor/notes-board/board.html missing from tarball (adapted Board asset)");
}
step("isolated install OK, resources present");

// 4. run the INSTALLED cli from an unrelated cwd as a fresh user, so the
// developer's own ~/.mawf and host config are neither read nor written: HOME
// is in tmp, and the variables that point mawf or its hosts at state elsewhere
// (CODEX_HOME, CLAUDE_CONFIG_DIR, MAWF_INSTALL_STATE_DIR, ...) are dropped.
const home = path.join(tmp, "home");
fs.mkdirSync(home);
const cliEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^((MAWF?|CODEX|CLAUDE|PI|DSH|CC_SWITCH)_|NODE_COMPILE_CACHE$)/i.test(key))),
  HOME: home,
  USERPROFILE: home,
};
const run = (args, cwd = tmp) => {
  const r = spawnSync(process.execPath, [mawf, ...args], { cwd, encoding: "utf8", env: cliEnv });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
step("mawf version…");
const version = run(["version"]);
if (version.code !== 0) fail(`mawf version failed from installed package: ${version.out.trim()}`);
// 1.0.0 keeps every optional integration off until it is selected: a fresh user
// is refused first, then the selected features run from the installed package.
step("optional features stay off until selected…");
const unselected = run(["knowledge", "status"]);
if (unselected.code === 0 || !/knowledge is disabled/.test(unselected.out)) fail(`knowledge ran before it was selected: ${unselected.out.trim()}`);
const select = (id, project) => {
  const r = run(["integrations", "enable", id, "--project", project], project);
  if (r.code !== 0) fail(`mawf integrations enable ${id} failed from installed package: ${r.out.trim()}`);
};
for (const id of ["knowledge", "archify"]) select(id, tmp);
step("mawf knowledge status…");
const knowledge = run(["knowledge", "status"]);
if (knowledge.code !== 0) fail(`mawf knowledge status failed from installed package: ${knowledge.out.trim()}`);
step("mawf components status…");
const components = run(["components", "status"]);
if (components.code !== 0) fail(`mawf components status failed from installed package: ${components.out.trim()}`);
step("archify adapter no-engine error path…");
const noEngine = run(["archify", "doctor"]);
if (noEngine.code !== 3) fail(`expected exit 3 for missing engine, got ${noEngine.code}`);
if (!/not installed/.test(noEngine.out)) fail("no-engine diagnostic missing");
step("knowledge verify on a fresh project…");
const proj = path.join(tmp, "proj");
fs.mkdirSync(proj, { recursive: true });
select("knowledge", proj);
if (run(["knowledge", "verify"], proj).code !== 0) fail("knowledge verify failed on a fresh empty project");
console.log("A20 PASS");
