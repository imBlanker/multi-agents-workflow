import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidateIdentity } from '../src/verification.js';

test('candidate hashes and ordering do not depend on locale collation or scope order', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-order-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const names = ['z.txt', 'ä.txt', 'A.txt', '_x.txt', '中.txt'];
  for (const name of names) fs.writeFileSync(path.join(workspace, name), name);
  const run = { snapshot: { workspace, effectiveConfigHash: 'fixed-config' } };
  const capture = (locale, scope) => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function (other) { return new Intl.Collator(locale).compare(this, other); };
    try { return candidateIdentity(run, { scope }); }
    finally { String.prototype.localeCompare = original; }
  };
  const german = capture('de', names), swedish = capture('sv', [...names].reverse());
  assert.deepEqual(german.files.map(file => file.path), [...names].sort());
  assert.deepEqual(german, swedish);
});
