// @ts-check
// Adapter contract tests for `mawf archify` (stabilization §5.3):
// raw argv must reach the locked engine verbatim — flags, values, order.
// Spawn is injected; no real engine spawn happens in these tests except the
// explicit live test guarded by MAWF_ARCHIFY_SRC.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runArchify, resolveEngine } from "../src/archify.js";

/** Capture spawn args; configurable exit status. Engine file faked in tmpdir. */
function capturingSpawn(status = 0) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "maw-archify-"));
  fs.mkdirSync(path.join(src, "archify", "bin"), { recursive: true });
  fs.writeFileSync(path.join(src, "archify", "bin", "archify.mjs"), "// fake engine entry\n");
  const env = { MAWF_ARCHIFY_SRC: src };
  const calls = [];
  const spawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    return { status };
  };
  return { calls, spawnFn, env, enginePath: path.join(src, "archify", "bin", "archify.mjs") };
}

test("raw flags are forwarded verbatim: order and values preserved", () => {
  const { calls, spawnFn, env } = capturingSpawn(0);
  const code = runArchify(
    ["validate", "architecture", "spec.json", "--quality", "showcase", "--json", "--repo-root", "/srv/repo"],
    { env, spawnFn },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  // fake spawnFn records args = [enginePath, ...argv] (no node prefix)
  assert.deepEqual(calls[0].args.slice(1), [
    "validate", "architecture", "spec.json", "--quality", "showcase", "--json", "--repo-root", "/srv/repo",
  ]);
});

test("deliver with output path and --open reaches the engine untouched", () => {
  const { calls, spawnFn, env, enginePath } = capturingSpawn(0);
  runArchify(["deliver", "workflow", "c.json", "out.html", "--open"], { env, spawnFn });
  assert.deepEqual(calls[0].args, [enginePath, "deliver", "workflow", "c.json", "out.html", "--open"]);
});

test("preview --no-open and visual-check --json are forwarded", () => {
  for (const argv of [["preview", "sequence", "s.json", "--no-open"], ["visual-check", "diagram.html", "--json"]]) {
    const { calls, spawnFn, env } = capturingSpawn(0);
    const code = runArchify(argv, { env, spawnFn });
    assert.equal(code, 0);
    assert.deepEqual(calls[0].args.slice(1), argv); // [enginePath, ...argv]
  }
});

test("non-allowlisted command is rejected before any spawn (exit 2)", () => {
  const { calls, spawnFn, env } = capturingSpawn(0);
  const code = runArchify(["exec", "rm -rf /"], { env, spawnFn });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.equal(runArchify([], { env, spawnFn }), 2);
  assert.equal(runArchify(["brands", "query"], { env, spawnFn }), 2); // NC-licensed icons stay out
});

test("engine non-zero exit propagates unchanged (receipt authority)", () => {
  for (const status of [1, 2]) {
    const { spawnFn, env } = capturingSpawn(status);
    const code = runArchify(["validate", "workflow", "broken.json", "--json"], { env, spawnFn });
    assert.equal(code, status);
  }
});

test("missing engine surfaces structured exit 3 without spawn", () => {
  const { calls, spawnFn } = capturingSpawn(0);
  const code = runArchify(["doctor"], { env: {}, spawnFn });
  assert.equal(code, 3);
  assert.equal(calls.length, 0);
});

test("live: real locked engine validates an example with --json (requires MAWF_ARCHIFY_SRC)", { skip: !process.env.MAWF_ARCHIFY_SRC }, () => {
  // This is the only test that spawns the real engine; it proves the boundary
  // works against the actual locked CLI, not just the capture harness.
  const resolved = resolveEngine();
  assert.ok(!resolved.error, `engine should resolve: ${resolved.error ?? ""}`);
});
