// @ts-check
// `mawf knowledge` — CLI surface for the durable knowledge store (P2).
// Subcommands: status | list | search | context | verify | reindex
// Contract: contract §5 (store), §6 (retrieval/budget). JSON output via --json.

import path from "node:path";
import { KnowledgeStore, PROBLEM_TYPES, SEVERITIES } from "./store.js";
import { searchKnowledge, renderContextBlock } from "./search.js";

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
      // Mechanical structural verification across both corpora (A03/A05 gate).
      const kinds = flags.kind === "decision" || flags.kind === "solution"
        ? [flags.kind] : ["decision", "solution"];
      let bad = 0;
      const report = [];
      for (const kind of kinds) {
        for (const item of store.walk(kind)) {
          if (!item.parsed.ok) {
            bad++;
            report.push({ kind, rel: item.rel, errors: item.parsed.errors });
          }
        }
      }
      if (asJson) console.log(JSON.stringify({ ok: bad === 0, checked: "all", invalid: report }, null, 2));
      else if (bad === 0) console.log(`knowledge verify: OK (${kinds.join(" + ")})`);
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

    default:
      console.error("usage: mawf knowledge <status|list|search|context|verify|reindex> [--project dir] [--json]");
      console.error(`  solution frontmatter enums: problem_type ∈ ${PROBLEM_TYPES.length} values, severity ∈ ${SEVERITIES.join("|")}`);
      return 2;
  }
}
