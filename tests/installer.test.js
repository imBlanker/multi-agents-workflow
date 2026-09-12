import { setHome } from "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { install, uninstall, update, migrateLegacyMawDirs } from "../src/installer.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "maw-inst-"));
const claudeDir = path.join(tmpHome, ".claude");
fs.mkdirSync(path.join(claudeDir, "commands"), { recursive: true });

let restoreSuiteHome;
test.before(() => {
  restoreSuiteHome = setHome(tmpHome);
});

test("install copies commands/agents/skills into the host and writes a manifest", () => {
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  assert.ok(r.copied.some((c) => c.includes("commands")));
  assert.ok(r.copied.some((c) => c.includes("agents")));
  assert.ok(r.copied.some((c) => c.includes("skills")));
  assert.ok(fs.existsSync(path.join(claudeDir, "commands", "mawf-plan.md")));
  assert.ok(fs.existsSync(path.join(claudeDir, "agents", "orchestrator.md")));
  assert.ok(fs.existsSync(path.join(claudeDir, "skills", "mawf-orchestration", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(tmpHome, ".mawf", "installed.json")));
});

test("update overwrites templates but preserves user-added files", () => {
  const userFile = path.join(claudeDir, "commands", "user-kept.md");
  fs.writeFileSync(userFile, "keep me");
  const r = update({ claudeDir });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(userFile), "user file must survive update");
  assert.ok(fs.existsSync(path.join(claudeDir, "commands", "mawf-plan.md")));
});

test("uninstall removes maw-* files only and the manifest", () => {
  // add a non-maw file to ensure we don't nuke it
  const other = path.join(claudeDir, "commands", "other-tool.md");
  fs.writeFileSync(other, "not mine");
  const r = uninstall();
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(claudeDir, "commands", "mawf-plan.md")), "maw command removed");
  assert.ok(fs.existsSync(other), "non-maw file preserved");
});

test("install on a pi host copies skills+prompts into the pi home and records piDir", () => {
  const piHome = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(piHome, { recursive: true });
  process.env.MAW_HOST = "pi";
  try {
    const r = install({ claudeDir, piDir: piHome });
    assert.equal(r.ok, true);
    assert.ok(r.copied.some((c) => c.includes("pi skills")), `pi skills missing from: ${r.copied.join(" | ")}`);
    assert.ok(r.copied.some((c) => c.includes("pi prompts")), `pi prompts missing`);
    assert.ok(fs.existsSync(path.join(piHome, "skills", "mawf-orchestration", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(piHome, "prompts", "mawf-plan.md")));
    const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
    assert.equal(m.dirs.piDir, piHome);
  } finally { delete process.env.MAW_HOST; }
});

test("install on a dsh host copies skills into $DSH_HOME/skills and records dshDir; uninstall removes only maw-*", () => {
  const dshHome = path.join(tmpHome, ".dsh");
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  process.env.MAW_HOST = "dsh";
  try {
    const r = install({ claudeDir, dshHome });
    assert.equal(r.ok, true);
    assert.ok(r.copied.some((c) => c.includes("dsh skills")), `dsh skills missing from: ${r.copied.join(" | ")}`);
    // no prompts surface for dsh
    assert.ok(!r.copied.some((c) => c.includes("dsh prompts")), "dsh has no prompts surface");
    assert.ok(fs.existsSync(path.join(dshHome, "skills", "mawf-orchestration", "SKILL.md")));
    const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
    assert.equal(m.dirs.dshDir, dshHome);
    // a non-maw dsh skill must survive uninstall
    fs.mkdirSync(path.join(dshHome, "skills", "user-skill"), { recursive: true });
    fs.writeFileSync(path.join(dshHome, "skills", "user-skill", "SKILL.md"), "# keep\n");
    const u = uninstall();
    assert.equal(u.ok, true);
    assert.ok(!fs.existsSync(path.join(dshHome, "skills", "mawf-orchestration")), "maw skill removed");
    assert.ok(fs.existsSync(path.join(dshHome, "skills", "user-skill", "SKILL.md")), "non-maw dsh skill preserved");
  } finally { delete process.env.MAW_HOST; }
});

test("manifest v2 records every written file; uninstall removes ALL (incl. non-prefixed agents/hooks) and prunes empty dirs", () => {
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  // non-maw-prefixed plugin files ARE copied…
  assert.ok(fs.existsSync(path.join(claudeDir, "agents", "orchestrator.md")));
  assert.ok(fs.existsSync(path.join(claudeDir, "hooks", "hooks.json")));
  // …and ARE recorded in the v2 manifest
  const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
  assert.ok(Array.isArray(m.files) && m.files.length >= 15, `manifest.files must record every write, got ${m.files?.length}`);
  assert.ok(m.files.some((f) => f.endsWith(path.join("agents", "orchestrator.md"))));
  assert.ok(m.files.some((f) => f.endsWith(path.join("hooks", "hooks.json"))));
  // a user file in the same tree must survive
  fs.writeFileSync(path.join(claudeDir, "agents", "user-own.md"), "mine");
  const u = uninstall({ project: tmpHome });
  assert.equal(u.ok, true);
  assert.ok(!fs.existsSync(path.join(claudeDir, "agents", "orchestrator.md")), "non-prefixed agent file must be removed");
  assert.ok(!fs.existsSync(path.join(claudeDir, "hooks", "hooks.json")), "hooks.json must be removed");
  assert.ok(fs.existsSync(path.join(claudeDir, "agents", "user-own.md")), "user file preserved");
  assert.ok(!fs.existsSync(path.join(claudeDir, "hooks")), "empty hooks dir pruned");
  assert.ok(!fs.existsSync(path.join(tmpHome, ".mawf", "installed.json")), "manifest removed");
});

test("legacy manifest (dirs only) still uninstalls via the prefix fallback", () => {
  install({ claudeDir });
  const mp = path.join(tmpHome, ".mawf", "installed.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  delete m.files; // pre-v2 shape
  fs.writeFileSync(mp, JSON.stringify(m));
  fs.writeFileSync(path.join(claudeDir, "commands", "user-own.md"), "mine");
  const u = uninstall({ project: tmpHome });
  assert.equal(u.ok, true);
  assert.ok(!fs.existsSync(path.join(claudeDir, "commands", "mawf-plan.md")), "maw-* removed by fallback");
  assert.ok(fs.existsSync(path.join(claudeDir, "commands", "user-own.md")), "user file preserved by fallback");
});

test("uninstall keeps configs by default; --purge-config removes .mawf and .pi/agents/maw-* (never trellis-*)", () => {
  const proj = path.join(tmpHome, "proj-x");
  fs.mkdirSync(path.join(proj, ".mawf", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".mawf", "workflow.json"), "{}");
  fs.mkdirSync(path.join(proj, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".pi", "agents", "maw-worker.md"), "#");
  const trellisAgent = path.join(proj, ".pi", "agents", "trellis-implement.md");
  fs.writeFileSync(trellisAgent, "# trellis agent\n");
  const trellisConfig = path.join(proj, ".trellis", "config.json");
  fs.mkdirSync(path.dirname(trellisConfig), { recursive: true });
  fs.writeFileSync(trellisConfig, "{\"owner\":\"trellis\"}\n");
  const trellisBefore = new Map([[trellisAgent, fs.readFileSync(trellisAgent)], [trellisConfig, fs.readFileSync(trellisConfig)]]);
  install({ claudeDir });
  const keep = uninstall({ project: proj });
  assert.ok(fs.existsSync(path.join(proj, ".mawf", "workflow.json")), "default keeps configs");
  assert.ok(keep.kept.some((p) => p === path.join(proj, ".mawf")));
  const purge = uninstall({ project: proj, purgeConfig: true });
  assert.ok(!fs.existsSync(path.join(proj, ".mawf")), ".mawf purged");
  assert.ok(!fs.existsSync(path.join(proj, ".pi", "agents", "maw-worker.md")), "maw-* pi agent purged");
  for (const [file, bytes] of trellisBefore) assert.deepEqual(fs.readFileSync(file), bytes, `Trellis file preserved byte-identically: ${file}`);
  assert.ok(purge.purged.some((p) => p === path.join(proj, ".mawf")));
});

test("uninstall removes maw-* leftovers from an OLDER install even when the current manifest does not list them", () => {
  install({ claudeDir });
  // simulate an update() that dropped a skill: stale maw-* file on disk,
  // absent from the freshly written manifest
  fs.mkdirSync(path.join(claudeDir, "skills", "maw-retired-skill"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "skills", "maw-retired-skill", "SKILL.md"), "# old\n");
  const mp = path.join(tmpHome, ".mawf", "installed.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  assert.ok(!m.files.some((f) => f.includes("maw-retired-skill")), "fixture premise: not in manifest");
  const u = uninstall({ project: tmpHome });
  assert.ok(!fs.existsSync(path.join(claudeDir, "skills", "maw-retired-skill")), "stale maw-* leftover must be removed by the prefix safety net");
});

test("install cleans stale assets recorded by an older v2 manifest (maw-* → mawf-* incident)", () => {
  // recreate the 2026-08-18 incident shape: a 0.1.0-era manifest recording
  // maw-* assets that still exist on disk while the package ships mawf-*
  fs.mkdirSync(path.join(claudeDir, "skills", "maw-planner"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "skills", "maw-planner", "SKILL.md"), "# old\n");
  fs.writeFileSync(path.join(claudeDir, "commands", "maw-plan.md"), "# old\n");
  fs.mkdirSync(path.join(claudeDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "hooks", "hooks.json"), JSON.stringify({ hooks: { bad: "bin/maw.js" } }));
  const staleSkill = path.join(claudeDir, "skills", "maw-planner", "SKILL.md");
  const staleCmd = path.join(claudeDir, "commands", "maw-plan.md");
  const hookPath = path.join(claudeDir, "hooks", "hooks.json");
  fs.mkdirSync(path.join(tmpHome, ".mawf"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({
    version: "0.1.0", installedAt: "2026-08-18T02:27:47.187Z",
    host: { app: "dsh" }, dirs: { claudeDir, codexDir: path.join(tmpHome, ".codex") },
    files: [staleSkill, staleCmd, hookPath],
  }));
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(staleSkill), "stale maw-* skill removed");
  assert.ok(!fs.existsSync(staleCmd), "stale maw-* command removed");
  assert.ok(!fs.existsSync(path.dirname(staleSkill)), "emptied stale skill dir pruned");
  assert.ok(fs.existsSync(path.join(claudeDir, "skills", "mawf-planner", "SKILL.md")), "current mawf-* asset in place");
  // hooks.json is recorded by the OLD manifest AND written by the CURRENT
  // install → not stale: kept and overwritten with the fixed (mawf.js) hook
  assert.ok(fs.existsSync(hookPath), "hooks.json re-written by current install");
  assert.ok(!JSON.parse(fs.readFileSync(hookPath, "utf8")).hooks.bad, "stale hook content replaced");
  assert.ok(r.removedStale.includes(staleSkill) && r.removedStale.includes(staleCmd), "removedStale reports exact paths");
  assert.ok(!r.removedStale.includes(hookPath), "path also written by current install is NOT stale");
});

test("install stale-cleanup never touches files absent from the old manifest (no prefix scan)", () => {
  fs.mkdirSync(path.join(claudeDir, "skills", "my-own-skill"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "skills", "my-own-skill", "SKILL.md"), "# mine\n");
  fs.writeFileSync(path.join(claudeDir, "commands", "maw-user-custom.md"), "# user-made with maw- prefix\n");
  fs.writeFileSync(path.join(claudeDir, "commands", "maw-gone.md"), "# stale (recorded)\n");
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({
    version: "0.4.0", dirs: { claudeDir },
    files: [path.join(claudeDir, "commands", "maw-gone.md")],
  }));
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(claudeDir, "commands", "maw-gone.md")), "recorded stale file removed");
  assert.ok(fs.existsSync(path.join(claudeDir, "skills", "my-own-skill", "SKILL.md")), "unrecorded user file kept");
  assert.ok(fs.existsSync(path.join(claudeDir, "commands", "maw-user-custom.md")), "user file with maw- prefix kept (exact-diff only, no prefix scan)");
});

test("install skips stale-cleanup for a legacy manifest without files[]", () => {
  const stale = path.join(claudeDir, "commands", "maw-legacy.md");
  fs.writeFileSync(stale, "# old\n");
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({ version: "0.1.0", dirs: { claudeDir } }));
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  assert.deepEqual(r.removedStale, []);
  assert.ok(fs.existsSync(stale), "legacy manifest → no cleanup (uninstall prefix fallback covers it)");
});

test("install ADDS a second special host without purging the first (0.4.2 union)", () => {
  const dshHome = path.join(tmpHome, ".dsh");
  fs.mkdirSync(path.join(dshHome, "skills"), { recursive: true });
  const dshSkill = path.join(dshHome, "skills", "mawf-planner", "SKILL.md");
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({
    version: "0.4.1", host: { app: "dsh" },
    dirs: { claudeDir, dshDir: dshHome },
    files: [dshSkill],
  }));
  const piHome = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(piHome, { recursive: true });
  process.env.MAW_HOST = "pi";
  try {
    const r = install({ claudeDir, piDir: piHome, dshHome });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(piHome, "skills", "mawf-planner", "SKILL.md")), "pi skills shipped");
    assert.ok(fs.existsSync(path.join(piHome, "prompts", "mawf-plan.md")), "pi prompts shipped");
    assert.ok(fs.existsSync(dshSkill), "dsh assets of the FIRST host survive the second host's install");
    assert.deepEqual(r.removedStale, [], "union install must not treat the other host's files as stale");
    const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
    assert.equal(m.dirs.piDir, piHome, "manifest records the added pi dir");
    assert.equal(m.dirs.dshDir, dshHome, "manifest keeps the dsh dir");
    assert.equal(m.host.app, "pi", "primary host = the explicitly requested one");
  } finally { delete process.env.MAW_HOST; }
});

test("bare install (claude detected) on a dsh-install machine keeps dsh assets (0.4.1 regression)", () => {
  const dshHome = path.join(tmpHome, ".dsh");
  fs.mkdirSync(path.join(dshHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({
    version: "0.4.1", host: { app: "dsh" }, dirs: { claudeDir, dshDir: dshHome }, files: [],
  }));
  delete process.env.MAW_HOST; // bare — detection must not drop the recorded dsh host
  const r = install({ claudeDir, dshHome });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dshHome, "skills", "mawf-planner", "SKILL.md")), "dsh skills kept on a bare claude-detected install");
  assert.deepEqual(r.removedStale, []);
  const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
  assert.equal(m.dirs.dshDir, dshHome, "dsh dir still recorded");
});

test("union targets the OLD manifest's recorded dir, not a fresh detection path", () => {
  const piAlt = path.join(tmpHome, ".pi-alt");
  fs.writeFileSync(path.join(tmpHome, ".mawf", "installed.json"), JSON.stringify({
    version: "0.4.1", host: { app: "dsh" }, dirs: { claudeDir, piDir: piAlt }, files: [],
  }));
  delete process.env.MAW_HOST;
  const r = install({ claudeDir });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(piAlt, "skills", "mawf-planner", "SKILL.md")), "union shipped to the recorded pi dir");
  const m = JSON.parse(fs.readFileSync(path.join(tmpHome, ".mawf", "installed.json"), "utf8"));
  assert.equal(m.dirs.piDir, piAlt);
});

test.after(() => {
  restoreSuiteHome();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test("migrateLegacyMawDirs: renames legacy .maw -> .mawf (project + global), idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-mig-home-"));
  const restoreHome = setHome(home);
  try {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "maw-mig-proj-"));
    fs.mkdirSync(path.join(home, ".maw", "skills", "mawf-cost-guard"), { recursive: true });
    fs.writeFileSync(path.join(home, ".maw", "installed.json"), "{}");
    fs.mkdirSync(path.join(proj, ".maw", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".maw", "config.yaml"), "workflow: {}\n");
    const notes = migrateLegacyMawDirs({ project: proj });
    assert.equal(notes.length, 2);
    assert.ok(fs.existsSync(path.join(home, ".mawf", "installed.json")));
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "runtime")));
    assert.ok(!fs.existsSync(path.join(home, ".maw")));
    assert.ok(!fs.existsSync(path.join(proj, ".maw")));
    // idempotent: second run is a no-op
    assert.deepEqual(migrateLegacyMawDirs({ project: proj }), []);
    // pre-existing .mawf wins: legacy dir left untouched (no merge)
    fs.mkdirSync(path.join(proj, ".maw"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".maw", "stale.txt"), "x");
    assert.deepEqual(migrateLegacyMawDirs({ project: proj }), []);
    assert.ok(fs.existsSync(path.join(proj, ".maw", "stale.txt")));
  } finally {
    restoreHome();
  }
});
