// @ts-check
// Knowledge document schema — write-notes-compatible Decision format plus the
// MAWF Solution kind, with sidecar metadata (contract §5).
//
// Facts source: research/baseline-write-notes.md (upstream 2aef219):
// - Path-as-identity: {lifecycle}/{class}/yyyy-mm-dd-topic.md under the notes
//   root; lifecycle ∈ {proposed, implemented, rejected, archived}; closed set
//   of 6 classes; filename date = first-proposal date, never rewritten.
// - Header contract: L1 "# Agent Note: <title>", L2 blank, L3 "Status: ...",
//   L4 blank; archived files insert "Archived: YYYY-MM-DD" immediately below
//   the Status line. No YAML frontmatter in the upstream format.
// - Upstream metadata is path + header only. Long-lived facts that must NOT be
//   forced into old documents (stable id, source task, verification, freshness)
//   live in a JSON sidecar next to the document: "<name>.mawf.json".
//
// This module is pure (no fs, no I/O). Storage lives in store.js.

import { parseYamlSubset } from "../util.js";

/** Lifecycle directories (write-notes closed set; archived = frozen). */
export const LIFECYCLES = Object.freeze([
  "proposed", "implemented", "rejected", "archived",
]);

/** The six upstream classes, closed set (extending requires schema bump). */
export const DECISION_CLASSES = Object.freeze([
  "feature", "bug-fix", "simplification", "architecture", "process", "testing",
]);

/** Solution categories — open-ended but normalized to slug form. */
export const SOLUTION_CATEGORIES = Object.freeze([
  "build", "runtime", "host-integration", "tooling", "data", "network", "platform", "testing", "general",
]);

/** Solution status: candidates lack verified evidence (contract §5.3). */
export const SOLUTION_STATUSES = Object.freeze([
  "candidate", // captured, evidence incomplete — must not be presented as verified
  "verified", // working fix + evidence recorded
  "superseded", // replaced by another solution (see relations)
]);

export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** CE-compatible solution classification enums (research/baseline-ce-compound.md §schema.yaml). */
export const PROBLEM_TYPES = Object.freeze([
  // bug track
  "build_error", "test_failure", "runtime_error", "performance_issue", "database_issue",
  "security_issue", "ui_bug", "integration_issue", "logic_error",
  // knowledge track
  "best_practice", "documentation_gap", "workflow_issue", "developer_experience",
  "architecture_pattern", "design_pattern", "tooling_decision", "convention",
]);
export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
export const RESOLUTION_TYPES = Object.freeze([
  "code_fix", "migration", "config_change", "test_fix", "dependency_update",
  "environment_setup", "workflow_improvement", "documentation_update", "tooling_addition", "seed_data_update",
]);

/** Section heading aliases accepted per kind/lifecycle (upstream zh aliases kept). */
const SECTION_ALIASES = {
  problem: ["Problem", "问题"],
  proposal: ["Proposal", "提议", "方案", "提案"],
  acceptance: ["Acceptance criteria", "验收标准", "验收条件", "接受标准"],
  risks: ["Risks", "风险"],
  decision: ["Decision", "决定", "决策"],
  consequences: ["Consequences", "后果", "影响", "结果"],
  alternatives: ["Alternatives considered", "替代方案", "备选方案", "曾考虑的替代方案", "曾考虑的备选"],
  // solution-only sections
  symptom: ["Symptom", "症状"],
  rootCause: ["Root cause", "根因"],
  failedAttempts: ["Failed attempts", "失败尝试"],
  fix: ["Fix", "工作解法", "解法"],
  whyItWorks: ["Why it works", "为何有效"],
  prevention: ["Prevention", "预防"],
  scope: ["Scope", "适用范围"],
  evidence: ["Evidence", "证据"],
};

/** Required sections per document kind + lifecycle. */
const REQUIRED_SECTIONS = {
  decision: {
    proposed: ["problem", "proposal", "acceptance", "risks", "alternatives"],
    implemented: ["problem", "decision", "consequences", "alternatives"],
    rejected: ["problem", "proposal", "alternatives"],
    archived: ["problem", "decision", "consequences", "alternatives"],
  },
  solution: {
    candidate: ["problem", "symptom", "fix", "alternatives"],
    verified: ["problem", "symptom", "rootCause", "failedAttempts", "fix", "whyItWorks", "prevention", "scope", "evidence"],
    superseded: ["problem", "symptom", "rootCause", "fix", "scope", "evidence"],
  },
};

/** Banned headings for implemented decisions (upstream rule). */
const IMPLEMENTED_BANNED = [
  "Proposal", "提议", "方案", "提案",
  "Plan", "Migration plan", "Acceptance criteria", "验收标准", "验收条件", "接受标准",
];

const KIND_HEADER = { decision: "Agent Note", solution: "Solution" };

/**
 * Parse a knowledge markdown document (pure).
 * Returns { ok, doc|errors } — never throws on malformed input.
 * @param {string} text raw file content
 * @param {{kind: "decision"|"solution", relPath: string}} meta kind + path
 *        relative to the knowledge root, e.g. "implemented/architecture/2026-09-01-ipc.md"
 */
export function parseKnowledgeDoc(text, meta) {
  const errors = [];
  const kind = meta?.kind;
  if (kind !== "decision" && kind !== "solution") {
    return { ok: false, errors: [{ code: "kind", message: "kind must be decision|solution" }] };
  }
  const norm = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  // --- optional YAML frontmatter (solutions, CE-compatible; ID-1) ---------
  let frontmatter = null;
  let bodyText = norm;
  const fmMatch = norm.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    try {
      frontmatter = parseYamlSubset(fmMatch[1]);
    } catch (e) {
      errors.push({ code: "frontmatter", message: `unparseable frontmatter: ${e.message}` });
      frontmatter = {};
    }
    bodyText = norm.slice(fmMatch[0].length);
    if (kind === "solution") {
      const fmErr = validateSolutionFrontmatter(frontmatter);
      errors.push(...fmErr);
    }
  } else if (kind === "solution" && meta.relPath && !/^rejected\//.test(meta.relPath)) {
    // solutions are expected to carry CE-compatible frontmatter (recommended,
    // hard-required only for verified status via enum check below)
  }

  let lines = bodyText.split("\n");
  if (frontmatter) {
    // a blank separator line after the closing --- is conventional; the title
    // is the first non-empty line in frontmatter-bearing documents
    while (lines.length && lines[0].trim() === "") lines = lines.slice(1);
  }
  const header = KIND_HEADER[kind];

  // --- path grammar -------------------------------------------------------
  const pathInfo = parseKnowledgeRelPath(meta.relPath, kind);
  if (!pathInfo.ok) errors.push(...pathInfo.errors);

  // --- header lines -------------------------------------------------------
  const l1 = lines[0] ?? "";
  const titleMatch = l1.match(new RegExp(`^# ${header}[:：] ?(\\S.*)$`));
  if (!titleMatch) {
    errors.push({ code: "header", message: `L1 must be "# ${header}: <title>"` });
  }
  const title = titleMatch ? titleMatch[1].trim() : "";

  const statusLineIdx = findStatusLine(lines);
  if (statusLineIdx < 0) {
    errors.push({ code: "status", message: "exactly one strict Status line required" });
  }
  const status = statusLineIdx >= 0 ? parseStatusLine(lines[statusLineIdx]) : null;
  if (statusLineIdx >= 0 && !status) {
    errors.push({ code: "status", message: `malformed status line: ${lines[statusLineIdx]}` });
  }

  let archivedAt = null;
  if (pathInfo.ok && pathInfo.lifecycle === "archived") {
    // Archived layout: Status line, then Archived: line immediately below.
    const archLine = lines[statusLineIdx + 1] ?? "";
    const m = archLine.match(/^Archived: (\d{4}-\d{2}-\d{2})$/);
    if (!m) {
      errors.push({ code: "archived-line", message: "archived docs need 'Archived: YYYY-MM-DD' immediately below Status" });
    } else {
      archivedAt = m[1];
    }
    if (status && status.lifecycle !== "implemented") {
      // Upstream rule: archived files keep "Status: implemented"; the archived
      // state lives in the folder + Archived: line, not in the Status value.
      errors.push({ code: "status-folder", message: "archived folder requires 'Status: implemented'" });
    }
  }
  if (status && pathInfo.ok && pathInfo.lifecycle && status.lifecycle !== pathInfo.lifecycle && !(pathInfo.lifecycle === "archived" && status.lifecycle === "implemented")) {
    errors.push({ code: "status-folder", message: `status '${status.lifecycle}' does not match folder '${pathInfo.lifecycle}'` });
  }

  // --- body sections ------------------------------------------------------
  const body = lines.slice(firstBodyLine(lines)).join("\n");
  const sections = extractSections(body);
  const lifecycle = pathInfo.ok ? pathInfo.lifecycle : status?.lifecycle ?? null;
  if (lifecycle) {
    const req = REQUIRED_SECTIONS[kind][lifecycle] ?? [];
    for (const sec of req) {
      if (sections[sec] === undefined) {
        errors.push({ code: "section", message: `missing required section: ${sec} (${SECTION_ALIASES[sec][0]})` });
      }
    }
    if (kind === "decision" && lifecycle === "implemented") {
      for (const banned of IMPLEMENTED_BANNED) {
        if (sections._headings.some((h) => h.name === banned)) {
          errors.push({ code: "banned-heading", message: `implemented decisions must not keep heading "${banned}"` });
        }
      }
    }
  }

  const doc = {
    kind,
    title,
    status: status ?? null,
    archivedAt,
    lifecycle,
    frontmatter,
    ...pathInfo.ok
      ? { lifecycle: pathInfo.lifecycle, cls: pathInfo.cls ?? null, category: pathInfo.category ?? null, date: pathInfo.date, slug: pathInfo.slug }
      : {},
    sections,
    outLinks: extractRelLinks(body),
    sectionHeadings: sections._headings.map((h) => h.name),
  };
  return errors.length ? { ok: false, errors, doc } : { ok: true, doc };
}

/**
 * Parse relative path under a knowledge root.
 * decision: {lifecycle}/{class}/yyyy-mm-dd-topic.md (archived keeps class dir)
 * solution: solutions/<category>/yyyy-mm-dd-topic.md
 */
export function parseKnowledgeRelPath(relPath, kind) {
  const errors = [];
  const parts = relPath.split("/");
  if (kind === "decision") {
    if (parts.length !== 3) {
      return { ok: false, errors: [{ code: "path", message: `decision path must be {lifecycle}/{class}/file.md, got: ${relPath}` }] };
    }
    const [lifecycle, cls, file] = parts;
    if (!LIFECYCLES.includes(lifecycle)) errors.push({ code: "path", message: `unknown lifecycle dir: ${lifecycle}` });
    if (!DECISION_CLASSES.includes(cls)) errors.push({ code: "path", message: `unknown class dir: ${cls} (closed set of 6)` });
    const fm = file.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/);
    if (!fm) errors.push({ code: "path", message: `filename must be yyyy-mm-dd-topic.md: ${file}` });
    if (errors.length) return { ok: false, errors };
    return { ok: true, lifecycle, cls, date: fm[1], slug: fm[2], errors: [] };
  }
  // solution: allow "solutions/<cat>/file.md" or bare "<cat>/file.md" depending on root layout
  const p = parts[0] === "solutions" ? parts.slice(1) : parts;
  if (p.length !== 2) {
    return { ok: false, errors: [{ code: "path", message: `solution path must be solutions/{category}/file.md, got: ${relPath}` }] };
  }
  const [category, file] = p;
  const fm = file.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/);
  if (!fm) errors.push({ code: "path", message: `filename must be yyyy-mm-dd-topic.md: ${file}` });
  if (!SOLUTION_CATEGORIES.includes(category)) {
    errors.push({ code: "path", message: `unknown solution category: ${category}` });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, lifecycle: null, category, date: fm[1], slug: fm[2], errors: [] };
}

/**
 * Stable document ID (contract §5.4): explicit sidecar IDs win; the fallback
 * is a deterministic content-independent hash of kind + original slug/date so
 * it survives directory moves within the same store (mapping table handles
 * renames; see store.js id-registry).
 */
export function deriveFallbackId(kind, date, slug) {
  return `${kind.slice(0, 3)}-${date}-${slug}`;
}

/** Validate CE-compatible solution frontmatter fields (subset of schema.yaml). */
function validateSolutionFrontmatter(fm) {
  /** @type {{code: string, message: string}[]} */
  const errs = [];
  if (typeof fm !== "object" || fm === null) {
    return [{ code: "frontmatter", message: "frontmatter must be a mapping" }];
  }
  for (const req of ["module", "date", "problem_type", "component", "severity"]) {
    if (fm[req] === undefined || fm[req] === null || fm[req] === "") {
      errs.push({ code: "frontmatter", message: `solution frontmatter missing required field: ${req}` });
    }
  }
  if (fm.problem_type !== undefined && !PROBLEM_TYPES.includes(fm.problem_type)) {
    errs.push({ code: "frontmatter", message: `unknown problem_type: ${fm.problem_type}` });
  }
  if (fm.severity !== undefined && !SEVERITIES.includes(fm.severity)) {
    errs.push({ code: "frontmatter", message: `unknown severity: ${fm.severity}` });
  }
  if (fm.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm.date))) {
    errs.push({ code: "frontmatter", message: `frontmatter date must be YYYY-MM-DD: ${fm.date}` });
  }
  for (const arrField of ["symptoms", "tags", "applies_when"]) {
    if (fm[arrField] !== undefined && !Array.isArray(fm[arrField])) {
      errs.push({ code: "frontmatter", message: `${arrField} must be a list` });
    }
  }
  if (Array.isArray(fm.tags) && fm.tags.length > 8) {
    errs.push({ code: "frontmatter", message: "tags limited to 8 items" });
  }
  return errs;
}

/** Strict status line finder: ignores fenced code, HTML comments, quotes. */
function findStatusLine(lines) {
  let inFence = false;
  let inHtmlComment = false;
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) inFence = !inFence;
    if (inFence) continue;
    if (inHtmlComment) { if (t.includes("-->")) inHtmlComment = false; continue; }
    if (t.startsWith("<!--") && !t.includes("-->")) inHtmlComment = true;
    if (/^(>|\s{4})/.test(lines[i])) continue; // blockquote / indented code
    if (/^Status[:：]/.test(t)) {
      if (found >= 0) return -1; // uniqueness (upstream rule)
      found = i;
    }
  }
  return found;
}

/** "Status: implemented" | "Status: rejected — reason" | "Status: candidate" */
function parseStatusLine(line) {
  const m = line.match(/^Status[:：]\s*(\w+)(?:\s*[—–-]+\s*(.+))?$/);
  if (!m) return null;
  const lifecycle = m[1].toLowerCase();
  const valid = LIFECYCLES.includes(lifecycle) || SOLUTION_STATUSES.includes(lifecycle);
  if (!valid) return null;
  if (lifecycle === "rejected" && !m[2]) return null; // reason required (upstream)
  return { status: lifecycle, lifecycle, reason: m[2]?.trim() ?? null };
}

/** Split body into sections keyed by canonical name (first occurrence wins). */
function extractSections(body) {
  /** @type {{name: string, level: number, body: string}[]} */
  const headings = [];
  const lines = body.split("\n");
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) {
      const raw = m[2].replace(/（.*?）$/, "").trim(); // "Decision（...）" suffix
      headings.push({ name: raw, level: m[1].length });
    }
  }
  /** @type {Record<string, string>} */
  const sections = {};
  for (let i = 0; i < headings.length; i++) {
    const canon = canonicalSection(headings[i].name);
    if (!canon) continue;
    if (sections[canon] !== undefined) continue; // first wins
    const start = body.indexOf(headings[i].name);
    const startIdx = body.indexOf("\n", start);
    const endHeading = headings[i + 1];
    const endIdx = endHeading ? body.indexOf(endHeading.name, startIdx) : body.length;
    sections[canon] = body.slice(startIdx + 1, endIdx > startIdx ? endIdx : body.length).trim();
  }
  sections._headings = headings;
  return sections;
}

function canonicalSection(name) {
  for (const [canon, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((a) => name === a)) return canon;
  }
  return null;
}

/** Relative markdown links between notes (must resolve inside the store; validated by store). */
function extractRelLinks(body) {
  /** @type {string[]} */
  const out = [];
  const re = /\[[^\]]*\]\(([^)]+\.md)\)/g;
  let m;
  while ((m = re.exec(body))) {
    const href = m[1];
    if (/^(https?:|#|mailto:)/.test(href)) continue;
    out.push(href);
  }
  return out;
}

/** Body starts after the header block (title/status/archived lines + blanks). */
function firstBodyLine(lines) {
  let i = 1;
  if ((lines[1] ?? "").trim() === "") i = 2;
  if (/^Status[:：]/.test(lines[i] ?? "")) {
    i++;
    if (/^Archived: \d{4}-\d{2}-\d{2}$/.test(lines[i] ?? "")) i++;
  }
  return i;
}
