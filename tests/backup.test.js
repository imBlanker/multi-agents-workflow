import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { snapshotCcSwitch } from "../src/backup.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-backup-"));
const srcDir = path.join(tmp, ".cc-switch");
fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(srcDir, "cc-switch.db"), Buffer.from("fake-sqlite-bytes"));
fs.writeFileSync(path.join(srcDir, "codex_oauth_auth.json"), JSON.stringify({ default_account_id: "a" }));
fs.writeFileSync(path.join(srcDir, "sub", "extra.json"), "{}");
const dbPath = path.join(srcDir, "cc-switch.db");

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("snapshotCcSwitch packages ALL cc-switch config files", () => {
  const destDir = path.join(tmp, "backups-out");
  const r = snapshotCcSwitch({ dbPath, destDir });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.files, 3);
  assert.ok(r.totalBytes > 0);
  const packaged = r.archive ?? r.dir;
  assert.ok(packaged && fs.existsSync(packaged), "archive or snapshot dir must exist");
  if (r.impl === "copy") assert.ok(fs.existsSync(r.manifest), "copy fallback writes a manifest.json");
});

test("snapshot inside the cc-switch dir excludes the backups dir itself", () => {
  // default destDir = <srcDir>/maw-backups — must not recurse into itself
  const r1 = snapshotCcSwitch({ dbPath });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.files, 3, "backup dir contents must be excluded from the file list");
  assert.ok(String(r1.archive ?? r1.dir).startsWith(path.join(srcDir, "maw-backups")));
  // a second snapshot still sees only the 3 source files
  const r2 = snapshotCcSwitch({ dbPath });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.files, 3);
});

test("snapshot with a missing db reports an error, never throws", () => {
  const r = snapshotCcSwitch({ dbPath: path.join(tmp, "nope", "cc-switch.db") });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found|empty/i);
});
