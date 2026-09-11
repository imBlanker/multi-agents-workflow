// @ts-check
// Static Pi package/resource and MCP discovery, based on Pi 0.85.1 and
// pi-mcp-adapter 2.33.0 contracts. No modules, secret helpers or servers run.
import fs from "node:fs";
import path from "node:path";
import { exists, home, readJson } from "./util.js";
import { resolvePiAgentDir } from "./piprovider.js";

const TYPES = ["skills", "extensions", "prompts", "themes"];
const slash = (s) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const localPath = (p, base, homeDir) => path.resolve(base, p.startsWith("~/") || p.startsWith("~\\") ? path.join(homeDir, p.slice(2)) : p);
function real(p) { try { return fs.realpathSync(p); } catch { return p; } }
function entries(p) { try { return fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Only visible descendants; explicitly listed roots may themselves be symlinks.
function walk(root, notes, out = [], seen = new Set()) {
  if (seen.has(real(root))) return out;
  seen.add(real(root));
  for (const e of entries(root)) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
    if (out.length >= 10000) { notes.push(`Resource scan limit reached at ${root}`); break; }
    const p = path.join(root, e.name);
    out.push(p);
    if (e.isDirectory()) walk(p, notes, out, seen);
  }
  return out;
}
function matches(pattern, value) {
  const p = slash(pattern);
  const v = slash(value);
  if (!/[?*]/.test(p)) return v === p;
  let expression = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && p[i + 1] === "*") {
      i++;
      if (p[i + 1] === "/") { expression += "(?:.*/)?"; i++; }
      else expression += ".*";
    } else if (p[i] === "*") expression += "[^/]*";
    else if (p[i] === "?") expression += "[^/]";
    else expression += p[i].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(v);
}
function targets(relative) {
  const p = slash(relative), result = [p, path.posix.basename(p)];
  if (p.endsWith("/SKILL.md")) result.push(path.posix.dirname(p), path.posix.basename(path.posix.dirname(p)));
  return result;
}
function filterMatch(pattern, relative, exact = false) {
  const p = slash(pattern), values = targets(relative);
  return exact ? values.filter((v) => v === slash(relative) || (relative.endsWith("SKILL.md") && v === path.posix.dirname(slash(relative)))).includes(p) : values.some((v) => matches(p, v));
}
function selected(filters, relative) {
  if (!Array.isArray(filters)) return true;
  if (!filters.length) return false;
  const valid = filters.filter((p) => typeof p === "string");
  const positives = valid.filter((p) => !/^[!+-]/.test(p));
  let enabled = !positives.length || positives.some((p) => filterMatch(p, relative));
  if (valid.some((p) => p[0] === "!" && filterMatch(p.slice(1), relative))) enabled = false;
  if (valid.some((p) => p[0] === "+" && filterMatch(p.slice(1), relative, true))) enabled = true;
  if (valid.some((p) => p[0] === "-" && filterMatch(p.slice(1), relative, true))) enabled = false;
  return enabled;
}
function extensionEntries(root) {
  const declared = readJson(path.join(root, "package.json"), {})?.pi?.extensions;
  if (Array.isArray(declared) && declared.length) return declared.filter((p) => typeof p === "string").map((p) => path.resolve(root, p)).filter(isFile);
  for (const name of ["index.ts", "index.js"]) if (isFile(path.join(root, name))) return [path.join(root, name)];
  return [];
}
function packageSpec(source, base, homeDir) {
  if (source.startsWith("npm:")) {
    const name = source.slice(4).replace(/@[^@/]+$/, "");
    if (!/^(?:@[^/]+\/)?[^/@]+$/.test(name)) return null;
    return { name, id: `npm:${name}`, kind: "npm", root: path.join(base, "npm", "node_modules", ...name.split("/")) };
  }
  if (/^(git:|https?:\/\/|ssh:\/\/)/.test(source)) {
    // Inventory retains repository/ref identity, never URL auth or query data.
    let repo = source.replace(/^git:/, "").split(/[?#]/, 1)[0];
    if (/^[a-z]+:\/\//.test(repo)) {
      try { const url = new URL(repo); repo = `${url.hostname}${url.pathname}`; }
      catch { return null; }
    } else repo = repo.replace(/^git@([^:]+):/, "$1/");
    const refMatch = repo.match(/@([^/]*)$/), ref = refMatch?.[1] ?? "";
    repo = repo.replace(/@[^/]*$/, "").replace(/\/$/, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w./-]+$/.test(repo) || repo.split("/").includes("..")) return null;
    return { name: repo, id: `git:${repo}`, safeSource: `git:${repo}${ref ? `@${ref}` : ""}`, kind: "git", root: path.join(base, "git", ...repo.split("/")) };
  }
  const root = localPath(source, base, homeDir);
  return { name: path.basename(root), id: `local:${real(root)}`, kind: "local", root };
}
function packageResources(pkg, notes) {
  const manifest = readJson(path.join(pkg.root, "package.json"), {});
  const pi = object(manifest?.pi) ? manifest.pi : null;
  const out = [];
  for (const type of TYPES) {
    const paths = pkg.explicit ? (pkg.explicit.type === type ? [pkg.explicit.path] : []) : isFile(pkg.root) ? (type === "extensions" ? [pkg.root] : []) : (pi ? pi[type] : [type]);
    if (!Array.isArray(paths)) continue;
    const candidates = new Set();
    const add = (p) => {
      if (isFile(p)) { candidates.add(p); return; }
      if (type === "skills" && isFile(path.join(p, "SKILL.md"))) { candidates.add(path.join(p, "SKILL.md")); return; }
      if (type === "extensions") {
        const own = extensionEntries(p);
        if (own.length) { for (const child of own) candidates.add(child); return; }
        for (const e of entries(p)) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const child = path.join(p, e.name);
          if (isFile(child)) candidates.add(child);
          else for (const file of extensionEntries(child)) candidates.add(file);
        }
        return;
      }
      for (const child of walk(p, notes)) if (isFile(child)) candidates.add(child);
    };
    for (const item of paths) {
      if (typeof item !== "string" || item.startsWith("!")) continue;
      if (/[\[\]{}]/.test(item)) { notes.push(`Unsupported resource glob in ${pkg.name}: ${item}`); continue; }
      if (/[?*]/.test(item)) {
        for (const p of walk(pkg.root, notes)) if (matches(item, path.relative(pkg.root, p))) add(p);
      } else add(path.resolve(pkg.root, item));
    }
    for (const p of candidates) {
      const rel = path.relative(pkg.root, p);
      if (paths.some((f) => typeof f === "string" && f.startsWith("!") && matches(f.slice(1), rel))) continue;
      if (type === "skills" && !p.endsWith(".md")) continue;
      if (type === "skills" && path.basename(p) !== "SKILL.md") {
        if (["README.md", "AGENTS.md", "CHANGELOG.md", "CONTRIBUTING.md"].includes(path.basename(p))) continue;
        // Markdown supporting an existing SKILL.md is not a second skill.
        let parent = path.dirname(p), nested = false;
        while (parent !== path.dirname(parent) && parent.startsWith(pkg.root)) {
          if (isFile(path.join(parent, "SKILL.md"))) { nested = true; break; }
          if (parent === pkg.root) break;
          parent = path.dirname(parent);
        }
        if (nested) continue;
      }
      if (type === "extensions" && !/\.(ts|js)$/.test(p)) continue;
      if (type === "prompts" && !p.endsWith(".md")) continue;
      if (type === "themes" && !p.endsWith(".json")) continue;
      let enabled = pkg.configured && selected(pkg.filters?.[type], slash(rel));
      for (const delta of pkg.deltas ?? []) for (const rule of Array.isArray(delta[type]) ? delta[type] : []) {
        if (typeof rule === "string" && filterMatch(rule.replace(/^[!+-]/, ""), slash(rel), /^[+-]/.test(rule))) enabled = !/^[!-]/.test(rule);
      }
      out.push({ type, path: p, realPath: real(p), name: path.basename(p) === "SKILL.md" ? path.basename(path.dirname(p)) : path.basename(p, path.extname(p)), source: pkg.source, origin: `${pkg.scope}-${pkg.kind}`, configured: pkg.configured, enabled, status: !pkg.configured ? "discovered" : enabled ? "configured" : "disabled", trust: pkg.scope === "project" ? "project-trust-required" : "user-global", loaded: false });
    }
  }
  return out;
}

/** Read package metadata and resource paths; configured never means loaded.
 * @param {{piDir?:string,projectDir?:string,homeDir?:string}} [opts]
 */
export function readPiResources(opts = {}) {
  const piDir = resolvePiAgentDir(opts.piDir), projectDir = opts.projectDir ?? process.cwd(), homeDir = opts.homeDir ?? home();
  const packages = new Map(), notes = [], loose = [];
  for (const [base, scope] of [[piDir, "global"], [path.join(projectDir, ".pi"), "project"]]) {
    const rawSettings = readJson(path.join(base, "settings.json"), {});
    const settings = object(rawSettings) ? rawSettings : {};
    for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string" || !source) continue;
      const spec = packageSpec(source, base, homeDir);
      if (!spec) { notes.push("Unrecognized Pi package source"); continue; }
      const previous = packages.get(spec.id);
      if (entry?.autoload === false) {
        if (previous) packages.set(spec.id, { ...previous, scope, deltas: [...(previous.deltas ?? []), entry] });
        else notes.push(`Non-autoload package override has no base: ${spec.name}`);
        continue;
      }
      packages.set(spec.id, { ...spec, source: spec.safeSource ?? source, scope, configured: true, filters: object(entry) ? entry : {} });
    }
    // Installed workspace dependencies are evidence of presence, not autoload.
    const deps = readJson(path.join(base, "npm", "package.json"), {})?.dependencies;
    if (object(deps)) for (const name of Object.keys(deps)) {
      const spec = packageSpec(`npm:${name}`, base, homeDir);
      if (spec && !packages.has(spec.id)) packages.set(spec.id, { ...spec, source: `npm:${name}`, scope, configured: false, filters: {} });
    }
    for (const type of TYPES) {
      const roots = [path.join(base, type)];
      for (const value of Array.isArray(settings[type]) ? settings[type] : []) {
        if (typeof value === "string" && !/^[!+-]/.test(value)) roots.push(localPath(value, base, homeDir));
      }
      for (const root of roots) {
        const pseudo = { root, name: path.basename(root), source: path.join(base, "settings.json"), scope, kind: "local", configured: true, filters: {} };
        loose.push(...packageResources({ ...pseudo, root: base, explicit: { type, path: root } }, notes));
      }
      // Disable overrides use exact absolute paths; plain entries add resources.
      for (const row of loose.filter((r) => r.type === type)) for (const value of Array.isArray(settings[type]) ? settings[type] : []) {
        if (typeof value === "string" && /^[+-]/.test(value) && real(localPath(value.slice(1), base, homeDir)) === row.realPath) {
          row.enabled = value[0] === "+"; row.status = row.enabled ? "configured" : "disabled";
        }
      }
    }
  }
  const plugins = [...packages.values()].map((p) => ({ name: p.name, source: p.source, path: p.root, origin: p.scope, configured: p.configured, installed: exists(p.root), status: !p.configured ? "discovered" : exists(p.root) ? "configured" : "missing", trust: p.scope === "project" ? "project-trust-required" : "user-global", loaded: false }));
  const resources = new Map();
  for (const p of packages.values()) for (const r of packageResources(p, notes)) resources.set(`${r.type}:${r.realPath}`, r);
  for (const r of loose) resources.set(`${r.type}:${r.realPath}`, r);
  for (const r of loose.filter((r) => r.type === "extensions")) plugins.push({ ...r, source: "extension", installed: true });
  return { plugins, resources: [...resources.values()], notes: [...new Set(notes)] };
}

/** The selected runner is optional. Presence/configuration is not live readiness. */
export function readPiRunner(opts = {}) {
  const { plugins, resources } = readPiResources(opts);
  const runner = plugins.find((p) => p.name === "pi-subagents-lite");
  const enabled = runner && resources.some((r) => r.type === "extensions" && r.source === runner.source && r.enabled);
  return { name: runner ? "pi-subagents-lite" : null, tool: runner ? "Agent" : null, configured: !!runner?.configured, installed: !!runner?.installed, status: !runner ? "unknown" : !runner.installed ? "missing" : !runner.configured ? "discovered" : enabled ? "configured" : "disabled", ready: false, note: "Pi core has no built-in subagents; confirm Agent is loaded in the live session before spawning." };
}

/** Read the six documented adapter layers, preserving same-name provenance.
 * Only safe metadata leaves this boundary. No endpoints, commands or auth data.
 * @param {{piDir?:string,projectDir?:string,homeDir?:string}} [opts]
 */
export function readPiMcps(opts = {}) {
  const piDir = resolvePiAgentDir(opts.piDir), projectDir = opts.projectDir ?? process.cwd(), homeDir = opts.homeDir ?? home();
  const layers = [[path.join(homeDir, ".config", "mcp", "mcp.json"), "shared-global"], [path.join(homeDir, ".agents", "mcp.json"), "agents-global"], [path.join(homeDir, ".agents", "mcp", "mcp.json"), "agents-mcp-global"], [path.join(piDir, "mcp.json"), "pi-global"], [path.join(projectDir, ".mcp.json"), "shared-project"], [path.join(projectDir, ".pi", "mcp.json"), "pi-project"]];
  const rows = new Map();
  for (const [file, source] of layers) {
    const servers = readJson(file, {})?.mcpServers;
    if (!object(servers)) continue;
    for (const [name, definition] of Object.entries(servers)) {
      if (!object(definition)) continue;
      const previous = rows.get(name);
      const transport = typeof definition.url === "string" ? "http" : typeof definition.command === "string" ? "stdio" : typeof definition.socket === "string" ? "socket" : previous?.transport ?? "unknown";
      const disabled = Object.hasOwn(definition, "disabled") ? definition.disabled === true : previous?.disabled ?? false;
      rows.set(name, { name, source, provenance: [...(previous?.provenance ?? []), { source, path: file }], disabled, status: disabled ? "disabled" : "configured", transport, trust: source.endsWith("project") ? "project-trust-required" : previous?.trust ?? "user-global", connected: false });
    }
  }
  return [...rows.values()];
}
