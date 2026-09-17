// @ts-check
// `mawf knowledge` — CLI surface for the durable knowledge store (P2).
// Subcommands: status | list | search | context | verify | reindex
// Contract: contract §5 (store), §6 (retrieval/budget). JSON output via --json.

import fs from "node:fs";
import path from "node:path";
import { KnowledgeStore, PROBLEM_TYPES, SEVERITIES } from "./store.js";
import { searchKnowledge, renderContextBlock } from "./search.js";

/**
 * CLI boundary for store errors: structured, actionable, non-crashing exits.
 * CAS conflicts get the current hash so the caller can rebase their edit.
 */
function wrapStoreErrors(fn) {
  try {
    return fn();
  } catch (e) {
    if (e.code === "KNOWLEDGE_CAS_CONFLICT") {
      console.error(`knowledge store: conflict — content changed since read. Current hash: ${e.currentHash}`);
      console.error(`Re-read with 'mawf knowledge get', rebase your edit, retry with --expected-hash ${e.currentHash}`);
      return 4;
    }
    if (e.code === "KNOWLEDGE_LOCK_BUSY") {
      console.error(`knowledge store: ${e.message}`);
      return 5;
    }
    if (e.code === "KNOWLEDGE_ARCHIVED_IMMUTABLE") {
      console.error(`knowledge store: ${e.message}`);
      return 6;
    }
    console.error(`knowledge store: ${e.message}`);
    return 1;
  }
}

/**
 * Entry used from index.js: `knowledge <sub> [args]`.
 * @param {string[]} f positional args after the subcommand name is stripped by caller? No:
 *        f = all args after "knowledge" (e.g. ["search", "query", ...])
 * @param {object} flags parsed flags (--project, --json, ...)
 * @returns {number} exit code
 */
export function runKnowledge(f, flags) {
  const [sub, ...rest] = f;
  const project = flags.project ? path.resolve(flags.project) : process.cwd();
  const asJson = flags.json === true;
  const store = KnowledgeStore.open(project);

  switch (sub) {
    case "status": {
      const idx = store.index();
      const counts = {};
      for (const e of idx.entries) {
        const k = `${e.kind}:${e.lifecycle ?? e.status ?? "?"}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      const invalid = idx.entries.filter((e) => !e.valid);
      if (asJson) {
        console.log(JSON.stringify({
          project,
          layout: {
            decisions: store.layout.decisions,
            solutions: store.layout.solutions,
            runtime: store.layout.runtime,
            legacy: store.layout.legacy,
          },
          total: idx.entries.length,
          counts,
          invalid: invalid.map((e) => ({ rel: e.rel, errors: e.errors })),
        }, null, 2));
      } else {
        console.log(`knowledge store @ ${project}`);
        console.log(`  decisions: ${store.layout.decisions} (${store.layout.legacy.decisions})`);
        console.log(`  solutions: ${store.layout.solutions} (${store.layout.legacy.solutions})`);
        console.log(`  runtime:   ${store.layout.runtime} (rebuildable cache)`);
        console.log(`  documents: ${idx.entries.length}`);
        for (const [k, n] of Object.entries(counts).sort()) console.log(`    ${k}: ${n}`);
        if (invalid.length) {
          console.log(`  ⚠ invalid documents: ${invalid.length}`);
          for (const e of invalid) console.log(`    - ${e.rel}: ${e.errors.join("; ")}`);
        }
      }
      return invalid.length ? 1 : 0;
    }

    case "list": {
      const kind = flags.kind === "decision" || flags.kind === "solution" ? flags.kind : null;
      let entries = store.index().entries;
      if (kind) entries = entries.filter((e) => e.kind === kind);
      if (typeof flags.status === "string") entries = entries.filter((e) => e.status === flags.status);
      if (asJson) console.log(JSON.stringify(entries, null, 2));
      else {
        for (const e of entries) {
          const badge = [e.kind, e.cls ?? e.category, e.status].filter(Boolean).join("/");
          const verified = e.sidecar?.lastVerified ? ` ✓${e.sidecar.lastVerified.slice(0, 10)}` : "";
          console.log(`${e.rel}  [${badge}]${verified}${e.valid ? "" : " ⚠invalid"}`);
        }
        console.log(`-- ${entries.length} document(s) --`);
      }
      return 0;
    }

    case "search": {
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("usage: mawf knowledge search <query> [--max-docs N] [--max-bytes N] [--include-archived]");
        return 2;
      }
      const idx = store.index();
      const result = searchKnowledge(idx.entries, {
        q,
        includeArchived: flags["include-archived"] === true,
        maxDocs: flags["max-docs"],
        maxBytes: flags["max-bytes"],
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        for (const c of result.candidates) {
          const why = c.matched.map((m) => `${m.field}:"${m.token}"`).join(", ");
          const flagsStr = c.caveats.length ? ` ⚠ ${c.caveats.join("; ")}` : "";
          console.log(`${c.path}  [${c.kind}/${c.cls ?? c.category ?? ""} ${c.status}] score=${c.score}`);
          console.log(`   matched: ${why}${flagsStr}`);
        }
        console.log(`-- ${result.budget.returned}/${result.budget.matchedTotal} matched (maxDocs=${result.budget.maxDocs}, maxBytes=${result.budget.maxBytes}) --`);
      }
      return 0;
    }

    case "context": {
      // Bounded Trellis-context injection block (contract §6) — pointers only.
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("usage: mawf knowledge context <query> [--workspace-label <label>]");
        return 2;
      }
      const idx = store.index();
      const result = searchKnowledge(idx.entries, {
        q,
        includeArchived: false,
        maxDocs: flags["max-docs"],
        maxBytes: flags["max-bytes"],
      });
      console.log(renderContextBlock(result, { workspaceLabel: flags["workspace-label"] ?? "local" }));
      return 0;
    }

    case "verify": {
      // Mechanical verification (stabilization §9): schema/format, path
      // grammar, status/folder consistency (via schema parse), relative-link
      // existence + root containment, duplicate stable ids, archive seals.
      const kinds = flags.kind === "decision" || flags.kind === "solution"
        ? [flags.kind] : ["decision", "solution"];
      let bad = 0;
      const report = [];
      /** duplicate stable-id detection across the whole store */
      const seenIds = new Map();
      for (const kind of kinds) {
        for (const item of store.walk(kind)) {
          if (!item.parsed.ok) {
            bad++;
            report.push({ kind, rel: item.rel, errors: item.parsed.errors });
            continue;
          }
          const stableId = store.stableId(kind, item.rel, item.abs, item.parsed);
          const prev = seenIds.get(stableId);
          if (prev) {
            bad++;
            report.push({ kind, rel: item.rel, errors: [{ code: "duplicate-id", message: `stable id '${stableId}' already used by ${prev}` }] });
          } else seenIds.set(stableId, item.rel);
          // relative-markdown-link existence + containment in the kind root
          const rootAbs = path.resolve(store.dirFor(kind));
          for (const link of item.parsed.doc.outLinks ?? []) {
            const target = path.resolve(rootAbs, link);
            if (!target.startsWith(rootAbs + path.sep)) {
              bad++;
              report.push({ kind, rel: item.rel, errors: [{ code: "link-escape", message: `link escapes knowledge root: ${link}` }] });
              continue;
            }
            if (!fs.existsSync(target)) {
              bad++;
              report.push({ kind, rel: item.rel, errors: [{ code: "link", message: `broken relative link: ${link}` }] });
            }
          }
        }
      }
      // archive seal verification (decisions corpus)
      const archives = store.verifyArchives();
      for (const v of archives.violations) {
        bad++;
        report.push({ kind: "decision", rel: v, errors: [{ code: "archive-seal", message: v }] });
      }
      if (asJson) console.log(JSON.stringify({ ok: bad === 0, invalid: report }, null, 2));
      else if (bad === 0) console.log(`knowledge verify: OK (${kinds.join(" + ")}, archive seals checked)`);
      else {
        for (const r of report) {
          console.error(`${r.kind} ${r.rel}:`);
          for (const e of r.errors) console.error(`  - [${e.code}] ${e.message}`);
        }
      }
      return bad ? 1 : 0;
    }

    case "reindex": {
      const idx = store.buildIndex();
      console.log(`reindexed ${idx.entries.length} document(s) -> ${store.indexPath()}`);
      return 0;
    }

    case "get": {
      // Writer-API read: returns the doc with its CAS base hash so callers can
      // edit + update() without racing other writers (stabilization §10).
      const [kind, relPath] = rest;
      if (!kind || !relPath || (kind !== "decision" && kind !== "solution")) {
        console.error("usage: mawf knowledge get <decision|solution> <relPath> [--json]");
        return 2;
      }
      const r = store.read(kind, relPath);
      if (asJson) {
        console.log(JSON.stringify({ relPath, hash: r.hash, sidecar: r.sidecar, valid: r.parsed.ok, errors: r.parsed.ok ? [] : r.parsed.errors, text: r.text }, null, 2));
      } else {
        console.log(`# hash: ${r.hash}`);
        console.log(r.text);
      }
      return 0;
    }

    case "create": {
      // Durable-write path: the agent authors a CANDIDATE temp file, then
      // commits it through the store (CAS/lock/sidecar/index all apply).
      // Writing canonical files directly bypasses these guarantees and is
      // never the sanctioned route (stabilization §10).
      const [kind, relPath] = rest;
      const file = flags.file;
      if (!kind || !relPath || !file || (kind !== "decision" && kind !== "solution")) {
        console.error("usage: mawf knowledge create <decision|solution> <relPath> --file <candidate.md> [--source-task t] [--source-commit c]");
        return 2;
      }
      const text = fs.readFileSync(path.resolve(file), "utf8");
      const r = wrapStoreErrors(() => store.create(kind, relPath, text, { sourceTask: flags["source-task"], sourceCommit: flags["source-commit"] }));
      if (typeof r === "number") return r;
      console.log(`created ${kind} ${relPath} -> ${r.abs}`);
      return 0;
    }

    case "update": {
      const [kind, relPath] = rest;
      const file = flags.file;
      if (!kind || !relPath || !file || (kind !== "decision" && kind !== "solution")) {
        console.error("usage: mawf knowledge update <decision|solution> <relPath> --file <candidate.md> [--expected-hash <hash>] [--verify-method m --verify-result r]");
        return 2;
      }
      const text = fs.readFileSync(path.resolve(file), "utf8");
      const sidecar = flags["verify-method"]
        ? { verification: { method: String(flags["verify-method"]), result: String(flags["verify-result"] ?? "pass") } }
        : undefined;
      const r = wrapStoreErrors(() => store.update(kind, relPath, text, { expectedHash: flags["expected-hash"], sidecar }));
      if (typeof r === "number") return r;
      console.log(`updated ${kind} ${relPath} (hash ${r.hash.slice(0, 12)}…)`);
      return 0;
    }

    case "archive": {
      const [relPath] = rest;
      if (!relPath) {
        console.error("usage: mawf knowledge archive <implemented/<class>/<file>.md> [--superseded-by <relPath>]");
        return 2;
      }
      const r = wrapStoreErrors(() => store.archiveDecision(relPath, { supersededBy: flags["superseded-by"] }));
      if (typeof r === "number") return r;
      if (asJson) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`archived: ${r.from} -> ${r.to} (Archived: ${r.archivedDate})`);
        if (r.inbound.length) console.log(`inbound links to review: ${r.inbound.join(", ")}`);
      }
      return 0;
    }

    case "verify-doc": {
      const [kind, relPath] = rest;
      if (!kind || !relPath || (kind !== "decision" && kind !== "solution")) {
        console.error("usage: mawf knowledge verify-doc <decision|solution> <relPath>");
        return 2;
      }
      const r = store.read(kind, relPath);
      if (r.parsed.ok) {
        console.log(`verify-doc: OK ${kind} ${relPath}`);
        return 0;
      }
      for (const e of r.parsed.errors) console.error(`  - [${e.code}] ${e.message}`);
      return 1;
    }

    default:
      console.error("usage: mawf knowledge <status|list|search|context|verify|reindex|get|create|update|archive|verify-doc> [--project dir] [--json]");
      console.error("  durable writes (create/update/archive) MUST go through this CLI so CAS, locks, sidecars and seals hold; direct file writes bypass them and are not sanctioned");
      console.error(`  solution frontmatter enums: problem_type ∈ ${PROBLEM_TYPES.length} values, severity ∈ ${SEVERITIES.join("|")}`);
      return 2;
  }
}
