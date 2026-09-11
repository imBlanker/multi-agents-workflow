import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { status, findCodexBinary, findCodexCompanion, shouldReview, runReview } from "../src/codex.js";

// CI runners do not have the codex CLI or codex-plugin-cc installed; skip the
// environment-dependent tests there so CI stays green. (findCodexBinary/
// findCodexCompanion are read-only probes.)
const HAS = (() => { try { return { bin: findCodexBinary(), comp: findCodexCompanion() }; } catch { return {}; } })();
const HAVE_CODEX = !!(HAS.bin && HAS.comp);

test("status reports binary + companion presence", { skip: !HAVE_CODEX }, () => {
  const s = status();
  assert.equal(typeof s.ready, "boolean");
  // On a dev machine codex + plugin are installed.
  assert.ok(s.binary, "codex binary expected on this machine");
  assert.ok(s.companion, "codex-plugin-cc companion expected on this machine");
});

test("findCodexCompanion returns a .mjs path under the claude plugins dir", { skip: !HAS.comp }, () => {
  const c = findCodexCompanion();
  assert.ok(c);
  assert.match(c, /codex-companion\.mjs$/);
  assert.ok(c.startsWith(path.join(os.homedir(), ".claude", "plugins")));
});

test("shouldReview respects plan gates", () => {
  const plan = { codex: { enabled: true }, reviewPoints: [{ by: "codex", scope: "auto", label: "post-implementation review" }] };
  const yes = shouldReview(plan, { after: "post-implementation" });
  assert.equal(yes.review, true);
  assert.equal(yes.scope, "auto");
  const no = shouldReview(plan, { after: "nonexistent" });
  assert.equal(no.review, false);
});

test("shouldReview declines when codex not enabled", () => {
  const plan = { codex: { enabled: false }, reviewPoints: [{ by: "codex", scope: "auto", label: "x" }] };
  const r = shouldReview(plan, { after: "x" });
  assert.equal(r.review, false);
});

test("runReview with no companion returns a graceful not-found result", () => {
  // Empty companion path forces the not-found branch without spawning node.
  const r = runReview({ companion: "", scope: "auto" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /companion script not found/);
});

test("runReview passes the selected project as child cwd", () => {
  const project = path.join(os.tmpdir(), "mawf review project");
  let received;
  const result = runReview({ companion: "C:/tmp/companion.mjs", cwd: project, spawnFn: (bin, args, options) => {
    received = { bin, args, options };
    return { status: 0, stdout: "review ok", stderr: "" };
  } });
  assert.equal(result.ok, true);
  assert.equal(received.options.cwd, project);
  assert.equal(received.args[1], "review");
});
