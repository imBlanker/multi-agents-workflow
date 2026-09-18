// @ts-check
// Tests for src/knowledge/schema.js — pure parsing/validation logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseKnowledgeDoc, parseKnowledgeRelPath, deriveFallbackId,
  LIFECYCLES, DECISION_CLASSES,
} from "../src/knowledge/schema.js";

const IMPL_DECISION = `# Agent Note: bridge 采用 NDJSON 帧协议

Status: implemented

## Problem

Card 前端与远端 helper 需要一致的流式协议。

## Decision

采用 NDJSON + epoch/seq 一致性模型，见 .mawf/runtime。

## Consequences

解析简单；大产物需分块，成本是额外摘要校验。

## Alternatives considered

- gRPC：最强理由是生态成熟，但引入运行时依赖，违反 MAWF 零依赖基线。
- WebSocket：浏览器侧合适，SSH stdio 侧多余。
`;

test("implemented decision with zh body parses clean", () => {
  const r = parseKnowledgeDoc(IMPL_DECISION, {
    kind: "decision", relPath: "implemented/architecture/2026-09-01-bridge-framing.md",
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.doc.title, "bridge 采用 NDJSON 帧协议");
  assert.equal(r.doc.lifecycle, "implemented");
  assert.equal(r.doc.cls, "architecture");
  assert.equal(r.doc.date, "2026-09-01");
  assert.equal(r.doc.slug, "bridge-framing");
  assert.ok(r.doc.sections.problem.includes("流式协议"));
  assert.ok(r.doc.sections.alternatives.includes("gRPC"));
  assert.deepEqual(r.doc.outLinks, []); // no .md links
});

test("rejected decision requires a reason and alternatives", () => {
  const good = `# Agent Note: 全量重写解析器

Status: rejected — 双实现维护成本不可接受

## Problem

两套 parser 语义漂移。

## Proposal

用 Node 重写全部 Card 解析逻辑。

## Alternatives considered

- 共享 Rust core：保留单一语义源。
`;
  const r = parseKnowledgeDoc(good, { kind: "decision", relPath: "rejected/architecture/2026-09-02-node-parser-rewrite.md" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  const noReason = good.replace("Status: rejected — 双实现维护成本不可接受", "Status: rejected");
  const r2 = parseKnowledgeDoc(noReason, { kind: "decision", relPath: "rejected/architecture/2026-09-02-x.md" });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.code === "status"));
});

test("archived layout requires Archived: line directly under Status and Status: implemented", () => {
  const base = (archLine) => `# Agent Note: 旧 IPC 形态

Status: implemented
${archLine}
## Problem

## Decision

## Consequences

## Alternatives considered
`;
  const good = parseKnowledgeDoc(base("Archived: 2026-09-10"), {
    kind: "decision", relPath: "archived/architecture/2026-01-05-old-ipc.md",
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.doc.archivedAt, "2026-09-10");

  const bad = parseKnowledgeDoc(base(""), { kind: "decision", relPath: "archived/architecture/2026-01-05-old-ipc.md" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.code === "archived-line"));

  // proposed must never appear in archived folder
  const propArch = parseKnowledgeDoc(
    "# Agent Note: 草稿\n\nStatus: proposed\n\n## Problem\n\n## Proposal\n\n## Acceptance criteria\n\n## Risks\n\n## Alternatives considered\n",
    { kind: "decision", relPath: "archived/architecture/2026-01-05-draft.md" },
  );
  assert.equal(propArch.ok, false);
});

test("Status lines inside fenced code or prose are ignored", () => {
  const text = `# Agent Note: 状态机注入免疫

Status: implemented

## Problem

文档里可能出现 Status: 200 means OK 之类行。

## Decision

严格形态匹配。

\`\`\`
Status: fake-in-code-fence
\`\`\`

## Consequences

无。

## Alternatives considered

- 全文扫描：误报。
`;
  const r = parseKnowledgeDoc(text, { kind: "decision", relPath: "implemented/process/2026-09-03-status-scan.md" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("duplicate Status lines are rejected (upstream uniqueness rule)", () => {
  const text = "# Agent Note: x\n\nStatus: implemented\n\n## Problem\n\nStatus: rejected — dup\n\n## Decision\n\n## Consequences\n\n## Alternatives considered\n";
  const r = parseKnowledgeDoc(text, { kind: "decision", relPath: "implemented/feature/2026-09-04-x.md" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "status"));
});

test("implemented decisions must not keep Proposal/Plan headings", () => {
  const text = "# Agent Note: x\n\nStatus: implemented\n\n## Problem\n\n## Decision\n\n## Plan\n\n后补计划。\n\n## Consequences\n\n## Alternatives considered\n";
  const r = parseKnowledgeDoc(text, { kind: "decision", relPath: "implemented/feature/2026-09-05-x.md" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "banned-heading"));
});

test("missing required sections are reported per lifecycle", () => {
  const text = "# Agent Note: 无备选方案\n\nStatus: implemented\n\n## Problem\n\n## Decision\n\n## Consequences\n";
  const r = parseKnowledgeDoc(text, { kind: "decision", relPath: "implemented/feature/2026-09-06-x.md" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "section" && e.message.includes("alternatives")));
});

test("verified solution requires full evidence chain sections", () => {
  const mk = (sections) => `# Solution: mawf 测试在 Windows tmpdir 失败

Status: verified

${sections}
`;
  const good = mk(`## Problem

测试在 Windows 上失败。

## Symptom

ENOENT on tmpdir。

## Root cause

大小写不敏感路径假定。

## Failed attempts

- 试图用 path.normalize：不够。

## Fix

显式 win32 归一化。

## Why it works

平台差异被隔离。

## Prevention

新增平台矩阵用例。

## Scope

Node 20+ / Windows。

## Evidence

tests/platform-probes.test.js 通过（Node 24, win32 模拟）。

## Alternatives considered

- 跳过 Windows：放弃平台支持。
`);
  const r = parseKnowledgeDoc(good, { kind: "solution", relPath: "solutions/testing/2026-09-07-win-tmpdir.md" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  // candidate without evidence is structurally fine, but must be marked candidate
  const cand = "# Solution: 猜测性修复\n\nStatus: candidate\n\n## Problem\n\n## Symptom\n\n## Fix\n\n## Alternatives considered\n";
  const r2 = parseKnowledgeDoc(cand, { kind: "solution", relPath: "solutions/general/2026-09-08-guess.md" });
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(r2.doc.status.status, "candidate");
});

test("path grammar: closed sets and filename rules", () => {
  assert.equal(parseKnowledgeRelPath("implemented/refactor/x.md", "decision").ok, false); // 7th class
  assert.equal(parseKnowledgeRelPath("draft/feature/x.md", "decision").ok, false); // bad lifecycle
  assert.equal(parseKnowledgeRelPath("implemented/feature/20260907-x.md", "decision").ok, false); // bad date
  assert.equal(parseKnowledgeRelPath("implemented/feature/2026-09-07-x.md", "decision").ok, true);
  assert.equal(parseKnowledgeRelPath("solutions/network/2026-09-07-retry.md", "solution").ok, true);
  assert.equal(parseKnowledgeRelPath("network/2026-09-07-retry.md", "solution").ok, true);
  assert.equal(parseKnowledgeRelPath("solutions/made-up-cat/x.md", "solution").ok, false);
});

test("relative .md links are collected for store-level validation", () => {
  const text = "# Agent Note: 链接收集\n\nStatus: implemented\n\n## Problem\n\n见 [协议](../architecture/2026-09-01-bridge-framing.md) 与 [外链](https://x.y)。\n\n## Decision\n\n## Consequences\n\n## Alternatives considered\n";
  const r = parseKnowledgeDoc(text, { kind: "decision", relPath: "implemented/process/2026-09-09-links.md" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.outLinks, ["../architecture/2026-09-01-bridge-framing.md"]);
});

test("fallback IDs are stable across folder moves (date+slug based)", () => {
  assert.equal(deriveFallbackId("decision", "2026-09-01", "bridge-framing"), "dec-2026-09-01-bridge-framing");
  assert.equal(deriveFallbackId("solution", "2026-09-07", "win-tmpdir"), "sol-2026-09-07-win-tmpdir");
});

test("closed sets are exactly the upstream ones", () => {
  assert.deepEqual(LIFECYCLES, ["proposed", "implemented", "rejected", "archived"]);
  assert.deepEqual(DECISION_CLASSES, ["feature", "bug-fix", "simplification", "architecture", "process", "testing"]);
});
