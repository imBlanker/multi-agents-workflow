import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { checkGuard } from "../bin/guard.mjs";
import { BUNDLED_CLI, materializePluginAssets } from "../src/pluginassets.js";

test("guard allows only successful ALLOW and fails closed on every launcher failure", () => {
  const runner = (result) => () => result;
  assert.equal(checkGuard("{}", { runner: runner({ status: 0, stdout: "ALLOW spawn: 3 slots\n" }) }), true);
  for (const result of [{ status: 0, stdout: "DENY spawn" }, { status: 7, stdout: "ALLOW spawn" }, { error: new Error("missing") }, { status: 0, stdout: "unknown" }]) {
    assert.equal(checkGuard("{}", { runner: runner(result) }), false);
  }
  for (const input of ["{", "null", "[]", '{"cwd":1}', '{"cwd":"relative"}']) assert.equal(checkGuard(input), false);
  assert.equal(checkGuard("{}", { runner: () => { throw new Error("failed"); } }), false);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf hook 椤圭洰-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "plugin", "hooks"), { recursive: true });
  const repo = fileURLToPath(new URL("../", import.meta.url));
  fs.copyFileSync(path.join(repo, "bin", "guard.mjs"), path.join(root, "bin", "guard.mjs"));
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
  fs.mkdirSync(path.join(root, "plugin"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function main(args){ console.log(JSON.stringify(args)); }");
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
