import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPiResources, readPiMcps, readPiRunner } from "../src/pi-resources.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf pi resources "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const piDir = path.join(root, "global"), projectDir = path.join(root, "project"), homeDir = path.join(root, "home");
  const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v)); };
  return { root, piDir, projectDir, homeDir, write };
}

test("Pi scoped npm manifests and package filters preserve disabled state without executing extensions", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "npm", "node_modules", "@monotykamary", "pi-vcc");
  f.write(path.join(f.piDir, "settings.json"), { packages: [{ source: "npm:@monotykamary/pi-vcc@0.8.8", skills: ["content/**", "!content/hidden", "+content/hidden/SKILL.md"], extensions: [] }] });
  f.write(path.join(root, "package.json"), { name: "@monotykamary/pi-vcc", pi: { skills: ["content"], extensions: ["index.ts"] } });
  f.write(path.join(root, "content", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---");
  f.write(path.join(root, "content", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden\n---");
  f.write(path.join(root, "content", "review", "notes.md"), "Supporting docs, not another skill.");
  f.write(path.join(root, "skills", "wrong", "SKILL.md"), "Not declared by the manifest");
  f.write(path.join(root, "index.ts"), "throw new Error('DO NOT EXECUTE');");
  const result = readPiResources(f);
  assert.deepEqual(result.resources.filter((r) => r.type === "skills").map((r) => r.name).sort(), ["hidden", "review"]);
  assert.ok(result.resources.filter((r) => r.type === "skills").every((r) => r.enabled));
  assert.equal(result.resources.find((r) => r.type === "extensions").status, "disabled");
  assert.ok(result.resources.every((r) => r.loaded === false));
  assert.equal(result.plugins[0].installed, true);
});

test("Pi global/project package identity, npm scopes, local paths and git refs resolve without installation", (t) => {
  const f = fixture(t), local = path.join(f.piDir, "archify"), git = path.join(f.projectDir, ".pi", "git", "github.com", "owner", "repo");
  f.write(path.join(f.piDir, "settings.json"), { packages: ["./archify", "npm:pi-lens@1.0.0", "git:git@github.com:owner/repo@v1"] });
  f.write(path.join(f.projectDir, ".pi", "settings.json"), { packages: ["npm:pi-lens@2.0.0", "https://github.com/owner/repo@v2", "npm:pi-web-access"] });
  f.write(path.join(local, "skills", "architecture", "SKILL.md"), "skill");
  f.write(path.join(git, "extensions", "index.ts"), "throw new Error('not executed');");
  f.write(path.join(f.projectDir, ".pi", "npm", "node_modules", "pi-lens", "skills", "inspect", "SKILL.md"), "skill");
  const result = readPiResources(f);
  assert.equal(result.plugins.filter((r) => r.name === "pi-lens").length, 1);
  assert.equal(result.plugins.find((r) => r.name === "pi-lens").origin, "project");
  assert.equal(result.plugins.find((r) => r.name === "pi-web-access").status, "missing");
  assert.equal(result.plugins.filter((r) => r.name === "github.com/owner/repo").length, 1);
  assert.equal(result.resources.find((r) => r.name === "index").trust, "project-trust-required");
  assert.ok(result.resources.some((r) => r.name === "architecture"));
});

test("Pi project autoload:false applies filters to global package and preserves installed-but-unconfigured state", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "npm", "node_modules", "pi-autoresearch");
  f.write(path.join(f.piDir, "settings.json"), { packages: ["npm:pi-autoresearch"] });
  f.write(path.join(f.projectDir, ".pi", "settings.json"), { packages: [{ source: "npm:pi-autoresearch", autoload: false, skills: ["-skills/research"] }] });
  f.write(path.join(root, "skills", "research", "SKILL.md"), "skill");
  f.write(path.join(f.piDir, "npm", "package.json"), { dependencies: { "pi-openai-fast-mode": "1.0.0" } });
  f.write(path.join(f.piDir, "npm", "node_modules", "pi-openai-fast-mode", "extensions", "index.ts"), "throw new Error('not executed');");
  const result = readPiResources(f);
  assert.equal(result.resources.find((r) => r.name === "research").enabled, false);
  assert.equal(result.resources.find((r) => r.name === "research").trust, "project-trust-required");
  const discovered = result.resources.find((r) => r.source === "npm:pi-openai-fast-mode");
  assert.equal(discovered.status, "discovered");
  assert.equal(discovered.enabled, false);
});

test("Pi glob manifests exclude support docs; local resources and explicit files preserve filter state", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "bundle");
  f.write(path.join(f.piDir, "settings.json"), { packages: ["./bundle"], extensions: ["-extensions/off.ts", "./custom.ts"], skills: ["./custom-skills"] });
  f.write(path.join(root, "package.json"), { pi: { skills: ["skills/**/SKILL.md", "!skills/skip/**"] } });
  for (const n of ["keep", "skip"]) f.write(path.join(root, "skills", n, "SKILL.md"), "skill");
  f.write(path.join(f.piDir, "extensions", "off.ts"), "throw new Error('not executed');");
  f.write(path.join(f.piDir, "custom.ts"), "throw new Error('not executed');");
  f.write(path.join(f.piDir, "custom-skills", "standalone.md"), "---\ndescription: Standalone\n---");
  const result = readPiResources(f);
  assert.ok(result.resources.some((r) => r.name === "keep"));
  assert.ok(!result.resources.some((r) => r.name === "skip"));
  assert.equal(result.resources.find((r) => r.name === "off").status, "disabled");
  assert.ok(result.resources.some((r) => r.name === "custom" && r.enabled));
  assert.ok(result.resources.some((r) => r.name === "standalone"));
});

test("Pi runner readiness stays unverified for configured/disabled/discovered package states", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "npm", "node_modules", "pi-subagents-lite");
  assert.equal(readPiRunner(f).status, "unknown");
  f.write(path.join(f.piDir, "settings.json"), { packages: ["npm:pi-subagents-lite"] });
  assert.equal(readPiRunner(f).status, "missing");
  f.write(path.join(root, "extensions", "index.ts"), "throw new Error('not executed');");
  assert.equal(readPiRunner(f).status, "configured");
  assert.equal(readPiRunner(f).tool, "Agent");
  assert.equal(readPiRunner(f).ready, false);
  f.write(path.join(f.piDir, "settings.json"), { packages: [{ source: "npm:pi-subagents-lite", extensions: [] }] });
  assert.equal(readPiRunner(f).status, "disabled");
});

test("Pi MCP six-layer merge keeps disabled patches/provenance and never exposes secrets or live claims", (t) => {
  const f = fixture(t);
  const files = [path.join(f.homeDir, ".config", "mcp", "mcp.json"), path.join(f.homeDir, ".agents", "mcp.json"), path.join(f.homeDir, ".agents", "mcp", "mcp.json"), path.join(f.piDir, "mcp.json"), path.join(f.projectDir, ".mcp.json"), path.join(f.projectDir, ".pi", "mcp.json")];
  for (const [i, p] of files.entries()) f.write(p, { mcpServers: { same: i === 0 ? { command: "secret-command", args: ["SECRET"], env: { TOKEN: "SECRET" } } : i === 3 ? { url: "https://SECRET", headers: { Authorization: "SECRET" }, disabled: true } : i === 5 ? { disabled: false } : { disabled: true }, [`layer${i}`]: { disabled: i === 1 ? "true" : true } } });
  f.write(path.join(f.homeDir, ".claude.json"), { mcpServers: { unrelated: { command: "do-not-import" } } });
  const rows = readPiMcps(f), same = rows.find((r) => r.name === "same");
  assert.equal(same.provenance.length, 6);
  assert.equal(same.source, "pi-project");
  assert.equal(same.transport, "http");
  assert.equal(same.disabled, false);
  assert.equal(same.status, "configured");
  assert.equal(same.trust, "project-trust-required");
  assert.equal(rows.find((r) => r.name === "layer1").disabled, false);
  assert.equal(rows.some((r) => r.name === "unrelated"), false);
  assert.ok(rows.every((r) => !r.connected));
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
  assert.ok(!JSON.stringify(rows).includes("secret-command"));
});

test("Pi extension folders expose entry points and exact exclusions win regardless of order", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "bundle");
  f.write(path.join(f.piDir, "settings.json"), { packages: [{ source: "./bundle", extensions: ["-extensions/one/index.ts", "+extensions/one/index.ts"] }] });
  f.write(path.join(root, "extensions", "one", "index.ts"), "throw new Error('not executed');");
  f.write(path.join(root, "extensions", "one", "support.ts"), "Supporting module, not an extension");
  f.write(path.join(root, "extensions", "two", "package.json"), { pi: { extensions: ["main.ts"] } });
  f.write(path.join(root, "extensions", "two", "main.ts"), "throw new Error('not executed');");
  f.write(path.join(root, "extensions", "two", "support.ts"), "Supporting module");
  const rows = readPiResources(f).resources;
  assert.equal(rows.filter((r) => r.type === "extensions").length, 2);
  assert.equal(rows.find((r) => r.name === "index").enabled, false);
  assert.equal(rows.find((r) => r.name === "main").enabled, true);
});

test("Pi empty project autoload delta preserves global resource selection", (t) => {
  const f = fixture(t), root = path.join(f.piDir, "npm", "node_modules", "pi-lens");
  f.write(path.join(f.piDir, "settings.json"), { packages: ["npm:pi-lens"] });
  f.write(path.join(root, "skills", "inspect", "SKILL.md"), "skill");
  f.write(path.join(f.projectDir, ".pi", "settings.json"), { packages: [{ source: "npm:pi-lens", autoload: false, skills: [] }] });
  assert.equal(readPiResources(f).resources.find((r) => r.name === "inspect").enabled, true);
});

test("Pi Git package inventory redacts URL credentials and query/fragment tokens while retaining refs", (t) => {
  const f = fixture(t);
  f.write(path.join(f.piDir, "settings.json"), { packages: [
    "https://secret-user:SENTINEL_PASSWORD@github.com/owner/one.git@v1?token=SENTINEL_QUERY#SENTINEL_FRAGMENT",
    { source: "git:https://secret-user:SENTINEL_SECOND@github.com/owner/two@v2" },
    "ssh://git@github.com/owner/three@v3?token=SENTINEL_SSH",
  ] });
  for (const name of ["one", "two", "three"]) f.write(path.join(f.piDir, "git", "github.com", "owner", name, "skills", name, "SKILL.md"), "skill");
  const result = readPiResources(f);
  assert.deepEqual(result.plugins.map((p) => p.source), ["git:github.com/owner/one@v1", "git:github.com/owner/two@v2", "git:github.com/owner/three@v3"]);
  assert.equal(result.resources.filter((r) => r.type === "skills").length, 3);
  assert.ok(!JSON.stringify(result).includes("SENTINEL"));
  assert.ok(!JSON.stringify(result).includes("secret-user"));
  assert.ok(result.resources.every((r) => r.source.startsWith("git:github.com/owner/")));
});


test("Pi malformed JSON document shapes degrade to empty evidence", (t) => {
  const f = fixture(t);
  f.write(path.join(f.piDir, "settings.json"), null);
  assert.deepEqual(readPiResources(f).resources, []);
  f.write(path.join(f.piDir, "settings.json"), { packages: ["./bundle"] });
  f.write(path.join(f.piDir, "bundle", "package.json"), null);
  assert.doesNotThrow(() => readPiResources(f));
});
