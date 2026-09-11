import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planWorkflow, scoreArchitectures, inferSignals } from "../src/planner.js";

const host = { app: "claude-code", hasSubagents: true, hasMultiAgent: true, hasDynamicWorkflow: true, codexPluginInstalled: true, codexBinary: "/x/codex" };
const cc = {
  currentProviders: {
    claude: { name: "Deep Worker", cost_multiplier: 1, settings_config: { env: { ANTHROPIC_MODEL: "claude-opus-5" } } },
    codex: { name: "Codex", cost_multiplier: 1, settings_config: { model: "gpt-5.2-codex" } },
  },
  modelPricing: { "claude-opus-5": {}, "gpt-5.2-codex": {} },
};

test("tiny low-risk fixed task scores highest for 'none'", () => {
  const s = scoreArchitectures({ files: 2, parallelizableSubtasks: 0, risk: "low", contextNeed: "small", taskType: "coding" }, host);
  assert.ok(s.none.score > 0);
});

test("high parallelism + high value picks multi-agent/dynamic", () => {
  const p = planWorkflow(
    { files: 60, parallelizableSubtasks: 6, risk: "high", contextNeed: "large", valuePerRun: "high", taskType: "research" },
    { host, ccSwitch: cc }
  );
  assert.ok(p.selected.includes("multi-agent") || p.selected.includes("dynamic") || p.selected.includes("orchestrator-workers"), `got ${p.selected}`);
  assert.ok(p.agents.length >= 2);
  // reviewer present because codex available
  assert.ok(p.agents.some((a) => a.role === "reviewer"));
});

test("high-risk coding with codex available picks ultracode", () => {
  const p = planWorkflow(
    { files: 40, parallelizableSubtasks: 2, risk: "high", contextNeed: "medium", valuePerRun: "medium", taskType: "coding" },
    { host, ccSwitch: cc }
  );
  assert.equal(p.primary, "ultracode");
  assert.ok(p.selected.includes("loop"));
  assert.ok(p.selected.includes("graph"));
  assert.ok(p.reviewPoints.some((rp) => rp.label?.includes("ultracode")));
});

test("needHITL/needPersistence pushes toward graph", () => {
  const p = planWorkflow(
    { files: 25, parallelizableSubtasks: 2, risk: "high", contextNeed: "medium", needHITL: true, needPersistence: true, taskType: "migration" },
    { host, ccSwitch: cc }
  );
  assert.ok(p.selected.includes("graph"), `got ${p.selected}`);
});

test("cost limits are applied independently and not summed", () => {
  const p = planWorkflow(
    { files: 30, parallelizableSubtasks: 4, risk: "medium", contextNeed: "large", valuePerRun: "high", taskType: "coding" },
    { host, ccSwitch: cc, cost: { perAgent: 1.5, total: 8, maxConcurrency: 3 } }
  );
  assert.equal(p.cost.perAgentLimitUsdPerMin, 1.5);
  assert.equal(p.cost.totalLimitUsdPerMin, 8);
  assert.equal(p.cost.maxConcurrency, 3);
  assert.ok(p.cost.totalLimitUsdPerMin !== p.agents.length * p.cost.perAgentLimitUsdPerMin, "total limit must be independent");
});

test("graceful degradation: no codex -> second claude reviewer when risk high", () => {
  const noCodexHost = { ...host, codexPluginInstalled: false, hasDynamicWorkflow: true, codexBinary: null };
  const p = planWorkflow(
    { files: 40, parallelizableSubtasks: 2, risk: "high", contextNeed: "medium", valuePerRun: "medium", taskType: "coding" },
    { host: noCodexHost, ccSwitch: cc }
  );
  assert.equal(p.codex.enabled, false);
  const reviewer = p.agents.find((a) => a.role === "reviewer");
  assert.ok(reviewer, "must still have a reviewer via graceful degradation");
  assert.equal(reviewer.agent, "claude-code");
  assert.match(reviewer.task, /codex unavailable/i);
});

test("inferSignals scales parallelism with project size", () => {
  const small = inferSignals({ files: 5, languages: ["js"] });
  assert.ok(small.parallelizableSubtasks <= 3);
  const big = inferSignals({ files: 120, languages: ["js", "py", "go", "rs"] });
  assert.ok(big.parallelizableSubtasks >= 3);
  assert.equal(big.risk, "high");
  assert.equal(big.contextNeed, "large");
});

test("default cost limits are $5/min per agent, $10/min total, concurrency 16", () => {
  const p = planWorkflow({ files: 10, parallelizableSubtasks: 2, risk: "medium", contextNeed: "medium", taskType: "coding" }, { host, ccSwitch: cc });
  assert.equal(p.cost.perAgentLimitUsdPerMin, 5.0);
  assert.equal(p.cost.totalLimitUsdPerMin, 10.0);
  assert.equal(p.cost.maxConcurrency, 16);
});
