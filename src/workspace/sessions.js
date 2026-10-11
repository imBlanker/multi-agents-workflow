// Host-neutral session producer. Hooks supply real host session IDs; no task
// framework, background daemon, host-home discovery, or generated fake IDs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { workspaceLayout, assertNativePath } from "./backend.js";

export function recordSession(project, action, input, now = new Date().toISOString()) {
  const layout = workspaceLayout(project);
  if (!layout.native) throw new Error("session recording requires a native MAWF workspace marker");
  if (!["start", "heartbeat", "stop"].includes(action)) throw new Error("session action must be start, heartbeat, or stop");
  const id = input.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(id)) throw new Error("session id must be a safe single filename segment (1–160 characters)");
  const dir = assertNativePath(project, layout.sessions);
  fs.mkdirSync(dir, { recursive: true });
  const file = assertNativePath(project, `${layout.sessions}/${id}.json`);
  // Atomic rename protects bytes, but a cross-process lock protects the state
  // transition. Never break an unknown writer's lock on a timer.
  const lock = path.join(dir, `.${id}.lock`);
  const deadline = Date.now() + 2000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`session writer lock busy: ${lock}; retry or inspect a terminated writer`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    assertNativePath(project, `${layout.sessions}/${id}.json`);
    return updateSession(file, dir, action, input, now);
  } finally { fs.rmdirSync(lock); }
}

function updateSession(file, dir, action, input, now) {
  const id = input.id;
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) throw new Error("invalid existing session record");
  if (action === "heartbeat" && prior.status === "stopped") throw new Error("session has stopped; use start to resume explicitly");
  const record = {
    ...prior, session_id: id,
    platform: typeof input.platform === "string" ? input.platform : prior.platform ?? "unknown",
    current_task: typeof input.task === "string" ? input.task : prior.current_task ?? null,
    started_at: action === "start" ? now : prior.started_at ?? now,
    last_seen_at: now,
    status: action === "stop" ? "stopped" : "active",
    ended_at: action === "stop" ? now : null,
  };
  const temp = path.join(dir, `.${id}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return record;
}

export function runSession(args, flags) {
  try {
    // Explicit --id never waits on stdin. Hook JSON is opt-in with --stdin.
    const input = flags.stdin === true ? JSON.parse(fs.readFileSync(0, "utf8") || "{}") : {};
    const hookActions = { SessionStart: "start", SessionEnd: "stop", UserPromptSubmit: "heartbeat", PostToolUse: "heartbeat", Stop: "heartbeat" };
    const action = args[0] === "hook" ? hookActions[input.hook_event_name] : args[0];
    const record = recordSession(flags.project || input.cwd || process.cwd(), action, {
      id: flags.id || input.session_id || input.sessionId,
      platform: flags.platform || input.platform,
      task: flags.task ?? input.current_task,
    });
    if (flags.json === true) console.log(JSON.stringify(record));
    return 0;
  } catch (error) {
    console.error(`mawf session: ${error.message}`);
    return 1;
  }
}
