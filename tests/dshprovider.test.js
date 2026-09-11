import "./fixtures/test-env.mjs";
// @ts-check
// Tests for the dsh provider/model reader (no cc-switch) + pricing JSON sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findDshHome,
  readDshConfig,
  readCcPricingJson,
  readCredentialKeys,
  dshDefaultModel,
  dshCostRateNote,
  readDshAsCc,
  listDshProfiles,
} from "../src/dshprovider.js";
import { candidatesForAppType } from "../src/modelcap.js";

function mkDshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-dsh-"));
  fs.writeFileSync(
    path.join(dir, "settings.yaml"),
    `llm-pi-ai:
  providers:
    zai-coding-cn:
      baseURL: https://open.bigmodel.cn/api/coding/paas/v4
      api: openai-completions
      apiKeyEnv: ZAI_CODING_CN_API_KEY
      models:
        - id: glm-5.2
          name: GLM-5.2
          contextWindow: 1000000
          maxTokens: 131072
        - id: glm-5v-turbo
          name: GLM-5V-Turbo
          contextWindow: 200000
          input: [text, image]
    my-gateway:
      baseURL: https://gw.example/v1
      apiKeyEnv: GATEWAY_API_KEY
      models:
        - id: legacy-chat
agent-presets:
  default: liangshen
ui-theme:
  preference: light
`
  );
  fs.writeFileSync(path.join(dir, ".credentials.yaml"), `zai-coding-cn: "sk-not-a-real-secret"\nmy-gateway: "also-fake"\n`);
  fs.mkdirSync(path.join(dir, "profiles", "web"), { recursive: true });
  return dir;
}

function mkPricingJson() {
  const file = path.join(os.tmpdir(), `maw-pricing-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      modelsDevSync: { autoSyncEnabled: true, lastSyncAt: 1 },
      models: [
        {
          modelId: "glm-5.2",
          displayName: "GLM 5.2",
          inputCostPerMillion: "0.6",
          outputCostPerMillion: "2.2",
          cacheReadCostPerMillion: "0.06",
          cacheCreationCostPerMillion: "0.7",
        },
        { modelId: "deleted-model", displayName: "x", inputCostPerMillion: "1", outputCostPerMillion: "1" },
      ],
      deletedModelIds: ["deleted-model"],
    })
  );
  return file;
}

test("findDshHome honors DSH_HOME env", () => {
  const dir = mkDshHome();
  process.env.DSH_HOME = dir;
  try {
    assert.equal(findDshHome(), dir);
  } finally {
    delete process.env.DSH_HOME;
  }
});

test("readDshConfig parses fixture; missing dir -> null; malformed -> null (no throw)", () => {
  const dir = mkDshHome();
  const cfg = readDshConfig(dir);
  assert.ok(cfg);
  assert.equal(cfg.dshHome, dir);
  assert.equal(cfg.settings["llm-pi-ai"].providers["zai-coding-cn"].apiKeyEnv, "ZAI_CODING_CN_API_KEY");
  assert.equal(cfg.settings["agent-presets"].default, "liangshen");
  assert.equal(readDshConfig(path.join(dir, "nope")), null);
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "maw-dsh-bad-"));
  fs.writeFileSync(path.join(bad, "settings.yaml"), "a: !!js process.env.X\n");
  assert.equal(readDshConfig(bad), null);
});

test("readCcPricingJson: matched ids get real prices; deleted ids dropped; missing file -> {}", () => {
  const file = mkPricingJson();
  const p = readCcPricingJson(file);
  assert.ok(p["glm-5.2"]);
  assert.equal(p["glm-5.2"].input_per_m, 0.6);
  assert.equal(p["glm-5.2"].output_per_m, 2.2);
  assert.equal(p["glm-5.2"].source, "cc-switch-pricing-json");
  assert.equal(p["deleted-model"], undefined);
  assert.deepEqual(readCcPricingJson(path.join(os.tmpdir(), "maw-missing-pricing.json")), {});
});

test("readCredentialKeys: names only, never values", () => {
  const dir = mkDshHome();
  const keys = readCredentialKeys(dir);
  assert.deepEqual(keys.sort(), ["my-gateway", "zai-coding-cn"]);
  const blob = JSON.stringify(readDshAsCc({ dshHome: dir, dumpConfig: "" }));
  assert.ok(!blob.includes("sk-not-a-real-secret"));
  assert.ok(!blob.includes("also-fake"));
});

test("dshDefaultModel: regex extraction from dump-config text; garbage -> null", () => {
  const dump = `# == @deepseek-ai/dsh-base
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
- id: jobs
`;
  const d = dshDefaultModel({ dumpConfig: dump });
  assert.deepEqual(d, { provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert.equal(dshDefaultModel({ dumpConfig: "total garbage" }), null);
});

test("readDshAsCc: cc shape, _dshModels, pricing entries, current provider from dump", () => {
  const dir = mkDshHome();
  const pricing = mkPricingJson();
  const cc = readDshAsCc({
    dshHome: dir,
    pricingPath: pricing,
    dumpConfig: "- id: agent-default-model\n  config:\n    provider: zai-coding-cn\n    model: glm-5.2\n",
  });
  assert.ok(cc);
  assert.equal(cc.appTypes[0], "dsh");
  assert.equal(cc.allProviders.length, 2);
  const cur = cc.currentProviders.dsh;
  assert.equal(cur.id, "zai-coding-cn");
  assert.equal(cur.app_type, "dsh");
  assert.equal(cur.is_current, 1);
  assert.equal(cur.settings_config.model, "glm-5.2");
  assert.deepEqual(cur.settings_config._dshModels, ["glm-5.2", "glm-5v-turbo"]);
  assert.equal(cur.settings_config._dshModelMeta[1].input[1], "image");
  assert.equal(cur.apiKeyEnv, "ZAI_CODING_CN_API_KEY"); // env var NAME only
  // pricing: glm-5.2 matched, glm-5v-turbo + legacy-chat absent (unknown)
  assert.ok(cc.modelPricing["glm-5.2"]);
  assert.equal(cc.modelPricing["glm-5v-turbo"], undefined);
  assert.equal(cc.modelPricing["legacy-chat"], undefined);
  // fallback when dump gives nothing: first provider becomes current
  const cc2 = readDshAsCc({ dshHome: dir, pricingPath: pricing, dumpConfig: "" });
  assert.equal(cc2.currentProviders.dsh.id, "zai-coding-cn");
});

test("candidatesForAppType('dsh') lists settings.yaml models", () => {
  const dir = mkDshHome();
  const cc = readDshAsCc({ dshHome: dir, dumpConfig: "" });
  const cands = candidatesForAppType(cc, "dsh");
  assert.equal(cands.length, 3); // glm-5.2, glm-5v-turbo, legacy-chat
  assert.ok(cands.some((c) => c.model === "glm-5.2" && c.providerId === "zai-coding-cn"));
  assert.ok(cands.every((c) => c.appType === "dsh"));
});

test("dshCostRateNote mentions concurrency-only and the pricing source", () => {
  const note = dshCostRateNote();
  assert.match(note, /concurrency-only/);
  assert.match(note, /model-pricing\.json/);
});

test("listDshProfiles returns real profile dirs only (skips node_modules, dot-dirs, files; missing dir → [])", () => {
  const dir = mkDshHome();
  // real profiles
  fs.mkdirSync(path.join(dir, "profiles", "web"), { recursive: true });
  fs.mkdirSync(path.join(dir, "profiles", "headless"));
  // decoys: pnpm/dsh symlink farm + hidden dir + plain file (regression: doctor reported "node_modules" as a profile)
  fs.mkdirSync(path.join(dir, "profiles", "node_modules"));
  fs.mkdirSync(path.join(dir, "profiles", ".cache"));
  fs.writeFileSync(path.join(dir, "profiles", "README.md"), "x");
  assert.deepEqual(listDshProfiles(dir), ["headless", "web"]);
  // missing profiles dir / missing home
  assert.deepEqual(listDshProfiles(path.join(dir, "nonexistent")), []);
});

test("versioned credentials report refs only, including multiline CRLF; no record payloads", () => {
  const dir = mkDshHome();
  fs.writeFileSync(path.join(dir, ".credentials.yaml"), [
    "version: 1", "refs:", "  DEEPSEEK_API_KEY: sk-SENTINEL", "  MULTILINE: |-", "    secret: SENTINEL-two", "    other", "records:", "  llm-pi-ai/openai-codex:", "    kind: grant", "    payload:", "      access: SENTINEL-three",
  ].join("\r\n"));
  assert.deepEqual(readCredentialKeys(dir), ["DEEPSEEK_API_KEY", "MULTILINE"]);
  assert.doesNotMatch(JSON.stringify(readDshAsCc({ dshHome: dir, dumpConfig: "" })), /SENTINEL|payload|openai-codex/);
  for (const contents of ["version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n", "version: 2\nrefs:\n  KEY: value\n", "refs:\n  KEY: value\n", "version: 1\nrefs:\n  KEY: ''\n", "version: 1\nrefs:\n  KEY: [bad]\n", "version: 1\nrefs:\n  KEY: 'unclosed\n", "version: 1\nrefs:\n  KEY: first\n  KEY: second\n"]) {
    fs.writeFileSync(path.join(dir, ".credentials.yaml"), contents);
    assert.deepEqual(readCredentialKeys(dir), []);
  }
});

test("saved default wins and observes subsequent writes and other homes/profiles", () => {
  const dir = mkDshHome();
  const other = mkDshHome();
  const dumpConfig = "- id: agent-default-model\n  config:\n    provider: composed\n    model: model-c\n";
  const set = (root, model) => fs.appendFileSync(path.join(root, "settings.yaml"), `agent-default-model:\n  provider: saved\n  model: ${model}\n`);
  set(dir, "model-a");
  set(other, "model-b");
  assert.deepEqual(dshDefaultModel({ dshHome: dir, profile: "web", dumpConfig }), { provider: "saved", model: "model-a" });
  assert.equal(dshDefaultModel({ dshHome: other, profile: "headless", dumpConfig }).model, "model-b");
  fs.writeFileSync(path.join(dir, "settings.yaml"), fs.readFileSync(path.join(dir, "settings.yaml"), "utf8").replace("model: model-a", "model: model-new"));
  assert.equal(dshDefaultModel({ dshHome: dir, dumpConfig }).model, "model-new");
  fs.writeFileSync(path.join(dir, "settings.yaml"), "agent-default-model:\n  provider: saved\n  model: ''\n");
  assert.equal(dshDefaultModel({ dshHome: dir, dumpConfig }).model, "model-c");
});

test("composition parser is bounded, supports quoted CRLF and ignores disabled rows and JS tags", () => {
  const dir = mkDshHome();
  for (const dumpConfig of [
    "- id: agent-default-model\n  config:\n    provider: wrong\n- id: unrelated\n  config:\n    model: stolen\n",
    "- id: agent-default-model\n  disabled: true\n  config:\n    provider: x\n    model: y\n",
    "- id: agent-default-model\n  config:\n    provider: !!js process.env.SECRET\n    model: y\n",
  ]) assert.equal(dshDefaultModel({ dshHome: dir, dumpConfig }), null);
  assert.deepEqual(dshDefaultModel({ dshHome: dir, dumpConfig: "- id: agent-default-model\r\n  config:\r\n    model: \"deepseek-flash\"\r\n    provider: 'deepseek-official'\r\n" }), { provider: "deepseek-official", model: "deepseek-flash" });
});

test("direct provider needs evidence; unresolved selected provider never switches to a custom route", () => {
  const dir = mkDshHome();
  const dumpConfig = "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n";
  const unresolved = readDshAsCc({ dshHome: dir, dumpConfig });
  assert.equal(unresolved.currentProviders.dsh, undefined);
  assert.equal(unresolved.unresolvedSelection.provider, "deepseek-official");
  const direct = readDshAsCc({ dshHome: dir, dumpConfig: dumpConfig + "- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n" });
  assert.equal(direct.currentProviders.dsh.id, "deepseek-official");
  assert.equal(direct.currentProviders.dsh.settings_config.model, "deepseek-flash");
  assert.equal(direct.modelPricing["deepseek-flash"], undefined);
  assert.equal(direct.catalogComplete, false);
  assert.equal(direct.unresolvedSelection, null);
  assert.equal(readDshAsCc({ dshHome: dir, dumpConfig: dumpConfig + "- id: llm-deepseek\n  disabled: true\n" }).currentProviders.dsh, undefined);
});

test("direct settings catalog and catalog-backed routes preserve explicit metadata and incompleteness", () => {
  const dir = mkDshHome();
  fs.writeFileSync(path.join(dir, "settings.yaml"), `llm-deepseek:
  models:
    - id: deepseek-flash
      contextWindow: 1000000
      input: [text, image]
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
llm-pi-ai:
  providers:
    openai:
      modelOverrides:
        gpt-test:
          contextWindow: 123
`);
  const cc = readDshAsCc({ dshHome: dir, dumpConfig: "" });
  assert.equal(cc.defaultSelectionSource, "settings.yaml");
  assert.equal(cc.currentProviders.dsh.catalogComplete, true);
  assert.deepEqual(cc.currentProviders.dsh.settings_config._dshModels, ["deepseek-flash"]);
  assert.deepEqual(cc.currentProviders.dsh.settings_config._dshModelMeta[0].input, ["text", "image"]);
  const openai = cc.allProviders.find((p) => p.id === "openai");
  assert.equal(openai.catalogComplete, false);
  assert.deepEqual(openai.catalogOverrideIds, ["gpt-test"]);
  assert.deepEqual(openai.settings_config._dshModels, []);
});

test("composition ignores YAML inside scripts and reads row metadata regardless of property order", () => {
  const dir = mkDshHome();
  assert.equal(dshDefaultModel({ dshHome: dir, dumpConfig: "- id: unrelated\n  config:\n    script: !!js |\n      - id: agent-default-model\n        config:\n          provider: fake\n          model: fake\n" }), null);
  assert.equal(dshDefaultModel({ dshHome: dir, dumpConfig: "- name: '@deepseek-ai/dsh-agent-default-model'\n  disabled: true\n  id: agent-default-model\n  config:\n    provider: fake\n    model: fake\n" }), null);
});

test("composed pi-ai providers merge saved fields; disabled adapter suppresses configured rows", () => {
  const dir = mkDshHome();
  fs.writeFileSync(path.join(dir, "settings.yaml"), "llm-pi-ai:\n  providers:\n    gateway:\n      apiKeyEnv: SAVED_KEY\n");
  const dumpConfig = "- id: llm-pi-ai\n  config:\n    providers:\n      gateway:\n        api: openai-completions\n        baseURL: https://example.test/v1\n        models:\n          - id: selected\n- id: agent-default-model\n  config:\n    provider: gateway\n    model: selected\n";
  const cc = readDshAsCc({ dshHome: dir, dumpConfig });
  assert.equal(cc.currentProviders.dsh.apiKeyEnv, "SAVED_KEY");
  assert.deepEqual(cc.currentProviders.dsh.settings_config._dshModels, ["selected"]);
  assert.equal(readDshAsCc({ dshHome: dir, dumpConfig: dumpConfig.replace("- id: llm-pi-ai\n", "- id: llm-pi-ai\n  disabled: true\n") }).allProviders.length, 0);
});


test("malformed provider entries do not invent configured routes or complete catalogs", () => {
  const dir = mkDshHome();
  fs.writeFileSync(path.join(dir, "settings.yaml"), `llm-pi-ai:
  providers:
    invalid: null
llm-deepseek: []
`);
  const empty = readDshAsCc({ dshHome: dir, dumpConfig: "" });
  assert.deepEqual(empty.allProviders, []);
  assert.equal(empty.catalogComplete, false);
  fs.writeFileSync(path.join(dir, "settings.yaml"), `llm-pi-ai:
  providers:
    valid:
      models:
        - id: valid-model
        - id:
            secret: SENTINEL_INVALID_ID
        - null
`);
  const cc = readDshAsCc({ dshHome: dir, dumpConfig: "" });
  assert.deepEqual(cc.allProviders[0].settings_config._dshModels, ["valid-model"]);
  assert.equal(cc.catalogComplete, false);
  assert.doesNotMatch(JSON.stringify(cc), /SENTINEL_INVALID_ID/);
  assert.doesNotThrow(() => candidatesForAppType(cc, "dsh"));
});
