import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { workspaceLayout } from "../src/workspace/backend.js";
import { createProviders } from "../src/workspace/providers.js";
import { recordSession } from "../src/workspace/sessions.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mawf-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".mawf"));
  fs.writeFileSync(path.join(root, ".mawf/workspace.json"), '{"version":1,"backend":"mawf","trellis":false}');
  return root;
}

test("dangling marker parent cannot silently enable legacy lifecycle", (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, ".mawf"), { recursive: true });
  fs.symlinkSync(path.join(root, "missing"), path.join(root, ".mawf"), "junction");
  assert.throws(() => workspaceLayout(root), /symlink/);
});

test("a valid legacy state-directory link without a native marker stays supported", (t) => {
  const root = fixture(t);
  const external = fixture(t);
  fs.rmSync(path.join(root, ".mawf"), { recursive: true });
  fs.symlinkSync(external, path.join(root, ".mawf"), "junction");
  assert.equal(workspaceLayout(root).native, false);
});

test("native task and context leaf links never expose external contents", async (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const task = path.join(root, "docs/plans/demo");
  fs.mkdirSync(task, { recursive: true });
  fs.mkdirSync(path.join(root, "docs/engineering/specs/backend"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/engineering/specs/backend/contract.md"), "contract");
  const secret = path.join(outside, "private.json");
  fs.writeFileSync(secret, '{"title":"PRIVATE","file":"PRIVATE"}');
  try {
    fs.symlinkSync(secret, path.join(task, "task.json"));
    fs.symlinkSync(secret, path.join(task, "implement.jsonl"));
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows requires symlink privilege"); return; }
    throw error;
  }
  const p = createProviders({ projectDir: root, store: {} });
  assert.doesNotMatch(JSON.stringify(await p.project.tasks()), /PRIVATE/);
  await assert.rejects(p.project.get({ id: "demo" }), /symlink/);
  assert.deepEqual((await p.project.relations()).groups[0].files, []);
  assert.deepEqual((await p.project.specs()).files.map(x => x.rel), ["docs/engineering/specs/backend/contract.md"]);
});

test("a heartbeat paused before rename cannot overwrite a concurrent stop", { timeout: 10000 }, async (t) => {
  const root = fixture(t);
  recordSession(root, "start", { id: "real-session", platform: "codex" });
  const moduleUrl = new URL("../src/workspace/sessions.js", import.meta.url).href;
  const release = path.join(root, "release-heartbeat");
  const code = `import fs from 'node:fs';
    import {recordSession} from ${JSON.stringify(moduleUrl)};
    const [root,action,release] = process.argv.slice(1);
    if(action==='heartbeat') {
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        process.send('paused');
        const until = Date.now()+5000;
        while(!fs.existsSync(release)) {
          if(Date.now()>until) throw Error('barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        }
        return rename(...args);
      };
    }
    if(action==='stop') process.send('starting');
    recordSession(root,action,{id:'real-session'});
    process.disconnect();`;
  const start = (action) => spawn(process.execPath, ["--input-type=module", "-e", code, root, action, release], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const beat = start("heartbeat");
  t.after(() => { if (beat.exitCode === null) beat.kill(); });
  const beatExit = once(beat, "exit");
  await once(beat, "message");
  const stop = start("stop");
  t.after(() => { if (stop.exitCode === null) stop.kill(); });
  const stopExit = once(stop, "exit");
  await once(stop, "message");
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(release, "continue");
  assert.equal((await beatExit)[0], 0);
  assert.equal((await stopExit)[0], 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".mawf/runtime/sessions/real-session.json"))).status, "stopped");
});
