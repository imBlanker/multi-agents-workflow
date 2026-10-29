import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { checkGuard } from "../bin/guard.mjs";
import { setIntegration } from "../src/integrations.js";
import { BUNDLED_CLI, materializePluginAssets } from "../src/pluginassets.js";

/**
 * The cost guard polices a project only when its optional `watchdog` budget
 * observer is selected (v1 defaults every integration off; the shipped hook is
 * inert until the user opts in). Fixtures therefore select it explicitly.
 * @param {import("node:test").TestContext} t
 */
function guardedProject(t, prefix = "mawf-guard-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setIntegration(root, "watchdog", true);
  return root;
}

test("guard allows only successful ALLOW and fails closed on every launcher failure", (t) => {
  const cwd = guardedProject(t);
  const runner = (result) => () => result;
  assert.equal(checkGuard("{}", { cwd, runner: runner({ status: 0, stdout: "ALLOW spawn: 3 slots\n" }) }), true);
  for (const result of [{ status: 0, stdout: "DENY spawn" }, { status: 7, stdout: "ALLOW spawn" }, { error: new Error("missing") }, { status: 0, stdout: "unknown" }]) {
    assert.equal(checkGuard("{}", { cwd, runner: runner(result) }), false);
  }
  for (const input of ["{", "null", "[]", '{"cwd":1}', '{"cwd":"relative"}']) assert.equal(checkGuard(input, { cwd }), false);
  assert.equal(checkGuard("{}", { cwd, runner: () => { throw new Error("failed"); } }), false);
  // an unselected project is not policed at all: no launcher is consulted
  const unselected = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-guard-off-"));
  t.after(() => fs.rmSync(unselected, { recursive: true, force: true }));
  let consulted = 0;
  assert.equal(checkGuard("{}", { cwd: unselected, runner: () => { consulted++; return { status: 0, stdout: "DENY spawn" }; } }), true);
  assert.equal(consulted, 0, "an unselected budget observer never spawns the guard CLI");
});

test("guard forwards absolute Unicode project path as one argument", () => {
  const cwd = path.resolve("space 椤圭洰 & more");
  assert.equal(checkGuard(JSON.stringify({ cwd }), { runner: (bin, args) => {
    assert.equal(bin, process.execPath);
    assert.equal(args.at(-1), cwd);
    return { status: 0, stdout: "ALLOW spawn" };
  } }), true);
});

test("bundled and copied hook launchers locate shipped guard without plugin shell expansion", (t) => {
  const root = guardedProject(t, "mawf hook 椤圭洰-");
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "plugin", "hooks"), { recursive: true });
  const repo = fileURLToPath(new URL("../", import.meta.url));
  fs.copyFileSync(path.join(repo, "bin", "guard.mjs"), path.join(root, "bin", "guard.mjs"));
  // v1's guard reads the project's own integration selection, so the fixture
  // mirrors a real package layout (`bin/` beside `src/`) instead of a lone file.
  fs.cpSync(path.join(repo, "src"), path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","version":"0.0.0-fixture"}');
  fs.writeFileSync(path.join(root, "bin", "mawf.js"), "console.log(process.env.MAWF_TEST_VERDICT || 'ALLOW spawn')");
  const hook = path.join(root, "plugin", "hooks", "hooks.json");
  fs.copyFileSync(path.join(repo, "plugin", "hooks", "hooks.json"), hook);
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, "plugin"), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const launch = () => JSON.parse(fs.readFileSync(hook)).hooks.PreToolUse[0].hooks[0].command;
  const options = { env, cwd: root, input: JSON.stringify({ cwd: root }), encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] };
  execSync(launch(), options);
  assert.throws(() => execSync(launch(), { ...options, env: { ...env, CLAUDE_PLUGIN_ROOT: "" } }), (err) => err.status === 2);
  assert.throws(() => execSync(launch(), { ...options, env: { ...env, MAWF_TEST_VERDICT: "DENY spawn" } }), (err) => err.status === 2);
  materializePluginAssets([hook], root);
  delete env.CLAUDE_PLUGIN_ROOT;
  execSync(launch(), options);
  fs.unlinkSync(path.join(root, "bin", "mawf.js"));
  assert.throws(() => execSync(launch(), options), (err) => err.status === 2);
});


test("bundled CLI template resolves plugin root on the native shell and copied template removes it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf commands 项目-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "plugin"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function main(args){ console.log(JSON.stringify(args)); }");
  // v1's bundled template invokes the real `bin/mawf.js` so the host can
  // discover the slash command literally (commit 8564047).
  fs.writeFileSync(path.join(root, "bin", "mawf.js"), "import { main } from '../src/index.js';\nmain(process.argv.slice(2));\n");
  const command = path.join(root, "command.md");
  fs.writeFileSync(command, BUNDLED_CLI + " version");
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, "plugin"), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const out = execSync(BUNDLED_CLI + " plan --project .", { env, cwd: root, encoding: "utf8", timeout: 10000 });
  assert.deepEqual(JSON.parse(out), ["plan", "--project", "."]);
  materializePluginAssets([command], root);
  const rendered = fs.readFileSync(command, "utf8");
  assert.ok(!rendered.includes("CLAUDE_PLUGIN_ROOT"));
  delete env.CLAUDE_PLUGIN_ROOT;
  assert.deepEqual(JSON.parse(execSync(rendered, { env, cwd: root, encoding: "utf8", timeout: 10000 })), ["version"]);
});

test("configured cost hook intercepts Agent and legacy Task before launch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-matcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "plugin"));
  const repo = fileURLToPath(new URL("../", import.meta.url));
  fs.copyFileSync(path.join(repo, "bin", "guard.mjs"), path.join(root, "bin", "guard.mjs"));
  fs.writeFileSync(path.join(root, "bin", "mawf.js"), "console.log('DENY spawn')");
  const config = JSON.parse(fs.readFileSync(path.join(repo, "plugin", "hooks", "hooks.json"), "utf8"));
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, "plugin"), PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  for (const toolName of ["Agent", "Task", "Read", "TaskCreate", "AgentExtra"]) {
    const hooks = config.hooks.PreToolUse.filter(group => new RegExp(group.matcher).test(toolName)).flatMap(group => group.hooks);
    if (["Agent", "Task"].includes(toolName)) {
      assert.equal(hooks.length, 1, `${toolName} must reach the guard`);
      assert.throws(() => execSync(hooks[0].command, { env, cwd: root, input: JSON.stringify({ cwd: root, tool_name: toolName }), encoding: "utf8", timeout: 10000 }), err => err.status === 2);
    } else assert.equal(hooks.length, 0, `${toolName} is not a spawn`);
  }
});

test("hooks manifest fails closed at the host layer too (onFailure:block, Claude Code 2.1.288+/2.1.295 semantics)", () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(repo, "plugin", "hooks", "hooks.json"), "utf8"));
  const group = config.hooks.PreToolUse[0];
  assert.equal(group.matcher, "^(Agent|Task)$");
  for (const hook of group.hooks) assert.equal(hook.onFailure, "block");
});
