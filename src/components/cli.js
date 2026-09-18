// @ts-check
// `mawf components` — component management CLI (stabilization §15).
// status/list are read-only and NEVER install anything; install/verify/rollback
// are explicit actions. No network downloads happen here — install is
// --from-file only until a release channel exists.

import { loadLock, componentStatus, installComponent, rollbackComponent, verifyComponent } from "./registry.js";

/**
 * @param {string[]} f args after "components"
 * @param {object} flags
 * @returns {number} exit code
 */
export function runComponents(f, flags) {
  const [sub, name] = f;
  const lock = loadLock();
  const asJson = flags.json === true;

  const findEntry = (n) => lock.components.find((c) => c.name === n);

  switch (sub) {
    case "list":
    case "status": {
      const entries = name ? [findEntry(name)].filter(Boolean) : lock.components;
      if (name && !findEntry(name)) {
        console.error(`mawf components: unknown component: ${name}`);
        console.error(`known: ${lock.components.map((c) => c.name).join(", ")}`);
        return 2;
      }
      const rows = entries.map((e) => ({ lock: e, status: componentStatus(e) }));
      if (asJson) {
        console.log(JSON.stringify(rows.map((r) => ({ name: r.status.name, ...r.status, entry: r.lock.entry })), null, 2));
      } else {
        for (const r of rows) {
          const s = r.status;
          console.log(`${s.name} [${s.kind}] ${s.state}`);
          console.log(`  locked: ${s.sourceCommit.slice(0, 12)}  distribution: ${s.distributionState}${s.bundled ? " (bundled with MAWF)" : ""}`);
          console.log(`  license: ${s.licenseStatus}${s.licenseBlocked ? "  ⚠ PUBLIC DISTRIBUTION BLOCKED" : ""}`);
          if (s.releaseBlocked) console.log(`  release: none yet — install via --from-file <archive built from the locked source>`);
          if (s.installed) {
            console.log(`  installed: ${s.installed.version} @ ${s.installed.installedAt} (sha256 ${String(s.installed.verifiedSha256).slice(0, 12)}…)`);
            if (s.installed.verification) console.log(`  verified: ${s.installed.verification.result} via ${s.installed.verification.method} at ${s.installed.verification.at}`);
          }
        }
      }
      return 0;
    }

    case "install": {
      const entry = findEntry(name);
      const file = flags["from-file"];
      if (!entry || !file) {
        console.error("usage: mawf components install <name> --from-file <archive> [--expected-sha256 <hex>] [--dry-run]");
        console.error(`known: ${lock.components.map((c) => c.name).join(", ")}`);
        return 2;
      }
      const r = installComponent(entry, file, {
        expectedSha256: flags["expected-sha256"],
        dryRun: flags["dry-run"] === true,
      });
      if (!r.ok) {
        console.error(`mawf components install: ${r.error}`);
        for (const v of r.violations ?? []) console.error(`  - ${v}`);
        return 1;
      }
      console.log(`installed ${entry.name} ${r.state.version} (${r.state.distributionState}; sha256 ${r.state.verifiedSha256.slice(0, 12)}…)`);
      if (r.state.extraction === "skipped") console.log("  note: bundled component — no extraction performed");
      console.log(`  next: mawf components verify ${entry.name}  (runs the component's real doctor; until then state stays installed-unverified)`);
      return 0;
    }

    case "verify": {
      const entry = findEntry(name);
      if (!entry) {
        console.error(`mawf components: unknown component: ${name}`);
        return 2;
      }
      const r = verifyComponent(entry);
      if (!r.ok) {
        console.error(`mawf components verify: ${r.error}`);
        if (r.output) console.error(r.output.split("\n").slice(0, 10).join("\n"));
        return 1;
      }
      console.log(`verified ${entry.name}: ${r.state.verification.method} pass — state now supported-and-tested`);
      return 0;
    }

    case "rollback": {
      if (!findEntry(name)) {
        console.error(`mawf components: unknown component: ${name}`);
        return 2;
      }
      const r = rollbackComponent(name);
      if (!r.ok) {
        console.error(`mawf components rollback: ${r.error}`);
        return 1;
      }
      console.log(`rolled back ${name} to ${r.state.version} (${r.state.installedAt}) — verify again: mawf components verify ${name}`);
      return 0;
    }

    default:
      console.error("usage: mawf components <list|status|install|verify|rollback> [name] [--json] [--from-file <archive>]");
      console.error("  read commands never install; install is --from-file only (no implicit network fetches)");
      return 2;
  }
}
