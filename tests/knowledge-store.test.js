// @ts-check
// Tests for src/knowledge/store.js + search.js — real fs in tmpdirs, no ~/ access.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { KnowledgeStore, resolveLayout, contentHash } from "../src/knowledge/store.js";
import { searchKnowledge, renderContextBlock, tokenize } from "../src/knowledge/search.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-knowledge-"));
}

const DECISION_OK = (title, alt = "共享 Rust core：单一语义源。") => `# Agent Note: ${title}

Status: implemented

## Problem

Card 前端与远端 helper 需要一致的协议。

## Decision

采用 NDJSON 帧协议与 epoch/seq 一致性。

## Consequences

解析简单，大产物需分块。

## Alternatives considered

- ${alt}
`;

const SOLUTION_OK = `---
module: workspace-bridge
date: 2026-09-10
problem_type: runtime_error
component: bridge
severity: high
symptoms:
  - "SSH 隧道断开后卡片显示 stale"
---

# Solution: 断线重连后重放快照

Status: verified

## Problem

显示端重连后状态陈旧。

## Symptom

卡片数据不刷新。

## Root cause

事件游标丢失后未做快照重建。

## Failed attempts

- 仅重放事件：丢失窗口无法恢复。

## Fix

重连时强制 snapshot，再从游标续传。

## Why it works

快照绑定 epoch，旧 epoch 事件被丢弃。

## Prevention

重连路径增加一致性测试。

## Scope

bridge v1 协议。

## Evidence

tests/workspace-protocol.test.js resumeDecision 用例通过。

## Alternatives considered

- 无限重试事件：无法保证一致性。
`;

function seedDecision(store, rel, text) {
  fs.mkdirSync(path.join(store.layout.decisions, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(store.layout.decisions, rel), text);
}

test("layout: default docs/knowledge when no legacy roots; legacy adopted when present", () => {
  const p1 = tmpProject();
  const l1 = resolveLayout(p1);
  assert.equal(l1.legacy.decisions, "default");
  assert.equal(l1.decisions, path.join(p1, "docs", "knowledge", "decisions")); // native-path compare, not POSIX regex
  assert.equal(l1.solutions, path.join(p1, "docs", "knowledge", "solutions"));

  const p2 = tmpProject();
  fs.mkdirSync(path.join(p2, ".agents", "notes"), { recursive: true });
  fs.mkdirSync(path.join(p2, "docs", "solutions"), { recursive: true });
  const l2 = resolveLayout(p2);
  assert.equal(l2.legacy.decisions, "legacy");
  assert.equal(l2.legacy.solutions, "legacy");
  assert.equal(l2.decisions, path.join(p2, ".agents", "notes"));
  // explicit config beats legacy adoption
  const l3 = resolveLayout(p2, { decisionRoot: path.join(p2, "docs", "knowledge", "decisions") });
  assert.equal(l3.legacy.decisions, "default");
});

test("create validates, writes atomically, seeds sidecar with provenance", () => {
  const store = KnowledgeStore.open(tmpProject());
  const r = store.create("decision", "implemented/architecture/2026-09-11-ndjson.md", DECISION_OK("NDJSON 帧协议"), {
    sourceTask: "09-17-mawf-four-tool-integration",
  });
  assert.ok(fs.existsSync(r.abs));
  const sc = store.readSidecar(r.abs);
  assert.equal(sc.sourceTask, "09-17-mawf-four-tool-integration");
  assert.equal(sc.id, null); // fallback id derived on demand, not persisted by default
  assert.ok(sc.created);

  assert.throws(() => store.create("decision", "implemented/architecture/2026-09-11-ndjson.md", "dup"));
  assert.throws(() => store.create("decision", "implemented/refactor/2026-09-11-x.md", DECISION_OK("x"))); // bad class
});

test("update enforces compare-and-swap; concurrent writer cannot silently overwrite", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("decision", "implemented/feature/2026-09-12-cas.md", DECISION_OK("CAS"));
  const first = store.read("decision", "implemented/feature/2026-09-12-cas.md");
  const edited = first.text.replace("解析简单", "解析简单且零依赖");
  // another writer lands a change first
  store.update("decision", "implemented/feature/2026-09-12-cas.md", edited);
  const staleEdit = edited.replace("零依赖", "零依赖 v2");
  assert.throws(
    () => store.update("decision", "implemented/feature/2026-09-12-cas.md", staleEdit, { expectedHash: first.hash }),
    (e) => e.code === "KNOWLEDGE_CAS_CONFLICT",
  );
  // correct CAS succeeds
  const ok = store.update("decision", "implemented/feature/2026-09-12-cas.md", staleEdit, {
    expectedHash: contentHash(edited),
  });
  assert.ok(ok.hash);
});

test("archiveDecision inserts Archived line, moves to archived/, seals manifest, reports inbound", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("decision", "implemented/architecture/2026-01-01-old-ipc.md", DECISION_OK("旧 IPC"));
  store.create("decision", "implemented/process/2026-02-02-ref.md", DECISION_OK("引用者"));
  // inbound link from ref doc
  const refAbs = path.join(store.layout.decisions, "implemented/process/2026-02-02-ref.md");
  fs.writeFileSync(refAbs, fs.readFileSync(refAbs, "utf8").replace("## Problem\n", "## Problem\n\n见 [旧 IPC](../architecture/2026-01-01-old-ipc.md)。\n"));

  const r = store.archiveDecision("implemented/architecture/2026-01-01-old-ipc.md");
  assert.equal(r.to, "archived/architecture/2026-01-01-old-ipc.md");
  assert.ok(!fs.existsSync(r.from === undefined ? "" : path.join(store.layout.decisions, "implemented/architecture/2026-01-01-old-ipc.md")));
  const moved = fs.readFileSync(path.join(store.layout.decisions, r.to), "utf8");
  assert.match(moved, /Status: implemented\nArchived: \d{4}-\d{2}-\d{2}\n/);
  const manifest = JSON.parse(fs.readFileSync(path.join(store.layout.decisions, "archived", "manifest.json"), "utf8"));
  assert.equal(manifest.files["archived/architecture/2026-01-01-old-ipc.md"], `sha256:${contentHash(moved)}`);
  assert.ok(r.inbound.includes("implemented/process/2026-02-02-ref.md"));

  // archiving a proposed doc is refused (upstream rule: proposed converts to rejected)
  seedDecision(store, "proposed/architecture/2026-03-03-draft.md", "# Agent Note: 草稿\n\nStatus: proposed\n\n## Problem\n\n## Proposal\n\n## Acceptance criteria\n\n## Risks\n\n## Alternatives considered\n");
  assert.throws(() => store.archiveDecision("proposed/architecture/2026-03-03-draft.md"));
});

test("last_verified only changes via explicit verification writes (§5.4)", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("solution", "runtime/2026-09-10-reconnect.md", SOLUTION_OK);
  const abs = path.join(store.layout.solutions, "runtime/2026-09-10-reconnect.md");
  const before = store.readSidecar(abs);
  assert.equal(before.lastVerified, null);
  // updating document content must NOT touch verification freshness
  store.update("solution", "runtime/2026-09-10-reconnect.md", SOLUTION_OK.replace("重连时强制 snapshot", "重连时强制 snapshot+校验和"), {});
  assert.equal(store.readSidecar(abs).lastVerified, null);
  // explicit verification does
  store.writeSidecar(abs, { verification: { method: "test", result: "pass" } });
  const after = store.readSidecar(abs);
  assert.equal(after.verification.result, "pass");
  assert.ok(after.lastVerified);
});

test("index is rebuildable; deleting cache loses nothing (A07)", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("decision", "implemented/architecture/2026-09-13-idx.md", DECISION_OK("索引"));
  const idx1 = store.buildIndex();
  assert.equal(idx1.entries.length, 1);
  fs.rmSync(store.indexPath(), { force: true });
  const idx2 = store.index(); // transparent rebuild
  assert.equal(idx2.entries.length, 1);
  assert.equal(idx2.entries[0].id, "dec-2026-09-13-idx");
});

test("walk surfaces invalid files instead of skipping them", () => {
  const store = KnowledgeStore.open(tmpProject());
  seedDecision(store, "implemented/feature/broken-name.md", "# Agent Note: x\n\nStatus: implemented\n\n## Problem\n\n## Decision\n\n## Consequences\n\n## Alternatives considered\n");
  const items = store.walk("decision");
  assert.equal(items.length, 1);
  assert.equal(items[0].parsed.ok, false);
  assert.ok(items[0].parsed.errors.some((e) => e.code === "path"));
});

test("tokenize keeps CJK bigrams and latin words", () => {
  const toks = tokenize("bridge 协议 epoch/seq 一致性 knowledge-search");
  assert.ok(toks.includes("bridge"));
  assert.ok(toks.includes("协议")); // bigram
  assert.ok(toks.includes("epoch"));
  assert.ok(toks.includes("knowledge-search"));
});

test("search: explainable candidates, status caveats, budget respected (A06)", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("decision", "implemented/architecture/2026-09-11-ndjson.md", DECISION_OK("NDJSON 帧协议"));
  seedDecision(store, "archived/architecture/2026-01-01-old.md", "# Agent Note: 旧协议\n\nStatus: implemented\nArchived: 2026-08-01\n\n## Problem\n\n协议漂移。\n\n## Decision\n\nNDJSON。\n\n## Consequences\n\n## Alternatives considered\n");
  const idx = store.buildIndex();
  const r = searchKnowledge(idx.entries, { q: "NDJSON 协议" });
  assert.ok(r.candidates.length >= 1);
  const active = r.candidates.find((c) => c.lifecycle === "implemented");
  assert.ok(active.matched.length > 0, "why-matched must be present");
  assert.ok(active.matched[0].field);
  assert.ok(!r.candidates.some((c) => c.lifecycle === "archived"), "archived excluded by default");
  const r2 = searchKnowledge(idx.entries, { q: "NDJSON", includeArchived: true, maxDocs: 1 });
  assert.equal(r2.candidates.length, 1);
  assert.ok(r2.budget.matchedTotal >= 2);
  assert.ok(r2.budget.truncatedByDocs);
});

test("rejected/proposed docs carry explicit caveats in context blocks", () => {
  const entries = [
    { kind: "decision", rel: "proposed/architecture/2026-09-14-p.md", id: "dec-p", title: "提案", lifecycle: "proposed", status: "proposed", cls: "architecture", date: "2026-09-14", hash: "x", digest: { problem: "bridge 帧协议" } },
    { kind: "decision", rel: "rejected/architecture/2026-09-15-r.md", id: "dec-r", title: "否决", lifecycle: "rejected", status: "rejected", cls: "architecture", date: "2026-09-15", hash: "x", digest: { problem: "bridge 帧协议重写" } },
  ];
  const r = searchKnowledge(entries, { q: "bridge 帧协议" });
  const block = renderContextBlock(r);
  assert.match(block, /NOT-IN-EFFECT/);
  assert.match(block, /NEGATIVE-EXPERIENCE/);
  assert.match(block, /mawf:knowledge-context BEGIN/);
});

test("sidecar survives walk → index → search: provenance + freshness reach candidates (§7.2)", () => {
  const store = KnowledgeStore.open(tmpProject());
  store.create("solution", "runtime/2026-09-10-reconnect.md", SOLUTION_OK, { sourceTask: "task-A", sourceCommit: "abc1234" });
  const abs = path.join(store.layout.solutions, "runtime/2026-09-10-reconnect.md");
  store.writeSidecar(abs, { verification: { method: "test", result: "pass" } });

  // walk must carry the sidecar (previous bug: item.sidecar was undefined)
  const walked = store.walk("solution").find((i) => i.rel === "runtime/2026-09-10-reconnect.md");
  assert.equal(walked.sidecar.sourceTask, "task-A");
  assert.equal(walked.sidecar.lastVerified, store.readSidecar(abs).lastVerified);

  const idx = store.buildIndex();
  const entry = idx.entries.find((e) => e.rel === "runtime/2026-09-10-reconnect.md");
  assert.equal(entry.id, "sol-2026-09-10-reconnect");
  assert.ok(entry.sidecar, "index entry must carry sidecar");
  assert.equal(entry.sidecar.sourceTask, "task-A");
  assert.equal(entry.sidecar.sourceCommit, "abc1234");
  assert.ok(entry.sidecar.lastVerified, "index entry must carry lastVerified");

  // full chain: index → search → candidate provenance & freshness
  const r = searchKnowledge(idx.entries, { q: "重连" });
  const c = r.candidates.find((x) => x.id === "sol-2026-09-10-reconnect");
  assert.ok(c, "candidate found");
  assert.equal(c.provenance.sourceTask, "task-A");
  assert.ok(c.provenance.lastVerified);
  assert.deepEqual(c.caveats, [], "verified doc must not be flagged never-verified");

  // editing body WITHOUT explicit verification must not refresh lastVerified
  const before = entry.sidecar.lastVerified;
  const cur = store.read("solution", "runtime/2026-09-10-reconnect.md");
  store.update("solution", "runtime/2026-09-10-reconnect.md", cur.text.replace("重连时强制 snapshot", "重连时强制 snapshot 与校验和"));
  const idx2 = store.buildIndex();
  const entry2 = idx2.entries.find((e) => e.rel === "runtime/2026-09-10-reconnect.md");
  assert.equal(entry2.sidecar.lastVerified, before, "lastVerified frozen without explicit verify");
  const c2 = searchKnowledge(idx2.entries, { q: "校验和" }).candidates.find((x) => x.id === "sol-2026-09-10-reconnect");
  assert.equal(c2.provenance.lastVerified, before);
});
