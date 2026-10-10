import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeV18Fixture, fixtureSql } from "./fixtures/ccswitch-v18.mjs";
import { readCcSwitch, costRate, perSessionRate, piManagedByCcSwitch } from "../src/ccswitch.js";

// cc-switch schema 19 (v3.20.4, MiniMax enable columns) and schema 20
// (v4.0.2, Pi sync column) are add-column-only migrations; mawf reads none of
// the new columns, so a v2x database behaves exactly like the v18 fixture —
// only PRAGMA user_version differs. We model exactly that.
function fixture(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-v2x-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, "cc-switch.db");
  makeV18Fixture(file);
  fixtureSql(file, `PRAGMA user_version=${version};`);
  return file;
}

test("schema 19 and 20 databases read like v18 with the guard open and zero writes", (t) => {
  for (const v of [19, 20]) {
    const file = fixture(t, v);
    const before = fs.readFileSync(file);
    const cc = readCcSwitch({ dbPath: file });
    assert.equal(cc.schemaVersion, v);
    assert.equal(cc.schemaSupported, true);
    assert.equal(piManagedByCcSwitch(cc), true);
    assert.ok(costRate({ dbPath: file, windowSeconds: 300 }).totalUsd > 0);
    assert.ok(perSessionRate({ dbPath: file, windowSeconds: 300 }).sessions.length > 0);
    assert.deepEqual(fs.readFileSync(file), before, "reading must not migrate or mutate the database");
  }
});
