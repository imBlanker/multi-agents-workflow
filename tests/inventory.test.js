// @ts-check
// Tests for cross-host inventory scanning (src/inventory.js).
// All host dirs are injected via opts — fixtures NEVER touch the real ~.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanInventory, listSkills, renderDigest, writeInventoryArtifacts } from "../src/inventory.js";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-inv-"));
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function w(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/** Build a full 4-host fixture + project dir. */
function fullFixture() {
  const root = tmpHome();
  const claudeDir = mk(path.join(root, "h", ".claude"));
  const codexDir = mk(path.join(root, "h", ".codex"));
  const piDir = mk(path.join(root, "h", ".pi", "agent"));
  const dshHome = mk(path.join(root, "h", ".dsh"));
  const claudeJson = path.join(root, "h", ".claude.json");
  const projectDir = mk(path.join(root, "proj"));

  // claude: skills + plugins + global prompt
  w(path.join(claudeDir, "skills", "grilling", "SKILL.md"), `---\nname: grilling\ndescription: "Grill the user relentlessly"\n---\n# Grilling\nbody\n`);
  w(path.join(claudeDir, "skills", "handoff", "SKILL.md"), `# Handoff\nFirst line description of handoff.\n`);
  w(path.join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "codex-plugin-cc": {}, "other": {} } }));
  mk(path.join(claudeDir, "plugins", "marketplaces", "openai-codex"));
  w(path.join(claudeDir, "CLAUDE.md"), "# global");
  w(claudeJson, JSON.stringify({
    mcpServers: { "zai-cn-web-search": {}, exa: {} },
    projects: { "/other/machine/proj": { mcpServers: { "claude-flow": {}, "ruv-swarm": {} } } },
  }));

  // codex: skills (codex-* family + plain) + config.toml mcp_servers + AGENTS.md
  w(path.join(codexDir, "skills", "codex-review", "SKILL.md"), "---\ndescription: codex review skill\n---\nx\n");
  w(path.join(codexDir, "skills", "plain-skill", "SKILL.md"), "---\ndescription: plain\n---\nx\n");
  w(path.join(codexDir, "config.toml"), `[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.\"grok-search\"]\ncommand = "x"\n\n[plugins.\"documents@openai-primary-runtime\"]\nenabled = true\n\n[plugins.\"github@openai-curated\"]\nenabled = true\n`);
  w(path.join(codexDir, "AGENTS.md"), "# codex global");

  // pi: skills (one symlinked to the claude skill → cross-dir dedupe is per
  // host, so here we test within-pi dedupe: two names → same realPath)
  const realSkill = mk(path.join(root, "shared-skill"));
  w(path.join(realSkill, "SKILL.md"), "---\ndescription: shared\n---\nx\n");
  // pi global standard skills dir (~/.agents/skills in production)
  w(path.join(root, "h", ".agents", "skills", "caveman", "SKILL.md"), "---\ndescription: ultra-compressed communication mode\n---\nx\n");
  mk(path.join(piDir, "skills"));
  fs.symlinkSync(realSkill, path.join(piDir, "skills", "alias-a"));
  fs.symlinkSync(realSkill, path.join(piDir, "skills", "alias-b"));
  w(path.join(piDir, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", dependencies: { "some-pkg": "^1.0.0", "pi-mcp-adapter": "^2.0.0" } }));
  w(path.join(piDir, "npm", "node_modules", "pi-mcp-adapter", "package.json"), JSON.stringify({ name: "pi-mcp-adapter", pi: { skills: ["./skills"] } }));
  w(path.join(piDir, "npm", "node_modules", "pi-mcp-adapter", "skills", "mcp-scripting", "SKILL.md"), `---\ndescription: Write mcpScript JavaScript\n---\nx\n`);
  w(path.join(piDir, "extensions", "rtk.ts"), "// ext");
  w(path.join(piDir, "mcp.json"), JSON.stringify({ mcpServers: { exa: {}, context7: {} } }));
  w(path.join(piDir, "AGENTS.md"), "# pi global");
  // pi models.json (providers/models for readPiAsCc) + models-store.json
  // (pi's cached remote catalogs — switchable via /model)
  w(path.join(piDir, "models.json"), JSON.stringify({
    providers: { "prov-a": { models: [{ id: "glm-4.5-air", cost: { input: 0.1, output: 0.4 } }] } },
  }));
  w(path.join(piDir, "models-store.json"), JSON.stringify({
    "openai-codex": { models: ["gpt-5.5", "gpt-5.4"] },
    "zai-coding-cn": { models: ["glm-4.7"] },
  }));

  // dsh: settings.yaml (strong marker) + skills + AGENTS.md
  w(path.join(dshHome, "settings.yaml"), `agent-presets:\n  default: liangshen\nllm-pi-ai:\n  providers:\n    zai-coding-cn:\n      baseURL: https://example\n      models:\n        - id: glm-4.5-air\n          name: GLM-4.5-Air\nmcp-client:\n  dsh-layer-a:\n    enabled: true\n`);
  w(path.join(dshHome, "skills", "dsh-skill", "SKILL.md"), "---\ndescription: dsh skill\n---\nx\n");
  w(path.join(dshHome, "AGENTS.md"), "# dsh global");

  // project: AGENTS.md + .mawf workflows + project .mcp.json + project .claude/skills
  w(path.join(projectDir, "AGENTS.md"), "# proj");
  w(path.join(projectDir, ".claude", "skills", "proj-claude-skill", "SKILL.md"), "---\ndescription: project-level claude skill\n---\nx\n");
  w(path.join(projectDir, ".mawf", "workflow.json"), JSON.stringify({ nodes: [] }));
  w(path.join(projectDir, ".mawf", "agents", "orchestrator.md"), "# orch");
  w(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { "proj-mcp": {} } }));

  return { root, claudeDir, codexDir, piDir, dshHome, claudeJson, projectDir, agentsSkillsDir: path.join(root, "h", ".agents", "skills") };
}

function scanOf(fx) {
  return scanInventory({
    claudeDir: fx.claudeDir, codexDir: fx.codexDir, piDir: fx.piDir, dshHome: fx.dshHome,
    claudeJson: fx.claudeJson, projectDir: fx.projectDir, agentsSkillsDir: fx.agentsSkillsDir,
    dbPath: "/nonexistent/ccswitch.db",
  });
}

test("scanInventory: full 4-host fixture — all hosts present with expected surfaces", () => {
  const fx = fullFixture();
  const r = scanOf(fx);
  assert.equal(r.hosts.length, 4);
  const by = Object.fromEntries(r.hosts.map((h) => [h.app, h]));

  const claude = by["claude-code"];
  assert.ok(!claude.error, claude.error);
  assert.deepEqual(claude.skills.map((s) => s.name).sort(), ["grilling", "handoff", "proj-claude-skill"]);
  assert.deepEqual(claude.skills.map((s) => s.origin).sort(), ["project", "user-global", "user-global"]);
  assert.ok(claude.marketplaces.includes("openai-codex"));
  assert.equal(claude.skills[0].description, "Grill the user relentlessly");
  assert.ok(claude.plugins.some((p) => p.name === "codex-plugin-cc" && p.source === "installed"));
  assert.equal(claude.plugins.length, 2); // installed_plugins.json keys only; marketplaces are NOT plugins
  assert.ok(claude.mcps.some((m) => m.name === "zai-cn-web-search" && m.source === "user"));
  assert.ok(claude.mcps.some((m) => m.name === "claude-flow" && m.source === "claude-project:/other/machine/proj"));
  assert.ok(claude.mcps.some((m) => m.name === "ruv-swarm"));
  assert.ok(claude.mcps.some((m) => m.name === "proj-mcp" && m.source === "project"));
  assert.ok(claude.prompts.global.endsWith("CLAUDE.md"));
  assert.deepEqual(claude.prompts.project, ["AGENTS.md"]); // fixture project has no CLAUDE.md
  assert.ok(claude.capabilities.length > 0);
  assert.ok(claude.workflowsHarnesses.some((w) => w.name === "workflow.json"));
  assert.ok(claude.workflowsHarnesses.some((w) => w.name === "orchestrator"));

  const codex = by.codex;
  assert.deepEqual(codex.skills.map((s) => s.name).sort(), ["codex-review", "plain-skill"]);
  assert.ok(codex.plugins.some((p) => p.name === "documents@openai-primary-runtime" && p.source === "codex-config.toml"));
  assert.ok(codex.plugins.some((p) => p.name === "github@openai-curated"));
  assert.equal(codex.plugins.length, 2);
  assert.ok(codex.mcps.some((m) => m.name === "context7" && m.source === "codex-config.toml"));
  assert.ok(codex.mcps.some((m) => m.name === "grok-search"));
  assert.ok(codex.prompts.global.endsWith("AGENTS.md"));

  const pi = by.pi;
  // two symlink names → ONE real skill entry (realPath dedupe) + global
  // ~/.agents/skills + npm package skills all discovered
  assert.deepEqual(pi.skills.map((s) => s.name).sort(), ["alias-a", "caveman", "mcp-scripting"]);
  const piOrigins = new Set(pi.skills.map((s) => s.origin));
  assert.ok(piOrigins.has("user-global") && piOrigins.has("agents-global") && piOrigins.has("npm-package"), [...piOrigins]);
  assert.ok(pi.plugins.some((p) => p.name === "some-pkg" && p.source === "npm"));
  assert.ok(pi.plugins.some((p) => p.name === "rtk.ts" && p.source === "extension"));
  assert.ok(pi.mcps.some((m) => m.name === "exa" && m.source === "pi-mcp.json"));
  assert.ok(pi.mcps.some((m) => m.name === "context7" && m.source === "pi-mcp.json"));
  assert.equal(pi.mcps.length, 2);
  assert.ok(pi.models.some((m) => m.id === "glm-4.5-air"), JSON.stringify(pi.models));
  // catalog merge: models-store.json providers join the switchable pool
  assert.equal(pi.models.length, 4, JSON.stringify(pi.models.map((m) => m.id)));
  assert.ok(pi.models.some((m) => m.id === "gpt-5.5"));
  assert.ok(pi.models.some((m) => m.id === "glm-4.7"));

  const dsh = by.dsh;
  assert.deepEqual(dsh.skills.map((s) => s.name), ["dsh-skill"]);
  assert.ok(dsh.mcps.some((m) => m.name === "dsh-layer-a" && m.source === "dsh-mcp-client"));
  assert.ok(dsh.models.some((m) => m.id === "glm-4.5-air"));
  assert.ok(dsh.prompts.global.endsWith("AGENTS.md"));
  assert.ok(String(dsh.harnessNote).includes("dsh web UI"));
});

test("scanInventory probe (verify mode): CLI statuses attached + CLI-only servers added", () => {
  const fx = fullFixture();
  const runCli = (cmd) => {
    if (cmd === "claude mcp list") {
      return "zai-cn-web-search: https://x (HTTP) - ✔ Connected\nclaude-flow: npx x - ✘ Failed to connect — boom\nghost-server: npx y - ✔ Connected\n";
    }
    if (cmd === "codex mcp list --json") {
      return JSON.stringify([
        { name: "context7", enabled: true, auth_status: "unsupported" },
        { name: "cli-only-server", enabled: true, auth_status: "ok" },
      ]);
    }
    if (cmd === "dsh --profile web --dump-config") {
      return "# == @deepseek-ai/dsh-base\n- id: skill\n  name: '@deepseek-ai/dsh-skill'\n# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app\n- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  disabled: true\n# == @deepseek-ai/dsh-base\n- id: ui-timer\n  name: '@deepseek-ai/cordis-plugin-timer'\n";
    }
    return "";
  };
  const r = scanInventory({
    claudeDir: fx.claudeDir, codexDir: fx.codexDir, piDir: fx.piDir, dshHome: fx.dshHome,
    claudeJson: fx.claudeJson, projectDir: fx.projectDir, agentsSkillsDir: fx.agentsSkillsDir,
    dbPath: "/nonexistent/ccswitch.db", probe: true, runCli,
  });
  const claude = r.hosts.find((h) => h.app === "claude-code");
  assert.equal(claude.mcps.find((m) => m.name === "zai-cn-web-search").status, "connected");
  assert.equal(claude.mcps.find((m) => m.name === "claude-flow").status, "failed");
  assert.ok(claude.mcps.some((m) => m.name === "ghost-server" && m.source === "claude-cli" && m.status === "connected"));
  const codex = r.hosts.find((h) => h.app === "codex");
  assert.equal(codex.mcps.find((m) => m.name === "context7").status, "unsupported");
  assert.ok(codex.mcps.some((m) => m.name === "cli-only-server" && m.source === "codex-cli"));
  assert.ok(String(codex.mcpNote).includes("codex_apps"));
  const dsh = r.hosts.find((h) => h.app === "dsh");
  assert.equal(dsh.plugins.length, 3); // everything-as-a-plugin: dump-config parsed
  const skillPlugin = dsh.plugins.find((p) => p.id === "skill");
  assert.equal(skillPlugin.name, "@deepseek-ai/dsh-skill");
  assert.equal(skillPlugin.status, "active");
  assert.equal(dsh.plugins.find((p) => p.id === "skill-filesystem").status, "disabled");
  assert.ok(String(dsh.harnessNote).includes("everything-as-a-plugin"));
});

test("scanInventory: missing dsh → 3 hosts, no error exit, others unaffected", () => {
  const fx = fullFixture();
  fs.rmSync(fx.dshHome, { recursive: true, force: true });
  const r = scanOf(fx);
  assert.equal(r.hosts.length, 3);
  assert.deepEqual(r.hosts.map((h) => h.app).sort(), ["claude-code", "codex", "pi"]);
});

test("scanInventory: broken installed_plugins.json tolerated (no crash, empty plugins)", () => {
  const fx = fullFixture();
  fs.writeFileSync(path.join(fx.claudeDir, "plugins", "installed_plugins.json"), "{not json");
  const r = scanOf(fx);
  const claude = r.hosts.find((h) => h.app === "claude-code");
  assert.ok(!claude.error);
  assert.equal(claude.plugins.filter((p) => p.source === "installed").length, 0);
});

test("listSkills: description fallback = first non-heading line, clipped", () => {
  const root = tmpHome();
  const skillsDir = mk(path.join(root, "skills"));
  w(path.join(skillsDir, "s1", "SKILL.md"), "# Title\n\nThis is the first body line and it is quite long. ".repeat(8) + "\n");
  const [s] = listSkills([skillsDir]);
  assert.ok(s, "skill entry found");
  assert.equal(s.description.length <= 200, true);
  assert.ok(s.description.startsWith("This is the first body line"));
});

test("renderDigest: structure + hard cap 200 lines with truncation marker", () => {
  const fx = fullFixture();
  // blow the budget: 200 skills on claude
  for (let i = 0; i < 300; i++) w(path.join(fx.claudeDir, "skills", `sk-${i}`, "SKILL.md"), `---\ndescription: s${i}\n---\nx\n`);
  const r = scanOf(fx);
  const digest = renderDigest(r);
  const lineCount = digest.split("\n").length;
  assert.ok(lineCount <= 202, `digest lines ${lineCount}`); // cap + final truncation marker line(s)
  assert.ok(/\(\+\d+ more — see \.mawf\/inventory\.json\)/.test(digest), "truncation marker present");
  assert.ok(digest.includes("## claude-code — caps:"));
  assert.ok(digest.includes("- mcp ("));
  assert.ok(digest.includes("- marketplaces ("));
});

test("renderDigest: per-host sections with capabilities/skills/mcp/models", () => {
  const fx = fullFixture();
  const digest = renderDigest(scanOf(fx));
  for (const app of ["claude-code", "codex", "pi", "dsh"]) {
    assert.ok(digest.includes(`## ${app} — caps:`), app);
  }
  assert.ok(digest.includes("grilling"));
  assert.ok(digest.includes("zai-cn-web-search"));
  assert.ok(digest.includes("glm-4.5-air"));
});

test("writeInventoryArtifacts: writes .mawf/inventory.json + digest", () => {
  const fx = fullFixture();
  const r = scanOf(fx);
  const paths = writeInventoryArtifacts(fx.projectDir, r);
  assert.ok(fs.existsSync(paths.jsonPath));
  assert.ok(fs.existsSync(paths.digestPath));
  const round = JSON.parse(fs.readFileSync(paths.jsonPath, "utf8"));
  assert.equal(round.hosts.length, 4);
});

test("scanInventory: cc-switch absent → hosts still scanned, models empty", () => {
  const fx = fullFixture();
  fs.rmSync(path.join(fx.claudeDir, "skills"), { recursive: true, force: true }); // claude dir still exists
  const r = scanOf(fx);
  const claude = r.hosts.find((h) => h.app === "claude-code");
  assert.deepEqual(claude.skills.filter((s) => s.origin === "user-global"), []); // user dir emptied
  assert.deepEqual(claude.models, []); // no cc-switch db in fixture (dbPath nonexistent)
});

// --- pi 0.84.3 skill-discovery adaptation (2026-08-31 host-changelog audit rows 1+2) ---

test("pi 0.84.3: grouped nested .md skills discovered; README/AGENTS never skills; skill dirs not treated as groups", () => {
  const root = tmpHome();
  const skillsDir = mk(path.join(root, "pi", "skills"));
  w(path.join(skillsDir, "grilling", "SKILL.md"), "---\ndescription: grill\n---\nx\n"); // classic skill dir
  w(path.join(skillsDir, "research", "find-docs.md"), "---\ndescription: find docs\n---\nx\n"); // grouped single-file skill
  w(path.join(skillsDir, "research", "to-issues.md"), "# to issues\nA nested skill without frontmatter.\n");
  w(path.join(skillsDir, "research", "README.md"), "# group readme"); // non-skill markdown
  w(path.join(skillsDir, "research", "AGENTS.md"), "# agents");
  w(path.join(skillsDir, "solo.md"), "---\ndescription: solo root skill\n---\nx\n"); // root .md (pi rule)
  w(path.join(skillsDir, "README.md"), "# dir readme"); // non-skill root markdown
  const list = listSkills([[skillsDir, "user-global"]]);
  const names = list.map((s) => s.name).sort();
  assert.deepEqual(names, ["find-docs", "grilling", "solo", "to-issues"]);
});

test("pi 0.84.3: grouped .md skills discovered in .agents/skills surfaces; bare root .md still ignored there", () => {
  const root = tmpHome();
  const agentsSkills = mk(path.join(root, ".agents", "skills"));
  w(path.join(agentsSkills, "group-a", "to-issues.md"), "---\ndescription: t\n---\nx\n");
  w(path.join(agentsSkills, "caveman", "SKILL.md"), "---\ndescription: c\n---\nx\n"); // skill dir, not a group
  w(path.join(agentsSkills, "loose.md"), "---\ndescription: bare root md in agents dir\n---\nx\n"); // ignored per pi rule
  const list = listSkills([[agentsSkills, "agents-global"]]);
  const names = list.map((s) => s.name).sort();
  assert.deepEqual(names, ["caveman", "to-issues"]);
});

// --- codex 0.151.0 per-repository plugin catalog adaptation (audit row 4) ---

test("codex 0.151.0: project .codex/config.toml + .codex/skills scanned, deduped against global config", () => {
  const root = tmpHome();
  const codexDir = mk(path.join(root, "h", ".codex"));
  w(path.join(codexDir, "config.toml"), `[plugins."global@market"]\nenabled = true\n\n[mcp_servers.global-srv]\ncommand = "npx"\n`);
  const projectDir = mk(path.join(root, "proj"));
  w(path.join(projectDir, ".codex", "config.toml"), `[plugins."proj-plug@market"]\nenabled = true\n\n[mcp_servers."proj-srv"]\ncommand = "x"\n\n[mcp_servers.global-srv]\ncommand = "dup"\n`);
  w(path.join(projectDir, ".codex", "skills", "proj-codex-skill", "SKILL.md"), "---\ndescription: p\n---\nx\n");
  const none = path.join(root, "none");
  const report = scanInventory({
    claudeDir: none, piDir: none, dshHome: none,
    claudeJson: path.join(root, "none.json"),
    codexDir, projectDir, dbPath: "/nonexistent/ccswitch.db",
  });
  const codex = report.hosts.find((h) => h.app === "codex");
  assert.ok(codex, "codex host scanned");
  assert.ok(codex.plugins.some((p) => p.name === "proj-plug@market" && p.source === "codex-project-config.toml"), "project plugin listed");
  assert.ok(codex.plugins.some((p) => p.name === "global@market" && p.source === "codex-config.toml"), "global plugin listed");
  assert.equal(codex.plugins.filter((p) => p.name === "global@market").length, 1, "no plugin dupe across configs");
  assert.ok(codex.mcps.some((m) => m.name === "proj-srv" && m.source === "codex-project-config.toml"), "project mcp listed");
  assert.equal(codex.mcps.filter((m) => m.name === "global-srv").length, 1, "global mcp name wins, no dupe");
  assert.ok(codex.skills.some((s) => s.name === "proj-codex-skill" && s.origin === "project"), "project .codex/skills listed");
});

// --- codex 0.152.0/0.153.0 adaptations (upstream round 2, audit rows A4/A5) ---

test("codex 0.152.0: MCP names with `:` `@` `/` `.` parse as atomic quoted keys, never dropped as dotted children", () => {
  const root = tmpHome();
  const codexDir = mk(path.join(root, "h", ".codex"));
  w(path.join(codexDir, "config.toml"), [
    `[mcp_servers."pkg@market:server/1.0"]`, `command = "npx"`, ``,
    `[mcp_servers."tools.calendar"]`, `command = "npx"`, ``,
    `[mcp_servers.tools]`, `command = "npx"`, ``,
    `[mcp_servers."my srv"]`, `command = "npx"`, ``,
    `[mcp_servers.plain-srv_2]`, `command = "npx"`, ``,
    `[mcp_servers.plain-srv_2.env]`, `TOKEN = "x"`, ``,
  ].join("\n"));
  const none = path.join(root, "none");
  const report = scanInventory({
    claudeDir: none, piDir: none, dshHome: none,
    claudeJson: path.join(root, "none.json"),
    codexDir, projectDir: mk(path.join(root, "p")), dbPath: "/nonexistent/ccswitch.db",
  });
  const codex = report.hosts.find((h) => h.app === "codex");
  const names = codex.mcps.map((m) => m.name);
  assert.ok(names.includes("pkg@market:server/1.0"), "package-style name with : @ / . parsed verbatim");
  assert.ok(names.includes("tools.calendar"), "quoted dotted name kept (atomic, not a child of tools)");
  assert.ok(names.includes("tools"), "bare namespaced sibling kept");
  assert.ok(names.includes("my srv"), "quoted name with space parsed");
  assert.ok(names.includes("plain-srv_2"), "bare name parsed");
  assert.ok(!names.includes("plain-srv_2.env"), "genuine TOML sub-section still dropped");
});

test("codex 0.153.0: remote-marketplace plugin installs keep the [plugins.\"name@market\"] shape; [marketplaces.*] tables ignored", () => {
  const root = tmpHome();
  const codexDir = mk(path.join(root, "h", ".codex"));
  // shape verified against codex-rs config/src/plugin_edit.rs (set_plugin_enabled
  // writes plugins[plugin_key] with plugin_key = "name@marketplace" via toml_edit;
  // remote marketplaces register under [marketplaces.<name>] — not a plugin surface)
  w(path.join(codexDir, "config.toml"), [
    `[marketplaces."my-remote-marketplace"]`, `git = "https://example.com/plugins.git"`, ``,
    `[plugins."remote-plugin@my-remote-marketplace"]`, `enabled = true`, ``,
    `[plugins."documents@openai-primary-runtime"]`, `enabled = true`, ``,
  ].join("\n"));
  const none = path.join(root, "none");
  const report = scanInventory({
    claudeDir: none, piDir: none, dshHome: none,
    claudeJson: path.join(root, "none.json"),
    codexDir, projectDir: mk(path.join(root, "p")), dbPath: "/nonexistent/ccswitch.db",
  });
  const codex = report.hosts.find((h) => h.app === "codex");
  const pluginNames = codex.plugins.map((p) => p.name);
  assert.ok(pluginNames.includes("remote-plugin@my-remote-marketplace"), "remote-marketplace plugin listed with name@market key");
  assert.ok(pluginNames.includes("documents@openai-primary-runtime"), "official-marketplace plugin listed");
  assert.equal(codex.plugins.length, 2, "no phantom plugins from [marketplaces.*] tables");
});

// --- dsh real captured dump-config fixtures (upstream round 2, audit rows A1/A2, live-verified) ---
// dsh-dump-0.1.2a2.txt  — captured 2026-08-31 on 0.1.2-alpha.2 core: post
//   dsh-web-ui-all→dsh-web-all migration but PRE the 2026-09-05 plugin-rename
//   wave (@deepseek-ai/dsh-plugin-console / @omdsh-dev/dsh-genui /
//   @omdsh-dev/dsh-drag-and-drop git names) and PRE web-all 0.3.14
//   sub-plugin namespacing — the LEGACY plugin-name regression fixture.
// dsh-dump-0.1.2rc1.txt — captured 2026-09-05 on 0.1.2-rc.1 core after the
//   rename wave (@noob-stupid/dsh-plugin-console@0.3.24,
//   @changfenhuang/dsh-genui@0.9.7, dsh-drag-and-drop@0.1.6, dsh-at-file 0.7.0
//   git, @linxin666/dsh-web-all@0.3.14 namespaced sub-plugins,
//   dsh-plugin-terminal 0.2.0) — the CURRENT plugin-id shape.

function scanDshFixture(dump) {
  const root = tmpHome();
  const dshHome = mk(path.join(root, "h", ".dsh"));
  w(path.join(dshHome, "settings.yaml"), "agent-presets:\n  default: x\n");
  const none = path.join(root, "none");
  const report = scanInventory({
    claudeDir: none, piDir: none, codexDir: none,
    claudeJson: path.join(root, "none.json"),
    dshHome, projectDir: mk(path.join(root, "p")), dbPath: "/nonexistent/ccswitch.db",
    dshDumpConfig: dump,
  });
  return report.hosts.find((h) => h.app === "dsh");
}

for (const [file, label] of [
  ["./fixtures/dsh-dump-0.1.2a2.txt", "dsh 0.1.2-alpha.2 (2026-08-31, legacy plugin names)"],
  ["./fixtures/dsh-dump-0.1.2rc1.txt", "dsh 0.1.2-rc.1 (2026-09-05, rename wave + web-all 0.3.14 namespacing)"],
]) {
  test(`real dump-config fixture ${label}: plugins parse, no duplicate ids`, () => {
    const dump = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const dsh = scanDshFixture(dump);
    assert.ok(dsh, "dsh host scanned");
    assert.ok(dsh.plugins.length >= 170, `real dump yields the full plugin table (got ${dsh.plugins.length})`);
    assert.ok(dsh.plugins.some((p) => /dsh-web-all/.test(p.origin || "")), "@linxin666/dsh-web-all bundle origin present");
    const ids = dsh.plugins.map((p) => p.id);
    assert.equal(ids.filter((x, i) => ids.indexOf(x) !== i).length, 0, "no duplicate plugin ids");
  });
}

test("dsh 0.1.2-rc.1 fixture: plugin-rename wave ids + web-all 0.3.14 namespaced sub-plugins", () => {
  const dump = fs.readFileSync(new URL("./fixtures/dsh-dump-0.1.2rc1.txt", import.meta.url), "utf8");
  const dsh = scanDshFixture(dump);
  const names = dsh.plugins.map((p) => p.name);
  const origins = dsh.plugins.map((p) => p.origin || "");
  // rename wave (audit row A2): new registry names present, old git names gone
  assert.ok(origins.some((o) => o.includes("@noob-stupid/dsh-plugin-console")), "renamed console bundle origin present");
  assert.ok(origins.every((o) => !o.includes("@deepseek-ai/dsh-plugin-console")), "old console name absent");
  assert.ok(origins.some((o) => o.includes("dsh-drag-and-drop")), "renamed drag-and-drop bundle origin present");
  assert.ok(origins.some((o) => o.includes("@changfenhuang/dsh-genui")), "renamed genui bundle origin present");
  assert.ok(origins.every((o) => !o.includes("@omdsh-dev/")), "no @omdsh-dev/* residue");
  // web-all 0.3.14 namespacing: sub-plugin names under dsh-web-all/<x>
  const ns = names.filter((n) => /^@linxin666\/dsh-web-all\//.test(n));
  assert.ok(ns.length >= 10, `namespaced web-all sub-plugin names parsed (got ${ns.length})`);
  assert.ok(dump.includes("plugin: '@linxin666/dsh-client-ui-web-ui-settings'"), "nested config.plugin key preserved in fixture");
  // rc.1 core: one-way report tool removed (superseded by send_message), turn-outline added
  assert.ok(names.every((n) => !n.includes("dsh-tool-subagent-report")), "one-way report tool gone in rc.1");
  assert.ok(names.some((n) => n.includes("dsh-session-turn-outline")), "session-turn-outline present in rc.1");
});

test("dsh 0.1.2-alpha.2 legacy fixture keeps pre-rename plugin-name shapes parsing", () => {
  const dump = fs.readFileSync(new URL("./fixtures/dsh-dump-0.1.2a2.txt", import.meta.url), "utf8");
  const dsh = scanDshFixture(dump);
  const names = dsh.plugins.map((p) => p.name);
  const origins = dsh.plugins.map((p) => p.origin || "");
  assert.ok(origins.some((o) => o.includes("@deepseek-ai/dsh-plugin-console")), "old console git name present (legacy)");
  assert.ok(names.some((n) => n.includes("@linxin666/dsh-client-ui-web-ui-settings")), "flat pre-namespacing client-ui name parses (legacy)");
  assert.ok(names.some((n) => n.includes("dsh-tool-subagent-report")), "report tool present pre-rc.1 (legacy)");
});
