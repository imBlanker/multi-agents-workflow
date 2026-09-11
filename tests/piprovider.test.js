import "./fixtures/test-env.mjs";
// @ts-check
// Tests for the Pi Agent provider/model reader (src/piprovider.js) and the
// modelcap.js pi appType path. cc-switch does NOT manage pi, so these cover the
// ~/.pi/agent/ -> cc-switch-shape mapping + capability-aware selection + the
// hard security guarantee that no key material ever crosses the boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readPiConfig,
  readPiAsCc,
  findPiAgentDir,
  resolvePiAgentDir,
  piCostRateNote,
} from "../src/piprovider.js";
import { candidatesForAppType, selectModelForRole, providerModels } from "../src/modelcap.js";

function piFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-pi-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      defaultProvider: "deep-worker",
      defaultModel: "deepseek-v4-flash",
      defaultThinkingLevel: "xhigh",
      packages: ["npm:@tintinweb/pi-subagents", "npm:remote-pi"],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "deep-worker": {
          baseUrl: "http://127.0.0.1:8081/v1",
          api: "openai-completions",
          apiKey: "sk-SECRET-DO-NOT-LEAK-12345",
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text"], cost: { input: 0.14, output: 0.28 } },
            { id: "glm-5.2", name: "GLM 5.2", reasoning: true, input: ["text"], cost: { input: 1.14, output: 4 } },
          ],
        },
        "openai-codex": {
          baseUrl: "https://chatgpt.com/backend-api",
          api: "openai-codex-responses",
          apiKey: "sk-OTHER-SECRET-67890",
          models: [
            { id: "gpt-5.5", name: "GPT 5.5", input: ["text", "image"], cost: { input: 5, output: 30 } },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" } } }),
  );
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ "deep-worker": { apiKey: "sk-AUTH-SECRET" } }),
  );
  // cached remote catalogs (switchable via /model; docs providers.md)
  fs.writeFileSync(
    path.join(dir, "models-store.json"),
    JSON.stringify({
      "openai-codex": { models: ["gpt-5.5", "gpt-5.4-mini"] },
      "zai-coding-cn": { models: ["glm-4.7", "glm-5-turbo"] },
    }),
  );
  return dir;
}

test("readPiConfig reads settings/models/mcp + auth presence", () => {
  const dir = piFixture();
  const cfg = readPiConfig(dir);
  assert.equal(cfg.settings.defaultProvider, "deep-worker");
  assert.equal(cfg.settings.defaultModel, "deepseek-v4-flash");
  assert.ok(cfg.models.providers["deep-worker"]);
  assert.equal(cfg.authPresent, true);
  assert.deepEqual(Object.keys(cfg.mcp.mcpServers), ["exa"]);
});

test("readPiAsCc produces cc-switch-shaped object with app_type:pi providers", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  assert.ok(cc);
  assert.equal(cc.impl, "pi-files");
  assert.equal(cc.dbPath, ""); // signals "not cc-switch" to cost paths
  // default provider marked current + carries default model
  assert.equal(cc.currentProviders.pi.app_type, "pi");
  assert.equal(cc.currentProviders.pi.is_current, 1);
  assert.equal(cc.currentProviders.pi.name, "deep-worker");
  assert.equal(cc.currentProviders.pi.settings_config.model, "deepseek-v4-flash");
  // all providers enumerated, all pi
  assert.deepEqual(
    cc.allProviders.map((p) => p.name).sort(),
    ["deep-worker", "openai-codex", "zai-coding-cn"],
  );
  assert.ok(cc.allProviders.every((p) => p.app_type === "pi"));
  // pricing merged from models.json cost (per-M USD, same scale as cc-switch)
  assert.deepEqual(cc.modelPricing["deepseek-v4-flash"], {
    input_per_m: 0.14,
    output_per_m: 0.28,
    source: "pi-models.json",
    estimated: false,
  });
  assert.deepEqual(cc.modelPricing["gpt-5.5"], {
    input_per_m: 5,
    output_per_m: 30,
    source: "pi-models.json",
    estimated: false,
  });
});

test("readPiAsCc merges models-store.json catalogs into the switchable pool", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  const byName = Object.fromEntries(cc.allProviders.map((p) => [p.name, p]));
  // catalog EXTENDS an existing models.json provider (openai-codex: 1 + 1 new)
  assert.deepEqual(byName["openai-codex"].settings_config._piModels.sort(), ["gpt-5.4-mini", "gpt-5.5"]);
  // catalog-only provider becomes a provider_type pi-catalog row
  assert.equal(byName["zai-coding-cn"].provider_type, "pi-catalog");
  assert.equal(byName["zai-coding-cn"].is_current, 0);
  assert.deepEqual(byName["zai-coding-cn"].settings_config._piModels.sort(), ["glm-4.7", "glm-5-turbo"]);
  // every switchable model is enumerated for capability selection
  const all = candidatesForAppType(cc, "pi").map((c) => c.model).sort();
  assert.deepEqual(all, ["deepseek-v4-flash", "glm-4.7", "glm-5-turbo", "glm-5.2", "gpt-5.4-mini", "gpt-5.5"]);
});

test("SECURITY: readPiAsCc output never contains apiKey or key bytes", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  const blob = JSON.stringify(cc);
  assert.equal(blob.includes("apiKey"), false, "apiKey key must not appear in output");
  assert.equal(blob.includes("SECRET"), false, "secret key bytes must not appear");
  assert.equal(blob.includes("sk-"), false, "sk- key prefixes must not appear");
});

test("candidatesForAppType(cc,'pi') enumerates every provider x model", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  const cands = candidatesForAppType(cc, "pi");
  assert.deepEqual(
    cands.map((c) => c.model).sort(),
    ["deepseek-v4-flash", "glm-4.7", "glm-5-turbo", "glm-5.2", "gpt-5.4-mini", "gpt-5.5"],
  );
  assert.ok(cands.every((c) => c.appType === "pi"));
  assert.ok(cands.find((c) => c.model === "deepseek-v4-flash" && c.isCurrent));
});

test("providerModels(sc,'pi') returns the provider's full model list", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  const sc = cc.currentProviders.pi.settings_config;
  assert.deepEqual(
    providerModels(sc, "pi").sort(),
    ["deepseek-v4-flash", "glm-5.2"],
  );
});

test("selectModelForRole for pi returns a ranked choice with pi pricing", () => {
  const dir = piFixture();
  const cc = readPiAsCc({ piDir: dir });
  const sel = selectModelForRole({ role: "implementer", appType: "pi", cc });
  assert.ok(sel, "expected a selection");
  assert.ok(["deepseek-v4-flash", "glm-5.2", "gpt-5.5"].includes(sel.model));
  assert.equal(sel.appType, "pi");
  assert.equal(sel.estimated, true);
  assert.ok(sel.price, "price should be present (pi models.json cost)");
  assert.equal(sel.price.source, "pi-models.json");
});

test("readPiAsCc merges cc-switch pricing for shared model ids", () => {
  const dir = piFixture();
  const cc = readPiAsCc({
    piDir: dir,
    ccSwitch: {
      modelPricing: {
        "gpt-5.5": { input_per_m: 5, output_per_m: 30, source: "cc-switch", estimated: true },
        "claude-opus-5": { input_per_m: 5, output_per_m: 25, source: "cc-switch" }, // not in pi store
      },
    },
  });
  // pi store price wins for pi-known models (re-mapped to pi source)
  assert.equal(cc.modelPricing["gpt-5.5"].source, "pi-models.json");
  // cc-switch-only model survives the merge
  assert.equal(cc.modelPricing["claude-opus-5"].source, "cc-switch");
});

test("readPiAsCc falls back to first provider when defaultProvider unknown", () => {
  const dir = piFixture();
  // break the default provider name so it matches no provider group
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ defaultProvider: "ghost", defaultModel: "deepseek-v4-flash" }),
  );
  const cc = readPiAsCc({ piDir: dir });
  assert.equal(cc.currentProviders.pi.name, "deep-worker"); // first provider
  assert.equal(cc.currentProviders.pi.is_current, 1);
});

test("piCostRateNote explains concurrency-only enforcement", () => {
  assert.match(piCostRateNote(), /concurrency-only/);
  assert.match(piCostRateNote(), /not.*measured/i);
});

test("readPiAsCc returns null when pi home is absent", () => {
  assert.equal(readPiAsCc({ piDir: "/nonexistent-maw-pi-test-xyz" }), null);
});

test("Pi directory precedence is explicit > canonical > legacy > home, including absent chosen roots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf pi homes "));
  const keys = ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR"];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } fs.rmSync(root, { recursive: true, force: true }); });
  const dirs = ["explicit", "canonical", "legacy"].map((n) => path.join(root, n));
  for (const [i, d] of dirs.entries()) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ defaultProvider: `provider-${i}` })); }
  process.env.PI_CODING_AGENT_DIR = dirs[1]; process.env.PI_AGENT_DIR = dirs[2];
  assert.equal(findPiAgentDir(dirs[0]), dirs[0]);
  assert.equal(readPiConfig(dirs[0]).settings.defaultProvider, "provider-0");
  assert.equal(findPiAgentDir(), dirs[1]);
  assert.equal(readPiConfig().settings.defaultProvider, "provider-1");
  assert.equal(findPiAgentDir(path.join(root, "absent")), "");
  assert.equal(readPiConfig(path.join(root, "absent")), null);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "absent-canonical");
  assert.equal(findPiAgentDir(), "", "never fall back from missing explicitly selected canonical home");
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(findPiAgentDir(), dirs[2]);
  delete process.env.PI_AGENT_DIR;
  assert.equal(resolvePiAgentDir(), path.join(os.homedir(), ".pi", "agent"));
});
