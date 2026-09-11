import { setHome } from "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, update } from "../src/installer.js";
import { parseYamlSubset } from "../src/util.js";

const names = ["mawf-cost-guard", "mawf-graph", "mawf-loop", "mawf-orchestration", "mawf-planner"];
const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));
function metadata(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, "skill must begin with YAML frontmatter");
  const data = parseYamlSubset(match[1]);
  assert.equal(typeof data.name, "string");
  assert.equal(typeof data.description, "string", "description is required");
  assert.ok(data.description.trim(), "description must not be empty");
  return data;
}
for (const name of names) {
  test(`${name} distributed skill has usable Pi metadata with LF and CRLF`, () => {
    const source = fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    const lf = source.replace(/\r\n/g, "\n");
    assert.equal(metadata(lf).name, name);
    assert.deepEqual(metadata(lf.replace(/\n/g, "\r\n")), metadata(lf));
  });
}
test("skill metadata regression rejects missing and empty descriptions", () => {
  for (const text of ["# skill", "---\nname: x\n---\n", "---\nname: x\ndescription: ''\n---\n"]) {
    assert.throws(() => metadata(text));
  }
});
test("Pi install and update distribute valid shared skills without replacing user skills", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-skill-metadata-"));
  const restore = setHome(home);
  t.after(() => { restore(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  process.env.MAW_HOST = "pi";
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_AGENT_DIR;
  const piDir = path.join(home, ".pi", "agent");
  const userSkill = path.join(piDir, "skills", "user-kept", "SKILL.md");
  fs.mkdirSync(path.dirname(userSkill), { recursive: true });
  fs.writeFileSync(userSkill, "# user content\n");
  const options = { piDir, claudeDir: path.join(home, "absent-claude"), projectDir: home };
  assert.equal(install(options).ok, true);
  for (const name of names) {
    const file = path.join(piDir, "skills", name, "SKILL.md");
    assert.equal(metadata(fs.readFileSync(file, "utf8")).name, name);
    fs.writeFileSync(file, "# outdated template\n");
  }
  assert.equal(update(options).ok, true);
  for (const name of names) {
    const installed = fs.readFileSync(path.join(piDir, "skills", name, "SKILL.md"), "utf8");
    assert.equal(metadata(installed).name, name);
    assert.equal(installed, fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8"));
  }
  assert.equal(fs.readFileSync(userSkill, "utf8"), "# user content\n");
});
