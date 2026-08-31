// @ts-check
// Project-level proactive advising injection: an idempotent managed block in
// the project root AGENTS.md + CLAUDE.md (both are always-loaded surfaces for
// claude-code / codex / pi / dsh in a MAW project — decision D1: project
// scope only, global prompt files are NEVER touched).
//
// Reversibility (08-17 uninstall policy parity):
//   - keep-config (default): blocks stay (consistent with keeping .mawf/)
//   - --purge-config: spans stripped from both files; files mawf CREATED are
//     deleted (recorded in .mawf/managed-blocks.json, read BEFORE .mawf removal).
// Project file paths are NEVER added to the installer manifest files[] — that
// invariant records whole files and would delete user project files.
import fs from "node:fs";
import path from "node:path";
import { exists, isFile, readText, writeText, readJson, writeJson, ensureDir } from "./util.js";

export const BLOCK_BEGIN = "<!-- mawf:cross-host-advise BEGIN -->";
export const BLOCK_END = "<!-- mawf:cross-host-advise END -->";
const RECORD_FILE = path.join(".mawf", "managed-blocks.json");
const TARGETS = ["AGENTS.md", "CLAUDE.md"];

/**
 * The managed block (<=26 content lines by design contract; raised from
 * <=20 in 08-31-mawf-pluginpool-stagegate to carry the plugin-pool rule).
 * Instructions:
 * re-advise at session start + first daily prompt (UTC+8), parse the
 * ADVISE-DONE footer, switch = fill handoff + show command (NEVER execute),
 * continue fresh handoff briefs (<48h), consult the inventory digest before
 * claiming a capability is missing.
 * @returns {string}
 */
export function blockText() {
  return [
    BLOCK_BEGIN,
    "## MAW cross-host advising (managed block — edit outside the markers only)",
    "",
    "This machine runs several supported agent hosts (claude/codex/pi/dsh). Act for the human:",
    "",
    "1. Session start AND first prompt of each day (UTC+8): run `mawf advise --check-fresh`;",
    "   when STALE, run `mawf advise --task \"<current task>\"` (no --task → project plan profile).",
    "2. Parse the trailing `ADVISE-DONE recommendation=… target=… margin=… handoff=…` line.",
    "3. On `switch`: fill the pre-created handoff brief (path from handoff=), then present the",
    "   recommendation + reasons and the exact launch command (dsh: `kill -9 $(lsof -ti tcp:3080) && dsh web`).",
    "   NEVER execute the launch command yourself — the human runs it.",
    "4. Session start: if `.mawf/handoff/` has a brief newer than 48h, offer to continue it.",
    "5. Before claiming a tool/model/skill is missing on this machine, check `.mawf/inventory-digest.md`",
    "   (another host may have it; `mawf inventory --verify` refreshes live MCP/plugin status).",
    "6. Plugin pool, stage-gated (graph gate batches / plan review points): run `mawf advise --pool`",
    "   at stage entry AND at the gate (≥2 judgments per stage). Parse the `POOL-DONE` footer;",
    "   present add/keep/remove verdicts + procedures to the human and NEVER execute them.",
    "   Apply ONLY at stage boundaries, never mid-batch. Installs must not clobber existing",
    "   assets; removals must verify no residue (follow the printed checklist).",
    "",
    "Advice is advisory — you propose, the human decides. Removed by `mawf uninstall --purge-config`.",
    BLOCK_END,
  ].join("\n");
}

/**
 * Insertion point for a marker-less file: after a leading `# Title` + blank
 * line; when a foreign managed span (e.g. `<!-- TRELLIS:START/END -->`) sits
 * at the top, insert AFTER its END so other tools' blocks stay contiguous.
 * @param {string} content
 * @returns {{ index: number, title: boolean }}
 */
function insertIndex(content) {
  const lines = content.split("\n");
  let i = 0;
  // foreign managed span at top (Trellis and friends)
  const spanStart = lines.findIndex((l) => /^\s*<!--\s*[\w:-]+\s*:\s*(START|BEGIN)\s*-->/.test(l));
  if (spanStart === 0) {
    const spanEnd = lines.findIndex((l) => /^\s*<!--\s*[\w:-]+\s*:\s*(END|FINISH)\s*-->/.test(l));
    if (spanEnd > 0) {
      let after = spanEnd + 1;
      while (after < lines.length && lines[after].trim() === "") after++;
      if (after < lines.length) return { index: after, title: false }; // before real content
      return { index: spanEnd + 1, title: false }; // span-only file: append after span
    }
  }
  if (lines.length && /^#\s/.test(lines[0])) {
    let after = 1;
    while (after < lines.length && lines[after].trim() === "") after++;
    return { index: after, title: true };
  }
  return { index: 0, title: false };
}

/** @param {string} file @param {string} body */
function writeCreated(file, body) {
  ensureDir(path.dirname(file));
  writeText(file, body);
}

/**
 * Ensure the managed block exists (idempotent) in project AGENTS.md + CLAUDE.md.
 * @param {string} projectDir
 * @returns {{ written: string[], created: string[] }} absolute paths
 */
export function writeManagedBlocks(projectDir) {
  const project = path.resolve(projectDir);
  const block = `${blockText()}\n`;
  const written = [];
  const created = [];
  for (const name of TARGETS) {
    const file = path.join(project, name);
    if (!isFile(file)) {
      const body = name === "AGENTS.md"
        ? `# AGENTS.md\n\n${block}`
        : `# Project instructions\n\nSee AGENTS.md for the full project instructions. The MAW cross-host advising block lives below.\n\n${block}`;
      writeCreated(file, body);
      created.push(file);
      written.push(file);
      continue;
    }
    const content = readText(file);
    const begin = content.indexOf(BLOCK_BEGIN);
    const end = content.indexOf(BLOCK_END);
    if (begin !== -1 && end !== -1 && end > begin) {
      const next = content.slice(0, begin) + block.replace(/\n$/, "") + content.slice(end + BLOCK_END.length);
      if (next !== content) writeText(file, next);
      written.push(file);
      continue;
    }
    if (begin !== -1 || end !== -1) {
      // corrupt: exactly one marker — strip the dangling marker line, append a
      // fresh block at the end (repair, never destructive to user content)
      process.stderr.write(`mawf injectblock: corrupt marker span in ${file} — repairing\n`);
      const cleaned = content
        .split("\n")
        .filter((l) => l.trim() !== BLOCK_BEGIN && l.trim() !== BLOCK_END)
        .join("\n");
      const sep = cleaned.endsWith("\n") || cleaned === "" ? "" : "\n";
      writeText(file, `${cleaned}${sep}${cleaned.trim() === "" ? "" : "\n"}${block}`);
      written.push(file);
      continue;
    }
    const { index } = insertIndex(content);
    const lines = content.split("\n");
    const before = lines.slice(0, index).join("\n");
    const after = lines.slice(index).join("\n");
    const glue = before.trim() === "" ? "" : "\n";
    writeText(file, `${before}${glue}${block.replace(/\n$/, "")}${after.startsWith("\n") || after.trim() === "" ? after : `\n${after}`}`);
    written.push(file);
  }
  recordCreated(project, created);
  return { written, created };
}

/**
 * Merge newly created files into .mawf/managed-blocks.json (project-scope
 * record; never the installer manifest — files[] must stay whole-file).
 * @param {string} project
 * @param {string[]} created absolute paths
 */
function recordCreated(project, created) {
  if (!created.length) return;
  const recPath = path.join(project, RECORD_FILE);
  const prev = readJson(recPath, { created: [] });
  const merged = [...new Set([...(Array.isArray(prev.created) ? prev.created : []), ...created])];
  ensureDir(path.dirname(recPath));
  writeJson(recPath, { created: merged });
}

/**
 * Strip the managed block from project AGENTS.md + CLAUDE.md. Files mawf
 * created (per record) whose remainder is only our created-header are deleted.
 * The record file itself is removed.
 * @param {string} projectDir
 * @returns {{ removed: string[], emptied: string[] }} removed = span stripped; emptied = file deleted
 */
export function removeManagedBlocks(projectDir) {
  const project = path.resolve(projectDir);
  const recPath = path.join(project, RECORD_FILE);
  const record = readJson(recPath, { created: [] });
  const createdSet = new Set(Array.isArray(record.created) ? record.created : []);
  const removed = [];
  const emptied = [];
  for (const name of TARGETS) {
    const file = path.join(project, name);
    if (!isFile(file)) continue;
    const content = readText(file);
    const begin = content.indexOf(BLOCK_BEGIN);
    const end = content.indexOf(BLOCK_END);
    if (begin === -1 || end === -1 || end < begin) continue;
    let next = content.slice(0, begin) + content.slice(end + BLOCK_END.length);
    next = next.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
    const remainder = next.trim();
    if (createdSet.has(file) && (remainder === "" || isCreatedHeaderRemnant(name, remainder))) {
      fs.unlinkSync(file);
      emptied.push(file);
    } else if (next !== content) {
      writeText(file, next);
      removed.push(file);
    } else {
      removed.push(file);
    }
  }
  if (isFile(recPath)) fs.unlinkSync(recPath);
  return { removed, emptied };
}

/**
 * Does the remainder match exactly what our create-if-absent wrote minus the
 * block (i.e. only the stub header we authored)? Then deleting is safe.
 * @param {string} name
 * @param {string} remainder trimmed content after span removal
 */
function isCreatedHeaderRemnant(name, remainder) {
  if (name === "AGENTS.md") return remainder === "# AGENTS.md";
  return remainder === "# Project instructions\n\nSee AGENTS.md for the full project instructions. The MAW cross-host advising block lives below.";
}
