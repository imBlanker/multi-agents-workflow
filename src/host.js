// @ts-check
// Detect the supported host agent software and its capabilities, so the
// planner can prefer native dynamic-workflow / multi-agent mechanisms when the
// host provides them instead of re-implementing them.
//
// Supported hosts are Claude Code, Codex, Pi Agent, and DeepSeek Harness
// (dsh) (project policy). Other agent software (Gemini CLI, opencode, …) is
// NOT supported; their cc-switch pricing data may still be READ for cost
// estimates.
import { findExecutable } from "./platform/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exists, readJson } from "./util.js";
import { resolvePiAgentDir } from "./piprovider.js";
import { readPiRunner } from "./pi-resources.js";

/**
 * @typedef {"claude-code"|"codex"|"pi"|"dsh"|"unknown"} HostApp
 * Note: claude-code, codex, pi, and dsh are supported. Everything else is "unknown".
 * @typedef {{
 *   app: HostApp,
 *   homeDir: string,
 *   hasSubagents: boolean,
 *   hasMultiAgent: boolean,
 *   hasDynamicWorkflow: boolean,
 *   hasGraphWorkflow: boolean,
 *   codexPluginInstalled: boolean,
 *   codexBinary: string|null,
 *   dshHome: string,
 *   dshBinary: string|null,
 *   skillsDirs: string[],
 *   commandsDirs: string[],
 *   agentsDirs: string[],
 *   extensionsDirs: string[],
 *   detected: string[]
 * }} HostInfo
 */

/** @returns {string} */
function home() {
  return os.homedir();
}

/**
 * Run a shell command, returning trimmed stdout or "" on failure.
 * @param {string} cmd
 */

/**
 * Detect installed host agent software and its capabilities.
 * @param {object} [opts]
 * @param {string} [opts.claudeDir]   override ~/.claude
 * @param {string} [opts.codexDir]    override ~/.codex
 * @param {string} [opts.piDir]       override ~/.pi/agent
 * @param {string} [opts.dshHome]     override $DSH_HOME (~/.dsh)
 * @param {string} [opts.projectDir]  override process.cwd() (for project-level .pi/ dirs)
 * @returns {HostInfo}
 */
export function detectHost(opts = {}) {
  const detected = [];
  const claudeDir = opts.claudeDir ?? path.join(home(), ".claude");
  const codexDir = opts.codexDir ?? path.join(home(), ".codex");
  const piDir = resolvePiAgentDir(opts.piDir);
  const dshHome = opts.dshHome ?? (process.env.DSH_HOME || path.join(home(), ".dsh"));
  const projectDir = opts.projectDir ?? process.cwd();
  const envHost = (process.env.MAW_HOST || "").toLowerCase();

  let /** @type {HostApp} */ app = "unknown";
  let homeDir = "";
  const skillsDirs = [];
  const commandsDirs = [];
  const agentsDirs = [];
  const extensionsDirs = [];

  if (exists(claudeDir)) {
    app = "claude-code";
    homeDir = claudeDir;
    detected.push(`Claude Code home at ${claudeDir}`);
    skillsDirs.push(path.join(claudeDir, "skills"));
    commandsDirs.push(path.join(claudeDir, "commands"));
    agentsDirs.push(path.join(claudeDir, "agents"));
  }

  // Supported hosts are Claude Code, Codex, and Pi Agent. Gemini CLI /
  // opencode / others are intentionally NOT detected as supported (they may
  // still be read for pricing).
  const codexBinary = findExecutable("codex");
  if (exists(codexDir)) {
    detected.push(`Codex home at ${codexDir}`);
    if (envHost !== "pi" && app === "unknown") { app = "codex"; homeDir = codexDir; }
    agentsDirs.push(path.join(codexDir, "agents"));
  }

  // Pi Agent manages its own config in ~/.pi/agent/ (NOT via cc-switch).
  // Detect it as a supported host; project-level .pi/ dirs + global ~/.pi/agent/
  // dirs feed the installer. MAW_HOST=pi forces app="pi" even when Claude Code
  // is also installed (otherwise Claude Code keeps precedence).
  if (exists(piDir)) {
    detected.push(`Pi Agent home at ${piDir}`);
    agentsDirs.push(path.join(projectDir, ".pi", "agents"));
    agentsDirs.push(path.join(piDir, "agents"));
    commandsDirs.push(path.join(projectDir, ".pi", "prompts"));
    commandsDirs.push(path.join(piDir, "prompts"));
    skillsDirs.push(path.join(projectDir, ".agents", "skills"));
    extensionsDirs.push(path.join(projectDir, ".pi", "extensions"));
    extensionsDirs.push(path.join(piDir, "extensions"));
    if (envHost === "pi") { app = "pi"; homeDir = piDir; }
    else if (app === "unknown") { app = "pi"; homeDir = piDir; }
  }

  // DeepSeek Harness (dsh) manages providers/models/MCP/skills/memory in its
  // own files under $DSH_HOME (~/.dsh) — NOT via cc-switch. Strong detection
  // marker: settings.yaml (the provider truth); weak fallback: profiles/.
  // A bare ~/.dsh (e.g. created by an npx boot) must NOT count. dsh has no
  // named project-level agent-definition surface (subagents spawn
  // prompt-driven via the subagent tool), so no agentsDirs entry here; MAW
  // role specs stay portable under .mawf/agents/. MAW_HOST=dsh forces app=dsh
  // even when Claude Code/Codex/Pi are also installed (otherwise dsh joins
  // last in precedence — it only claims the host when nothing else did).
  const dshBinary = findExecutable("dsh");
  const dshPresent = exists(path.join(dshHome, "settings.yaml")) || exists(path.join(dshHome, "profiles"));
  let dshDetected = "";
  if (dshPresent) {
    dshDetected = dshHome;
    detected.push(`DeepSeek Harness (dsh) home at ${dshHome}`);
    skillsDirs.push(path.join(dshHome, "skills")); // user rank-400 root; never .system
    if (envHost === "dsh") { app = "dsh"; homeDir = dshHome; }
    else if (app === "unknown") { app = "dsh"; homeDir = dshHome; }
  }

  let codexPluginInstalled = false;
  const installedPlugins = path.join(claudeDir, "plugins", "installed_plugins.json");
  if (exists(installedPlugins)) {
    const data = readJson(installedPlugins, { plugins: {} });
    const keys = Object.keys(data?.plugins ?? {});
    codexPluginInstalled = keys.some((k) => k.toLowerCase().includes("codex"));
    if (codexPluginInstalled) detected.push("codex-plugin-cc installed");
  }
  const codexMarketplace = path.join(claudeDir, "plugins", "marketplaces", "openai-codex");
  if (exists(codexMarketplace)) {
    codexPluginInstalled = true;
    detected.push("openai-codex marketplace present");
  }

  const hasSubagents = app === "claude-code" || app === "codex" || app === "pi" || app === "dsh";
  const hasMultiAgent = app === "claude-code" || app === "pi" || app === "dsh";
  const hasDynamicWorkflow = app === "claude-code" || app === "pi" || app === "dsh";
  const hasGraphWorkflow = false;

  return {
    app,
    homeDir,
    piDir: exists(piDir) ? piDir : null,
    // Static discovery does not establish that an optional runner is loaded.
    subagentRunner: app === "pi" ? readPiRunner({ piDir, projectDir }) : null,
    hasSubagents,
    hasMultiAgent,
    hasDynamicWorkflow,
    hasGraphWorkflow,
    codexPluginInstalled,
    codexBinary,
    dshHome: dshDetected,
    dshBinary,
    skillsDirs: [...new Set(skillsDirs)],
    commandsDirs: [...new Set(commandsDirs)],
    agentsDirs: [...new Set(agentsDirs)],
    extensionsDirs: [...new Set(extensionsDirs)],
    detected,
  };
}

/** @param {HostInfo} h @returns {string[]} */
export function hostCapabilities(h) {
  const caps = [];
  if (h.hasSubagents) caps.push("subagents");
  if (h.hasMultiAgent) caps.push("multi-agent");
  if (h.hasDynamicWorkflow) caps.push("dynamic-workflow");
  if (h.hasGraphWorkflow) caps.push("graph-workflow");
  if (h.codexPluginInstalled) caps.push("codex-review");
  return caps;
}
