// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, repairMawOverlays, runUpdateLifecycle, runUpgradeLifecycle } from "../src/index.js";

function project(t, trellis = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-life-"));
  if (trellis) fs.mkdirSync(path.join(dir, ".trellis"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("update orders MAWF, redirected Trellis --skip-all, then overlay repair", (t) => {
  const dir = project(t);
  const order = [];
  const r = runUpdateLifecycle({ project: dir, force: true, stdinIsTTY: false, stdoutIsTTY: false }, {
    updateMaw: (opts) => { order.push(["mawf", opts]); return { copied: [] }; },
    runTrellis: (opts) => { order.push(["trellis", opts]); return { stage: "trellis update", ok: true, args: ["update", "--skip-all"] }; },
    repairOverlays: () => { order.push(["repair"]); return { repaired: 1 }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order.map((x) => x[0]), ["mawf", "trellis", "repair"]);
  assert.equal(order[0][1].force, true);
  assert.equal("force" in order[1][1], false, "MAWF --force must not cross into Trellis");
});

test("update outside Trellis explicitly skips only Trellis", (t) => {
  const dir = project(t, false);
  let trellisCalls = 0;
  const r = runUpdateLifecycle({ project: dir }, {
    updateMaw: () => ({ copied: ["x"] }),
    runTrellis: () => { trellisCalls++; throw new Error("must not run"); },
    repairOverlays: () => ({ repaired: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(trellisCalls, 0);
  assert.equal(r.stages.find((s) => s.stage === "trellis update")?.skipped, true);
});

test("failed possibly-partial Trellis update still repairs overlays and fails overall", (t) => {
  const dir = project(t);
  const order = [];
  const r = runUpdateLifecycle({ project: dir }, {
    updateMaw: () => { order.push("mawf"); return { copied: [] }; },
    runTrellis: () => { order.push("trellis"); return { stage: "trellis update", ok: false, status: 2 }; },
    repairOverlays: () => { order.push("repair"); return { repaired: 1 }; },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(order, ["mawf", "trellis", "repair"]);
});

test("overlay repair failure is reported as an overall lifecycle failure", (t) => {
  const dir = project(t);
  const r = runUpdateLifecycle({ project: dir }, {
    updateMaw: () => ({ copied: [] }),
    runTrellis: () => ({ stage: "trellis update", ok: true }),
    repairOverlays: () => ({ ok: false, repaired: 0, errors: [new Error("read-only")] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stages.at(-1).stage, "mawf overlay repair");
  assert.equal(r.stages.at(-1).ok, false);
});

test("overlay repair errors retain structured operation, target, code, and message", (t) => {
  const dir = project(t);
  const writeError = Object.assign(new Error("managed file is read-only"), { code: "EACCES" });
  const grillError = Object.assign(new Error("wrapper replace failed"), { code: "EPERM" });
  const r = repairMawOverlays(dir, {
    writeManagedBlocks: () => { throw writeError; },
    readRegistry: () => ({}),
    resolveWatchList: () => [],
    grillSwapStatus: () => { throw grillError; },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    { operation: "write managed blocks", target: dir, code: "EACCES", message: "managed file is read-only" },
    { operation: "repair grill overlay", target: dir, code: "EPERM", message: "wrapper replace failed" },
  ]);
});

for (const command of ["update", "upgrade"]) {
  test(`${command} CLI reports overlay failure without a re-ensured claim and exits nonzero`, (t) => {
    const dir = project(t);
    const lines = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const overlay = {
      ok: false, repaired: 0,
      errors: [{ operation: "write managed blocks", target: dir, code: "EACCES", message: "read-only" }],
    };
    try {
      const deps = command === "update"
        ? {
            runUpdateLifecycle: () => ({
              ok: false, maw: { copied: [] }, trellis: { ok: true },
              stages: [{ stage: "trellis update", ok: true }], overlay,
            }),
          }
        : {
            runUpgradeLifecycle: () => ({
              ok: false, maw: { ok: true, output: [], mode: "npm" },
              trellisUpgrade: { ok: true }, trellisUpdate: { ok: true }, overlay,
            }),
          };
      main([command, "--project", dir], { ...deps, out: (line) => lines.push(line) });
      assert.equal(process.exitCode, 1);
      assert.match(lines.join("\n"), /MAWF overlay repair failed/);
      assert.match(lines.join("\n"), /overlay repair error \[write managed blocks\].*\(EACCES\): read-only/);
      assert.doesNotMatch(lines.join("\n"), /overlays re-ensured/);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
}

test("upgrade orders MAWF, Trellis CLI, project update, repair without tag leakage", (t) => {
  const dir = project(t);
  const order = [];
  const r = runUpgradeLifecycle({ project: dir, tag: "beta", stdinIsTTY: true, stdoutIsTTY: true }, {
    upgradeMaw: (opts) => { order.push(["mawf", opts]); return { ok: true, output: [], mode: "npm" }; },
    runTrellis: (opts) => { order.push([opts.command, opts]); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { order.push(["repair"]); return { repaired: 0 }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order.map((x) => x[0]), ["mawf", "upgrade", "update", "repair"]);
  assert.equal(order[0][1].tag, "beta");
  assert.equal("tag" in order[1][1], false);
  assert.equal("tag" in order[2][1], false);
});

test("MAWF upgrade failure prevents every Trellis stage", (t) => {
  const dir = project(t);
  let calls = 0;
  const r = runUpgradeLifecycle({ project: dir }, {
    upgradeMaw: () => ({ ok: false, output: [], error: "dirty" }),
    runTrellis: () => { calls++; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});

test("upgrade dry-run previews both products and project update without repair mutation", (t) => {
  const dir = project(t);
  const calls = [];
  const r = runUpgradeLifecycle({ project: dir, dryRun: true }, {
    upgradeMaw: (opts) => { calls.push(["mawf", opts.dryRun]); return { ok: true, output: [], mode: "checkout" }; },
    runTrellis: (opts) => { calls.push([opts.command, opts.dryRun]); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { throw new Error("dry-run must not repair"); },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [["mawf", true], ["upgrade", true], ["update", true]]);
});

test("--no-apply-templates still upgrades Trellis CLI but skips project update", (t) => {
  const dir = project(t);
  const calls = [];
  const r = runUpgradeLifecycle({ project: dir, applyTemplates: false }, {
    upgradeMaw: () => ({ ok: true, output: [], mode: "checkout" }),
    runTrellis: (opts) => { calls.push(opts.command); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { throw new Error("templates disabled"); },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["upgrade"]);
});

test("upgrade --dry-run does not perform the CLI's legacy project migration", (t) => {
  const dir = project(t, false);
  fs.mkdirSync(path.join(dir, ".maw"));
  const previousExitCode = process.exitCode;
  let migrateCalls = 0;
  try {
    main(["upgrade", "--dry-run", "--project", dir], {
      migrateLegacyMawDirs: () => { migrateCalls++; throw new Error("dry-run must skip migration"); },
      runUpgradeLifecycle: () => ({
        ok: true, maw: { ok: true, output: ["dry-run fixture"], mode: "fixture" },
        trellisUpgrade: { ok: true },
      }),
      out: () => {},
    });
    assert.equal(migrateCalls, 0);
    assert.ok(fs.existsSync(path.join(dir, ".maw")));
    assert.ok(!fs.existsSync(path.join(dir, ".mawf")));
  } finally {
    process.exitCode = previousExitCode;
  }
});
