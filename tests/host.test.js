import "./fixtures/test-env.mjs";
// @ts-check
// Tests for host detection (Claude Code / Codex / Pi Agent / DeepSeek Harness)
// and capability flags.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectHost, hostCapabilities } from "../src/host.js";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-host-"));
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

test("detectHost: pi home -> app=pi with pi capabilities and dirs", () => {
  const home = tmpHome();
  const piDir = mk(path.join(home, ".pi", "agent"));
  const projectDir = mk(path.join(home, "project"));
  const h = detectHost({
    piDir,
    projectDir,
    dshHome: path.join(home, ".dsh"),
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
  });
  assert.equal(h.app, "pi");
  assert.equal(h.homeDir, piDir);
  assert.equal(h.hasSubagents, true);
  assert.equal(h.hasMultiAgent, true);
  assert.equal(h.hasDynamicWorkflow, true);
  assert.equal(h.hasGraphWorkflow, false);
  // global + project pi dirs both wired
  assert.ok(h.agentsDirs.some((d) => d === path.join(piDir, "agents")));
  assert.ok(h.agentsDirs.some((d) => d === path.join(projectDir, ".pi", "agents")));
  assert.ok(h.commandsDirs.some((d) => d === path.join(piDir, "prompts")));
  assert.ok(h.commandsDirs.some((d) => d === path.join(projectDir, ".pi", "prompts")));
  assert.ok(h.skillsDirs.some((d) => d === path.join(projectDir, ".agents", "skills")));
  assert.ok(h.extensionsDirs.some((d) => d === path.join(piDir, "extensions")));
  assert.ok(h.extensionsDirs.some((d) => d === path.join(projectDir, ".pi", "extensions")));
  assert.ok(h.detected.some((s) => s.includes("Pi Agent home")));
  const caps = hostCapabilities(h);
  assert.ok(caps.includes("subagents"));
  assert.ok(caps.includes("multi-agent"));
  assert.ok(caps.includes("dynamic-workflow"));
});

test("detectHost: MAW_HOST=pi forces pi even when ~/.claude also exists", () => {
  const home = tmpHome();
  mk(path.join(home, ".claude")); // claude also present
  const piDir = mk(path.join(home, ".pi", "agent"));
  const projectDir = mk(path.join(home, "project"));
  process.env.MAW_HOST = "pi";
  try {
    const h = detectHost({
      piDir,
      projectDir,
      dshHome: path.join(home, ".dsh"),
      claudeDir: path.join(home, ".claude"),
      codexDir: path.join(home, ".codex"),
    });
    assert.equal(h.app, "pi");
    assert.equal(h.homeDir, piDir);
  } finally {
    delete process.env.MAW_HOST;
  }
});

test("detectHost: both claude + pi, no override -> claude-code precedence, pi still detected", () => {
  const home = tmpHome();
  const claudeDir = mk(path.join(home, ".claude"));
  const piDir = mk(path.join(home, ".pi", "agent"));
  const projectDir = mk(path.join(home, "project"));
  const h = detectHost({ claudeDir, piDir, projectDir, dshHome: path.join(home, ".dsh"), codexDir: path.join(home, ".codex") });
  assert.equal(h.app, "claude-code");
  assert.equal(h.homeDir, claudeDir);
  assert.ok(h.detected.some((s) => s.includes("Pi Agent home")));
  // pi dirs still listed (union) even though claude wins app
  assert.ok(h.agentsDirs.some((d) => d === path.join(piDir, "agents")));
  assert.ok(h.extensionsDirs.some((d) => d === path.join(piDir, "extensions")));
});

test("detectHost: claude-only detection unchanged (regression)", () => {
  const home = tmpHome();
  const claudeDir = mk(path.join(home, ".claude"));
  const h = detectHost({
    claudeDir,
    piDir: path.join(home, ".pi", "agent"),
    dshHome: path.join(home, ".dsh"),
    codexDir: path.join(home, ".codex"),
    projectDir: home,
  });
  assert.equal(h.app, "claude-code");
  assert.equal(h.hasSubagents, true);
  assert.equal(h.hasMultiAgent, true);
  assert.equal(h.hasDynamicWorkflow, true);
  assert.equal(h.extensionsDirs.length, 0);
  assert.ok(!h.detected.some((s) => s.includes("Pi Agent")));
});

test("detectHost: nothing installed -> unknown", () => {
  const home = tmpHome();
  const h = detectHost({
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    dshHome: path.join(home, ".dsh"),
    projectDir: home,
  });
  assert.equal(h.app, "unknown");
  assert.equal(h.hasSubagents, false);
  assert.equal(h.extensionsDirs.length, 0);
});

test("detectHost: dsh home with settings.yaml -> app=dsh with capabilities and dirs", () => {
  const home = tmpHome();
  const dshHome = mk(path.join(home, ".dsh"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  const h = detectHost({
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    dshHome,
    projectDir: home,
  });
  assert.equal(h.app, "dsh");
  assert.equal(h.homeDir, dshHome);
  assert.equal(h.dshHome, dshHome);
  assert.ok(h.dshBinary === null || typeof h.dshBinary === "string"); // binary reported, not required
  assert.equal(h.hasSubagents, true);
  assert.equal(h.hasMultiAgent, true);
  assert.equal(h.hasDynamicWorkflow, true);
  assert.equal(h.hasGraphWorkflow, false);
  assert.ok(h.skillsDirs.some((d) => d === path.join(dshHome, "skills")));
  // no named agent-definition surface for dsh — no dsh agents/commands dirs
  assert.ok(!h.agentsDirs.some((d) => d.startsWith(dshHome)));
  assert.ok(!h.commandsDirs.some((d) => d.startsWith(dshHome)));
  assert.ok(h.detected.some((s) => s.includes("DeepSeek Harness (dsh) home")));
  const caps = hostCapabilities(h);
  assert.ok(caps.includes("subagents"));
  assert.ok(caps.includes("multi-agent"));
  assert.ok(caps.includes("dynamic-workflow"));
});

test("detectHost: profiles/-only dsh home still detected (weak marker)", () => {
  const home = tmpHome();
  mk(path.join(home, ".dsh", "profiles", "web"));
  const dshHome = path.join(home, ".dsh");
  const h = detectHost({
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    dshHome,
    projectDir: home,
  });
  assert.equal(h.app, "dsh");
  assert.ok(h.detected.some((s) => s.includes("DeepSeek Harness (dsh) home")));
});

test("detectHost: bare ~/.dsh without settings.yaml or profiles/ is NOT dsh", () => {
  const home = tmpHome();
  const dshHome = mk(path.join(home, ".dsh")); // empty dir (e.g. npx boot artifact)
  const h = detectHost({
    claudeDir: path.join(home, ".claude"),
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    dshHome,
    projectDir: home,
  });
  assert.equal(h.app, "unknown");
  assert.equal(h.dshHome, "");
  assert.ok(!h.detected.some((s) => s.includes("DeepSeek Harness")));
});

test("detectHost: MAW_HOST=dsh forces dsh even when ~/.claude also exists", () => {
  const home = tmpHome();
  mk(path.join(home, ".claude")); // claude also present
  const dshHome = mk(path.join(home, ".dsh"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  process.env.MAW_HOST = "dsh";
  try {
    const h = detectHost({
      claudeDir: path.join(home, ".claude"),
      codexDir: path.join(home, ".codex"),
      piDir: path.join(home, ".pi", "agent"),
      dshHome,
      projectDir: home,
    });
    assert.equal(h.app, "dsh");
    assert.equal(h.homeDir, dshHome);
  } finally {
    delete process.env.MAW_HOST;
  }
});

test("detectHost: claude + dsh, no override -> claude-code precedence, dsh still detected", () => {
  const home = tmpHome();
  const claudeDir = mk(path.join(home, ".claude"));
  const dshHome = mk(path.join(home, ".dsh"));
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");
  const h = detectHost({
    claudeDir,
    codexDir: path.join(home, ".codex"),
    piDir: path.join(home, ".pi", "agent"),
    dshHome,
    projectDir: home,
  });
  assert.equal(h.app, "claude-code");
  assert.equal(h.homeDir, claudeDir);
  assert.ok(h.detected.some((s) => s.includes("DeepSeek Harness (dsh) home")));
  // dsh user skills root still listed (union) even though claude wins app
  assert.ok(h.skillsDirs.some((d) => d === path.join(dshHome, "skills")));
});
