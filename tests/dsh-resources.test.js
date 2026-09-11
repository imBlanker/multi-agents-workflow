import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dshSkillRoots, readDshSkills, readDshPresets } from "../src/dsh-resources.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf dsh resources "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "repo");
  const dshHome = path.join(root, "dsh");
  const agentsHome = path.join(root, "agents");
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  return { projectDir, dshHome, agentsHome, env: {} };
}
function skill(file, name, flags = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\r\nname: ${name}\r\ndescription: Use for fixture testing.\r\n${flags}---\r\nBody.`);
}

test("dsh default roots use nearest repository, environment agents root and documented priorities", (t) => {
  const o = fixture(t);
  const roots = dshSkillRoots({ ...o, projectDir: path.join(o.projectDir, "nested", "work"), agentsHome: undefined, env: { DSH_AGENTS_HOME: o.agentsHome } });
  assert.deepEqual(roots.map((r) => r.rank), [100, 200, 400, 500]);
  assert.equal(roots[0].path, path.join(o.projectDir, ".dsh", "skills"));
  assert.equal(roots[3].path, path.join(o.agentsHome, "skills"));
});

test("dsh skill discovery preserves precedence and invocation flags, skips nested/system/invalid metadata", (t) => {
  const o = fixture(t);
  const roots = dshSkillRoots(o);
  skill(path.join(roots[0].path, "shared", "SKILL.md"), "shared", "disable-model-invocation: yes\r\nuser-invocable: false\r\n");
  skill(path.join(roots[2].path, "shared.md"), "shared");
  skill(path.join(roots[2].path, ".system", "SKILL.md"), "system");
  skill(path.join(roots[1].path, "nested", "deeper", "SKILL.md"), "nested");
  skill(path.join(roots[3].path, "flat.md"), "flat");
  skill(path.join(roots[3].path, "invalid.md"), "invalid", "user-invocable: maybe\r\n");
  fs.writeFileSync(path.join(roots[3].path, "README.md"), "# Not a skill");
  const rows = readDshSkills(o);
  assert.equal(rows.length, 3);
  const winner = rows.find((r) => r.name === "shared" && r.rank === 100);
  assert.equal(winner.status, "discovered");
  assert.equal(winner.modelInvocable, false);
  assert.equal(winner.userInvocable, false);
  assert.equal(winner.loaded, null);
  const shadow = rows.find((r) => r.name === "shared" && r.rank === 400);
  assert.equal(shadow.status, "shadowed");
  assert.equal(shadow.shadowedBy, winner.path);
  assert.equal(rows.find((r) => r.name === "flat").userInvocable, true);
});

test("dsh preset library is staged metadata only; JS-tagged payloads never execute", (t) => {
  const o = fixture(t);
  const dir = path.join(o.dshHome, "agent-presets", "example");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preset.yaml"), "payload: !!js throw new Error('must not execute')");
  const rows = readDshPresets(o);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "staged");
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].source, "agent-preset-library");
  assert.deepEqual(readDshPresets({ dshHome: path.join(o.dshHome, "missing") }), []);
});
