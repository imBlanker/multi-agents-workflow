import { execFileSync } from "node:child_process";
import { makeFixtureDb } from "./make-db.mjs";
let sqlite;
try { sqlite = await import("node:sqlite"); } catch {}
export function fixtureSql(file, sql, query = false) {
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(file, query ? { readOnly: true } : {});
    try { return query ? db.prepare(sql).all() : db.exec(sql); } finally { db.close(); }
  }
  const output = execFileSync("sqlite3", [...(query ? ["-json", "-readonly"] : []), file], { input: sql, encoding: "utf8" });
  return query ? JSON.parse(output || "[]") : undefined;
}
// Exact additive v18 table contracts from cc-switch v3.20.3 schema.rs:307-334.
// Replace the older MODELED dedup ledger only in this disposable fixture.
export function makeV18Fixture(file) {
  makeFixtureDb(file, { v17: true, withLogs: true });
  fixtureSql(file, `CREATE TABLE session_log_sync (
    file_path TEXT PRIMARY KEY, last_modified INTEGER NOT NULL,
    last_line_offset INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
    last_byte_offset INTEGER, last_tail_fingerprint INTEGER
  );
  INSERT INTO session_log_sync VALUES ('legacy.jsonl',1,2,3,NULL,NULL);
  INSERT INTO session_log_sync VALUES ('current.jsonl',4,5,6,4096,123456);
  DROP TABLE session_usage_dedup;
  CREATE TABLE session_usage_dedup (
    data_source TEXT NOT NULL, request_id TEXT NOT NULL, semantic_id TEXT NOT NULL,
    has_entry_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(data_source, request_id)
  );
  CREATE INDEX idx_session_usage_dedup_semantic ON session_usage_dedup(data_source,semantic_id,has_entry_id);
  PRAGMA user_version=18;`);
}
