import "./fixtures/test-env.mjs";
// @ts-check
// cc-switch schema v17 (v3.20.0 GUI / v5.10.2 CLI) compatibility + pi-managed
// worldview. See task 08-21-ccswitch-v3.20-cli-v5.10.2-followup prd.md R1/R2.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readCcSwitch, piManagedByCcSwitch, costRate, perSessionRate, SUPPORTED_CC_SCHEMA } from "../src/ccswitch.js";
import { readPiAsCc, mergePiIntoCc, enrichPiDbRowsWithModelsJson } from "../src/piprovider.js";
import { makeFixtureDb } from "./fixtures/make-db.mjs";
import { execFileSync } from "node:child_process";

// resolved once (mirror the src/ccswitch.js resolution pattern)
let NODE_SQLITE_OK = null;
try { NODE_SQLITE_OK = await import("node:sqlite"); } catch { NODE_SQLITE_OK = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-v17-"));
const dbV17 = path.join(tmp, "v17.db");
const dbV17NoPi = path.join(tmp, "v17-nopi.db");
const dbV16 = path.join(tmp, "v16.db");
makeFixtureDb(dbV17, { v17: true });
makeFixtureDb(dbV17NoPi, { v17NoPi: true });
makeFixtureDb(dbV16, {});

test("readCcSwitch on v17: schema surfaced, pi provider rows visible, no crash", () => {
  const cc = readCcSwitch({ dbPath: dbV17 });
  assert.equal(cc.schemaVersion, 17);
  assert.equal(cc.schemaSupported, true);
  assert.ok(cc.currentProviders.pi, "pi current provider row from db");
  assert.equal(cc.currentProviders.pi.name, "Pi Official");
  assert.ok(cc.appTypes.includes("pi"));
});

test("readCcSwitch on v16: schemaVersion 16, supported, no pi rows", () => {
  const cc = readCcSwitch({ dbPath: dbV16 });
  assert.equal(cc.schemaVersion, 16);
  assert.equal(cc.schemaSupported, true);
  assert.ok(!piManagedByCcSwitch(cc));
});

test("schema guard: user_version newer than supported degrades gracefully", () => {
  const dbFuture = path.join(tmp, "future.db");
  makeFixtureDb(dbFuture, {});
  // bump to a future version directly (both impl paths accept PRAGMA via exec/sqlite3)
  if (NODE_SQLITE_OK) {
    const db = new NODE_SQLITE_OK.DatabaseSync(dbFuture);
    db.exec(`PRAGMA user_version = ${SUPPORTED_CC_SCHEMA + 1}`);
    db.close();
  } else {
    execFileSync("sqlite3", [dbFuture], { input: `PRAGMA user_version = ${SUPPORTED_CC_SCHEMA + 1};`, encoding: "utf8" });
  }
  const cc = readCcSwitch({ dbPath: dbFuture }); // must not throw
  assert.equal(cc.schemaVersion, SUPPORTED_CC_SCHEMA + 1);
  assert.equal(cc.schemaSupported, false);
  assert.ok(cc.currentProviders.claude, "read paths still parse (additive schema)");
});

test("piManagedByCcSwitch: true only for v17+ WITH pi rows", () => {
  const cc17 = readCcSwitch({ dbPath: dbV17 });
  const cc17NoPi = readCcSwitch({ dbPath: dbV17NoPi });
  assert.equal(piManagedByCcSwitch(cc17), true);
  assert.equal(piManagedByCcSwitch(cc17NoPi), false, "v17 without pi rows → not managed");
  assert.equal(piManagedByCcSwitch(null), false);
  assert.equal(piManagedByCcSwitch({ dbPath: "", allProviders: [] }), false);
});

test("no double counting: unfiltered spend == sum of per-app spends (pi-session counted once)", () => {
  const win = 300;
  const total = costRate({ dbPath: dbV17, windowSeconds: win });
  const claude = costRate({ dbPath: dbV17, windowSeconds: win, appType: "claude" });
  const codex = costRate({ dbPath: dbV17, windowSeconds: win, appType: "codex" });
  const pi = costRate({ dbPath: dbV17, windowSeconds: win, appType: "pi" });
  // fixture has no codex/gemini logs; total must equal claude + pi exactly
  const sum = claude.totalUsd + codex.totalUsd + pi.totalUsd;
  assert.ok(Math.abs(total.totalUsd - sum) < 1e-9, `total ${total.totalUsd} != sum ${sum}`);
  assert.ok(pi.totalUsd > 0, "pi-session rows counted as pi spend");
  assert.equal(pi.requestCount, 2);
});

test("perSessionRate includes pi sessions with error/interrupt signal rows", () => {
  const r = perSessionRate({ dbPath: dbV17, windowSeconds: 300 });
  const piSess = r.sessions.find((s) => s.sessionId === "pi-sess-1");
  assert.ok(piSess, "pi session visible");
  assert.equal(piSess.appType, "pi");
  assert.ok(piSess.totalUsd > 0);
});

test("readPiAsCc pricing priority: piManaged keeps cc-switch exact entries", () => {
  const piDir = path.join(tmp, "pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
    providers: {
      "my-openai": { models: [{ id: "gpt-5.5", cost: { input: 9, output: 9 } }, { id: "pi-only-model", cost: { input: 1, output: 2 } }] },
    },
  }));
  fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "my-openai", defaultModel: "gpt-5.5" }));

  const ccSwitch = { modelPricing: { "gpt-5.5": { input_per_m: 1.75, output_per_m: 14, source: "cc-switch" } } };

  const managed = readPiAsCc({ piDir, ccSwitch, piManaged: true });
  assert.equal(managed.modelPricing["gpt-5.5"].source, "cc-switch", "cc-switch exact wins when managed");
  assert.equal(managed.modelPricing["pi-only-model"].source, "pi-models.json", "gap filled by models.json");

  const unmanaged = readPiAsCc({ piDir, ccSwitch, piManaged: false });
  assert.equal(unmanaged.modelPricing["gpt-5.5"].source, "pi-models.json", "unmanaged: models.json cost authoritative (current behavior)");
});

test("mergePiIntoCc: providers merged once, pricing fills gaps only, pure", () => {
  const piAsCc = {
    allProviders: [{ id: "my-openai", app_type: "pi", is_current: 1, settings_config: { model: "gpt-5.5", _piModels: ["gpt-5.5"] } }],
    currentProviders: { pi: { id: "my-openai", app_type: "pi", is_current: 1 } },
    modelPricing: { "gpt-5.5": { input_per_m: 9, source: "pi-models.json" }, "pi-only": { input_per_m: 1, source: "pi-models.json" } },
  };
  const cc = {
    allProviders: [{ id: "p1", app_type: "claude" }],
    currentProviders: { claude: { id: "p1" } },
    appTypes: ["claude"],
    modelPricing: { "gpt-5.5": { input_per_m: 1.75, source: "cc-switch" } },
  };
  const merged = mergePiIntoCc(cc, piAsCc);
  assert.equal(merged.allProviders.filter((p) => p.app_type === "pi").length, 1, "pi providers appear exactly once");
  assert.ok(merged.currentProviders.pi);
  assert.ok(merged.appTypes.includes("pi"));
  assert.equal(merged.modelPricing["gpt-5.5"].source, "cc-switch", "shared ids keep cc-switch pricing");
  assert.equal(merged.modelPricing["pi-only"].source, "pi-models.json", "gaps filled");
  // pure on null
  assert.equal(mergePiIntoCc(cc, null), cc);
  assert.equal(mergePiIntoCc(null, piAsCc), null);
});

test("OpenModel provider row: no misclassification, candidates include it (R6)", async () => {
  const { candidatesForAppType, classifyModel } = await import("../src/modelcap.js");
  const cc = readCcSwitch({ dbPath: dbV17 });
  const cands = candidatesForAppType(cc, "claude");
  const om = cands.find((c) => c.providerName === "OpenModel");
  assert.ok(om, "OpenModel provider present in claude candidates");
  assert.ok(!om.isCurrent, "not current (fixture is_current=0)");
  const cls = classifyModel("openmodel-x");
  assert.ok(cls && typeof cls.family === "string", "classifyModel handles unknown OpenModel id without throwing");
});

test("mawfSkillsUnderCcSwitch: detects repo-managed mawf-* skills rows", async () => {
  const { mawfSkillsUnderCcSwitch } = await import("../src/ccswitch.js");
  const res = mawfSkillsUnderCcSwitch({ dbPath: dbV17 });
  assert.ok(res, "skills table present on v17");
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].name, "mawf-cost-guard");
  assert.deepEqual(res.rows[0].enabledApps, ["claude"]);
  // v16 fixture has no skills table → null (feature-detect degrades)
  assert.equal(mawfSkillsUnderCcSwitch({ dbPath: dbV16 }), null);
  assert.equal(mawfSkillsUnderCcSwitch({ dbPath: path.join(tmp, "nope.db") }), null);
});

test("enrichPiDbRowsWithModelsJson: name-joins model lists into db pi rows, pricing untouched", () => {
  const piDir = path.join(tmp, "pi-enrich");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "models.json"), JSON.stringify({
    providers: { "Pi Official": { models: [{ id: "gpt-5.5" }, { id: "pi-x2" }] }, empty: { models: [] } },
  }));
  fs.writeFileSync(path.join(piDir, "settings.json"), "{}");
  const cc = readCcSwitch({ dbPath: dbV17 }); // has pi row 'Pi Official' with model gpt-5.5 in settings_config only
  const piRow = cc.allProviders.find((p) => p.app_type === "pi");
  assert.ok(piRow.settingsConfig._piModels === undefined, "db row carries no model list pre-enrich");
  enrichPiDbRowsWithModelsJson(cc, piDir);
  assert.deepEqual(piRow.settingsConfig._piModels, ["gpt-5.5", "pi-x2"]);
  assert.equal(piRow.settingsConfig.model, "gpt-5.5");
  // pricing untouched: db-exact entries remain the source
  assert.equal(cc.modelPricing["gpt-5.5"]?.source ?? "cc-switch", "cc-switch");
  // no models.json match → row left as-is; non-pi rows untouched
  const claudeRows = cc.allProviders.filter((p) => p.app_type === "claude");
  assert.ok(claudeRows.every((r) => !r.settingsConfig?._piModels));
  // missing piDir → no-op
  const cc2 = readCcSwitch({ dbPath: dbV17 });
  enrichPiDbRowsWithModelsJson(cc2, path.join(tmp, "nope"));
  assert.equal(cc2.allProviders.find((p) => p.app_type === "pi").settingsConfig._piModels, undefined);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
