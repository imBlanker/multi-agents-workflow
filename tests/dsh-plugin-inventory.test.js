import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDshPlugins } from "../src/dsh-plugin-inventory.js";

test("dsh component inventory accepts either identity field first and ignores nested disabled", () => {
  const rows = parseDshPlugins(`# == fixture
- name: '@deepseek-ai/dsh-one'
  disabled: true
  id: one
- id: two
  config:
    disabled: true
  name: '@deepseek-ai/dsh-two'
`);
  assert.deepEqual(rows.map(r => [r.id, r.name, r.status]), [
    ["one", "@deepseek-ai/dsh-one", "disabled"],
    ["two", "@deepseek-ai/dsh-two", "active"],
  ]);
});
