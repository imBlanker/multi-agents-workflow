import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowGraph, graphFromPlan } from "../src/graph.js";

function planFixture() {
  return {
    name: "test",
    groups: [
      { parallel: false, steps: [{ role: "orchestrator", agent: "claude-code", task: "plan" }] },
      { parallel: true, steps: [{ role: "researcher", agent: "claude-code", task: "x" }, { role: "implementer", agent: "claude-code", task: "y" }] },
      { parallel: false, steps: [{ role: "orchestrator", agent: "claude-code", task: "synthesize" }] },
    ],
    reviewPoints: [{ by: "codex", scope: "auto", label: "post-implementation review" }],
    loops: [{ maxIterations: 3, exitWhen: "tests green" }],
  };
}

test("graphFromPlan builds connected nodes", () => {
  const g = graphFromPlan(planFixture());
  assert.ok(g.nodes.length >= 5);
  const v = g.validate();
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("validate flags unknown edge endpoints", () => {
  const g = new WorkflowGraph({ nodes: [{ id: "a", kind: "task" }] });
  g.addEdge({ from: "a", to: "ghost" });
  const v = g.validate();
  assert.equal(v.ok, false);
  assert.match(v.errors.join("; "), /to unknown node/);
});

test("loop nodes may self-reference; others may not", () => {
  const g = new WorkflowGraph({ nodes: [{ id: "l", kind: "loop" }, { id: "t", kind: "task" }] });
  g.addEdge({ from: "l", to: "l" }); // allowed
  const v = g.validate();
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("topoBatches separates review gates into their own batch", () => {
  const g = graphFromPlan(planFixture());
  const { batches } = g.topoBatches();
  assert.ok(batches.length >= 2);
  const gateBatches = batches.filter((b) => b.some((n) => n.kind === "review"));
  assert.ok(gateBatches.length >= 1);
  for (const b of gateBatches) assert.equal(b.length, 1, "review gate must be its own batch");
});

test("loop node expands to its iteration count within a batch", () => {
  const g = graphFromPlan(planFixture());
  const { batches } = g.topoBatches();
  const loopBatch = batches.find((b) => b.some((n) => n.kind === "loop"));
  assert.ok(loopBatch, "expected a batch containing loop nodes");
  assert.equal(loopBatch.length, 3, "loop should expand to 3 iterations");
});
