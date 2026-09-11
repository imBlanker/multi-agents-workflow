import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeV18Fixture, fixtureSql } from "./fixtures/ccswitch-v18.mjs";
import { readCcSwitch, costRate, perSessionRate, piManagedByCcSwitch } from "../src/ccswitch.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-v18-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "cc-switch.db");
  makeV18Fixture(file);
  return file;
}
test("schema18 is supported with exact nullable cursor columns and no database writes", (t) => {
  const file = fixture(t);
  const before = fs.readFileSync(file);
  const cc = readCcSwitch({ dbPath: file });
  assert.equal(cc.schemaVersion, 18);
  assert.equal(cc.schemaSupported, true);
  assert.equal(piManagedByCcSwitch(cc), true);
  const rows = fixtureSql(file, "SELECT last_byte_offset,last_tail_fingerprint FROM session_log_sync ORDER BY file_path", true);
  assert.deepEqual(rows.map(r => [r.last_byte_offset,r.last_tail_fingerprint]), [[4096,123456],[null,null]]);
  assert.deepEqual(fs.readFileSync(file), before, "reading must not migrate or mutate the database");
});
test("schema18 cost totals preserve Pi session attribution without double counting", (t) => {
  const file = fixture(t);
  const before = fs.readFileSync(file);
  const all = costRate({ dbPath: file, windowSeconds: 300 });
  const claude = costRate({ dbPath: file, appType: "claude", windowSeconds: 300 });
  const pi = costRate({ dbPath: file, appType: "pi", windowSeconds: 300 });
  assert.ok(Math.abs(all.totalUsd - 2.1) < 1e-9);
  assert.ok(Math.abs(all.totalUsd - claude.totalUsd - pi.totalUsd) < 1e-9);
  assert.equal(pi.requestCount, 2);
  assert.ok(perSessionRate({ dbPath: file, windowSeconds: 300 }).sessions.some(s => s.sessionId === "pi-sess-1"));
  assert.deepEqual(fs.readFileSync(file), before);
});
