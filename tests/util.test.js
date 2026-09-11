import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toYaml, slug, round, yamlQuote, parseYamlSubset } from "../src/util.js";

test("round handles float epsilon", () => {
  assert.equal(round(0.1 + 0.2, 2), 0.3);
  assert.equal(round(1.005, 2), 1.01);
});

test("slug lowercases and dashes", () => {
  assert.equal(slug("Multi Agents Workflow!"), "multi-agents-workflow");
  assert.equal(slug("a.b.c"), "a-b-c");
});

test("yamlQuote quotes special values", () => {
  assert.equal(yamlQuote("true"), '"true"');
  assert.equal(yamlQuote("12.5"), '"12.5"');
  assert.equal(yamlQuote("plain"), "plain");
  assert.equal(yamlQuote("a:b"), '"a:b"');
});

test("toYaml produces valid-looking nested yaml", () => {
  const y = toYaml({ a: 1, b: { c: 2 }, d: ["x", "y"] });
  assert.match(y, /a: 1/);
  assert.match(y, /b:/);
  assert.match(y, /- x/);
  assert.match(y, /- y/);
});

test("parseYamlSubset: nested mappings, scalars, comments", () => {
  const doc = parseYamlSubset(`
# top comment
locale:
  preference: zh   # trailing comment
pet:
  visible: true
  size: 160
  ratio: 1.5
  name: null
`);
  assert.deepEqual(doc.locale, { preference: "zh" });
  assert.equal(doc.pet.visible, true);
  assert.equal(doc.pet.size, 160);
  assert.equal(doc.pet.ratio, 1.5);
  assert.equal(doc.pet.name, null);
});

test("parseYamlSubset: lists of scalars and of mappings, flow sequences", () => {
  const doc = parseYamlSubset(`
llm-pi-ai:
  providers:
    zai-coding-cn:
      baseURL: https://open.bigmodel.cn/api/coding/paas/v4
      apiKeyEnv: ZAI_CODING_CN_API_KEY
      models:
        - id: glm-5.2
          name: GLM-5.2
          contextWindow: 1000000
          input: [text, image]
        - id: glm-5.3
          name: "GLM: 5.3"
    plain-list:
      - alpha
      - 'quoted: value'
`);
  const prov = doc["llm-pi-ai"].providers["zai-coding-cn"];
  assert.equal(prov.apiKeyEnv, "ZAI_CODING_CN_API_KEY");
  assert.equal(prov.baseURL, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(prov.models.length, 2);
  assert.deepEqual(prov.models[0], { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, input: ["text", "image"] });
  assert.equal(prov.models[1].name, "GLM: 5.3");
  assert.deepEqual(doc["llm-pi-ai"].providers["plain-list"], ["alpha", "quoted: value"]);
});

test("parseYamlSubset: same-indent list under a key", () => {
  const doc = parseYamlSubset(`
agent-presets:
  default: liangshen
models:
- id: a
- id: b
`);
  assert.equal(doc["agent-presets"].default, "liangshen");
  assert.deepEqual(doc.models.map((m) => m.id), ["a", "b"]);
});

test("parseYamlSubset: throws loudly on unsupported constructs", () => {
  assert.throws(() => parseYamlSubset("a: !!js process.env.X"), /unsupported construct/);
  assert.throws(() => parseYamlSubset("a: &anchor\n  b: 1\nc: *anchor"), /unsupported construct/);
  assert.throws(() => parseYamlSubset("---\na: 1"), /unsupported construct/);
  assert.throws(() => parseYamlSubset("a:\n\tb: 1"), /tabs/);
});

test("parseYamlSubset: round-trips against toYaml output for simple docs", () => {
  const obj = { name: "demo", count: 3, nested: { flag: true, items: ["x", "y"] } };
  const doc = parseYamlSubset(toYaml(obj));
  assert.deepEqual(doc, obj);
});
