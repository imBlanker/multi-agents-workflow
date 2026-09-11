import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { planWorkflow } from "../src/planner.js";
import { generateConfigs } from "../src/configgen.js";
import { readJson, exists } from "../src/util.js";

const host = { app: "claude-code", hasSubagents: true, hasMultiAgent: true, hasDynamicWorkflow: true, codexPluginInstalled: true, codexBinary: "/x/codex" };
const cc = {
  currentProviders: {
    claude: { name: "Deep Worker", cost_multiplier: 1, settings_config: { env: { ANTHROPIC_MODEL: "claude-opus-5" } } },
    codex: { name: "Codex", cost_multiplier: 1, settings_config: { model: "gpt-5.2-codex" } },
  },
  modelPricing: { "claude-opus-5": { input_per_m: 5, output_per_m: 25, cache_read_per_m: 0.5, cache_creation_per_m: 6.25, source: "cc-switch" }, "gpt-5.2-codex": { input_per_m: 1.75, output_per_m: 14, cache_read_per_m: 0.175, cache_creation_per_m: 0, source: "cc-switch" } },
};

function mkTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-cfg-"));
  return tmp;
}

test("generateConfigs writes per-agent .md and .json for every role", () => {
  const proj = mkTmpProject();
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host, ccSwitch: cc });
  const gen = generateConfigs(proj, plan, cc);
  assert.ok(gen.files.length >= 4);
  assert.ok(exists(path.join(proj, ".mawf", "workflow.json")));
  assert.ok(exists(path.join(proj, ".mawf", "config.yaml")));
  assert.ok(exists(path.join(proj, ".mawf", "plan.md")));
  assert.ok(exists(path.join(proj, ".mawf", "graph.json")));
  for (const a of plan.agents) {
    assert.ok(exists(path.join(proj, ".mawf", "agents", `${a.role}.md`)), `missing ${a.role}.md`);
    assert.ok(exists(path.join(proj, ".mawf", "agents", `${a.role}.json`)), `missing ${a.role}.json`);
  }
  fs.rmSync(proj, { recursive: true, force: true });
});

test("per-agent json carries model, cost limit, tools, and price source", () => {
  const proj = mkTmpProject();
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host, ccSwitch: cc });
  generateConfigs(proj, plan, cc);
  const reviewer = readJson(path.join(proj, ".mawf", "agents", "reviewer.json"));
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.agent, "codex");
  assert.equal(reviewer.model, "gpt-5.2-codex");
  assert.equal(reviewer.cost_rate_limit_usd_per_min, 5);
  assert.equal(reviewer.price.source, "cc-switch");
  assert.equal(reviewer.price.estimated, false);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("config.yaml contains editable cost knobs", () => {
  const proj = mkTmpProject();
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host, ccSwitch: cc, cost: { perAgent: 1.5, total: 7, maxConcurrency: 3 } });
  generateConfigs(proj, plan, cc);
  const yaml = fs.readFileSync(path.join(proj, ".mawf", "config.yaml"), "utf8");
  assert.match(yaml, /per_agent_limit_usd_per_min: 1\.5/);
  assert.match(yaml, /total_limit_usd_per_min: 7/);
  assert.match(yaml, /max_concurrency: 3/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("warnings emitted when model price unknown", () => {
  const proj = mkTmpProject();
  const plan = {
    name: "t", primary: "loop", selected: ["loop"],
    agents: [{ role: "x", agent: "claude-code", model: "totally-unknown-model-xyz", appType: "claude", costRateLimitUsdPerMin: 1, concurrency: 1, tools: [], reviewRequired: false, task: "x" }],
    groups: [], reviewPoints: [], loops: [],
    cost: { perAgentLimitUsdPerMin: 1, totalLimitUsdPerMin: 10, maxConcurrency: 4, sources: [] },
    hostApp: "claude-code", hostCapabilities: [], codex: { enabled: false, when: [], reviewScopes: [] }, signals: {}, rationale: [], createdAt: "",
  };
  const gen = generateConfigs(proj, plan, { modelPricing: {} });
  assert.ok(gen.warnings.length >= 1, `expected >=1 warning, got ${JSON.stringify(gen.warnings)}`);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("regenerating with fewer agents prunes stale agent files", () => {
  const proj = mkTmpProject();
  const big = planWorkflow({ files: 40, parallelizableSubtasks: 5, risk: "medium", contextNeed: "medium", taskType: "coding" }, { host, ccSwitch: cc });
  generateConfigs(proj, big, cc);
  const agentsDir = path.join(proj, ".mawf", "agents");
  const before = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json")).length;
  assert.ok(before >= 4, `expected several agents, got ${before}`);
  const small = planWorkflow({ files: 5, parallelizableSubtasks: 1, risk: "low", contextNeed: "small", taskType: "coding" }, { host, ccSwitch: cc });
  generateConfigs(proj, small, cc);
  const after = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json")).length;
  assert.equal(after, small.agents.length, "stale agent files must be pruned to match the new roster");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("pi host materializes .pi/agents/maw-*.md and advertises pi-subagents invocation", () => {
  const proj = mkTmpProject();
  const piHost = { ...host, app: "pi" };
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host: piHost, ccSwitch: cc });
  const gen = generateConfigs(proj, plan, cc);
  assert.equal(plan.hostApp, "pi");
  assert.ok(gen.files.some((f) => f.includes(path.join(".pi", "agents"))), "pi agent files must be in the generated list");
  for (const a of plan.agents.filter((a) => a.appType === "pi" || a.agent === "pi")) {
    const f = path.join(proj, ".pi", "agents", `maw-${a.role}.md`);
    assert.ok(exists(f), `missing pi agent file ${f}`);
    const md = fs.readFileSync(f, "utf8");
    assert.match(md, /^---\nname: maw-/m);
    assert.match(md, /^description: /m);
    assert.match(md, /^tools: /m);
    assert.match(md, /\.mawf\/agents/);
  }
  // the portable markdown points non-codex roles at pi-subagents
  const impl = fs.readFileSync(path.join(proj, ".mawf", "agents", "implementer.md"), "utf8");
  assert.match(impl, /pi-subagents/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("pi materialization prunes stale maw-* pi files but never trellis-*", () => {
  const proj = mkTmpProject();
  const piHost = { ...host, app: "pi" };
  const big = planWorkflow({ files: 40, parallelizableSubtasks: 5, risk: "medium", contextNeed: "medium", taskType: "coding" }, { host: piHost, ccSwitch: cc });
  generateConfigs(proj, big, cc);
  const piAgents = path.join(proj, ".pi", "agents");
  // a user/trellis pi agent file must survive pruning
  fs.writeFileSync(path.join(piAgents, "trellis-implement.md"), "# keep me\n");
  const small = planWorkflow({ files: 5, parallelizableSubtasks: 1, risk: "low", contextNeed: "small", taskType: "coding" }, { host: piHost, ccSwitch: cc });
  generateConfigs(proj, small, cc);
  const files = fs.readdirSync(piAgents).filter((f) => f.endsWith(".md"));
  assert.ok(files.includes("trellis-implement.md"), "trellis-* must be preserved");
  for (const a of small.agents.filter((a) => a.appType === "pi" || a.agent === "pi")) assert.ok(files.includes(`maw-${a.role}.md`), `expected maw-${a.role}.md`);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("dsh host: portable specs are the payload, nothing materialized under .dsh/", () => {
  const proj = mkTmpProject();
  const dshHost = { ...host, app: "dsh" };
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host: dshHost, ccSwitch: cc });
  const gen = generateConfigs(proj, plan, cc);
  assert.equal(plan.hostApp, "dsh");
  // no dsh-native surface — configgen must not write anything under .dsh/
  assert.ok(!gen.files.some((f) => f.includes(path.join(proj, ".dsh"))), "no files may be written under .dsh/");
  assert.ok(!exists(path.join(proj, ".dsh")) || fs.readdirSync(path.join(proj, ".dsh")).length === 0, "no .dsh materialization");
  // agent markdown points at the prompt-driven subagent tool + portable spec + guards
  const impl = fs.readFileSync(path.join(proj, ".mawf", "agents", "implementer.md"), "utf8");
  assert.match(impl, /prompt-driven subagent tool/);
  assert.match(impl, new RegExp("\\.mawf/agents/implementer\\.md"));
  assert.match(impl, /mawf acquire --role implementer/);
  assert.match(impl, /model-pricing\.json/);
  // machine config carries app_type dsh
  const spec = readJson(path.join(proj, ".mawf", "agents", "implementer.json"));
  assert.equal(spec.app_type, "dsh");
  // plan.md gains the dsh host notes section
  const planMd = fs.readFileSync(path.join(proj, ".mawf", "plan.md"), "utf8");
  assert.match(planMd, /Host notes — DeepSeek Harness \(dsh\)/);
  assert.match(planMd, /\.agents\/skills\//);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("Pi generated Agent frontmatter preserves tools/model selection and external Codex routing", (t) => {
  const proj = mkTmpProject();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const plan = planWorkflow({ files: 30, parallelizableSubtasks: 4, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "coding" }, { host: { ...host, app: "pi" }, ccSwitch: cc });
  const impl = plan.agents.find((a) => a.role === "implementer");
  impl.model = "model-id"; impl.modelChoice = { provider: "Provider display label", providerId: "custom-provider" }; impl.modelReasoningEffort = "low";
  impl.tools = ["Read", "Bash", "Edit", "Write", "Grep", "Glob", "Task", "Agent", "custom_tool"];
  plan.name = 'workflow: "quoted"';
  fs.mkdirSync(path.join(proj, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".pi", "agents", "maw-reviewer.md"), "Stale incorrectly materialized Codex reviewer");
  generateConfigs(proj, plan, cc);
  const native = fs.readFileSync(path.join(proj, ".pi", "agents", "maw-implementer.md"), "utf8");
  const field = (name) => JSON.parse(native.match(new RegExp(`^${name}: (.+)$`, "m"))[1]);
  assert.deepEqual(field("tools"), ["read", "bash", "edit", "write", "grep", "find", "custom_tool"]);
  assert.equal(field("model"), "custom-provider/model-id");
  assert.equal(field("thinking"), "low");
  assert.ok(field("description").includes(plan.name));
  const portable = fs.readFileSync(path.join(proj, ".mawf", "agents", "implementer.md"), "utf8");
  assert.match(portable, /Agent/);
  assert.doesNotMatch(portable, /trellis_subagent/);
  assert.match(portable, /confirming the extension/);
  assert.match(portable, /does not allow child agents to spawn/);
  assert.ok(portable.includes("Pi (Session)"));
  assert.doesNotMatch(portable, /real-spend is not measured/);
  const reviewer = plan.agents.find((a) => a.agent === "codex");
  assert.ok(reviewer);
  assert.ok(!exists(path.join(proj, ".pi", "agents", `maw-${reviewer.role}.md`)));
  assert.match(fs.readFileSync(path.join(proj, ".mawf", "agents", `${reviewer.role}.md`), "utf8"), /codex-plugin-cc/);
});
