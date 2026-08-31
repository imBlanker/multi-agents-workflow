// @ts-check
// Project plugin-pool: stage-gated add/keep/remove judgments for project-level
// MCP servers / skills / plugins across supported hosts (task
// 08-31-mawf-pluginpool-stagegate; PRD D1-D4 binding decisions).
//
// Contracts (see .trellis spec maw-pluginpool-contracts):
// - ADVISORY-ONLY: nothing here mutates host config. The only writes are
//   .mawf/runtime/pool-state.json (project-local state).
// - Deterministic: judgePool is pure (ts injected); same inputs → same
//   verdicts (property-tested).
// - Exclusion groups (D4): at most one member per project detected →
//   consolidation verdict, never "keep both".
// - Mid-batch protection (D3): judgments carry stageCtx + the apply-at-
//   -boundaries instruction; cadence is enforced by recording judgments
//   per stage id (≥2 per major stage; doctor WARNs below).
import fs from "node:fs";
import path from "node:path";
import { exists, isFile, readText, readJson, writeJson, ensureDir } from "./util.js";
import { WorkflowGraph } from "./graph.js";

export const POOL_SCHEMA_KNOWN = 1;
const POOL_STATE_FILE = path.join(".mawf", "runtime", "pool-state.json");

export const POOL_DEFAULTS = {
  threshold: 3, // min value score to justify add/keep
  stayBonus: 2, // hysteresis: prior-stage presence/verdict bonus
  removeLookback: 2, // consecutive low-value judgments before remove
};

// Local tokenizer mirroring advise.tokenize (kept local to avoid the
// advise→inventory import cycle; keep the two in sync — a parity test pins it).
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on", "is", "are", "be", "this", "that"]);
export function tokenizeP(text) {
  const out = [];
  const low = String(text || "").toLowerCase();
  for (const w of low.match(/[a-z0-9][a-z0-9_\-+.]{1,}/g) || []) {
    if (!STOPWORDS.has(w)) out.push(w);
  }
  for (const seg of low.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length === 1) out.push(seg);
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return [...new Set(out)];
}

/**
 * Load + guard the pool catalog. Forward-only: newer schemaVersion warns,
 * never throws. Injectable path for tests.
 * @param {string} [catalogPath]
 * @returns {{ schemaVersion: number, components: any[], warning?: string }}
 */
export function loadCatalog(catalogPath) {
  const file = catalogPath || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "defaults", "pool-catalog.json");
  const raw = readJson(file, null);
  if (!raw || !Array.isArray(raw.components)) return { schemaVersion: POOL_SCHEMA_KNOWN, components: [], warning: "pool catalog missing or unreadable" };
  const warning = raw.schemaVersion > POOL_SCHEMA_KNOWN ? `pool catalog schema v${raw.schemaVersion} > known v${POOL_SCHEMA_KNOWN} — best-effort` : undefined;
  return { schemaVersion: raw.schemaVersion, components: raw.components, warning };
}

/**
 * Catalog completeness check (R5 hard gate; also a doctor ERROR source).
 * @param {any} catalog
 * @returns {string[]} problems (empty = valid)
 */
export function catalogProblems(catalog) {
  const out = [];
  for (const c of catalog.components || []) {
    if (!c.id) out.push("component without id");
    if (!c.install?.footprint?.length) out.push(`${c.id}: install.footprint empty`);
    if (!c.removal?.residueChecklist?.length) out.push(`${c.id}: removal.residueChecklist empty`);
    if (c.footprintVerified !== true && c.footprintVerified !== false) out.push(`${c.id}: footprintVerified missing`);
    if (c.footprintVerified === true && (!c.install?.procedure || !c.removal?.procedure)) out.push(`${c.id}: verified entry lacks procedures`);
  }
  return out;
}

/**
 * Detect pool components against an inventory report (read-only; evidence =
 * the matching entry). detectOnly hosts get found/not-found + caveat, never
 * install/removal procedures.
 * @param {{ hosts: any[] }} report inventory report (hosts[].{app,skills,plugins,mcps})
 * @param {any} catalog
 * @returns {{ components: any[] }}
 */
export function detectPool(report, catalog) {
  const hosts = (report && Array.isArray(report.hosts) ? report.hosts : []).filter((h) => !h.error);
  const byApp = new Map(hosts.map((h) => [h.app, h]));
  const components = [];
  for (const c of catalog.components || []) {
    const detected = {};
    for (const host of ["claude-code", "codex", "pi", "dsh"]) {
      const rule = c.detect?.[host];
      if (!rule) continue;
      const h = byApp.get(host);
      let evidence = null;
      if (h) {
        if (rule.mcpName) {
          const m = (h.mcps || []).find((x) => x.name === rule.mcpName || String(x.name).startsWith(rule.mcpName + "@"));
          if (m) evidence = `mcp:${m.name} (${m.source})`;
        }
        if (!evidence && rule.skillName) {
          const s = (h.skills || []).find((x) => x.name === rule.skillName);
          if (s) evidence = `skill:${s.name} (${s.origin || "?"})`;
        }
        if (!evidence && rule.pluginName) {
          const p = (h.plugins || []).find((x) => x.id === rule.pluginName || x.name === rule.pluginName);
          if (p) evidence = `plugin:${p.id || p.name}`;
        }
      }
      detected[host] = {
        found: !!evidence,
        evidence,
        detectOnly: (c.detectOnly || []).includes(host),
      };
    }
    components.push({ ...c, detected });
  }
  return { components };
}

/**
 * Derive stages from .mawf/graph.json (gate/review batches split stages) with
 * a workflow.json reviewPoints fallback. Null when no plan artifacts.
 * @param {string} projectDir
 * @returns {{ stages: { id: string, label?: string, nodeCount: number }[] } | null}
 */
export function deriveStages(projectDir) {
  const graphFile = path.join(projectDir, ".mawf", "graph.json");
  if (isFile(graphFile)) {
    const raw = readJson(graphFile, null);
    const g = raw?.graph || raw;
    if (g && Array.isArray(g.nodes) && g.nodes.length) {
      const wf = new WorkflowGraph({ id: g.id, name: g.name, nodes: g.nodes, edges: g.edges || [] });
      const batches = wf.topoBatches();
      const stages = [];
      let cur = { id: `stage-${stages.length + 1}`, label: undefined, nodeCount: 0 };
      for (const b of batches.batches || []) {
        const gate = b.find((n) => n.kind === "review" || n.kind === "gate");
        if (gate) {
          cur.label = gate.description || gate.id;
          cur.nodeCount += 1;
          stages.push(cur);
          cur = { id: `stage-${stages.length + 1}`, label: undefined, nodeCount: 0 };
        } else {
          cur.nodeCount += b.length;
        }
      }
      if (cur.nodeCount > 0) stages.push(cur);
      if (stages.length) return { stages };
    }
  }
  const wfFile = path.join(projectDir, ".mawf", "workflow.json");
  const wf = readJson(wfFile, null);
  const rps = wf?.reviewPoints;
  if (Array.isArray(rps) && rps.length) {
    // fallback: one stage per review point + trailing stage
    const stages = rps.map((rp, i) => ({ id: `stage-${i + 1}`, label: rp.label || `${rp.by || "review"}: ${rp.scope || ""}`, nodeCount: 0 }));
    stages.push({ id: `stage-${rps.length + 1}`, label: "post-review closeout", nodeCount: 0 });
    return { stages };
  }
  return null;
}

/**
 * Pure judgment (R3). ts is injected; no clock/fs access.
 * @param {object} o
 * @param {any} o.catalog
 * @param {{ components: any[] }} o.pool detectPool output
 * @param {{ text: string, domain?: string }} o.profile
 * @param {{ id: string, label?: string } | null} o.stageCtx current stage (null = cadence-free)
 * @param {any} o.poolState prior state ({ stages: {} } shape)
 * @param {any} [o.cfg] overrides {threshold, stayBonus, removeLookback}
 * @returns {{ stageCtx: any, verdicts: any[], footerNote?: string }}
 */
export function judgePool(o) {
  const cfg = { ...POOL_DEFAULTS, ...(o.cfg || {}) };
  const tokens = tokenizeP(`${o.profile.text || ""} ${o.profile.domain || ""}`);
  const priorStages = Object.keys(o.poolState?.stages || {});
  const longLived = priorStages.length > 0;
  // value per component
  const value = new Map();
  const reasonsMap = new Map();
  for (const c of o.pool.components) {
    let v = 0;
    const reasons = [];
    for (const sig of c.valueSignals?.any || []) {
      const st = sig.toLowerCase();
      if (tokens.includes(st)) { v += 3; reasons.push(`signal "${sig}" (exact)`); }
      else if (tokens.some((t) => t.includes(st) || st.includes(t))) { v += 2; reasons.push(`signal "${sig}" (partial)`); }
    }
    for (const trait of c.valueSignals?.projectTraits || []) {
      if (trait === "long-lived" && longLived) { v += 2; reasons.push("trait long-lived (prior stages exist)"); }
      if (trait === "large-codebase" && (o.poolState?.projectTraits?.largeCodebase === true)) { v += 2; reasons.push("trait large-codebase"); }
    }
    const lastVerdict = lastVerdictFor(o.poolState, c.id);
    // stayBonus encodes INCUMBENCY: only add/keep priors count. A noop prior
    // (alternate of the exclusion-group winner) must NOT get the bonus —
    // otherwise the alternate can tie and flip the winner on a later task
    // (found in parent-acceptance smoke 2026-08-31, fixed with regression test).
    if ((lastVerdict === "add" || lastVerdict === "keep") && v > 0) { v += cfg.stayBonus; reasons.push(`stayBonus +${cfg.stayBonus} (prior: ${lastVerdict})`); }
    value.set(c.id, v);
    reasonsMap.set(c.id, reasons);
  }
  // exclusion groups (D4): candidates = DETECTED members OR absent members
  // whose value clears the threshold (would-be adds). D4 forbids recommending
  // both adds just as it forbids keeping both present.
  const byGroup = new Map();
  for (const c of o.pool.components) {
    if (!c.exclusionGroup) continue;
    const present = Object.entries(c.detected || {}).filter(([, d]) => d.found);
    const wouldAdd = present.length === 0 && (value.get(c.id) || 0) >= cfg.threshold;
    if (present.length || wouldAdd) {
      if (!byGroup.has(c.exclusionGroup)) byGroup.set(c.exclusionGroup, []);
      byGroup.get(c.exclusionGroup).push({ c, spread: present.length, detected: present.length > 0 });
    }
  }
  const losers = new Set();
  const alternates = new Map();
  const swaps = [];
  for (const [group, members] of byGroup) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => (Number(b.detected) - Number(a.detected)) || (value.get(b.c.id) || 0) - (value.get(a.c.id) || 0) || b.spread - a.spread || (a.c.id < b.c.id ? -1 : 1));
    const winner = sorted[0].c;
    for (const m of sorted.slice(1)) {
      losers.add(m.c.id);
      swaps.push({ loser: m.c.id, winner: winner.id, group });
    }
  }
  // verdicts
  const verdicts = [];
  for (const c of o.pool.components) {
    const hostsFound = Object.entries(c.detected || {}).filter(([, d]) => d.found).map(([h]) => h);
    const v = value.get(c.id) || 0;
    if (losers.has(c.id) && hostsFound.length) {
      const sw = swaps.find((s) => s.loser === c.id);
      verdicts.push({
        component: c.id, verdict: "remove", value: v, hosts: hostsFound,
        reasons: [`exclusion group ${sw.group}: consolidate on ${sw.winner} (higher value/spread)`, ...reasonsMap.get(c.id)],
        procedure: c.removal?.procedure || null,
        residueChecklist: c.removal?.residueChecklist || [],
        gaps: c.removal?.gaps || "",
      });
      continue;
    }
    if (losers.has(c.id)) {
      // absent loser of an exclusion group: the winner is the recommended
      // alternate — never recommend adding both (D4)
      const sw = swaps.find((s) => s.loser === c.id);
      verdicts.push({
        component: c.id, verdict: "noop", value: v, hosts: [],
        reasons: [`alternate of ${sw.winner} in exclusion group ${sw.group} — at most one graph indexer per project`, ...reasonsMap.get(c.id)],
        procedure: null,
      });
      continue;
    }
    if (hostsFound.length) {
      const lowFor = lowRunLength(o.poolState, c.id);
      const low = v < cfg.threshold;
      if (low && lowFor >= cfg.removeLookback - 1) {
        verdicts.push({
          component: c.id, verdict: "remove", value: v, hosts: hostsFound, low: true,
          reasons: [`value ${v} < threshold ${cfg.threshold} for ${lowFor + 1} consecutive judgments`, ...reasonsMap.get(c.id)],
          procedure: c.removal?.procedure || null,
          residueChecklist: c.removal?.residueChecklist || [],
          gaps: c.removal?.gaps || "",
        });
      } else {
        verdicts.push({
          component: c.id, verdict: "keep", value: v, hosts: hostsFound, low,
          reasons: [`present on ${hostsFound.join(", ")}`, ...(low ? [`value ${v} < threshold ${cfg.threshold} — first consecutive low; remove fires on the next`] : []), ...reasonsMap.get(c.id)],
          procedure: null,
        });
      }
    } else if (v >= cfg.threshold) {
      verdicts.push({
        component: c.id, verdict: "add", value: v, hosts: [],
        reasons: reasonsMap.get(c.id),
        procedure: c.install?.procedure || null,
        noClobber: c.install?.noClobber || "",
      });
    } else {
      verdicts.push({ component: c.id, verdict: "noop", value: v, hosts: [], reasons: [`value ${v} < threshold ${cfg.threshold}`], procedure: null });
    }
  }
  const footerNote = o.stageCtx ? null : "no plan/graph found — cadence-free judgment (not counted toward any stage)";
  return { stageCtx: o.stageCtx, verdicts, footerNote };
}

function lastVerdictFor(poolState, id) {
  const stages = poolState?.stages || {};
  const ids = Object.keys(stages).sort();
  for (let i = ids.length - 1; i >= 0; i--) {
    const js = stages[ids[i]]?.judgments || [];
    for (let j = js.length - 1; j >= 0; j--) {
      const e = js[j].verdicts?.[id];
      const v = e && typeof e === "object" ? e.verdict : e;
      if (v) return v;
    }
  }
  return null;
}

// Trailing run of prior judgments that recorded this component as LOW value
// (verdict remove, or keep with low:true). Legacy string "remove" counts.
function lowRunLength(poolState, id) {
  const stages = poolState?.stages || {};
  const ids = Object.keys(stages).sort();
  let run = 0;
  outer: for (let i = ids.length - 1; i >= 0; i--) {
    const js = stages[ids[i]]?.judgments || [];
    for (let j = js.length - 1; j >= 0; j--) {
      const e = js[j].verdicts?.[id];
      const v = e && typeof e === "object" ? e.verdict : e;
      const low = e && typeof e === "object" ? e.low === true : e === "remove";
      if (v && (v === "remove" || (v === "keep" && low))) { run++; continue; }
      if (v) break outer;
    }
  }
  return run;
}

/**
 * Render a judgment (renderAdvise parity). Ends with the POOL-DONE footer.
 * @param {any} j judgePool result
 * @param {{ judgments: number, needed: number }} [cadence]
 */
export function renderPool(j, cadence) {
  const lines = [];
  lines.push(`MAW plugin-pool judgment — stage: ${j.stageCtx ? `${j.stageCtx.id}${j.stageCtx.label ? ` (${j.stageCtx.label})` : ""}` : "(none)"}`);
  if (j.footerNote) lines.push(`note: ${j.footerNote}`);
  lines.push("apply ONLY at stage boundaries / review gates — never mid-batch. You present, the human executes; installs must not clobber, removals must verify no residue.");
  lines.push("");
  for (const v of j.verdicts) {
    if (v.verdict === "noop") continue;
    lines.push(`  ${v.component}: ${v.verdict.toUpperCase()} (value ${v.value}${v.hosts.length ? ` · on ${v.hosts.join(", ")}` : ""})`);
    for (const r of v.reasons.slice(0, 4)) lines.push(`    - ${r}`);
    if (v.procedure) {
      lines.push(`    procedure (human runs; check-then-act):`);
      for (const l of String(v.procedure).split("\n")) lines.push(`      ${l}`);
    }
    if (v.residueChecklist?.length) {
      lines.push(`    verify no residue:`);
      for (const rc of v.residueChecklist) lines.push(`      ${rc.verifyCmd}   # ${rc.artifact}`);
    }
    if (v.gaps) lines.push(`    gap: ${v.gaps}`);
  }
  lines.push("");
  if (cadence) lines.push(`stage cadence: ${cadence.judgments}/${cadence.needed} judgments recorded for this stage${cadence.judgments < cadence.needed ? " — run again at the gate" : ""}`);
  lines.push(`POOL-DONE stage=${j.stageCtx ? j.stageCtx.id : "-"} verdicts=${j.verdicts.map((v) => `${v.component}:${v.verdict}`).join(",")}`);
  return lines.join("\n");
}

/**
 * Read pool state (missing/corrupt → empty, never throws; corrupt flagged).
 * @param {string} projectDir
 */
export function readPoolState(projectDir) {
  const file = path.join(projectDir, POOL_STATE_FILE);
  const raw = readJson(file, null);
  if (raw === null) {
    if (isFile(file)) return { stages: {}, corrupt: true };
    return { stages: {} };
  }
  return raw.stages ? raw : { ...raw, stages: {} };
}

/**
 * Record a judgment into pool state (the ONLY write pool performs).
 * @param {string} projectDir
 * @param {{ id: string, label?: string } | null} stageCtx
 * @param {Record<string, string>} verdicts {componentId: verdict}
 * @param {string} isoTs injected clock (determinism)
 */
export function recordJudgment(projectDir, stageCtx, verdicts, isoTs) {
  if (!stageCtx) return readPoolState(projectDir); // cadence-free: not recorded
  const state = readPoolState(projectDir);
  state.stages = state.stages || {};
  const st = state.stages[stageCtx.id] || { label: stageCtx.label, judgments: [] };
  st.judgments.push({ ts: isoTs, verdicts });
  state.stages[stageCtx.id] = st;
  ensureDir(path.join(projectDir, ".mawf", "runtime"));
  writeJson(path.join(projectDir, POOL_STATE_FILE), state);
  return state;
}

/**
 * Cadence issues for doctor: stages with fewer than 2 judgments.
 * @param {any} poolState
 * @returns {string[]}
 */
export function poolCadenceIssues(poolState) {
  const out = [];
  for (const [id, st] of Object.entries(poolState?.stages || {})) {
    const n = (/** @type {any} */ (st).judgments || []).length;
    if (n < 2) out.push(`${id}: ${n}/2 pool judgments`);
  }
  return out;
}
