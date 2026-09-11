import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { platformFor } from "../src/platform/index.js";

test("native Windows probes find only the fixture project process and loopback listener", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawf probe 项目-"));
  const script = path.join(dir, "listener.cjs");
  fs.writeFileSync(script, "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>console.log(server.address().port));setTimeout(()=>process.exit(),20000);");
  const child = spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exit = once(child, "exit");
  t.after(async () => { child.kill(); await exit; fs.rmSync(dir, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  lines.close();
  const platform = platformFor();
  assert.equal(platform.portOwner(Number(line)), String(child.pid));
  let processProbe;
  const alive = platform.projectProcessAlive(dir, (...args) => (processProbe = platform.run(...args)));
  assert.equal(alive, true, JSON.stringify({ status: processProbe.status, error: processProbe.error?.message, stdout: processProbe.stdout, stderr: processProbe.stderr, childExit: child.exitCode }));
  assert.equal(platform.projectProcessAlive(path.join(dir, "not-running")), false);
});

test("session directory encodings preserve POSIX and match native Windows Claude names", () => {
  assert.deepEqual(platformFor("linux").sessionSlugs("/home/dev/my-project"), { claude: "-home-dev-my-project", pi: "--home-dev-my-project--" });
  assert.deepEqual(platformFor("win32").sessionSlugs("C:\\Users\\dev\\my-project"), { claude: "C--Users-dev-my-project", pi: "--C--Users-dev-my-project--" });
});
