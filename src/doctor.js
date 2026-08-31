// @ts-check
// `mawf doctor` — environment + capability + policy report.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { exists, readJson } from "./util.js";
import { readCcSwitch, findDb, readRouting, routingPolicy, SUPPORTED_CC_SCHEMA, piManagedByCcSwitch, mawfSkillsUnderCcSwitch } from "./ccswitch.js";
import { grillSwapStatus } from "./grillswap.js";
import { detectHost, hostCapabilities } from "./host.js";
import { status as codexStatus } from "./codex.js";
import { detectTrellis } from "./trellis.js";
import { readDshConfig, readDshAsCc, readCredentialKeys, dshDefaultModel, dshCostRateNote, readCcPricingJson, listDshProfiles } from "./dshprovider.js";
import { detectInstallMode } from "./upgrade.js";
import path from "node:path";
import os from "node:os";

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SUPPORTED = ["claude-code", "codex", "pi", "dsh"]; // supported host agents (pi/dsh per MAW support-surface policy)

/** cc-switch synced model-pricing.json + its lastSyncAt, or {error}. */
/** Best-effort `git describe` for a checkout, "?" when unavailable. @param {string} gitRoot */
function gitDescribe(gitRoot) {
  try {
    return execFileSync("git", ["-C", gitRoot, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return "?";
  }
}

function pricingSyncInfo() {
  try {
    const doc = readJson(path.join(os.homedir(), ".cc-switch", "model-pricing.json"), null);
    if (!doc || !Array.isArray(doc.models)) return { map: {}, syncAt: null, error: "unparseable" };
    return { map: readCcPricingJson(), syncAt: doc.modelsDevSync?.lastSyncAt ?? null, error: null };
  } catch {
    return { map: {}, syncAt: null, error: "unavailable" };
  }
}

/** @returns {{ ok: boolean, checks: { name: string, status: "ok"|"warn"|"fail"|"info", detail: string }[], summary: string }} */
export function doctor() {
  const checks = [];

  // node version
  const nv = process.versions.node;
  checks.push({ name: "Node.js", status: Number(nv.split(".")[0]) >= 20 ? "ok" : "warn", detail: `v${nv}` });

  // git
  try {
    const git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    checks.push({ name: "git", status: "ok", detail: git });
  } catch {
    checks.push({ name: "git", status: "warn", detail: "not found" });
  }

  // host (claude-code + codex only are supported)
  const host = detectHost();
  const supported = SUPPORTED.includes(host.app);
  checks.push({ name: "Host agent software", status: host.app === "unknown" ? "warn" : (supported ? "ok" : "warn"), detail: `${host.app} at ${host.homeDir || "(none)"}; caps: ${hostCapabilities(host).join(", ") || "none"}${supported ? "" : " — only Claude Code, Codex, Pi and DeepSeek Harness (dsh) are supported"}` });

  // cc-switch (read-only)
  const db = findDb();
  /** @type {any} */
  let ccInfo = null;
  if (!db) {
    checks.push({ name: "cc-switch database", status: "warn", detail: "not found; pricing & cost-rate will be unavailable" });
  } else {
    const cc = readCcSwitch({ dbPath: db });
    ccInfo = cc;
    const cur = Object.keys(cc.currentProviders);
    checks.push({ name: "cc-switch database (read-only)", status: "ok", detail: `${db} (impl ${cc.impl}); current providers: ${cur.join(", ") || "none"}` });
    checks.push(cc.schemaSupported
      ? { name: "cc-switch schema", status: "ok", detail: `v${cc.schemaVersion} (supported ≤ v${SUPPORTED_CC_SCHEMA})` }
      : { name: "cc-switch schema", status: "warn", detail: `v${cc.schemaVersion} is newer than supported v${SUPPORTED_CC_SCHEMA} — reads may miss new semantics; upgrade mawf` });
    checks.push({ name: "cc-switch model pricing", status: "ok", detail: `${Object.keys(cc.modelPricing).length} models priced` });
    // cc-switch repo-backed skills coexistence (GUI v3.20+/CLI v5.10+): if any
    // mawf-* skills are managed there, `cc-switch skills update` may overwrite
    // them — informational; mawf's installer stays the version source of truth.
    const mawfSkills = mawfSkillsUnderCcSwitch({ dbPath: db });
    if (mawfSkills && mawfSkills.rows.length) {
      checks.push({ name: "mawf skills under cc-switch management", status: "ok", detail: `${mawfSkills.rows.map((s) => s.name).join(", ")} — cc-switch 'skills update' may overwrite them; re-run mawf install/upgrade to restore (mawf is the version source of truth)` });
    }

    // routing policy (claude always on+failover; codex on except OAuth)
    try {
      const routing = readRouting({ dbPath: db });
      const pol = routingPolicy(routing);
      const det = pol.violations.length ? `violations: ${pol.violations.map((v) => v.app + "." + v.field + "=" + v.expected).join("; ")}` : "claude local-routing+failover on; codex " + (pol.codexOAuthInUse ? "routing OFF (OAuth)" : "routing ON");
      checks.push({ name: "cc-switch routing policy", status: pol.compliant ? "ok" : "warn", detail: det + (pol.compliant ? "" : " — run `mawf routing --fix`") });
    } catch (e) {
      checks.push({ name: "cc-switch routing policy", status: "warn", detail: "could not read proxy_config" });
    }
  }

  // codex
  const cs = codexStatus();
  checks.push({ name: "Codex CLI", status: cs.binary ? "ok" : "warn", detail: cs.binary || "not found" });
  checks.push({ name: "codex-plugin-cc", status: cs.companion ? "ok" : "warn", detail: cs.companion || cs.reason });
  // codex 0.150.0 (#39837): untrusted projects no longer supply project-level
  // AGENTS.md instructions — the mawf managed block reaches codex sessions
  // only after project trust is granted (info, not a failure).
  checks.push({ name: "codex project trust (managed block)", status: "info", detail: "codex ≥0.150.0 ignores project AGENTS.md in untrusted projects — grant trust in codex or the mawf advise block never loads there" });

  // pi agent — config lives in ~/.pi/agent/. Since cc-switch v3.20.0 (schema
  // v17) pi MAY be cc-switch-managed: providers/pricing then come from the
  // cc-switch db (exact) and models.json mirrors what cc-switch wrote. Spend
  // becomes measurable via cc-switch's Pi (Session) import once data exists
  // (cache-write accounting may be incomplete — upstream caveat).
  const piHome = path.join(os.homedir(), ".pi", "agent");
  const piManaged = piManagedByCcSwitch(ccInfo);
  if (exists(piHome)) {
    const settings = readJson(path.join(piHome, "settings.json"), null);
    const models = readJson(path.join(piHome, "models.json"), null);
    checks.push({ name: "Pi Agent config", status: "ok", detail: `${piHome}; default provider/model: ${settings?.defaultProvider || "?"} / ${settings?.defaultModel || "?"}` });
    checks.push({ name: "Pi models store", status: models ? "ok" : "warn", detail: models ? `${Object.keys(models.providers || {}).length} providers in models.json${piManaged ? " (mirrors cc-switch-managed pi providers)" : ""}` : "models.json not found — provider/model view will be empty" });
    checks.push({ name: "Pi spend tracking", status: piManaged ? "ok" : "warn", detail: piManaged
      ? "pi is cc-switch-managed (schema v17+); spend measured via cc-switch Pi (Session) import when data exists — cache-write accounting may be incomplete"
      : "pi is not routed via the cc-switch proxy — cost-rate is concurrency-only; real spend is not measured" });
  } else {
    checks.push({ name: "Pi Agent config", status: "warn", detail: "~/.pi/agent not found (not installed)" });
  }

  // grill-brainstorm swap (workspace-level)
  {
    const st = grillSwapStatus(process.cwd());
    if (st.trellisBrainstormPresent) {
      if (st.wrapperInstalled && st.wrapperCurrent && !st.missing.length) {
        checks.push({ name: "trellis-brainstorm (grill edition)", status: "ok", detail: `wrapper current in ${st.roots.join(", ")}; vendored: ${st.vendored.join(", ")}${st.origBackup ? "; stock backup: trellis-brainstorm.orig.md" : ""}` });
      } else if (st.wrapperInstalled && !st.wrapperCurrent) {
        checks.push({ name: "trellis-brainstorm (grill edition)", status: "warn", detail: "wrapper outdated (mawf asset changed) — run `mawf update` to refresh" });
      } else {
        checks.push({ name: "trellis-brainstorm (grill edition)", status: "warn", detail: `stock trellis-brainstorm detected (trellis update clobbered the swap${st.missing.length ? `; missing vendored: ${st.missing.join(", ")}` : ""}) — run \`mawf update\` to repair` });
      }
    }
  }

  // watchdog (opt-in rescue layer)
  {
    const regPath = process.env.MAW_WATCHDOG_REGISTRY || path.join(os.homedir(), ".mawf", "projects.json");
    const reg = exists(regPath) ? readJson(regPath, { projects: [] }) : null;
    const watched = reg ? (reg.projects || []).filter((p) => !p.excluded).length : 0;
    checks.push({ name: "watchdog registry", status: reg ? "ok" : "warn", detail: reg ? `${watched} project(s) watched (~/.mawf/projects.json; mawf init registers, --no-watchdog excludes)` : "no projects registered yet — mawf init adds them" });
    const alerts = path.join(process.cwd(), ".mawf", "watchdog", "ALERTS.md");
    if (exists(alerts)) {
      const n = readText(alerts).split("\n").filter((l) => l.startsWith("- ")).length;
      checks.push({ name: "watchdog alerts", status: n > 0 ? "warn" : "ok", detail: n > 0 ? `${n} alert(s) in .mawf/watchdog/ALERTS.md — review before they age out` : "no alerts recorded" });
    }
    checks.push({ name: "watchdog scheduling", status: "ok", detail: "runs ONLY when invoked — resident `mawf watchdog` or cron `*/15 * * * * mawf watchdog --once` (opt-in by design; spends real money when dispatching)" });
  }

  // DeepSeek Harness (dsh) — config lives in $DSH_HOME (~/.dsh), NOT
  // cc-switch-managed. Providers come from settings.yaml
  // (llm-pi-ai.providers); prices cross-ref cc-switch's auto-synced
  // model-pricing.json; spend rate is not measurable (no proxy) → cost-rate
  // degrades to concurrency-only.
  if (host.dshHome) {
    const dshHome = host.dshHome;
    let version = "?";
    try { version = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 10000 }).trim(); } catch {}
    const cfg = readDshConfig(dshHome);
    const cc = readDshAsCc({ dshHome });
    const provs = cc?.allProviders ?? [];
    const modelIds = provs.flatMap((p) => p.settings_config?._dshModels ?? []);
    const profiles = listDshProfiles(dshHome);
    checks.push({ name: "DeepSeek Harness (dsh) config", status: "ok", detail: `${dshHome}${version !== "?" ? `; dsh ${version}` : ""}; profiles: ${profiles.join(", ") || "none"}` });
    checks.push({
      name: "dsh providers (settings.yaml)",
      status: provs.length ? "ok" : "warn",
      detail: provs.length
        ? `${provs.length} provider(s): ${provs.map((p) => `${p.id} (${p.settings_config._dshModels.length} models)`).join(", ")}`
        : "no llm-pi-ai.providers configured — open dsh web → Settings → Models",
    });
    const def = dshDefaultModel({ profile: "web" });
    checks.push({ name: "dsh default model", status: "ok", detail: def ? `${def.provider} / ${def.model} (composed agent-default-model)` : (cc?.currentProviders?.dsh ? `${cc.currentProviders.dsh.id} / ${cc.currentProviders.dsh.settings_config.model} (first provider fallback)` : "unknown") });
    const credKeys = readCredentialKeys(dshHome);
    const envSatisfied = provs.filter((p) => p.apiKeyEnv && process.env[p.apiKeyEnv]).map((p) => p.id);
    checks.push({ name: "dsh credentials", status: "ok", detail: `${credKeys.length} key(s) in .credentials.yaml (${credKeys.join(", ") || "none"}); apiKeyEnv satisfied for: ${envSatisfied.join(", ") || "none (keys resolve inside dsh per request)"}` });
    const preset = cfg?.settings?.["agent-presets"]?.default;
    checks.push({ name: "dsh agent preset", status: preset ? "ok" : "warn", detail: preset ? `default: ${preset}` : "no agent-presets.default in settings.yaml (dsh built-in default applies)" });
    const pricing = pricingSyncInfo();
    const matched = modelIds.filter((id) => pricing.map[id]);
    checks.push({ name: "dsh model pricing (cc-switch sync)", status: "ok", detail: pricing.error ? "model-pricing.json unavailable — price gate reports unknown" : `${Object.keys(pricing.map).length} models synced (last sync ${pricing.syncAt ? new Date(pricing.syncAt).toISOString().slice(0, 16) : "?"}); ${matched.length}/${modelIds.length} dsh models priced` });
    checks.push({ name: "dsh spend tracking", status: "warn", detail: dshCostRateNote() });
    checks.push({ name: "dsh MCP servers", status: "ok", detail: "managed by dsh patch layers (dsh-mcp-client), not cc-switch — MAW reports only" });
  } else {
    checks.push({ name: "DeepSeek Harness (dsh) config", status: "warn", detail: "$DSH_HOME (~/.dsh) not found (not installed)" });
  }

  // trellis (the mandatory next-step init)
  try {
    const det = detectTrellis();
    checks.push({ name: "trellis (next-step init)", status: det.via === "npx" ? "warn" : "ok", detail: det.via === "npx" ? "not on PATH; will use `npx --yes @mindfoldhq/trellis@latest`" : `${det.bin}` });
  } catch (e) {
    checks.push({ name: "trellis (next-step init)", status: "warn", detail: "trellis module unavailable" });
  }

  // package
  const pkg = readJson(path.join(PKG_ROOT, "package.json"), { version: "?" });
  checks.push({ name: "MAW package", status: "ok", detail: `v${pkg.version}` });

  // install mode + self-upgrade path
  try {
    const det = detectInstallMode();
    if (det.mode === "checkout" && det.gitRoot) {
      const desc = gitDescribe(det.gitRoot);
      checks.push({ name: "MAW install mode", status: "ok", detail: `git checkout at ${det.gitRoot} (${desc}); self-upgrade: mawf upgrade` });
    } else if (det.mode === "npm" && det.squatted) {
      checks.push({ name: "MAW install mode", status: "warn", detail: `npm global resolves to the squatted third-party name "${det.pkgName}" — upgrade from a git checkout instead` });
    } else {
      checks.push({ name: "MAW install mode", status: "ok", detail: `npm global (${det.pkgName}); self-upgrade: mawf upgrade` });
    }
  } catch {
    checks.push({ name: "MAW install mode", status: "warn", detail: "could not detect" });
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const ok = fails === 0;
  const summary = `${checks.length} checks: ${checks.length - fails - warns} ok, ${warns} warn, ${fails} fail`;
  return { ok, checks, summary };
}
