// @ts-check
// Tests for the deterministic cross-host advising engine (src/advise.js).
// All host data is injected via `inventory` opts — no real ~ access, no exec.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { adviseTask, checkFreshness, renderAdvise, tokenize, resolveDshPid } from "../src/advise.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-advise-"));
}

/** Crafted inventory: pi has matching skills; codex has better models+price. */
function fixtureInventory() {
  const host = (app, over = {}) => ({
    app, homeDir: `/fake/${app}`,
    detected: [], capabilities: over.caps ?? ["subagents", "multi-agent", "dynamic-workflow"],
    skills: over.skills ?? [], plugins: over.plugins ?? [], mcps: over.mcps ?? [],
    prompts: { global: null, project: [] },
    models: over.models ?? [], workflowsHarnesses: [],
    ...over.extra,
  });
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    projectDir: "/fake/proj",
    hosts: [
      host("pi", {
        skills: [{ name: "research", path: "/p", realPath: "/p", description: "deep 调研 and multi-repo analysis" }],
        mcps: [
          { name: "exa", source: "user", status: "connected" },
          { name: "dead-mcp", source: "user", status: "failed" },
          { name: "pend-mcp", source: "user", status: "pending-approval" },
        ],
        plugins: [{ name: "live-plugin", source: "npm", status: "active" }, { name: "dead-plugin", source: "npm", status: "disabled" }],
        models: [
          { id: "glm-4.6", provider: "p", source: "pi", isCurrent: true, family: "agentic", tags: ["agentic", "reasoning"], price: { input_per_m: 1, output_per_m: 4, source: "pi", estimated: true } },
        ],
      }),
      host("codex", {
        skills: [],
        models: [
          { id: "gpt-5.5", provider: "o", source: "codex", isCurrent: true, family: "coding", tags: ["coding", "reasoning", "agentic"], price: { input_per_m: 5, output_per_m: 30, source: "cc", estimated: false } },
          { id: "gpt-5-mini", provider: "o", source: "codex", isCurrent: false, family: "coding", tags: ["coding"], price: { input_per_m: 0.5, output_per_m: 2, source: "cc", estimated: false } },
        ],
      }),
      host("claude-code", {
        skills: [{ name: "grilling", path: "/g", realPath: "/g", description: "stress-test plans" }],
        models: [
          { id: "claude-opus-4-8", provider: "a", source: "claude", isCurrent: true, family: "agentic", tags: ["agentic", "coding", "reasoning"], price: { input_per_m: 2.5, output_per_m: 12, source: "cc", estimated: false } },
        ],
      }),
      host("dsh", {
        caps: ["subagents"],
        skills: [{ name: "dsh-skill", path: "/d", realPath: "/d", description: "" }],
        models: [
          { id: "glm-4.5-air", provider: "z", source: "dsh", isCurrent: true, family: "agentic", tags: ["agentic"], price: { input_per_m: 0.1, output_per_m: 0.4, source: "dsh", estimated: true } },
        ],
      }),
    ],
  };
}

const OPTS = (over = {}) => ({
  projectDir: tmpProject(),
  inventory: fixtureInventory(),
  currentHost: "pi",
  updateState: false,
  pidResolver: () => "4242",
  ...over,
});

test("adviseTask: research task — pi scores via skill/mcp match, JSON shape valid", () => {
  const r = adviseTask(OPTS({ task: "深入调研 multiple repos and write a 对比 report", difficulty: 4 }));
  assert.equal(r.recommendation === "stay" || r.recommendation === "switch", true);
  const pi = r.scores.find((s) => s.host === "pi");
  assert.ok(pi.breakdown.skillMatch > 0, "pi skill match scored");
  assert.ok(pi.matched.skills.includes("research") || pi.matched.mcps.includes("exa"));
  // unusable surfaces never match: failed/pending MCPs, disabled plugins
  assert.ok(!pi.matched.mcps.includes("dead-mcp"));
  assert.ok(!pi.matched.mcps.includes("pend-mcp"));
  assert.ok(!pi.matched.plugins.includes("dead-plugin"));
  assert.equal(pi.matched.plugins.includes("live-plugin"), false); // name won't match task tokens; just no crash
  assert.ok(Array.isArray(r.tokens) && r.tokens.length > 0);
  assert.ok(r.tokens.some((t) => t === "调研" || t.length === 2)); // CJK bigram present
  for (const s of r.scores) {
    assert.ok(s.total <= 100 + 8, `total sane: ${s.total}`);
    assert.ok(Array.isArray(s.reasons));
  }
  assert.equal(r.currentHost, "pi");
});

test("adviseTask: hysteresis — winner≠current with margin <10 → stay", () => {
  // crafted: current=pi, others weak → any winner margin stays small
  const inv = fixtureInventory();
  inv.hosts = inv.hosts.map((h) => ({ ...h, skills: [], mcps: [] }));
  const r = adviseTask(OPTS({ task: "generic task", difficulty: 2, inventory: inv }));
  assert.equal(r.recommendation, "stay");
  assert.equal(r.target, null);
  assert.equal(r.handoffPath, null);
});

test("adviseTask: switch fires when margin ≥ 10; handoff created; launch present", () => {
  // lopsided: current=dsh has nothing; pi is rich in everything research
  const inv = fixtureInventory();
  const dsh = inv.hosts.find((h) => h.app === "dsh");
  dsh.capabilities = []; dsh.skills = []; dsh.models = [];
  const projectDir = tmpProject();
  const r = adviseTask(OPTS({ projectDir, currentHost: "dsh", task: "research 调研 repos report analysis", difficulty: 4, inventory: inv }));
  assert.equal(r.recommendation, "switch");
  assert.notEqual(r.target, "dsh");
  assert.ok(r.margin >= 10, `margin ${r.margin}`);
  assert.ok(r.handoffPath && r.handoffPath.includes("-to-"));
  const handoffFile = path.join(projectDir, r.handoffPath);
  assert.ok(fs.existsSync(handoffFile));
  assert.ok(r.launch && r.launch.command);
  const handoff = fs.readFileSync(handoffFile, "utf8");
  assert.match(handoff, /Reconfiguration gate \(required before ready\)/);
  assert.match(handoff, /This switch is NOT ready yet/);
  assert.match(handoff, /Known source-host facts \(dsh\)/);
  assert.match(handoff, /Known target-host facts \(pi\)/);
  assert.match(handoff, /Recommended interrogation mode: \*\*grill\*\*/);
  assert.match(handoff, /A user response is required before this switch is treated as ready/);
  assert.match(handoff, /child\/subagent model strategy/);
  const rendered = renderAdvise(r);
  assert.match(rendered, /do NOT treat the switch as ready before the user responds/i);
});

test("adviseTask: dsh launch = kill -9 <resolved pid> && dsh web; template fallback", () => {
  // lopsided so the winner is ALWAYS dsh: claude-code stripped, dsh rich
  const mkInv = () => {
    const inv = fixtureInventory();
    const cc = inv.hosts.find((h) => h.app === "claude-code");
    cc.capabilities = []; cc.skills = []; cc.models = [];
    const pi = inv.hosts.find((h) => h.app === "pi");
    pi.skills = []; pi.mcps = []; pi.models = [];
    const cx = inv.hosts.find((h) => h.app === "codex");
    cx.models = [];
    return inv;
  };
  const a = adviseTask(OPTS({ currentHost: "claude-code", task: "research 调研 repos report", difficulty: 4, inventory: mkInv(), pidResolver: () => "4242" }));
  assert.equal(a.target, "dsh", `expected dsh target, got ${a.target}`);
  assert.equal(a.launch.command, "kill -9 4242 && dsh web");
  assert.ok(a.launch.note.includes("3080"));
  const b = adviseTask(OPTS({ currentHost: "claude-code", task: "research 调研 repos report", difficulty: 4, inventory: mkInv(), pidResolver: () => null }));
  assert.equal(b.launch.command, "kill -9 $(lsof -ti tcp:3080) && dsh web");
  assert.ok(b.launch.note.includes("template"));
});

test("adviseTask: stayBonus applied exactly once to current host only", () => {
  const r = adviseTask(OPTS({ task: "research task", difficulty: 3 }));
  for (const s of r.scores) {
    if (s.host === "pi") assert.ok(s.stayBonus > 0);
    else assert.equal(s.stayBonus, 0);
  }
});

test("adviseTask: never spawns processes (only injectable pid resolver runs)", () => {
  let called = 0;
  adviseTask(OPTS({ currentHost: "claude-code", task: "research", difficulty: 4, pidResolver: () => { called++; return "1"; } }));
  // resolver only invoked when target is dsh; count is 0 or 1, never real exec
  assert.ok(called <= 1);
});

test("adviseTask: difficulty shifts capabilityFit visible in breakdown", () => {
  const low = adviseTask(OPTS({ task: "small fix", difficulty: 1 }));
  const high = adviseTask(OPTS({ task: "small fix", difficulty: 5 }));
  const sum = (r, host) => r.scores.find((s) => s.host === host).breakdown.capabilityFit;
  // dsh lacks multi-agent/dynamic caps → gap grows with difficulty
  assert.ok(sum(high, "dsh") < sum(high, "pi"));
  assert.equal(sum(low, "dsh") <= sum(low, "pi"), true);
});

test("adviseTask: state file updated (UTC+8 day, runsToday) and --check-fresh flips", () => {
  const projectDir = tmpProject();
  let fake = new Date("2026-08-20T15:59:00Z").getTime(); // 23:59 UTC+8
  const clock = () => fake;
  const r1 = adviseTask(OPTS({ projectDir, updateState: true, task: "research", difficulty: 3, clock }));
  assert.equal(r1.stateUpdated, true);
  const statePath = path.join(projectDir, ".mawf", "runtime", "advise-state.json");
  assert.equal(checkFreshness(statePath, clock), "ADVISED_TODAY");
  fake = new Date("2026-08-20T16:01:00Z").getTime(); // 00:01 next day UTC+8
  assert.equal(checkFreshness(statePath, clock), "STALE");
  const r2 = adviseTask(OPTS({ projectDir, updateState: true, task: "research", difficulty: 3, clock }));
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastDayUtc8, "2026-08-21");
  assert.ok(state.runsToday >= 1);
});

test("renderAdvise: contains footer line + recommendation + scores", () => {
  const r = adviseTask(OPTS({ task: "research 调研", difficulty: 4 }));
  const text = renderAdvise(r);
  assert.ok(text.startsWith("MAW cross-host advise"));
  const footer = text.split("\n").find((l) => l.startsWith("ADVISE-DONE"));
  assert.ok(footer, "footer present");
  const m = footer.match(/^ADVISE-DONE recommendation=(stay|switch) target=(\S+) margin=(\S+) handoff=(\S+)$/);
  assert.ok(m, footer);
  assert.ok(text.includes("host scores:"));
});

test("tokenize: ASCII + CJK bigrams, stopwords dropped", () => {
  const t = tokenize("Refactor the 代码库 and fix bugs");
  assert.ok(t.includes("refactor"));
  assert.ok(!t.includes("the"));
  assert.ok(t.includes("代码") && t.includes("码库"));
});

test("resolveDshPid: injectable resolver passes through", () => {
  assert.equal(resolveDshPid(() => "777"), "777");
  assert.equal(resolveDshPid(() => null), null);
});
