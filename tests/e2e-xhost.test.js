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

test("e2e: init → inventory → advise (switch + handoff) → uninstall purge, all under .mawf", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-proj-"));
  const env = fixtureEnv(home);
  const BLOCK = "<!-- mawf:cross-host-advise BEGIN -->";
  try {
    // 1) init: .mawf workspace + managed blocks in AGENTS.md + CLAUDE.md +
    //    inventory artifacts (no hosts installed in this tmp HOME — the scan
    //    must still succeed with zero hosts, proving graceful degradation)
    const init = run(["init", "-u", "tester", "--no-trellis", "--project", proj, "--allow-pricey"], env);
    assert.match(init, /Initialized \.mawf\//);
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "config.yaml")));
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "inventory.json")));
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "inventory-digest.md")));
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      const t = fs.readFileSync(path.join(proj, f), "utf8");
      assert.equal(t.split(BLOCK).length - 1, 1, `${f} has exactly one block`);
    }

    // 2) inventory CLI against the isolated HOME: zero hosts, exit fine
    const inv = run(["inventory", "--project", proj, "--json"], env);
    const report = JSON.parse(inv);
    assert.equal(report.hosts.length, 0);
    assert.equal(report.projectDir, proj);

    // 3) advise with an explicit task: zero hosts → stay (nothing to switch
    //    to), state file updated under .mawf/runtime, footer present
    const adv = run(["advise", "--project", proj, "--task", "调研 open source repos", "--host", "pi"], env);
    assert.match(adv, /ADVISE-DONE recommendation=stay/);
    const state = JSON.parse(fs.readFileSync(path.join(proj, ".mawf", "runtime", "advise-state.json"), "utf8"));
    assert.ok(state.lastDayUtc8);
    assert.equal(state.lastRecommendation.recommendation, "stay");

    // 4) check-fresh: ADVISED_TODAY right after
    assert.match(run(["advise", "--project", proj, "--check-fresh"], env), /ADVISED_TODAY/);

    // 5) re-init idempotent: still exactly one block per file
    run(["init", "-u", "tester", "--no-trellis", "--project", proj, "--allow-pricey"], env);
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      assert.equal(fs.readFileSync(path.join(proj, f), "utf8").split(BLOCK).length - 1, 1);
    }

    // 6) uninstall --purge-config: blocks stripped / created files deleted,
    //    .mawf gone, tmp HOME host dirs untouched by definition (isolated)
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8") + "\nuser footer line\n");
    run(["uninstall", "--project", proj, "--purge-config"], env);
    assert.ok(!fs.existsSync(path.join(proj, ".mawf")));
    assert.ok(!fs.existsSync(path.join(proj, "AGENTS.md")), "created AGENTS.md deleted");
    const claude = fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8");
    assert.ok(!claude.includes(BLOCK));
    assert.ok(claude.includes("user footer line"), "user content survives purge");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("e2e: legacy .maw project auto-migrates to .mawf on first command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-mig-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "maw-e2e-mig-proj-"));
  const env = fixtureEnv(home);
  try {
    fs.mkdirSync(path.join(proj, ".maw"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".maw", "config.yaml"), "workflow: {}\n");
    const out = run(["version", "--project", proj], env);
    assert.match(out, /migrated:/);
    assert.ok(fs.existsSync(path.join(proj, ".mawf", "config.yaml")));
    assert.ok(!fs.existsSync(path.join(proj, ".maw")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
