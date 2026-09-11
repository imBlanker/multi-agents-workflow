import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function findExecutable(name, { env = process.env, paths = (env.PATH || "").split(":") } = {}) {
  for (const candidate of name.includes("/") ? [name] : paths.map((dir) => path.join(dir || ".", name))) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

export const run = (command, args = [], options = {}) => spawnSync(command, args, options);

export function projectProcessAlive(dir, runner = run) {
  // pgrep accepts a regex; escape project paths so punctuation stays literal.
  const pattern = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = runner("pgrep", ["-f", "--", pattern], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 && !!r.stdout?.trim();
}

export function portOwner(port, runner = run) {
  const options = { encoding: "utf8", timeout: 5000 };
  const lsof = runner("lsof", ["-ti", `tcp:${port}`], options);
  const pid = lsof.stdout?.trim().split(/\r?\n/)[0];
  if (lsof.status === 0 && /^\d+$/.test(pid || "")) return pid;
  const ss = runner("ss", ["-ltnp"], options);
  return ss.stdout?.split(/\r?\n/).find((line) => line.includes(`:${port} `))?.match(/pid=(\d+)/)?.[1] || null;
}

export function dshLaunch(pid) {
  return pid ? `kill -9 ${pid} && dsh web` : "kill -9 $(lsof -ti tcp:3080) && dsh web";
}

export const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
export const commandText = (command, args = []) => [command, ...args].map(quote).join(" ");

export function sessionSlugs(cwd) {
  const encoded = cwd.replace(/[/\\]/g, "-");
  return { claude: "-" + encoded.replace(/^-+/, ""), pi: "--" + (encoded.replace(/^-+|-+$/g, "") || "root") + "--" };
}
