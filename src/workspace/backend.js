// Explicit native-workspace opt-out. Missing marker retains the legacy adapter;
// an invalid marker must never silently re-enable lifecycle execution.
import fs from "node:fs";
import path from "node:path";

export function workspaceLayout(projectDir) {
  const root = path.resolve(projectDir);
  const marker = path.join(root, ".mawf", "workspace.json");
  let raw;
  try { raw = fs.readFileSync(marker, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A broken parent or marker link is not proof of an absent opt-out.
    // A valid legacy .mawf directory link without a marker remains supported.
    for (const candidate of [path.dirname(marker), marker]) {
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()
            && (candidate === marker || !fs.existsSync(candidate))) {
          throw new Error(`invalid workspace marker symlink: ${candidate}`);
        }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return { backend: "trellis", native: false, tasks: ".trellis/tasks", specs: ".trellis/spec", sessions: ".trellis/.runtime/sessions", artifacts: [".trellis/tasks", "docs/architecture"] };
  }
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error(`invalid workspace marker JSON: ${marker}`); }
  if (!config || Array.isArray(config) || config.version !== 1 || config.backend !== "mawf" || config.trellis !== false) {
    throw new Error(`unsupported workspace marker: expected version=1, backend=mawf, trellis=false (${marker})`);
  }
  for (const rel of [".mawf/workspace.json", "docs/plans", "docs/engineering/specs", "docs/history/tasks", ".mawf/runtime/sessions"]) {
    assertNativePath(root, rel);
  }
  return { backend: "mawf", native: true, tasks: "docs/plans", specs: "docs/engineering/specs", sessions: ".mawf/runtime/sessions", artifacts: ["docs/plans", "docs/history/tasks", "docs/architecture"] };
}

// Fixed native storage paths cannot follow symlinks, including missing leaves
// below an existing symlink. Avoid writing/reading outside the workspace.
export function assertNativePath(root, relative) {
  let current = path.resolve(root);
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("invalid native workspace path");
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`native workspace storage cannot be a symlink: ${current}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}
