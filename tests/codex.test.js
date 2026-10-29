import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { status, findCodexBinary, findCodexCompanion, shouldReview, runReview } from "../src/codex.js";
import { createRun, addTask, runtimeStatus } from "../src/runtime.js";

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

// v1 routes every review through the fenced companion adapter
// (src/adapters/companion.js startCompanion; commit 265463f): a review is a
// registered run/task with an explicit prompt specification, and the companion
// path/cwd come from the frozen task instead of caller-supplied options. The
// v0.8 `companion`/`cwd`/`spawnFn` injection seam no longer exists, so these
// two cases assert the same degradation and workspace-binding properties
// through the v1 surface.

test("runReview without a runtime run/task degrades gracefully", async () => {
  const r = await runReview({ scope: "auto" });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "TASK_CONTEXT_REQUIRED");
  assert.match(r.stderr, /run\/task and promptFile/);
  // still graceful when only the prompt specification is missing
  const noPrompt = await runReview({ runId: "r1", taskId: "t1", scope: "auto" });
  assert.equal(noPrompt.ok, false);
  assert.equal(noPrompt.reasonCode, "TASK_CONTEXT_REQUIRED");
});

test("runReview binds the review to the task's selected workspace and never launches an unselected adapter", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf review project "));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows handle */ } });
  const project = path.join(dir, "proj");
  const workspace = path.join(dir, "selected workspace");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const promptFile = path.join(dir, "prompt.txt");
  fs.writeFileSync(promptFile, "review the working tree\n");
  const stateRoot = path.join(dir, "runtime");

  await createRun({ project, stateRoot, runId: "r1", workspace });
  const added = addTask({ project, stateRoot, runId: "r1", taskId: "review-1", adapter: "codex-plugin-cc", role: "reviewer", actorId: "reviewer-1", providerId: "openai", modelId: "gpt-5.2-codex", billingMode: "api" });
  assert.equal(added.ok, true);
  // the child cwd is the task's recorded workspace, taken from the run
  // snapshot rather than a caller-supplied option, in its on-disk spelling
  // (Windows runners spell TEMP with 8.3 short names)
  assert.equal(added.task.workspace, fs.realpathSync.native(workspace));

  // codex-plugin-cc is not selected in this project, so the review reports the
  // disabled capability instead of spawning anything
  const r = await runReview({ project, stateRoot, runId: "r1", taskId: "review-1", promptFile, actorId: "reviewer-1", scope: "auto" });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "INTEGRATION_DISABLED");
  assert.equal(r.capability.id, "codex-plugin-cc");
  assert.equal(r.capability.selected, false);
  assert.equal(r.capability.compatible, false);
  // nothing was reserved: a refused review consumes no capacity
  assert.equal(runtimeStatus({ project, stateRoot }).activeCount, 0);
});
