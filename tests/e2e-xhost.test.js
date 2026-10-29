import { fileURLToPath } from "node:url";
import { fixtureEnv } from "./fixtures/test-env.mjs";
// @ts-check
// End-to-end CLI test: the full proactive cross-host chain in ONE fixture
// project — init (blocks + inventory) → advise (state + switch handoff) →
// uninstall purge (blocks stripped, .mawf removed) — with full HOME/tmp
// isolation (never touches the real ~; see maw-installer-contracts spec).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args, env) {
  return execFileSync(process.execPath, [path.join(REPO, "bin", "mawf.js"), ...args], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ...env },
  });
}

test("e2e: init → inventory → advise (switch + handoff) → uninstall, all under .mawf", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-proj-"));
  const env = fixtureEnv(home);
  const BLOCK = "<!-- mawf:cross-host-advise BEGIN -->";
  // v1 defaults every optional integration off (docs/V1_CORE.md "All
  // integrations default disabled"), so the chain selects what it exercises.
  const select = (...ids) => { for (const id of ids) run(["integrations", "enable", id, "--project", proj, "--json"], env); };
  try {
    select("inventory", "cross-host-advise");
    // 1) init: .mawf workspace + managed blocks in AGENTS.md + CLAUDE.md +
    //    the inventory snapshot (no hosts installed in this tmp HOME — the scan
    //    must still succeed with zero hosts, proving graceful degradation)
    const init = JSON.parse(run(["init", "-u", "tester", "--no-trellis", "--project", proj], env));
    assert.equal(init.ok, true);
    assert.equal(init.project, proj);
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "config.yaml")));
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "inventory.json")));
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      const t = fs.readFileSync(path.join(proj, f), "utf8");
      assert.equal(t.split(BLOCK).length - 1, 1, `${f} has exactly one block`);
    }

    // 2) inventory CLI against the isolated HOME: zero hosts, exit fine
    const report = JSON.parse(run(["inventory", "--project", proj, "--json"], env)).inventory;
    assert.equal(report.hosts.length, 0);
    assert.equal(report.projectDir, proj);
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "inventory-digest.md")));

    // 3) advise with an explicit task: zero hosts → stay (nothing to switch
    //    to), state file updated under .mawf/runtime, footer present
    const adv = run(["advise", "--project", proj, "--task", "调研 open source repos"], env);
    assert.match(adv, /ADVISE-DONE recommendation=stay/);
    const state = JSON.parse(fs.readFileSync(path.join(proj, ".mawf", "runtime", "advise-state.json"), "utf8"));
    assert.ok(state.lastDayUtc8);
    assert.equal(state.lastRecommendation.recommendation, "stay");

    // 4) check-fresh: ADVISED_TODAY right after
    assert.match(run(["advise", "--project", proj, "--check-fresh"], env), /ADVISED_TODAY/);

    // 5) re-init idempotent: still exactly one block per file
    run(["init", "-u", "tester", "--no-trellis", "--project", proj], env);
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      assert.equal(fs.readFileSync(path.join(proj, f), "utf8").split(BLOCK).length - 1, 1);
    }

    // 6) uninstall: v1 removes only exact recorded manifest entries and retains
    //    project data (docs/V1_CORE.md "Uninstall removes exact manifest entries
    //    and retains project data"); --purge-config is retired.
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8") + "\nuser footer line\n");
    run(["install", "--project", proj, "--json"], env);
    const removal = JSON.parse(run(["uninstall", "--project", proj, "--json"], env));
    assert.equal(removal.ok, true);
    assert.ok(removal.kept.some((entry) => String(entry).includes(".mawf")), "project data listed as kept");
    assert.ok(fs.existsSync(path.join(proj, ".mawf")), "project data survives uninstall");
    assert.ok(fs.existsSync(path.join(proj, "AGENTS.md")), "project files survive uninstall");
    const claude = fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8");
    assert.ok(claude.includes("user footer line"), "user content survives uninstall");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("e2e: 1.0.0 leaves a pre-0.6 .maw layout untouched; it is renamed by hand", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-mig-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-mig-proj-"));
  const env = fixtureEnv(home);
  try {
    fs.mkdirSync(path.join(proj, ".maw"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".maw", "config.yaml"), "workflow: {}\n");
    // 1.0.0 dropped the 0.6-0.8 automatic .maw -> .mawf rename (CHANGELOG 1.0.0):
    // the legacy directory is neither read nor moved, and the project gets a fresh .mawf.
    const out = JSON.parse(run(["plan", "--project", proj, "--json"], env));
    assert.equal(out.ok, true);
    assert.equal(out.layoutMigration, undefined);
    assert.equal(fs.readFileSync(path.join(proj, ".maw", "config.yaml"), "utf8"), "workflow: {}\n");
    assert.ok(fs.existsSync(path.join(proj, ".mawf")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
