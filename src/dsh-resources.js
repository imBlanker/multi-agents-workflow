// @ts-check
// Static, read-only dsh filesystem evidence. This is not a live skill catalog:
// custom composed roots, injected providers and host registration remain unknown.
import fs from "node:fs";
import path from "node:path";
import { home, exists, readText, parseYamlSubset } from "./util.js";

function projectRoot(cwd) {
  let current = path.resolve(cwd);
  while (!exists(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
  return current;
}

/** Documented dsh-skill-filesystem default ranks; lowest rank wins. */
export function dshSkillRoots({ dshHome, projectDir, agentsHome, env = process.env }) {
  const project = projectRoot(projectDir);
  return [
    { path: path.join(project, ".dsh", "skills"), source: "project-dsh", rank: 100 },
    { path: path.join(project, ".agents", "skills"), source: "project-agents", rank: 200 },
    { path: path.join(dshHome, "skills"), source: "user-dsh", rank: 400 },
    { path: path.join(agentsHome || env.DSH_AGENTS_HOME || path.join(home(), ".agents"), "skills"), source: "user-agents", rank: 500 },
    ...(env.DSH_BUNDLED_SKILL_DIR ? [{ path: env.DSH_BUNDLED_SKILL_DIR, source: "bundled", rank: 600 }] : []),
  ];
}

function invocationFlag(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "yes", "on", "1"].includes(String(value).toLowerCase())) return true;
  if (["false", "no", "off", "0"].includes(String(value).toLowerCase())) return false;
  return null;
}

/**
 * Immediate bundle/flat skills only. Preserve losing candidates as shadowed
 * evidence; .system and malformed required metadata never become discoveries.
 */
export function readDshSkills(opts) {
  const out = [];
  const winners = new Map();
  for (const root of dshSkillRoots(opts)) {
    let entries;
    try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const file = entry.isDirectory() ? path.join(root.path, entry.name, "SKILL.md")
        : entry.isFile() && entry.name.endsWith(".md") ? path.join(root.path, entry.name) : null;
      if (!file) continue;
      try {
        const match = readText(file).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
        if (!match) continue;
        const meta = parseYamlSubset(match[1]);
        if (typeof meta.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64 || typeof meta.description !== "string" || !meta.description.trim()) continue;
        const disabled = invocationFlag(meta["disable-model-invocation"], false);
        const userInvocable = invocationFlag(meta["user-invocable"], true);
        if (disabled === null || userInvocable === null) continue;
        const shadowedBy = winners.get(meta.name);
        if (!shadowedBy) winners.set(meta.name, file);
        out.push({ name: meta.name, description: meta.description, path: file,
          source: root.source, rank: root.rank, provenance: root.path,
          status: shadowedBy ? "shadowed" : "discovered", shadowedBy: shadowedBy || null,
          modelInvocable: !disabled, userInvocable, loaded: null });
      } catch { /* unsupported metadata is not a loaded skill */ }
    }
  }
  return out;
}

/** Installed library entries are inert; no preset code/YAML is evaluated. */
export function readDshPresets({ dshHome }) {
  const dir = path.join(dshHome, "agent-presets");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), source: "agent-preset-library",
        status: "staged", enabled: false, provenance: dir }));
  } catch { return []; }
}
