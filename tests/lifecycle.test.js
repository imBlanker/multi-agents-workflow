// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, repairMawOverlays, runUpdateLifecycle, runUpgradeLifecycle } from "../src/index.js";
import { setIntegration } from "../src/integrations.js";

// v1 gates the Trellis lifecycle on an explicit selection rather than on a
// leftover `.trellis` directory (docs/V1_CORE.md: "All integrations default
// disabled"), and the three lifecycle seams now return promises ("callers must
// await them"), so every historical synchronous assertion is awaited here.
function project(t, trellis = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-life-"));
  if (trellis) {
    fs.mkdirSync(path.join(dir, ".trellis"));
    setIntegration(dir, "trellis", true);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Core commands emit one JSON object on stdout; capture it around `fn`. */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { return { value: await fn(), text: chunks.join("") }; }
  finally { process.stdout.write = original; }
}

test("update orders MAWF, redirected Trellis --skip-all, then overlay repair", async (t) => {
  const dir = project(t);
  const order = [];
  const r = await runUpdateLifecycle({ project: dir, force: true, stdinIsTTY: false, stdoutIsTTY: false }, {
    updateMaw: (opts) => { order.push(["mawf", opts]); return { copied: [] }; },
    runTrellis: (opts) => { order.push(["trellis", opts]); return { stage: "trellis update", ok: true, args: ["update", "--skip-all"] }; },
    repairOverlays: () => { order.push(["repair"]); return { repaired: 1 }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order.map((x) => x[0]), ["mawf", "trellis", "repair"]);
  assert.equal(order[0][1].force, true);
});

test("update with Trellis unselected explicitly skips only Trellis", async (t) => {
  const dir = project(t, false);
  let trellisCalls = 0;
  const r = await runUpdateLifecycle({ project: dir }, {
    updateMaw: () => ({ copied: ["x"] }),
    runTrellis: () => { trellisCalls++; throw new Error("must not run"); },
    repairOverlays: () => ({ repaired: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(trellisCalls, 0);
  const skipped = r.stages.find((s) => s.stage === "trellis update");
  assert.equal(skipped?.skipped, true);
  assert.match(skipped.reason, /Not selected or native workspace/);
});

test("failed possibly-partial Trellis update still repairs overlays and fails overall", async (t) => {
  const dir = project(t);
  const order = [];
  const r = await runUpdateLifecycle({ project: dir }, {
    updateMaw: () => { order.push("mawf"); return { copied: [] }; },
    runTrellis: () => { order.push("trellis"); return { stage: "trellis update", ok: false, status: 2 }; },
    repairOverlays: () => { order.push("repair"); return { repaired: 1 }; },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(order, ["mawf", "trellis", "repair"]);
});

test("overlay repair failure is reported as an overall lifecycle failure", async (t) => {
  const dir = project(t);
  const r = await runUpdateLifecycle({ project: dir }, {
    updateMaw: () => ({ copied: [] }),
    runTrellis: () => ({ stage: "trellis update", ok: true }),
    repairOverlays: () => ({ ok: false, repaired: 0, errors: [new Error("read-only")] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stages.at(-1).stage, "mawf overlay repair");
  assert.equal(r.stages.at(-1).ok, false);
});

test("overlay repair errors retain structured operation, target, code, and message", async (t) => {
  const dir = project(t);
  // both overlays are selected explicitly: an unselected overlay is not repaired
  for (const id of ["cross-host-advise", "grill"]) setIntegration(dir, id, true);
  const writeError = Object.assign(new Error("managed file is read-only"), { code: "EACCES" });
  const grillError = Object.assign(new Error("wrapper replace failed"), { code: "EPERM" });
  const r = await repairMawOverlays(dir, {
    writeManagedBlocks: () => { throw writeError; },
    readRegistry: () => ({}),
    resolveWatchList: () => [],
    applyGrillSwap: () => { throw grillError; },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    { operation: "managed blocks", target: dir, code: "EACCES", message: "managed file is read-only" },
    { operation: "grill overlay", target: dir, code: "EPERM", message: "wrapper replace failed" },
  ]);
});

for (const command of ["update", "upgrade"]) {
  test(`${command} CLI reports overlay failure without a re-ensured claim and exits nonzero`, async (t) => {
    const dir = project(t);
    setIntegration(dir, "cross-host-advise", true);
    const error = { operation: "managed blocks", target: dir, code: "EACCES", message: "read-only" };
    // v1 has no `out` seam and no runUpdate/UpgradeLifecycle override: the CLI
    // runs the real lifecycle over the injected product/overlay seams, emits one
    // JSON object, and `main` resolves to the process exit code.
    const { value, text } = await captureStdout(() => main([command, "--project", dir], {
      updateMaw: () => ({ ok: true, copied: [] }),
      upgradeMaw: () => ({ ok: true, output: [], mode: "npm" }),
      runTrellis: () => ({ stage: `trellis ${command}`, ok: true }),
      repairOverlays: () => ({ ok: false, repaired: 0, errors: [error] }),
    }));
    assert.equal(value, 1);
    const report = JSON.parse(text);
    assert.equal(report.ok, false);
    const stage = report.stages.at(-1);
    assert.equal(stage.stage, "mawf overlay repair");
    assert.equal(stage.ok, false);
    assert.deepEqual(stage.errors, [error]);
    assert.equal(stage.repaired, 0, "a failed repair never claims a re-ensured overlay");
  });
}

test("upgrade orders MAWF, Trellis CLI, then overlay repair", async (t) => {
  const dir = project(t);
  const order = [];
  const r = await runUpgradeLifecycle({ project: dir, tag: "beta", stdinIsTTY: true, stdoutIsTTY: true }, {
    upgradeMaw: (opts) => { order.push(["mawf", opts]); return { ok: true, output: [], mode: "npm" }; },
    runTrellis: (opts) => { order.push([opts.command, opts]); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { order.push(["repair"]); return { repaired: 0 }; },
  });
  assert.equal(r.ok, true);
  // v1 chains one Trellis command; MAWF's own overlay repair replaced the
  // separate Trellis project-update stage (see report open question 3).
  assert.deepEqual(order.map((x) => x[0]), ["mawf", "upgrade", "repair"]);
  assert.equal(order[0][1].tag, "beta");
});

// Known 1.0.0 gap, kept visible instead of deleted: both lifecycles hand their
// whole option object (MAWF-only --force/--tag and the resolved settings
// included) to the Trellis runner. Today's runner reads none of those keys.
test("MAWF-only lifecycle flags stay out of the Trellis runner", { todo: "1.0.0 passes the full option object to the Trellis runner; isolating it is tracked for 1.0.x" }, async (t) => {
  const dir = project(t);
  const seen = [];
  const deps = {
    updateMaw: () => ({ copied: [] }),
    upgradeMaw: () => ({ ok: true, output: [], mode: "npm" }),
    runTrellis: (opts) => { seen.push(opts); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => ({ repaired: 0 }),
  };
  await runUpdateLifecycle({ project: dir, force: true }, deps);
  await runUpgradeLifecycle({ project: dir, tag: "beta" }, deps);
  assert.equal("force" in seen[0], false, "MAWF --force must not cross into Trellis");
  assert.equal("tag" in seen[1], false, "MAWF --tag must not cross into Trellis");
});

test("MAWF upgrade failure prevents every Trellis stage", async (t) => {
  const dir = project(t);
  let calls = 0;
  const r = await runUpgradeLifecycle({ project: dir }, {
    upgradeMaw: () => ({ ok: false, output: [], error: "dirty" }),
    runTrellis: () => { calls++; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});

test("upgrade dry-run previews both products without repair mutation", async (t) => {
  const dir = project(t);
  const calls = [];
  const r = await runUpgradeLifecycle({ project: dir, dryRun: true }, {
    upgradeMaw: (opts) => { calls.push(["mawf", opts.dryRun]); return { ok: true, output: [], mode: "checkout" }; },
    runTrellis: (opts) => { calls.push([opts.command, opts.dryRun]); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { throw new Error("dry-run must not repair"); },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [["mawf", true], ["upgrade", true]]);
});

test("--no-apply-templates still upgrades Trellis CLI but skips the overlay repair", async (t) => {
  const dir = project(t);
  const calls = [];
  const r = await runUpgradeLifecycle({ project: dir, applyTemplates: false }, {
    upgradeMaw: () => ({ ok: true, output: [], mode: "checkout" }),
    runTrellis: (opts) => { calls.push(opts.command); return { stage: `trellis ${opts.command}`, ok: true }; },
    repairOverlays: () => { throw new Error("templates disabled"); },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["upgrade"]);
});

test("upgrade --dry-run leaves a legacy .maw project untouched", async (t) => {
  const dir = project(t, false);
  fs.mkdirSync(path.join(dir, ".maw"));
  // 1.0.0 renames a pre-0.6 `.maw` layout nowhere (CHANGELOG 1.0.0), and a
  // dry run must not create the `.mawf` workspace either.
  const { value } = await captureStdout(() => main(["upgrade", "--dry-run", "--project", dir], {
    upgradeMaw: () => ({ ok: true, output: ["dry-run fixture"], mode: "fixture" }),
    repairOverlays: () => { throw new Error("dry-run must not repair"); },
  }));
  assert.equal(value, 0);
  assert.ok(fs.existsSync(path.join(dir, ".maw")));
  assert.ok(!fs.existsSync(path.join(dir, ".mawf")));
});
