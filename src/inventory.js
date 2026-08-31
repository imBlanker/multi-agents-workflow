// @ts-check
// Cross-host agent inventory: scan ALL installed supported hosts
// (claude-code, codex, pi, dsh) + the current project and emit an
// InventoryReport (machine JSON) plus a compact digest (agent-readable).
// This is the machine-wide awareness layer consumed by advise/injection.
//
// Reuse rules (do NOT duplicate parsing):
//   - presence + capabilities: detectHost() from host.js
//   - providers/models: readCcSwitch / readPiAsCc / readDshAsCc + candidatesForAppType
//   - prices: resolvePrice (pricing.js source chain; never fake exact)
//
// Robustness: a missing host is skipped; a throwing per-host scan degrades to
// {app, error}; broken JSON files fall back to empty (readJson fallback).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { exists, isFile, readJson, readText, writeJson, writeText, ensureDir } from "./util.js";
import { detectHost, hostCapabilities } from "./host.js";
import { readCcSwitch, piManagedByCcSwitch, piSessionUsagePresent } from "./ccswitch.js";
import { readPiAsCc } from "./piprovider.js";
import { readDshAsCc } from "./dshprovider.js";
import { candidatesForAppType, classifyModel } from "./modelcap.js";
import { resolvePrice } from "./pricing.js";

/**
 * @typedef {"claude-code"|"codex"|"pi"|"dsh"} HostApp
 * @typedef {{ name: string, path: string, realPath: string, description: string }} SkillEntry
 * @typedef {{ name: string, source: string }} NamedEntry
 * @typedef {{ id: string, provider: string, source: string, isCurrent: boolean, family: string, tags: string[], price: { input_per_m: number, output_per_m: number, source: string, estimated: boolean } | null }} ModelEntry
 * @typedef {{ generatedAt: string, projectDir: string, hosts: any[] }} InventoryReport
 */

const APP_TYPES = { "claude-code": "claude", codex: "codex", pi: "pi", dsh: "dsh" };

/** Default CLI runner for probe mode (injectable in tests; hermetic default off).
 *  60s timeout: `claude mcp list` performs live health checks. */
function runCliDefault(cmd) {
  try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 60000 }); }
  catch { return ""; }
}

/** Parse `claude mcp list` lines → Map(name → status). Word-based — symbol
 *  codepoints differ across terminals. Observed states: Connected /
 *  Pending approval / Failed to connect. Both the full name and its
 *  @alias-stripped base are keyed (claude-flow@alpha → claude-flow). */
function probeClaudeMcp(runCli) {
  const txt = runCli("claude mcp list");
  const map = new Map();
  for (const line of String(txt).split("\n")) {
    const m = line.match(/^([^:\s]+):/);
    if (!m) continue;
    let status = null;
    if (/\bPending approval/.test(line)) status = "pending-approval";
    else if (/\bFailed\b/.test(line)) status = "failed";
    else if (/\bConnected\b/.test(line)) status = "connected";
    if (!status) continue;
    map.set(m[1], status);
    map.set(m[1].split("@")[0], status);
  }
  return map;
}

/** Parse `codex mcp list --json` → Map(name → status). */
function probeCodexMcp(runCli) {
  const txt = runCli("codex mcp list --json");
  const map = new Map();
  try {
    const list = JSON.parse(txt);
    for (const s of list || []) {
      if (!s?.name) continue;
      if (s.enabled === false) map.set(s.name, "disabled");
      else if (s.auth_status === "unsupported") map.set(s.name, "unsupported");
      else map.set(s.name, "unknown");
    }
  } catch {}
  return map;
}

/** Attach CLI-probed statuses to static mcp entries; add CLI-only servers. */
function applyMcpStatus(mcps, probeMap, cliSource) {
  for (const m of mcps) {
    const st = probeMap.get(m.name);
    if (st) m.status = st;
  }
  for (const [name, status] of probeMap) {
    // base keys (alias-stripped) duplicate a full key — skip adding them twice
    if (name.includes("@") && probeMap.has(name.split("@")[0])) continue;
    if (mcps.some((m) => m.name === name)) continue;
    mcps.push({ name, source: cliSource, status });
  }
}

/** @returns {string} */
function home() { return os.homedir(); }

/** Parse dsh --dump-config component blocks → plugin entries.
 *  dsh is everything-as-a-plugin: every component (ui/tool/session/skill/...)
 *  is a plugin. The dump lists active-profile components; the dsh web UI
 *  remains the FULL plugin truth (it can show more than the dump). */
function parseDshPlugins(dump) {
  const out = [];
  const text = String(dump);
  const originRe = /^# == ([^\n]+)/m;
  // iterate entries; `disabled: true` counts ONLY when it appears inside THIS
  // entry's block (before the next `- id:` or `# ==` line)
  const entries = [...text.matchAll(/^- id: ([\w-]+)\n\s+name: '?([^'\n]+)'?/gm)];
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i];
    const blockEnd = i + 1 < entries.length ? entries[i + 1].index : text.length;
    // block start: last `# ==` comment line before this entry
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const originMatches = [...before.matchAll(/^# == ([^\n]+)$/gm)];
    const origin = originMatches.length ? originMatches[originMatches.length - 1][1].trim() : "";
    const block = text.slice(m.index, blockEnd);
    out.push({
      id: m[1],
      name: m[2].trim(),
      status: /disabled:\s*true/.test(block) ? "disabled" : "active",
      origin,
      source: "dump-config",
    });
  }
  return out;
}

/**
 * Scan one skills directory: every child dir containing SKILL.md becomes an
 * entry. Description = YAML frontmatter `description:` if present, else the
 * first non-heading line (≤200 chars), else "".
 * @param {string} dir
 * @returns {SkillEntry[]}
 */
function scanSkillsDir(dir) {
  if (!exists(dir)) return [];
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillPath = path.join(dir, e.name);
    const md = path.join(skillPath, "SKILL.md");
    if (!isFile(md)) continue;
    let realPath = skillPath;
    try { realPath = fs.realpathSync(skillPath); } catch {}
    out.push({ name: e.name, path: skillPath, realPath, description: readSkillDescription(md) });
  }
  return out;
}

/**
 * @param {string} md
 * @returns {string}
 */
function readSkillDescription(md) {
  let text = "";
  try { text = readText(md); } catch { return ""; }
  // frontmatter description
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const m = text.slice(3, end).match(/^description:\s*"?(.+?)"?\s*$/m);
      if (m) return clip(m[1]);
    }
  }
  // first non-heading, non-empty line outside frontmatter
  const body = text.replace(/^---[\s\S]*?\n---\s*\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return clip(t);
  }
  return "";
}

/** @param {string} s */
function clip(s) { s = String(s).trim(); return s.length > 200 ? s.slice(0, 197) + "…" : s; }

/**
 * List skills across dirs, deduped by resolved real path (symlinks from
 * ~/.cc-switch/skills are linked into several hosts; within ONE host the same
 * real skill must appear once).
 * @param {string[]} dirs
 * @returns {SkillEntry[]}
 */
export function listSkills(dirs) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const dir = Array.isArray(d) ? d[0] : d;
    const origin = Array.isArray(d) ? d[1] : "user-global";
    for (const s of scanSkillsDir(dir)) {
      if (seen.has(s.realPath)) continue;
      seen.add(s.realPath);
      out.push({ ...s, origin });
    }
    // pi 0.84.3 discovery rule: Markdown skills nested one level inside
    // grouping directories (<group>/<skill>.md) are discovered in ALL skill
    // dirs (incl. .agents/skills surfaces). A subdir that itself has a
    // SKILL.md is a skill dir (handled above), not a grouping dir.
    for (const s of scanGroupedMdSkills(dir)) {
      if (seen.has(s.realPath)) continue;
      seen.add(s.realPath);
      out.push({ ...s, origin });
    }
    // pi discovery rule: root .md files in ~/.pi/agent/skills and .pi/skills
    // are individual skills (ignored in .agents/skills dirs)
    if (Array.isArray(d) && (origin === "user-global" || origin === "project")) {
      for (const s of scanRootMdSkills(dir)) {
        if (seen.has(s.realPath)) continue;
        seen.add(s.realPath);
        out.push({ ...s, origin });
      }
    }
  }
  return out;
}

// Well-known non-skill markdown files. pi 0.84.3: root Markdown files such
// as README.md/AGENTS.md without valid skill frontmatter are NOT skills.
const NON_SKILL_MD = new Set(["README.md", "AGENTS.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md", "NOTICE.md"]);

/** Root-level *.md files as skills (pi rule; none on the verify machine). */
function scanRootMdSkills(dir) {
  if (!exists(dir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || NON_SKILL_MD.has(e.name)) continue;
    const p = path.join(dir, e.name);
    out.push({ name: e.name.replace(/\.md$/, ""), path: p, realPath: fs.realpathSync(p), description: readSkillDescription(p) });
  }
  return out;
}

/**
 * Markdown skills nested one level inside grouping directories:
 * <dir>/<group>/<skill>.md where <group> has no SKILL.md of its own.
 * pi 0.84.3 fix: nested Markdown skills inside `.agents/skills/` grouping
 * directories are discovered (previously missed → under-reporting drift).
 * @param {string} dir
 */
function scanGroupedMdSkills(dir) {
  if (!exists(dir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const groupDir = path.join(dir, e.name);
    if (isFile(path.join(groupDir, "SKILL.md"))) continue; // a skill dir, not a group
    let groupEntries = [];
    try { groupEntries = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
    for (const g of groupEntries) {
      if (!g.isFile() || !g.name.endsWith(".md") || NON_SKILL_MD.has(g.name)) continue;
      const p = path.join(groupDir, g.name);
      let realPath = p;
      try { realPath = fs.realpathSync(p); } catch {}
      out.push({ name: g.name.replace(/\.md$/, ""), path: p, realPath, description: readSkillDescription(p) });
    }
  }
  return out;
}

/**
 * Read a "mcpServers"-shaped JSON file → NamedEntry[].
 * @param {string} file
 * @param {string} source
 */
function mcpFromJson(file, source) {
  const d = readJson(file, null);
  const map = d && typeof d === "object" ? (d.mcpServers ?? d.servers ?? null) : null;
  if (!map || typeof map !== "object") return [];
  return Object.keys(map).map((name) => ({ name, source }));
}

/**
 * Build model entries for one host from its cc-shaped provider data.
 * @param {any} cc cc-shaped object ({allProviders, modelPricing})
 * @param {string} appType
 * @returns {ModelEntry[]}
 */
function modelsForAppType(cc, appType) {
  if (!cc) return [];
  const pricing = cc.modelPricing || {};
  const seen = new Set();
  const out = [];
  for (const c of candidatesForAppType(cc, appType)) {
    if (!c.model || seen.has(c.model)) continue;
    seen.add(c.model);
    const cls = classifyModel(c.model);
    const tags = Object.entries(cls.caps ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    const price = resolvePrice(c.model, { modelPricing: pricing, costMultiplier: c.costMultiplier });
    out.push({
      id: c.model,
      provider: c.providerName || c.providerId || appType,
      source: appType,
      isCurrent: !!c.isCurrent,
      family: cls.family,
      tags,
      price: price ? { input_per_m: price.input_per_m, output_per_m: price.output_per_m, source: price.source, estimated: !!price.estimated } : null,
    });
  }
  return out;
}

/**
 * Ancestor `.agents/skills` dirs from projectDir upward, stopping after the
 * git root (dir containing .git) or at fs root; projectDir itself excluded
 * (already scanned as "project").
 * @param {string} projectDir
 * @returns {string[]}
 */
function ancestorAgentsSkillsDirs(projectDir) {
  const out = [];
  let cur = path.resolve(projectDir);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    const dir = path.join(cur, ".agents", "skills");
    if (exists(dir)) out.push(dir);
    if (exists(path.join(cur, ".git"))) break;
  }
  return out;
}

/**
 * Scan ALL installed supported hosts + the project → InventoryReport.
 * All host dirs are injectable (tests NEVER touch the real ~).
 * @param {object} [opts]
 * @param {string} [opts.claudeDir]   default ~/.claude
 * @param {string} [opts.codexDir]    default ~/.codex
 * @param {string} [opts.piDir]       default $PI_AGENT_DIR | ~/.pi/agent
 * @param {string} [opts.dshHome]     default $DSH_HOME | ~/.dsh
 * @param {string} [opts.claudeJson]  default ~/.claude.json (mcpServers + projects)
 * @param {string} [opts.agentsSkillsDir] default ~/.agents/skills (pi global standard skills dir)
 * @param {string} [opts.projectDir]  default process.cwd()
 * @param {string} [opts.dbPath]      cc-switch db override
 * @param {string} [opts.dshDumpConfig] dsh --dump-config output override (default "" → skip the real `dsh` exec; hermetic)
 * @param {boolean} [opts.probe]  run host CLIs to attach MCP statuses (verify mode)
 * @param {(cmd: string) => string} [opts.runCli] injectable CLI runner (tests)
 * @returns {InventoryReport}
 */
export function scanInventory(opts = {}) {
  const claudeDir = opts.claudeDir ?? path.join(home(), ".claude");
  const codexDir = opts.codexDir ?? path.join(home(), ".codex");
  const piDir = opts.piDir ?? (process.env.PI_AGENT_DIR || path.join(home(), ".pi", "agent"));
  const dshHome = opts.dshHome ?? (process.env.DSH_HOME || path.join(home(), ".dsh"));
  const claudeJson = opts.claudeJson ?? path.join(home(), ".claude.json");
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());

  const hostInfo = detectHost({ claudeDir, codexDir, piDir, dshHome, projectDir });
  const cc = readCcSwitch(opts.dbPath ? { dbPath: opts.dbPath } : {});
  const basePricing = { ...(cc.modelPricing || {}) };

  /** @type {any[]} */
  const hosts = [];
  const push = (fn) => { try { hosts.push(fn()); } catch (err) { hosts.push({ app: "unknown", error: String(err?.message ?? err) }); } };

  if (exists(claudeDir)) push(() => scanClaude({ claudeDir, claudeJson, projectDir, cc, hostInfo, probe: !!opts.probe, runCli: opts.runCli ?? runCliDefault }));
  if (exists(codexDir)) push(() => scanCodex({ codexDir, projectDir, cc, hostInfo, probe: !!opts.probe, runCli: opts.runCli ?? runCliDefault }));
  if (exists(piDir)) push(() => scanPi({ piDir, projectDir, cc, hostInfo, agentsSkillsDir: opts.agentsSkillsDir, probe: !!opts.probe, runCli: opts.runCli ?? runCliDefault }));
  if (exists(path.join(dshHome, "settings.yaml")) || exists(path.join(dshHome, "profiles"))) {
    push(() => scanDsh({ dshHome, projectDir, cc, hostInfo, dumpConfig: opts.dshDumpConfig ?? "", probe: !!opts.probe, runCli: opts.runCli ?? runCliDefault }));
  }

  return { generatedAt: new Date().toISOString(), projectDir, hosts };
}

/**
 * @param {{claudeDir:string, claudeJson:string, projectDir:string, cc:any, hostInfo:any}} o
 */
function scanClaude(o) {
  const app = "claude-code";
  const skills = listSkills([
    [path.join(o.claudeDir, "skills"), "user-global"],
    [path.join(o.projectDir, ".claude", "skills"), "project"],
  ]);
  const plugins = [];
  const installed = readJson(path.join(o.claudeDir, "plugins", "installed_plugins.json"), null);
  const instMap = installed?.plugins && typeof installed.plugins === "object" ? installed.plugins : null;
  if (instMap) for (const k of Object.keys(instMap)) plugins.push({ name: k, source: "installed" });
  // marketplaces are their own category (plugin/skill catalogs live there)
  const marketplaces = [];
  const mkts = path.join(o.claudeDir, "plugins", "marketplaces");
  if (exists(mkts)) {
    try {
      for (const e of fs.readdirSync(mkts, { withFileTypes: true })) {
        if (e.isDirectory()) marketplaces.push(e.name);
      }
    } catch {}
  }
  // NOTE: plugin-provided skills counted only when the plugin is enabled —
  // enable state is not file-detectable; on the verify machine all 3 user
  // plugins are disabled, so plugin skills stay uncounted (digest notes it).
  const mcps = [...mcpFromJson(o.claudeJson, "user")];
  // project-scoped servers recorded under ~/.claude.json projects[*].mcpServers
  // (verified vs `claude mcp list`: global + all project entries are listed)
  const cj = readJson(o.claudeJson, null);
  const projs = cj?.projects && typeof cj.projects === "object" ? cj.projects : {};
  for (const [key, p] of Object.entries(projs)) {
    const ms = p?.mcpServers && typeof p.mcpServers === "object" ? p.mcpServers : null;
    if (!ms) continue;
    for (const name of Object.keys(ms)) {
      if (!mcps.some((m) => m.name === name)) mcps.push({ name, source: `claude-project:${key}` });
    }
  }
  for (const e of mcpFromJson(path.join(o.projectDir, ".mcp.json"), "project")) {
    if (!mcps.some((m) => m.name === e.name)) mcps.push(e);
  }
  if (o.probe) {
    // `claude mcp list` health output is nondeterministic (failed servers
    // may be omitted when they fail slowly); retry once if any statically-
    // known server is missing from the probe result.
    let map = probeClaudeMcp(o.runCli);
    const known = mcps.map((m) => m.name);
    if (known.length && !known.every((n) => map.has(n))) {
      map = new Map([...map, ...probeClaudeMcp(o.runCli)]);
    }
    applyMcpStatus(mcps, map, "claude-cli");
  }
  const global = isFile(path.join(o.claudeDir, "CLAUDE.md")) ? path.join(o.claudeDir, "CLAUDE.md") : null;
  return {
    app, homeDir: o.claudeDir,
    detected: o.hostInfo.detected.filter((d) => /claude/i.test(d)),
    capabilities: hostCapabilities({ ...o.hostInfo, app: "claude-code" }),
    skills, plugins, marketplaces, mcps,
    prompts: { global, project: projectPromptSurfaces(o.projectDir, ["AGENTS.md", "CLAUDE.md"]) },
    models: modelsForAppType(o.cc, APP_TYPES[app]),
    workflowsHarnesses: projectWorkflows(o.projectDir),
  };
}

/**
 * @param {{codexDir:string, projectDir:string, cc:any, hostInfo:any}} o
 */
function scanCodex(o) {
  const app = "codex";
  const tomlFile = path.join(o.codexDir, "config.toml");
  const toml = isFile(tomlFile) ? readText(tomlFile) : "";
  // codex 0.151.0: plugin catalogs combine per-repository configuration —
  // a project-level .codex/config.toml is scanned with the same parse when
  // present (additive; absence changes nothing).
  const projectTomlFile = path.join(o.projectDir, ".codex", "config.toml");
  const projectToml = isFile(projectTomlFile) ? readText(projectTomlFile) : "";
  const skills = listSkills([path.join(o.codexDir, "skills"), [path.join(o.projectDir, ".codex", "skills"), "project"]]);
  // plugins: [plugins."name@marketplace"] sections in config.toml (verified
  // vs `codex plugin list` — installed+enabled plugins appear there)
  const plugins = [];
  for (const src of [["codex-config.toml", toml], ["codex-project-config.toml", projectToml]]) {
    for (const m of src[1].matchAll(/^\[plugins\."([^"]+)"\]\s*$/gm)) {
      if (!plugins.some((p) => p.name === m[1])) plugins.push({ name: m[1], source: src[0] });
    }
  }
  // MCP: codex keeps servers in config.toml [mcp_servers.<name>] sections;
  // mcp.json is a tolerated fallback shape.
  const mcps = [];
  for (const src of [["codex-config.toml", toml, tomlFile], ["codex-project-config.toml", projectToml, projectTomlFile]]) {
    if (!src[2] || !isFile(src[2])) continue;
    try {
      const names = [];
      for (const m of src[1].matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
        names.push(m[1] ?? m[2]);
      }
      // drop TOML sub-sections (e.g. [mcp_servers.<srv>.env]) — a dotted
      // child of another captured name is config detail, not a server
      for (const n of names) {
        const dot = n.lastIndexOf(".");
        if (dot > 0 && names.includes(n.slice(0, dot))) continue;
        if (!mcps.some((m) => m.name === n)) mcps.push({ name: n, source: src[0] });
      }
    } catch {}
  }
  for (const e of mcpFromJson(path.join(o.codexDir, "mcp.json"), "codex-config")) {
    if (!mcps.some((m) => m.name === e.name)) mcps.push(e);
  }
  if (o.probe) applyMcpStatus(mcps, probeCodexMcp(o.runCli), "codex-cli");
  const mcpNote = "codex_apps builtin connector (official OpenAI features when connected) is visible in the codex UI, not in mcp configs";
  const global = isFile(path.join(o.codexDir, "AGENTS.md")) ? path.join(o.codexDir, "AGENTS.md") : null;
  return {
    app, homeDir: o.codexDir,
    detected: o.hostInfo.detected.filter((d) => /codex/i.test(d)),
    capabilities: hostCapabilities({ ...o.hostInfo, app: "codex" }),
    skills, plugins, marketplaces: [], mcps, mcpNote,
    prompts: { global, project: projectPromptSurfaces(o.projectDir, ["AGENTS.md"]) },
    models: modelsForAppType(o.cc, APP_TYPES[app]),
    workflowsHarnesses: projectWorkflows(o.projectDir),
  };
}

/**
 * @param {{piDir:string, projectDir:string, cc:any, hostInfo:any}} o
 */
function scanPi(o) {
  const app = "pi";
  // Skill discovery dirs per pi docs (verified against this machine's live
  // session): ~/.pi/agent/skills, ~/.agents/skills (global standard dir),
  // project .pi/skills + .agents/skills, and skills/ dirs of npm packages
  // (package.json `pi.skills`, default ./skills).
  const skillDirs = [
    [path.join(o.piDir, "skills"), "user-global"],
    [o.agentsSkillsDir ?? path.join(home(), ".agents", "skills"), "agents-global"],
    [path.join(o.projectDir, ".pi", "skills"), "project"],
    [path.join(o.projectDir, ".agents", "skills"), "project"],
  ];
  // pi discovery rule: .agents/skills in cwd AND ancestor directories up to
  // the git repo root (fs root when not in a repo)
  for (const anc of ancestorAgentsSkillsDirs(o.projectDir)) {
    skillDirs.push([anc, "project-ancestor"]);
  }
  const nmDir = path.join(o.piDir, "npm", "node_modules");
  if (exists(nmDir)) {
    try {
      for (const e of fs.readdirSync(nmDir, { withFileTypes: true })) {
        if (e.isDirectory() && exists(path.join(nmDir, e.name, "skills"))) {
          skillDirs.push([path.join(nmDir, e.name, "skills"), "npm-package"]);
        }
      }
    } catch {}
  }
  const skills = listSkills(skillDirs);
  const plugins = [];
  // pi's npm surface is ONE workspace-style package.json whose dependencies
  // are the installed extensions/plugins (verified on a real install).
  const npmPkg = readJson(path.join(o.piDir, "npm", "package.json"), null);
  const deps = npmPkg?.dependencies && typeof npmPkg.dependencies === "object" ? npmPkg.dependencies : null;
  if (deps) for (const k of Object.keys(deps)) plugins.push({ name: k, source: "npm" });
  const extDir = path.join(o.piDir, "extensions");
  if (exists(extDir)) {
    try {
      for (const e of fs.readdirSync(extDir, { withFileTypes: true })) {
        if ((e.isDirectory() || e.isFile()) && !plugins.some((p) => p.name === e.name)) plugins.push({ name: e.name, source: "extension" });
      }
    } catch {}
  }
  // MCP: pi's real server list lives in ~/.pi/agent/mcp.json (verified: exa,
  // context7, searchcode, zai-mcp-server, web-search-prime, web-reader, zread)
  const mcps = mcpFromJson(path.join(o.piDir, "mcp.json"), "pi-mcp.json");
  const global = isFile(path.join(o.piDir, "AGENTS.md")) ? path.join(o.piDir, "AGENTS.md") : null;
  const piAsCc = readPiAsCc({ piDir: o.piDir, ccSwitch: { modelPricing: o.cc?.modelPricing }, piManaged: piManagedByCcSwitch(o.cc), piSpendMeasured: piSessionUsagePresent({ dbPath: o.cc?.dbPath }) });
  return {
    app, homeDir: o.piDir,
    detected: o.hostInfo.detected.filter((d) => /pi agent/i.test(d)),
    capabilities: hostCapabilities({ ...o.hostInfo, app: "pi" }),
    skills, plugins, marketplaces: [], mcps,
    prompts: { global, project: projectPromptSurfaces(o.projectDir, ["AGENTS.md"]) },
    models: modelsForAppType(piAsCc, APP_TYPES[app]),
    workflowsHarnesses: projectWorkflows(o.projectDir),
  };
}

/**
 * @param {{dshHome:string, projectDir:string, cc:any, hostInfo:any, dumpConfig:string}} o
 */
function scanDsh(o) {
  const app = "dsh";
  const skills = listSkills([[path.join(o.dshHome, "skills"), "user-global"]]);
  // everything-as-a-plugin: probe mode parses --dump-config into the plugin
  // list (active/disabled per component). Static mode: [] + note. The dsh web
  // UI is the FULL plugin truth (may show more than the dump).
  let plugins = [];
  let harnessNote = "dsh is everything-as-a-plugin; run `mawf inventory --verify` for the dump-config plugin list (web profile); the dsh web UI plugin panel is the full truth";
  let dump = o.dumpConfig ?? "";
  if (o.probe && !dump) dump = o.runCli("dsh --profile web --dump-config");
  if (dump) {
    plugins = parseDshPlugins(dump);
    const active = plugins.filter((p) => p.status === "active").length;
    harnessNote = `everything-as-a-plugin: dump-config lists ${plugins.length} components (${active} active / ${plugins.length - active} disabled); the dsh web UI plugin panel may show more`;
  }
  // MCP report-only: dsh MCP servers are configured under the
  // `@deepseek-ai/dsh-mcp-client` component — top-level `mcp-client:` key in
  // settings.yaml (verified in dsh docs/config-catalog.md); patch layers manage it.
  const mcps = [];
  try {
    const yaml = readText(path.join(o.dshHome, "settings.yaml"));
    for (const name of parseTopLevelSection(yaml, "mcp-client")) {
      mcps.push({ name, source: "dsh-mcp-client" });
    }
  } catch {}
  const presets = path.join(o.dshHome, "agent-presets");
  if (exists(presets)) {
    try {
      for (const e of fs.readdirSync(presets, { withFileTypes: true })) {
        if (e.isDirectory()) plugins.push({ name: e.name, source: "agent-preset" });
      }
    } catch {}
  }
  const global = isFile(path.join(o.dshHome, "AGENTS.md")) ? path.join(o.dshHome, "AGENTS.md") : null;
  const dshAsCc = readDshAsCc({ dshHome: o.dshHome, ccSwitch: { modelPricing: o.cc?.modelPricing }, dumpConfig: dump });
  return {
    app, homeDir: o.dshHome,
    detected: o.hostInfo.detected.filter((d) => /dsh|deepseek/i.test(d)),
    capabilities: hostCapabilities({ ...o.hostInfo, app: "dsh" }),
    skills, plugins, marketplaces: [], mcps, harnessNote,
    prompts: { global, project: projectPromptSurfaces(o.projectDir, ["AGENTS.md"]) },
    models: modelsForAppType(dshAsCc, APP_TYPES[app]),
    workflowsHarnesses: projectWorkflows(o.projectDir),
  };
}

/**
 * Extract sub-key names under a top-level YAML key (2-space indented
 * `name:` lines). Report-only heuristics — never authoritative.
 * @param {string} yaml
 * @param {string} key
 * @returns {string[]}
 */
function parseTopLevelSection(yaml, key) {
  const re = new RegExp(`^${key}:\\s*\\n([\\s\\S]*?)(?=^\\S|\\n\\S|$)`, "m");
  const m = yaml.match(re);
  if (!m) return [];
  const names = [];
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*$/);
    if (mm) names.push(mm[1]);
  }
  return names;
}

/**
 * Which project prompt surfaces exist (relative names).
 * @param {string} projectDir
 * @param {string[]} relevant
 * @returns {string[]}
 */
function projectPromptSurfaces(projectDir, relevant) {
  return relevant.filter((f) => isFile(path.join(projectDir, f)));
}

/**
 * MAW workflows/harnesses living in the project's .mawf/.
 * @param {string} projectDir
 */
function projectWorkflows(projectDir) {
  const out = [];
  const wf = path.join(projectDir, ".mawf", "workflow.json");
  if (isFile(wf)) out.push({ name: "workflow.json", path: wf });
  const agents = path.join(projectDir, ".mawf", "agents");
  if (exists(agents)) {
    try {
      for (const e of fs.readdirSync(agents)) {
        if (e.endsWith(".md")) out.push({ name: e.replace(/\.md$/, ""), path: path.join(agents, e) });
      }
    } catch {}
  }
  return out;
}

const DIGEST_MAX_LINES = 200;

/**
 * Render the compact agent-readable digest. Hard cap 200 lines; over budget
 * truncates name lists with "(+N more — see .mawf/inventory.json)".
 * @param {InventoryReport} report
 * @returns {string}
 */
export function renderDigest(report) {
  const lines = [];
  lines.push(`# MAW cross-host inventory (generated ${report.generatedAt})`);
  lines.push(`Project: ${report.projectDir}`);
  lines.push("");
  for (const h of report.hosts ?? []) {
    if (h.error) { lines.push(`## ${h.app} — error: ${h.error}`); lines.push(""); continue; }
    lines.push(`## ${h.app} — caps: ${(h.capabilities || []).join(", ") || "none"}`);
    lines.push(`- home: ${h.homeDir}`);
    lines.push(`- skills (${h.skills.length}): ${nameList(h.skills.map((s) => s.name))}`);
    lines.push(`- plugins (${h.plugins.length}): ${nameList(h.plugins.map((p) => p.name))}`);
    const mcpNames = (h.mcps || []).map((m) => `${m.name}${m.status === "connected" ? "✓" : m.status === "failed" ? "✗" : m.status === "pending-approval" ? "⏸" : m.status === "unsupported" ? "⚠" : m.status === "disabled" ? "⊘" : ""}`);
    lines.push(`- mcp (${h.mcps.length}): ${nameList(mcpNames)}`);
    if (h.marketplaces?.length) lines.push(`- marketplaces (${h.marketplaces.length}): ${nameList(h.marketplaces)}`);
    if (h.mcpNote) lines.push(`- mcp note: ${h.mcpNote}`);
    if (h.harnessNote) lines.push(`- harness: ${h.harnessNote}`);
    const models = (h.models || []).map((m) => {
      const tags = m.tags?.length ? ` [${m.tags.join(",")}]` : "";
      const price = m.price ? ` ($${m.price.input_per_m}/$${m.price.output_per_m} per M${m.price.estimated ? " est." : ""})` : "";
      return `${m.id}${tags}${price}`;
    });
    lines.push(`- models (${h.models.length}): ${nameList(models)}`);
    lines.push(`- prompts: global ${h.prompts?.global ? "✓" : "✗"} / project ${(h.prompts?.project || []).join("+") || "✗"}`);
    if (h.workflowsHarnesses?.length) lines.push(`- workflows: ${nameList(h.workflowsHarnesses.map((w) => w.name))}`);
    lines.push("");
  }
  if (lines.length > DIGEST_MAX_LINES) {
    lines.length = DIGEST_MAX_LINES;
    lines.push(`… truncated at ${DIGEST_MAX_LINES} lines — see .mawf/inventory.json for the full report`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Comma-joined name list that yields "(+N more — see .mawf/inventory.json)"
 * when it would blow the line budget (rough heuristic: ~110 names visible).
 * @param {string[]} names
 */
function nameList(names) {
  const visible = names.slice(0, 110);
  const rest = names.length - visible.length;
  return visible.join(", ") + (rest > 0 ? ` (+${rest} more — see .mawf/inventory.json)` : "");
}

/**
 * Write .mawf/inventory.json + .mawf/inventory-digest.md.
 * @param {string} projectDir
 * @param {InventoryReport} report
 * @returns {{ jsonPath: string, digestPath: string }}
 */
export function writeInventoryArtifacts(projectDir, report) {
  const mawDir = path.join(projectDir, ".mawf");
  ensureDir(mawDir);
  const jsonPath = path.join(mawDir, "inventory.json");
  const digestPath = path.join(mawDir, "inventory-digest.md");
  writeJson(jsonPath, report);
  writeText(digestPath, renderDigest(report));
  return { jsonPath, digestPath };
}
