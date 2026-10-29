import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { candidateIdentity, checkCandidateCurrent } from "../src/verification.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mawf-candidate-git-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Git must not inherit developer config, repository overrides, filters or hooks.
  const isolated = (key) => /^GIT_/i.test(key) || ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"].includes(key);
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => isolated(key)));
  for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key];
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "empty.gitconfig"),
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (isolated(key)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const workspace = path.join(root, "repo"), empty = path.join(root, "empty-hooks-and-template");
  fs.mkdirSync(workspace); fs.mkdirSync(empty);
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
  git("init", `--template=${empty}`);
  for (const [key, value] of Object.entries({ "user.name": "MAWF fixture", "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false", "tag.gpgsign": "false", "core.hooksPath": empty,
    "core.autocrlf": "false", "core.fsmonitor": "false" })) git("config", "--local", key, value);
  const product = path.join(workspace, "product.txt");
  fs.writeFileSync(product, "original raw line\n");
  git("add", "--", "product.txt");
  git("commit", "--no-gpg-sign", "-m", "isolated fixture baseline");
  fs.writeFileSync(product, "changed raw line\n");
  const rawDiff = git("diff", "--binary", "HEAD", "--", "product.txt");
  assert.match(rawDiff, /-original raw line/);
  assert.match(rawDiff, /\+changed raw line/);
  return { root, workspace, product, git, rawDiff };
}

// Git executes configured helpers through its shell on both Linux and Windows.
const quote = (value) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";

// The helpers Git can run while it diffs through the worktree: diff drivers,
// worktree conversion filters and the fsmonitor hook.
const CALLBACKS = {
  textconv: { key: "diff.fixture.textconv", attributes: "product.txt diff=fixture\n" },
  command: { key: "diff.fixture.command", attributes: "product.txt diff=fixture\n" },
  clean: { key: "filter.fixture.clean", attributes: "product.txt filter=fixture\n" },
  process: { key: "filter.fixture.process", attributes: "product.txt filter=fixture\n" },
  fsmonitor: { key: "core.fsmonitor", attributes: null },
};

for (const [kind, callback] of Object.entries(CALLBACKS)) {
  test(`candidate capture and revalidation never execute configured Git ${kind} callbacks`, (t) => {
    const f = fixture(t);
    const marker = path.join(f.root, `${kind}-executed`);
    const helper = path.join(f.root, `${kind}-helper.cjs`);
    fs.writeFileSync(helper, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "callback executed");
process.stdout.write("callback output, not the raw candidate bytes\\n");
`);
    f.git("config", "--local", callback.key, `${quote(process.execPath)} ${quote(helper)}`);
    if (callback.attributes) fs.writeFileSync(path.join(f.workspace, ".gitattributes"), callback.attributes);

    // Positive control: an ordinary worktree diff runs the configured callback.
    // A helper that ignores Git's filter or hook protocol may fail that diff; only
    // its side effect, a marker inside this temporary fixture root, matters here.
    let control = null;
    try { f.git("diff", "--binary", "HEAD", "--", "product.txt"); } catch (error) { control = error; }
    assert.ok(fs.existsSync(marker), `the ${kind} helper must run without the protection: ${control?.stderr || control?.message || "git exited 0"}`);
    fs.unlinkSync(marker);

    const run = { snapshot: { workspace: f.workspace, effectiveConfigHash: "fixture-config" }, tasks: {} };
    const candidate = { ...candidateIdentity(run, { scope: ["product.txt"] }), implementerActorIds: [] };
    assert.equal(fs.existsSync(marker), false, "candidate capture must not execute the callback");
    assert.equal(candidate.commitSha, f.git("rev-parse", "HEAD"));
    assert.equal(checkCandidateCurrent(run, candidate).candidateId, candidate.candidateId);
    assert.equal(fs.existsSync(marker), false, "revalidation must not execute the callback");

    fs.writeFileSync(f.product, "a later raw change\n");
    assert.throws(() => checkCandidateCurrent(run, candidate), { code: "CANDIDATE_DRIFT" });
    assert.equal(fs.existsSync(marker), false, "drift checking must not execute the callback");
  });
}

test("the diff hash still names the dirty delta against the committed baseline", (t) => {
  const f = fixture(t);
  const run = { snapshot: { workspace: f.workspace, effectiveConfigHash: "fixture-config" }, tasks: {} };
  const dirty = candidateIdentity(run, { scope: ["product.txt"] });
  // The same raw bytes, once committed, are equal content but a different delta.
  f.git("commit", "--no-gpg-sign", "-am", "commit the change");
  const committed = candidateIdentity(run, { scope: ["product.txt"] });
  assert.equal(committed.contentHash, dirty.contentHash);
  assert.notEqual(committed.commitSha, dirty.commitSha);
  assert.notEqual(committed.diffHash, dirty.diffHash);
  assert.notEqual(committed.candidateId, dirty.candidateId);
});
