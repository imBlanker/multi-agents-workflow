// @ts-check
// Tests for src/knowledge/migrate.js — legacy→default corpus migration with
// dry-run, conflict skip, rollback record (contract §5.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { planMigration, migrateToDefault, rollbackMigration } from "../src/knowledge/migrate.js";
import { resolveLayout, KnowledgeStore } from "../src/knowledge/store.js";

const DEC = `# Agent Note: 迁移样例

Status: implemented

## Problem

迁移不能丢内容。

## Decision

结构保持移动。

## Consequences

回滚可用。

## Alternatives considered

- 复制三份：禁止。
`;

function seedLegacy(p) {
  const dec = path.join(p, ".agents", "notes");
  const sol = path.join(p, "docs", "solutions");
  fs.mkdirSync(path.join(dec, "implemented", "architecture"), { recursive: true });
  fs.mkdirSync(path.join(dec, "archived", "architecture"), { recursive: true });
  fs.mkdirSync(path.join(sol, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(dec, "implemented", "architecture", "2026-01-01-mig.md"), DEC);
  fs.writeFileSync(path.join(dec, "implemented", "architecture", "2026-01-01-mig.mawf.json"), JSON.stringify({ schema: 1, id: null, sourceTask: "t1" }));
  fs.writeFileSync(path.join(dec, "archived", "architecture", "2025-01-01-old.md"), DEC);
  fs.writeFileSync(path.join(dec, "archived", "manifest.json"), JSON.stringify({ version: 1, files: { "archived/architecture/2025-01-01-old.md": "sha256:x" } }));
  fs.writeFileSync(path.join(sol, "runtime", "2026-02-02-fix.md"), DEC);
  return { dec, sol };
}

test("plan detects legacy roots; dry-run writes nothing", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "maw-mig-"));
  seedLegacy(p);
  const plan = planMigration(p);
  assert.equal(plan.hasWork, true);
  const total = plan.plans.reduce((n, x) => n + x.moves.length, 0);
  assert.equal(total, 5); // 2 dec + sidecar + archived md + manifest + 1 sol
  const r = migrateToDefault(p, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.moved, 0);
  // nothing moved
  assert.ok(fs.existsSync(path.join(p, ".agents", "notes", "implemented", "architecture", "2026-01-01-mig.md")));
  assert.equal(resolveLayout(p).legacy.decisions, "legacy");
});

test("migrate moves everything (incl. sidecars + manifest), prunes legacy, store reads default", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "maw-mig-"));
  seedLegacy(p);
  const r = migrateToDefault(p, {});
  assert.equal(r.ok, true);
  assert.equal(r.moved, 5);
  const target = path.join(p, "docs", "knowledge", "decisions", "implemented", "architecture", "2026-01-01-mig.md");
  assert.ok(fs.existsSync(target));
  assert.ok(fs.existsSync(path.join(p, "docs", "knowledge", "decisions", "archived", "manifest.json")));
  assert.ok(fs.existsSync(path.join(p, "docs", "knowledge", "solutions", "runtime", "2026-02-02-fix.md")));
  // sidecar moved with its doc
  assert.ok(fs.existsSync(path.join(p, "docs", "knowledge", "decisions", "implemented", "architecture", "2026-01-01-mig.mawf.json")));
  // legacy pruned; layout now resolves to default
  assert.ok(!fs.existsSync(path.join(p, ".agents")));
  assert.equal(resolveLayout(p).legacy.decisions, "default");
  // store reads the migrated corpus
  const store = KnowledgeStore.open(p);
  // decision + archived decision + solution — archived stays indexed (walk
  // includes it with lifecycle "archived"; seals are verify()-time checks)
  assert.equal(store.buildIndex().entries.length, 3);
  // rollback record exists
  const migDir = path.join(p, ".mawf", "runtime", "knowledge", "migrations");
  assert.equal(fs.readdirSync(migDir).length, 1);
});

test("conflicts are skipped, never overwritten; rollback restores original state", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "maw-mig-"));
  seedLegacy(p);
  // pre-occupy one destination
  const clash = path.join(p, "docs", "knowledge", "decisions", "implemented", "architecture", "2026-01-01-mig.md");
  fs.mkdirSync(path.dirname(clash), { recursive: true });
  fs.writeFileSync(clash, "# Agent Note: 占位\n\nStatus: implemented\n\n## Problem\n\nx\n\n## Decision\n\ny\n\n## Consequences\n\nz\n\n## Alternatives considered\n\n- w\n");
  const r = migrateToDefault(p, {});
  assert.equal(r.moved, 4); // clash skipped
  assert.ok(r.conflicts.length >= 1);
  assert.match(fs.readFileSync(clash, "utf8"), /占位/); // untouched

  // rollback: reverse all recorded moves
  const migDir = path.join(p, ".mawf", "runtime", "knowledge", "migrations");
  const id = fs.readdirSync(migDir)[0].replace(/\.json$/, "");
  const rb = rollbackMigration(p, id);
  assert.equal(rb.ok, true);
  assert.equal(rb.restored, 4);
  assert.ok(fs.existsSync(path.join(p, ".agents", "notes", "implemented", "architecture", "2026-01-01-mig.md")));
  // the pre-existing dest file is untouched by rollback (refused origins kept)
  assert.match(fs.readFileSync(clash, "utf8"), /占位/);
  const missing = rollbackMigration(p, "nonexistent-id");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
});
