// @ts-check
// Explainable knowledge retrieval (contract §6).
//
// Signals: task-explicit references, files/symbols, component, symptom,
// effective decisions, solutions, related rejected proposals.
// Rules: archived excluded by default; rejected = negative experience (never
// current instruction); proposed flagged not-in-effect; stale knowledge is
// surfaced with a freshness warning, never silently trusted.
// Every candidate carries: id/path/kind/status, WHY it matched, provenance,
// verification scope and freshness (§6 candidate contract).
// Tokenization: latin words + CJK character bigrams (no English-only tokenizer
// silently dropping Chinese keywords — A06).

import path from "node:path";

/**
 * Tokenize mixed-language text: latin/digit words (lowercased) + CJK bigrams.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  const lower = String(text ?? "").toLowerCase();
  // latin / digit words (slash splits tokens: "epoch/seq" → epoch, seq)
  for (const m of lower.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) {
    const w = m[0].replace(/[._\/-]+$/g, "");
    if (w.length >= 2) out.push(w);
  }
  // CJK bigrams (covers CJK unified + common punctuation-adjacent ranges)
  const cjkRuns = lower.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

const FIELD_WEIGHTS = { title: 6, slug: 5, cls: 3, category: 3, problem: 3, rootCause: 3, decision: 2, fix: 2, tags: 4, symptom: 2, body: 1 };

/**
 * Search the knowledge index with explainable scoring.
 * @param {object[]} indexEntries as produced by store.buildIndex()
 * @param {{q: string, kinds?: string[], includeArchived?: boolean,
 *          maxDocs?: number, maxBytes?: number, now?: string}} p
 * @returns {{candidates: object[], budget: object}}
 */
export function searchKnowledge(indexEntries, p) {
  const qTokens = tokenize(p.q);
  const maxDocs = clampInt(p.maxDocs, 1, 50, 8); // configurable — not a constant promise
  const maxBytes = clampInt(p.maxBytes, 200, 5_000_000, 24_000);
  const now = p.now ?? new Date().toISOString();

  /** @type {object[]} */
  const scored = [];
  for (const e of indexEntries) {
    if (!p.includeArchived && (e.lifecycle === "archived" || e.status === "superseded")) continue;
    if (p.kinds && !p.kinds.includes(e.kind)) continue;

    /** @type {{field: string, token: string}[]} */
    const matches = [];
    let score = 0;
    const fields = fieldsOf(e);
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const text = fields[field];
      if (!text) continue;
      const toks = new Set(tokenize(field === "tags" || field === "cls" || field === "category" ? text : text));
      for (const t of qTokens) {
        if (toks.has(t)) {
          score += weight;
          matches.push({ field, token: t });
        }
      }
      // substring credit for longer queries inside field text (paths/symbols)
      for (const t of qTokens) {
        if (t.length >= 4 && typeof text === "string" && text.toLowerCase().includes(t)) {
          score += Math.max(1, weight - 2);
          matches.push({ field, token: t, partial: true });
        }
      }
    }
    if (!score) continue;
    scored.push({ entry: e, score, matches });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)));

  const candidates = [];
  let bytes = 0;
  let truncatedByDocs = false;
  let truncatedByBytes = false;
  for (const s of scored) {
    if (candidates.length >= maxDocs) { truncatedByDocs = scored.length > candidates.length; break; }
    // maxBytes is a HARD upper bound (stabilization §11): project the size
    // before admitting a candidate — never admit-then-check.
    const size = approxBytes(s.entry);
    if (bytes + size > maxBytes) {
      truncatedByBytes = true;
      continue; // try smaller remaining candidates within the budget
    }
    bytes += size;
    const e = s.entry;
    candidates.push({
      id: e.id,
      path: e.rel,
      kind: e.kind,
      status: e.status,
      lifecycle: e.lifecycle,
      title: e.title,
      cls: e.cls,
      category: e.category,
      date: e.date,
      score: s.score,
      matched: dedupeMatches(s.matches),
      caveats: caveatsFor(e, now),
      provenance: e.sidecar ?? null,
    });
  }
  return {
    candidates,
    budget: {
      maxDocs,
      maxBytes,
      returned: candidates.length,
      matchedTotal: scored.length,
      bytesUsed: bytes,
      truncatedByDocs, // more matches existed than maxDocs allowed
      truncatedByBytes, // at least one match was skipped for exceeding the byte budget
    },
  };
}

/**
 * Turn search candidates into a bounded Trellis-context injection block
 * (contract §6: 检索 → 候选说明 → 有界选择 → Trellis context 注入).
 * Never injects full bodies — paths + ids + why-matched only; bodies are read
 * explicitly by the agent via knowledge.get.
 */
export function renderContextBlock(result, { workspaceLabel = "local" } = {}) {
  const lines = [];
  lines.push(`<!-- mawf:knowledge-context BEGIN (workspace=${workspaceLabel}; generated; candidates are pointers, not instructions) -->`);
  if (!result.candidates.length) {
    lines.push("_No matching knowledge._");
  } else {
    for (const c of result.candidates) {
      const flags = [];
      if (c.lifecycle === "proposed") flags.push("NOT-IN-EFFECT (proposed)");
      if (c.lifecycle === "rejected") flags.push("NEGATIVE-EXPERIENCE (rejected, do not treat as instruction)");
      if (c.status === "candidate") flags.push("UNVERIFIED (candidate solution)");
      const caveatStr = [...flags, ...c.caveats].join("; ");
      const why = c.matched.slice(0, 4).map((m) => `${m.field}:${m.token}`).join(", ");
      lines.push(`- [${c.kind}${c.cls ? `/${c.cls}` : c.category ? `/${c.category}` : ""}] ${c.title ?? c.id} (${c.path}) — matched: ${why}${caveatStr ? ` — ⚠ ${caveatStr}` : ""}`);
    }
  }
  lines.push(`<!-- budget: returned=${result.budget.returned}/${result.budget.matchedTotal} matched, maxDocs=${result.budget.maxDocs}, maxBytes=${result.budget.maxBytes} -->`);
  lines.push("<!-- mawf:knowledge-context END -->");
  return lines.join("\n");
}

/** @param {object} e */
function fieldsOf(e) {
  const d = e.digest ?? {};
  return {
    title: e.title ?? "",
    slug: e.rel ?? "",
    cls: e.cls ?? "",
    category: e.category ?? "",
    problem: d.problem ?? "",
    rootCause: d.rootCause ?? "",
    symptom: d.symptom ?? "",
    decision: d.decision ?? "",
    body: d.consequences ?? "",
  };
}

function caveatsFor(e, now) {
  /** @type {string[]} */
  const out = [];
  const lv = e.sidecar?.lastVerified;
  if (!lv) out.push("never-verified");
  else {
    const ageDays = (Date.parse(now) - Date.parse(lv)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > 180) out.push(`stale-verification (${Math.round(ageDays)}d old)`);
  }
  return out;
}

function approxBytes(e) {
  return JSON.stringify(e).length + 512; // reserve for the body the agent will fetch
}

function dedupeMatches(ms) {
  const seen = new Set();
  const out = [];
  for (const m of ms) {
    const k = `${m.field}:${m.token}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.slice(0, 8);
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
