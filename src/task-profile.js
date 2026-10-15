import path from 'node:path';
import { readJson } from './util.js';

/**
 * Derive a task profile from project artifacts when --task was not given.
 * @param {string} projectDir
 * @returns {{ text: string, difficulty: number }}
 */
export function deriveTaskProfile(projectDir) {
  let text = "";
  let difficulty = 3;
  const wf = readJson(path.join(projectDir, ".mawf", "workflow.json"), null);
  if (wf) {
    const parts = [wf.name, wf.primary, ...(Array.isArray(wf.rationale) ? wf.rationale : [])].filter(Boolean);
    text = parts.join(". ");
    const primary = String(wf.primary || "");
    if (/multi-agent|orchestrator-workers/.test(primary)) difficulty = 4;
    else if (/loop|dynamic/.test(primary)) difficulty = 3;
    else difficulty = 2;
  }
  if (!text) text = "project work (no plan artifacts)";
  return { text, difficulty };
}

