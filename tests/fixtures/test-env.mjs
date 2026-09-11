// Isolate each Node test-file process from developer configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach } from "node:test";

const controlled = /^(?:HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_AGENT_DIR|DSH_HOME|DSH_AGENTS_HOME|DSH_BUNDLED_SKILL_DIR|CC_SWITCH_DB|TRELLIS_BIN|MAW_.*|CLAUDECODE|CODEX_THREAD_ID)$/i;
export function fixtureEnv(home, overrides = {}, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !controlled.test(key)));
  return { ...env, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), PI_AGENT_DIR: path.join(home, ".pi", "agent"), DSH_HOME: path.join(home, ".dsh"),
    CC_SWITCH_DB: path.join(home, ".cc-switch", "cc-switch.db"),
    MAW_WATCHDOG_REGISTRY: path.join(home, ".mawf", "projects.json"), ...overrides };
}

export function setHome(home) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const original = { ...process.env };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-test-home-"));
for (const key of Object.keys(process.env)) if (controlled.test(key)) delete process.env[key];
// Host overrides stay absent so tests may pass their own home/directory options.
process.env.HOME = home;
process.env.USERPROFILE = home;
let beforeTest;
beforeEach(() => { beforeTest = { ...process.env }; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in beforeTest)) delete process.env[key];
  Object.assign(process.env, beforeTest);
});
process.once("exit", () => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(error.code)) throw error;
    if (error.code === "EPERM" && fs.readdirSync(home).length !== 0) throw error;
    // A Windows child/tool can retain a directory handle beyond test exit.
    // Preserve every test result and report the leftover fixture explicitly.
    console.warn(`Temporary test home remains locked after cleanup retries: ${home}`);
  }
});
