import { setHome } from "./fixtures/test-env.mjs";
// @ts-check
// Tests for `mawf upgrade` (self-upgrade: checkout ff-pull / npm / squat detection).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { upgrade, detectInstallMode } from "../src/upgrade.js";

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** Build a bare remote + a clean clone containing a minimal maw-like package. */
function mkCheckout(version = "0.1.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-upg-"));
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf8" });
  const seed = path.join(dir, "seed");
  fs.mkdirSync(path.join(seed, "bin"), { recursive: true });
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "multi-agents-workflow", version, bin: { mawf: "bin/mawf.js" } }, null, 2));
  fs.writeFileSync(path.join(seed, "bin", "mawf.js"), "#!/usr/bin/env node\n");
  git(["init", "-b", "main"], seed);
  git(["add", "-A"], seed);
  git(["commit", "-m", "init"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  const clone = path.join(dir, "clone");
  execFileSync("git", ["clone", remote, clone], { encoding: "utf8" });
  return { dir, remote, clone };
}

/** Push one commit bumping the version on the bare remote. */
function pushVersion(remote, version) {
  const w = path.join(path.dirname(remote), "w-" + version);
  execFileSync("git", ["clone", remote, w], { encoding: "utf8" });
  const pkg = JSON.parse(fs.readFileSync(path.join(w, "package.json"), "utf8"));
  pkg.version = version;
  fs.writeFileSync(path.join(w, "package.json"), JSON.stringify(pkg, null, 2));
  git(["add", "-A"], w);
  git(["commit", "-m", "v" + version], w);
  git(["push", "origin", "main"], w);
}

test("checkout mode: --dry-run prints the exact steps and changes nothing", () => {
  const { clone } = mkCheckout();
  const before = git(["rev-parse", "HEAD"], clone);
  const r = upgrade({ pkgRoot: clone, dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.output.join("\n"), /dry-run: git .* fetch origin/);
  assert.match(r.output.join("\n"), /dry-run: git .* merge --ff-only origin\/main/);
  assert.equal(git(["rev-parse", "HEAD"], clone), before, "dry-run must not move HEAD");
});

test("checkout mode: clean ff-pull advances HEAD, reports old→new version, refreshes templates by default", () => {
  const { clone, remote } = mkCheckout("0.1.0");
  pushVersion(remote, "0.2.0");
  const r = upgrade({ pkgRoot: clone });
  assert.equal(r.ok, true, r.error || "");
  assert.equal(r.from, "0.1.0");
  assert.equal(r.to, "0.2.0");
  // 0.4.1: template refresh is the DEFAULT — the spawned stub bin/mawf.js
  // exits 0 with empty stdout, so we get the refreshed marker + no tail.
  assert.equal(r.appliedTemplates, true);
  assert.match(r.output.join("\n"), /templates refreshed \(post-upgrade code\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(clone, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.2.0");
});

test("checkout mode: --no-apply-templates skips the refresh and prints the manual follow-up", () => {
  const { clone, remote } = mkCheckout("0.1.0");
  pushVersion(remote, "0.2.0");
  let spawned = 0;
  const r = upgrade({ pkgRoot: clone, applyTemplates: false, spawnFn: () => { spawned++; return { status: 0, stdout: "" }; } });
  assert.equal(r.ok, true, r.error || "");
  assert.equal(spawned, 0, "--no-apply-templates must not spawn the updater");
  assert.equal(r.appliedTemplates, false);
  assert.match(r.output.join("\n"), /npx \. update/);
  assert.match(r.output.join("\n"), /--no-apply-templates/);
});

test("checkout mode: dry-run previews the automatic template refresh", () => {
  const { clone } = mkCheckout();
  const r = upgrade({ pkgRoot: clone, dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.output.join("\n"), /would refresh templates via bin\/mawf\.js update/);
});

test("checkout mode: dry-run with --no-apply-templates says templates are NOT refreshed", () => {
  const { clone } = mkCheckout();
  const r = upgrade({ pkgRoot: clone, dryRun: true, applyTemplates: false });
  assert.equal(r.ok, true);
  assert.match(r.output.join("\n"), /templates NOT refreshed \(--no-apply-templates\)/);
});

test("checkout mode: dirty tree aborts before any fetch, with manual guidance", () => {
  const { clone } = mkCheckout();
  fs.writeFileSync(path.join(clone, "dirty.txt"), "local edit");
  const before = git(["rev-parse", "HEAD"], clone);
  const r = upgrade({ pkgRoot: clone });
  assert.equal(r.ok, false);
  assert.match(r.error, /dirty/);
  assert.match(r.error, /never stashes/);
  assert.equal(git(["rev-parse", "HEAD"], clone), before, "HEAD must not move on abort");
});

test("checkout mode: diverged branch aborts with ff-only guidance (no history rewrite)", () => {
  const { clone, remote } = mkCheckout("0.1.0");
  pushVersion(remote, "0.2.0");
  fs.writeFileSync(path.join(clone, "local.txt"), "local divergence");
  git(["add", "-A"], clone);
  git(["commit", "-m", "local"], clone);
  const r = upgrade({ pkgRoot: clone });
  assert.equal(r.ok, false);
  assert.match(r.error, /ff-only/);
});

test("checkout mode: --tag is rejected with a clear message", () => {
  const { clone } = mkCheckout();
  const r = upgrade({ pkgRoot: clone, tag: "beta" });
  assert.equal(r.ok, false);
  assert.match(r.error, /reserved for npm-mode/);
});

test("npm mode: squatted legacy name is reported, never installed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-upg-npm-"));
  const pkgRoot = path.join(dir, "lib", "node_modules", "multi-agent-workflow");
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "multi-agent-workflow", version: "0.1.0" }));
  const det = detectInstallMode(pkgRoot, { npmPrefix: path.join(dir, "lib") });
  assert.equal(det.mode, "npm");
  assert.equal(det.squatted, true);
  const r = upgrade({ pkgRoot, npmPrefix: path.join(dir, "lib") });
  assert.equal(r.ok, true);
  assert.match(r.output.join("\n"), /unrelated third-party package/);
  assert.match(r.output.join("\n"), /refusing to run npm i -g/);
});

test("npm mode: dry-run prints the install command without running it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-upg-npm2-"));
  const pkgRoot = path.join(dir, "lib", "node_modules", "@scope", "maw");
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@scope/maw", version: "0.1.0" }));
  const r = upgrade({ pkgRoot, npmPrefix: path.join(dir, "lib"), dryRun: true, tag: "beta" });
  assert.equal(r.ok, true);
  assert.match(r.output.join("\n"), /dry-run: would run `npm i -g @scope\/maw@beta`/);
  assert.match(r.output.join("\n"), /would refresh templates via bin\/mawf\.js update/);
});

/** npm-mode fixture: a package under a fake npm prefix (NOT squatted). */
function mkNpmPkg(version = "0.4.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-upg-npm3-"));
  const pkgRoot = path.join(dir, "lib", "node_modules", "multi-agents-workflow");
  fs.mkdirSync(path.join(pkgRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "multi-agents-workflow", version }));
  fs.writeFileSync(path.join(pkgRoot, "bin", "mawf.js"), "#!/usr/bin/env node\n");
  return { dir, pkgRoot, npmPrefix: path.join(dir, "lib") };
}

test("npm mode: successful install spawns the NEW code's update and reports appliedTemplates", () => {
  const { pkgRoot, npmPrefix } = mkNpmPkg();
  /** @type {any[]} */
  const spawns = [];
  const r = upgrade({
    pkgRoot, npmPrefix,
    runSh: () => "added 1 package",
    spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { status: 0, stdout: "updated mawf 0.4.1\n  copied -> /x" }; },
  });
  assert.equal(r.ok, true, r.error || "");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, process.execPath);
  assert.deepEqual(spawns[0].args, [path.join(pkgRoot, "bin", "mawf.js"), "update", "--mawf-only"]);
  assert.equal(spawns[0].opts.cwd, pkgRoot);
  assert.equal(r.appliedTemplates, true);
  assert.match(r.output.join("\n"), /templates refreshed \(post-upgrade code\)/);
  assert.match(r.output.join("\n"), /updated mawf 0\.4\.1/);
});

test("npm mode: template-refresh failure degrades to a warning, upgrade still ok", () => {
  const { pkgRoot, npmPrefix } = mkNpmPkg();
  const r = upgrade({
    pkgRoot, npmPrefix,
    runSh: () => "added 1 package",
    spawnFn: () => ({ status: 1, stdout: "boom" }),
  });
  assert.equal(r.ok, true, "refresh failure must NOT fail the upgrade");
  assert.equal(r.appliedTemplates, false);
  assert.match(r.output.join("\n"), /template refresh FAILED/);
  assert.match(r.output.join("\n"), /mawf update` manually/);
});

test("npm mode: --no-apply-templates skips the spawn entirely", () => {
  const { pkgRoot, npmPrefix } = mkNpmPkg();
  let spawned = 0;
  const r = upgrade({
    pkgRoot, npmPrefix, applyTemplates: false,
    runSh: () => "added 1 package",
    spawnFn: () => { spawned++; return { status: 0, stdout: "" }; },
  });
  assert.equal(r.ok, true, r.error || "");
  assert.equal(spawned, 0);
  assert.equal(r.appliedTemplates, false);
  assert.match(r.output.join("\n"), /mawf update` manually/);
});

test("npm mode: refresh spawns update with MAW_HOST inherited from the installed manifest (0.4.2)", () => {
  const { pkgRoot, npmPrefix } = mkNpmPkg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-host-hint-"));
  fs.mkdirSync(path.join(home, ".mawf"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mawf", "installed.json"), JSON.stringify({ version: "0.4.1", host: { app: "dsh" }, dirs: {}, files: [] }));
  const restoreHome = setHome(home);
  try {
    /** @type {any} */
    let captured;
    const r = upgrade({
      pkgRoot, npmPrefix,
      runSh: () => "added 1 package",
      spawnFn: (_cmd, _args, opts) => { captured = opts; return { status: 0, stdout: "updated mawf 0.4.2" }; },
    });
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.appliedTemplates, true);
    assert.equal(captured.env?.MAW_HOST, "dsh", "spawned update must run with the recorded install host");
    assert.equal(Object.entries(captured.env ?? {}).find(([key]) => key.toUpperCase() === "PATH")?.[1], process.env.PATH, "rest of the environment is inherited");
  } finally { restoreHome(); }
});

test("npm mode: no manifest → no MAW_HOST injection into the spawned update", () => {
  const { pkgRoot, npmPrefix } = mkNpmPkg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-no-hint-"));
  const restoreHome = setHome(home); // no ~/.mawf here
  try {
    /** @type {any} */
    let captured;
    const r = upgrade({
      pkgRoot, npmPrefix,
      runSh: () => "added 1 package",
      spawnFn: (_cmd, _args, opts) => { captured = opts; return { status: 0, stdout: "" }; },
    });
    assert.equal(r.ok, true, r.error || "");
    assert.equal(r.appliedTemplates, true);
    assert.ok(!captured.env?.MAW_HOST, "no manifest → pure detection, no env injection");
  } finally { restoreHome(); }
});
