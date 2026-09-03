// @ts-check
// Tests for project-level proactive advising blocks (src/injectblock.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { blockText, writeManagedBlocks, removeManagedBlocks, BLOCK_BEGIN, BLOCK_END } from "../src/injectblock.js";
import { uninstall } from "../src/installer.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maw-inj-"));
}
const countBlocks = (file) => {
  const t = fs.readFileSync(file, "utf8");
  return t.split(BLOCK_BEGIN).length - 1;
};

test("blockText: <=26 content lines, required phrases present", () => {
  const lines = blockText().split("\n");
  const content = lines.slice(1, -1); // between markers
  assert.ok(content.length <= 26, `${content.length} lines`);
  const text = blockText();
  for (const phrase of ["UTC+8", "ADVISE-DONE", "inventory-digest", "kill -9 $(lsof -ti tcp:3080) && dsh web", "NEVER execute", "48h", "ask/grill only unresolved", "Do NOT treat the switch as ready"]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("writeManagedBlocks: create-if-absent writes both files + record", () => {
  const p = tmpProject();
  const r = writeManagedBlocks(p);
  assert.equal(r.created.length, 2);
  for (const f of [path.join(p, "AGENTS.md"), path.join(p, "CLAUDE.md")]) {
    assert.ok(fs.existsSync(f), f);
    assert.equal(countBlocks(f), 1);
  }
  const rec = JSON.parse(fs.readFileSync(path.join(p, ".mawf", "managed-blocks.json"), "utf8"));
  assert.equal(rec.created.length, 2);
});

test("writeManagedBlocks: idempotent — 3 runs leave exactly one block each", () => {
  const p = tmpProject();
  writeManagedBlocks(p);
  writeManagedBlocks(p);
  writeManagedBlocks(p);
  for (const f of [path.join(p, "AGENTS.md"), path.join(p, "CLAUDE.md")]) {
    assert.equal(countBlocks(f), 1);
  }
});

test("writeManagedBlocks: existing user file — inserted after title, user content intact", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "AGENTS.md"), "# My project\n\nUser instructions stay.\n");
  fs.writeFileSync(path.join(p, "CLAUDE.md"), "# Existing CLAUDE\n\nBody line.\n");
  const r = writeManagedBlocks(p);
  assert.equal(r.created.length, 0);
  const agents = fs.readFileSync(path.join(p, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# My project\n"));
  assert.ok(agents.includes("User instructions stay."));
  assert.ok(agents.indexOf("User instructions stay.") > agents.indexOf(BLOCK_BEGIN), "block inserted after title, before user body");
  assert.equal(countBlocks(path.join(p, "AGENTS.md")), 1);
});

test("writeManagedBlocks: foreign managed span (Trellis) stays contiguous; block after it", () => {
  const p = tmpProject();
  fs.writeFileSync(
    path.join(p, "AGENTS.md"),
    "<!-- TRELLIS:START -->\n# Trellis Instructions\nManaged by Trellis.\n<!-- TRELLIS:END -->\n\nReal project content.\n",
  );
  writeManagedBlocks(p);
  const t = fs.readFileSync(path.join(p, "AGENTS.md"), "utf8");
  const trellisStart = t.indexOf("<!-- TRELLIS:START -->");
  const trellisEnd = t.indexOf("<!-- TRELLIS:END -->");
  const ours = t.indexOf(BLOCK_BEGIN);
  assert.ok(trellisStart !== -1 && trellisEnd !== -1);
  assert.ok(trellisEnd < ours, "our block after the Trellis span");
  assert.ok(t.includes("Real project content."));
});

test("writeManagedBlocks: corrupt single marker repaired (fresh block, no dangling marker)", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "AGENTS.md"), `# Title\n\nUser line.\n\n${BLOCK_BEGIN}\norphan content without end marker\n`);
  writeManagedBlocks(p);
  const t = fs.readFileSync(path.join(p, "AGENTS.md"), "utf8");
  assert.equal(t.split(BLOCK_BEGIN).length - 1, 1);
  assert.ok(t.includes("User line."));
  assert.equal(t.includes("orphan content without end marker"), true); // user-ish content preserved
  // the repaired block has a matched pair
  const begin = t.indexOf(BLOCK_BEGIN);
  const end = t.indexOf(BLOCK_END);
  assert.ok(begin !== -1 && end > begin);
});

test("removeManagedBlocks: user content preserved; created header-only files deleted; record removed", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "CLAUDE.md"), "# Existing\n\nUser body.\n"); // exists → strip span only
  writeManagedBlocks(p); // AGENTS.md created (header-only after strip); CLAUDE.md gets block
  const r = removeManagedBlocks(p);
  assert.ok(r.emptied.includes(path.join(p, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(p, "AGENTS.md")), "header-only created file deleted");
  const claude = fs.readFileSync(path.join(p, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("User body."));
  assert.ok(!claude.includes(BLOCK_BEGIN));
  assert.ok(!fs.existsSync(path.join(p, ".mawf", "managed-blocks.json")));
});

test("uninstall --purge-config strips blocks + deletes created files; keep keeps them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maw-inj-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // keep: blocks stay
    const keep = tmpProject();
    writeManagedBlocks(keep);
    uninstall({ project: keep, purgeConfig: false });
    assert.equal(countBlocks(path.join(keep, "AGENTS.md")), 1);

    // purge: spans stripped, created files deleted, .mawf gone
    const purge = tmpProject();
    fs.writeFileSync(path.join(purge, "CLAUDE.md"), "# Title\n\nUser body.\n");
    writeManagedBlocks(purge);
    const r = uninstall({ project: purge, purgeConfig: true });
    assert.ok(!fs.existsSync(path.join(purge, "AGENTS.md")), "created AGENTS.md deleted on purge");
    const claude = fs.readFileSync(path.join(purge, "CLAUDE.md"), "utf8");
    assert.ok(claude.includes("User body."));
    assert.ok(!claude.includes(BLOCK_BEGIN));
    assert.ok(!fs.existsSync(path.join(purge, ".mawf")));
    assert.ok(r.purged.some((x) => x.endsWith("AGENTS.md")));
  } finally {
    process.env.HOME = prevHome;
  }
});
