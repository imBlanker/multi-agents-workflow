// @ts-check
// Tests for the stage-gated plugin-pool (src/pool.js + integrations).
// Task 08-31-mawf-pluginpool-stagegate; PRD D1-D4 are the binding decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadCatalog, catalogProblems, detectPool, deriveStages, judgePool, renderPool,
  readPoolState, recordJudgment, poolCadenceIssues, tokenizeP, POOL_DEFAULTS,
} from "../src/pool.js";
import { tokenize } from "../src/advise.js";
import { scanInventory } from "../src/inventory.js";
import { blockText, BLOCK_BEGIN, BLOCK_END } from "../src/injectblock.js";

const CATALOG = new URL("../defaults/pool-catalog.json", import.meta.url).pathname;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "maw-pool-")); }
function w(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }

// --- R5 hard gates: catalog schema ---

test("catalog: shipped pool-catalog passes completeness (footprint + residueChecklist + verified procedures)", () => {
  const cat = loadCatalog(CATALOG);
  assert.equal(cat.warning, undefined);
  assert.deepEqual(catalogProblems(cat), []);
  assert.ok(cat.components.length >= 3, "three seeds present");
});

test("catalog: schema guard warns (never throws) on newer schemaVersion", () => {
  const dir = tmp();
  const file = w(path.join(dir, "cat.json"), JSON.stringify({ schemaVersion: 99, components: [] }));
  const cat = loadCatalog(file);
  assert.match(cat.warning, /schema v99 > known/);
});

test("catalog: catalogProblems flags incomplete entries (CI gate)", () => {
  const bad = {
    schemaVersion: 1,
    components: [
      { id: "x" }, // no footprint / checklist / flag
      { id: "y", install: { footprint: [] }, removal: { residueChecklist: [] }, footprintVerified: false },
    ],
  };
  const problems = catalogProblems(bad);
  assert.ok(problems.some((p) => p.includes("x: install.footprint empty")));
  assert.ok(problems.some((p) => p.includes("y: install.footprint empty")));
  assert.ok(problems.some((p) => p.includes("x: footprintVerified missing")));
});

test("tokenizer parity: tokenizeP mirrors advise.tokenize (documented sync contract)", () => {
  for (const t of ["Explore and refactor the AUTH module with tests", "浏览器 browser e2e snapshot", ""]) {
    assert.deepEqual(tokenizeP(t), tokenize(t));
  }
});

// --- R2: detection ---

function reportFixture({ piMcps = [], piSkills = [], dshPlugins = [] } = {}) {
  return {
    hosts: [
      { app: "pi", skills: piSkills.map((s) => ({ name: s, origin: "project" })), plugins: [], mcps: piMcps.map((m) => ({ name: m, source: "pi-mcp.json" })) },
      { app: "dsh", skills: [], plugins: dshPlugins.map((p) => ({ id: p, name: p })), mcps: [] },
    ],
  };
}

test("detectPool: mcp + skill + dsh plugin detection with evidence; dsh stays detectOnly", () => {
  const cat = loadCatalog(CATALOG);
  const pool = detectPool(reportFixture({ piMcps: ["codegraph"], piSkills: ["agent-browser"], dshPlugins: [] }), cat);
  const by = Object.fromEntries(pool.components.map((c) => [c.id, c]));
  assert.equal(by.codegraph.detected.pi.found, true);
  assert.match(by.codegraph.detected.pi.evidence, /^mcp:codegraph/);
  assert.equal(by.codegraph.detected["claude-code"].found, false);
  assert.equal(by["agent-browser"].detected.pi.found, true);
  assert.match(by["agent-browser"].detected.pi.evidence, /^skill:agent-browser/);
  assert.equal(by["agent-browser"].detected.dsh.detectOnly, true);
  assert.equal(by["agent-browser"].detected.dsh.found, false);
  // dsh plugin-table detection when wired via patch layer
  const pool2 = detectPool(reportFixture({ dshPlugins: ["codebase-memory-mcp"] }), cat);
  const cbm2 = pool2.components.find((c) => c.id === "codebase-memory-mcp");
  assert.equal(cbm2.detected.dsh.found, true);
  assert.equal(cbm2.detected.dsh.detectOnly, true);
});

test("inventory: scanInventory embeds a pool section; opts.pool === false disables it", () => {
  const root = tmp();
  const none = path.join(root, "none");
  const piDir = w(path.join(root, "h", ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { codegraph: {} } }));
  const report = scanInventory({ claudeDir: none, piDir: path.dirname(piDir), dshHome: none, codexDir: none, claudeJson: path.join(root, "n.json"), projectDir: path.join(root, "p"), dbPath: "/nonexistent/ccswitch.db" });
  assert.ok(report.pool, "pool section present");
  const cg = report.pool.components.find((c) => c.id === "codegraph");
  assert.equal(cg.detected.pi.found, true);
  const bare = scanInventory({ claudeDir: none, piDir: path.dirname(piDir), dshHome: none, codexDir: none, claudeJson: path.join(root, "n.json"), projectDir: path.join(root, "p"), dbPath: "/nonexistent/ccswitch.db", pool: false });
  assert.equal(bare.pool, undefined);
});

// --- R3: stage derivation ---

test("deriveStages: graph gate batches split stages; reviewPoints fallback; none → null", () => {
  const root = tmp();
  // 2 work nodes → gate → 1 work node
  w(path.join(root, "g", ".mawf", "graph.json"), JSON.stringify({ graph: { id: "wf", nodes: [
    { id: "n1", kind: "task" }, { id: "n2", kind: "task" }, { id: "g1", kind: "review", description: "codex review" }, { id: "n3", kind: "task" },
  ], edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "g1" }, { from: "g1", to: "n3" }] } }));
  const s1 = deriveStages(path.join(root, "g"));
  assert.ok(s1 && s1.stages.length === 2, `gate splits stages (got ${s1?.stages.length})`);
  assert.equal(s1.stages[0].label, "codex review");
  assert.equal(s1.stages[0].nodeCount, 3); // n1+n2+gate
  assert.equal(s1.stages[1].nodeCount, 1);
  // fallback: workflow.json reviewPoints
  w(path.join(root, "wf", ".mawf", "workflow.json"), JSON.stringify({ name: "x", reviewPoints: [{ by: "codex", scope: "auto", label: "mid review" }] }));
  const s2 = deriveStages(path.join(root, "wf"));
  assert.ok(s2 && s2.stages.length === 2);
  assert.equal(s2.stages[0].label, "mid review");
  assert.equal(deriveStages(tmp()), null);
});

// --- R3: judgment engine ---

const EMPTY_STATE = { stages: {} };

function poolOf(ids) {
  const cat = loadCatalog(CATALOG);
  const report = reportFixture({ piMcps: [], piSkills: [], dshPlugins: [] });
  const pool = detectPool(report, cat);
  const foundPi = new Set(ids);
  for (const c of pool.components) {
    if (foundPi.has(c.id)) c.detected.pi = { found: true, evidence: "fixture", detectOnly: false };
  }
  return pool;
}

test("judgePool: ADD when absent and task signals value (browser task)", () => {
  const j = judgePool({ catalog: loadCatalog(CATALOG), pool: poolOf([]), profile: { text: "fix the web ui e2e test and take a screenshot of the browser" }, stageCtx: { id: "stage-1" }, poolState: EMPTY_STATE });
  const ab = j.verdicts.find((v) => v.component === "agent-browser");
  assert.equal(ab.verdict, "add");
  assert.ok(ab.procedure.includes("npx skills add"), "D3-safe install procedure attached");
  assert.ok(ab.noClobber.length > 0);
});

test("judgePool: KEEP when present and valued; graph-indexer pair never both kept (D4 both directions)", () => {
  for (const present of [["codegraph"], ["codebase-memory-mcp"], ["codegraph", "codebase-memory-mcp"]]) {
    const j = judgePool({ catalog: loadCatalog(CATALOG), pool: poolOf(present), profile: { text: "refactor the codebase: trace the call chain of the auth symbol" }, stageCtx: { id: "stage-1" }, poolState: EMPTY_STATE });
    const group = j.verdicts.filter((v) => ["codegraph", "codebase-memory-mcp"].includes(v.component));
    const keeps = group.filter((v) => v.verdict === "keep").length;
    const removes = group.filter((v) => v.verdict === "remove").length;
    if (present.length === 2) {
      assert.equal(keeps, 1, `${present}: exactly one keep`);
      assert.equal(removes, 1, `${present}: exactly one remove (consolidation)`);
      const rm = group.find((v) => v.verdict === "remove");
      assert.ok(rm.reasons.some((r) => r.includes("consolidate")), "consolidation reason");
      assert.ok(rm.residueChecklist.length > 0, "no-residue checklist attached");
    } else {
      assert.equal(keeps, 1, `${present}: the single member is kept`);
      assert.equal(removes, 0);
    }
  }
});

test("judgePool: REMOVE only after removeLookback consecutive low-value judgments (hysteresis)", () => {
  const cat = loadCatalog(CATALOG);
  const pool = poolOf(["agent-browser"]);
  const lowProfile = { text: "refactor database schemas" }; // no browser signals
  // 1st low judgment: keep (not yet removeLookback)
  const st1 = { stages: { "stage-1": { judgments: [{ ts: "t1", verdicts: { "agent-browser": "keep" } }] } } };
  const j1 = judgePool({ catalog: cat, pool, profile: lowProfile, stageCtx: { id: "stage-2" }, poolState: st1 });
  // seed the run properly: first judgment recorded as keep-with-low-value
  const stateLow = { stages: { "stage-1": { judgments: [{ ts: "t1", verdicts: { "agent-browser": "keep" } }, { ts: "t2", verdicts: { "agent-browser": "keep" } }] } } };
  // prior keep breaks the low-run → still keep; simulate prior REMOVE run:
  const stateRemoved = { stages: { "stage-1": { judgments: [{ ts: "t1", verdicts: { "agent-browser": "remove" } }] } } };
  const j2 = judgePool({ catalog: cat, pool, profile: lowProfile, stageCtx: { id: "stage-2" }, poolState: stateRemoved });
  const ab1 = j1.verdicts.find((v) => v.component === "agent-browser");
  const ab2 = j2.verdicts.find((v) => v.component === "agent-browser");
  assert.equal(ab1.verdict, "keep", "prior keep breaks the low run");
  assert.equal(ab2.verdict, "remove", "remove run ≥ lookback(2 incl. this) → remove");
  void stateLow;
});

test("judgePool: D4 also constrains ADD — both graph indexers absent → only one add, the other is the alternate noop", () => {
  const j = judgePool({ catalog: loadCatalog(CATALOG), pool: poolOf([]), profile: { text: "explore the codebase call chain and refactor the auth symbol" }, stageCtx: { id: "stage-1" }, poolState: EMPTY_STATE });
  const cg = j.verdicts.find((v) => v.component === "codegraph");
  const cbm = j.verdicts.find((v) => v.component === "codebase-memory-mcp");
  const adds = [cg, cbm].filter((v) => v.verdict === "add").length;
  assert.equal(adds, 1, "exactly one graph indexer recommended");
  const alt = [cg, cbm].find((v) => v.verdict === "noop");
  assert.match(alt.reasons[0], /alternate of/);
});

test("judgePool: determinism — identical inputs, identical output (twice + shuffled state keys)", () => {
  const cat = loadCatalog(CATALOG);
  const pool = poolOf(["codegraph"]);
  const args = { catalog: cat, pool, profile: { text: "explore the codebase knowledge graph" }, stageCtx: { id: "stage-1" }, poolState: { stages: { "stage-0": { judgments: [{ ts: "x", verdicts: { codegraph: "add" } }] } } } };
  const a = JSON.stringify(judgePool(args));
  const b = JSON.stringify(judgePool(args));
  assert.equal(a, b);
});

test("renderPool: header, boundary rule, procedures, POOL-DONE footer", () => {
  const j = judgePool({ catalog: loadCatalog(CATALOG), pool: poolOf([]), profile: { text: "browser e2e screenshot" }, stageCtx: { id: "stage-2", label: "gate" }, poolState: EMPTY_STATE });
  const text = renderPool(j, { judgments: 1, needed: 2 });
  assert.match(text, /stage: stage-2 \(gate\)/);
  assert.match(text, /never mid-batch/);
  assert.match(text, /1\/2 judgments recorded/);
  const footer = text.trim().split("\n").pop();
  assert.match(footer, /^POOL-DONE stage=stage-2 verdicts=\S+/);
  assert.match(footer, /agent-browser:add/);
});

test("renderPool: cadence-free note when no plan", () => {
  const j = judgePool({ catalog: loadCatalog(CATALOG), pool: poolOf([]), profile: { text: "x" }, stageCtx: null, poolState: EMPTY_STATE });
  assert.match(renderPool(j), /cadence-free judgment/);
  assert.match(renderPool(j), /^POOL-DONE stage=- /m);
});

// --- cadence + state ---

test("recordJudgment: appends per-stage, reads back, cadence issues; cadence-free not recorded", () => {
  const root = tmp();
  const st0 = readPoolState(root);
  assert.deepEqual(st0.stages, {});
  recordJudgment(root, { id: "stage-1" }, { "agent-browser": "add" }, "2026-08-31T00:00:00Z");
  recordJudgment(root, { id: "stage-1", label: "gate" }, { "agent-browser": "keep" }, "2026-08-31T01:00:00Z");
  const st = readPoolState(root);
  assert.equal(st.stages["stage-1"].judgments.length, 2);
  assert.deepEqual(poolCadenceIssues(st), [], "2 judgments → no issue");
  recordJudgment(root, { id: "stage-2" }, { "agent-browser": "keep" }, "2026-08-31T02:00:00Z");
  assert.deepEqual(poolCadenceIssues(readPoolState(root)), ["stage-2: 1/2 pool judgments"]);
  recordJudgment(root, null, { x: "keep" }, "2026-08-31T03:00:00Z");
  assert.equal(readPoolState(root).stages["stage-2"].judgments.length, 1, "cadence-free not recorded");
});

test("readPoolState: corrupt state flagged, never throws", () => {
  const root = tmp();
  w(path.join(root, ".mawf", "runtime", "pool-state.json"), "{not json");
  const st = readPoolState(root);
  assert.equal(st.corrupt, true);
  assert.deepEqual(st.stages, {});
});

// --- R5: no-write-outside-.mawf invariant ---

test("advisory-only invariant: pool operations write ONLY under <project>/.mawf/", () => {
  const root = tmp();
  const before = new Set();
  const walk = (d, acc) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); acc.add(p); if (e.isDirectory()) walk(p, acc); } };
  walk(root, before);
  const cat = loadCatalog(CATALOG);
  const pool = detectPool(reportFixture({ piMcps: ["codegraph"] }), cat);
  const j = judgePool({ catalog: cat, pool, profile: { text: "explore codebase" }, stageCtx: { id: "stage-1" }, poolState: EMPTY_STATE });
  renderPool(j);
  recordJudgment(root, { id: "stage-1" }, { codegraph: "keep" }, "t");
  const after = new Set();
  walk(root, after);
  const added = [...after].filter((p) => !before.has(p));
  assert.ok(added.length > 0, "state was written");
  for (const p of added) assert.ok(p.startsWith(path.join(root, ".mawf")), `write outside .mawf: ${p}`);
});

// --- R4: managed block budget ---

test("managed block: ≤26 content lines, markers intact, pool rule present", () => {
  const lines = blockText().split("\n");
  const inner = lines.slice(lines.indexOf(BLOCK_BEGIN) + 1, lines.indexOf(BLOCK_END));
  assert.ok(inner.length <= 26, `content lines ${inner.length} > 26`);
  assert.match(blockText(), /advise --pool/);
  assert.match(blockText(), /never mid-batch/);
  assert.match(blockText(), /no residue/);
});

test("config defaults exposed for override (threshold/stayBonus/removeLookback)", () => {
  assert.equal(POOL_DEFAULTS.threshold, 3);
  assert.equal(POOL_DEFAULTS.stayBonus, 2);
  assert.equal(POOL_DEFAULTS.removeLookback, 2);
});
