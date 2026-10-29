import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const envValue = (env, key) => env[Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase())] || "";

export function findExecutable(name, { env = process.env, paths = envValue(env, "PATH").split(";") } = {}) {
  const extensions = envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const names = path.win32.extname(name) ? [name] : extensions.split(";").filter(Boolean).map((ext) => name + ext);
  for (const dir of /[\\/]/.test(name) ? [""] : paths) {
    for (const file of names) {
      const candidate = dir ? path.join(dir.replace(/^"|"$/g, ""), file) : file;
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}

// cmd.exe expands percent variables even inside quotes. Pass arguments through
// environment expansion (one expansion pass), never by interpolating shell data.
// /v:off preserves !; quotes protect metacharacters. Embedded quotes/newlines
// cannot be represented safely for arbitrary batch programs and fail explicitly.
function nodeShimEntry(executable) {
  try {
    const source = fs.readFileSync(executable, "utf8");
    // Only direct cmd-shim launch lines qualify, never comments, extra Node
    // flags, or an unrelated batch program that happens to mention Node.
    const invocation = /^[ \t]*@?(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?("%_prog%"|"%~dp0[\\/]node\.exe"|node(?:\.exe)?) +"%(?:~dp0|dp0%)[\\/]?([^"\r\n]+)" +%\*[ \t]*\r?$/im;
    const match = source.match(invocation);
    if (!match) return null;
    if (match[1].toLowerCase() === '"%_prog%"') {
      const assignments = [...source.matchAll(/^[ \t]*SET "_prog=([^"\r\n]+)"[ \t]*\r?$/gim)];
      if (!assignments.length || assignments.some(([, value]) => !/^(?:node|%(?:~dp0|dp0%)[\\/]node\.exe)$/i.test(value))) return null;
    }
    const scaffold = /^(?:echo off|setlocal|endlocal|goto start|:find_dp0|:start|call :find_dp0|exit \/b|set dp0=%~dp0|if exist "%(?:~dp0|dp0%)[\\/]node\.exe" \(|\) else \(|\)|set "_prog=(?:node|%(?:~dp0|dp0%)[\\/]node\.exe)"|set PATHEXT=%PATHEXT:;\.JS;=;%)$/i;
    if (source.split(/\r?\n/).some((line) => {
      const text = line.trim().replace(/^@/, "");
      return text && !scaffold.test(text) && !invocation.test(text);
    })) return null;
    const entry = path.resolve(path.dirname(executable), match[2]);
    return fs.statSync(entry).isFile() ? entry : null;
  } catch { return null; }
}

// Async controlled launches cannot use cmd.exe shell reinterpretation. Native
// binaries and recognized npm Node shims have an exact executable/argv mapping.
export function nativeInvocation(command, args = []) {
  const executable = findExecutable(command) || command;
  if (!/\.(cmd|bat)$/i.test(executable)) return [executable, ...args];
  const entry = nodeShimEntry(executable);
  if (entry) return [process.execPath, entry, ...args];
  // npm also generates a direct native-binary shim. Match its entire scaffold
  // so custom wrapper logic is never silently dropped or interpreted as a shell.
  const source = fs.readFileSync(executable, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const native = /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%[\\/]([^"%\n]+\.exe)"[ \t]+%\*[ \t]*\n?$/i.exec(source);
  const target = native && path.resolve(path.dirname(executable), native[1]);
  if (target && fs.statSync(target).isFile()) return [target, ...args];
  throw Object.assign(new Error('Controlled Windows launches require a native executable or recognized npm shim'), { code: 'WINDOWS_NATIVE_SHIM_UNSUPPORTED' });
}

export function run(command, args = [], options = {}) {
  const env = options.env || process.env;
  const executable = findExecutable(command, { env }) || command;
  if (!/\.(cmd|bat)$/i.test(executable)) return spawnSync(executable, args, options);
  const entry = nodeShimEntry(executable);
  if (entry) return spawnSync(process.execPath, [entry, ...args], options);
  if ([executable, ...args].some((arg) => /["\r\n\0]/.test(String(arg)))) {
    return { status: null, signal: null, stdout: null, stderr: null, error: Object.assign(new Error("Batch arguments cannot contain quotes, newlines, or NUL; use a native executable or Node entry point"), { code: "EINVAL" }) };
  }
  const childEnv = { ...env };
  const tokens = [executable, ...args].map((arg, index) => {
    const key = `MAWF_BATCH_ARG_${index}`;
    if (String(arg) === "") return '""';
    childEnv[key] = String(arg).replace(/\\+$/, (tail) => tail + tail);
    return `"%${key}%"`;
  });
  return spawnSync(envValue(env, "COMSPEC") || "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${tokens.join(" ")}"`], { ...options, env: childEnv, windowsVerbatimArguments: true });
}

// Git for Windows checks text out with CRLF by default (core.autocrlf=true), and so
// do the plugin clones hosts make. A pin of the committed LF bytes must match such a
// checkout too, so also offer the content with every CRLF turned back into LF.
export function checkoutVariants(bytes) {
  const text = bytes.toString("latin1");
  return text.includes("\r\n") ? [bytes, Buffer.from(text.replaceAll("\r\n", "\n"), "latin1")] : [bytes];
}

// fs.realpathSync keeps the caller's letter case and 8.3 short names. The native
// call returns the on-disk spelling, so one directory has one canonical path.
export function realpath(file) {
  try { return fs.realpathSync.native(file); } catch { return fs.realpathSync(file); }
}

// NTFS names are case-insensitive: compare one case-folded on-disk spelling. A
// missing tail keeps its own spelling below its deepest existing ancestor.
export function comparablePath(file) {
  const absolute = path.win32.resolve(file), parent = path.win32.dirname(absolute);
  let spelled;
  try { spelled = fs.realpathSync.native(absolute); }
  catch { spelled = parent === absolute ? absolute : path.win32.join(comparablePath(parent), path.win32.basename(absolute)); }
  return spelled.toLowerCase();
}

// Windows refuses to open or replace a file that another process holds at that
// moment (a reader during an atomic rename, or on Node 20 a file whose delete is
// still pending) with EPERM, EACCES or EBUSY. Retry those for about a second; a
// lasting permission error still fails, only that much later.
const SHARING_VIOLATIONS = new Set(["EPERM", "EACCES", "EBUSY"]);
export function retryTransient(operation, { attempts = 100, waitMs = 10 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (!SHARING_VIOLATIONS.has(error.code) || attempt >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export function projectProcessAlive(dir, runner = run) {
  const script = "$ErrorActionPreference='Stop'; $p=$env:MAWF_PROCESS_PROJECT; $found=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0 }); if($found.Count){'yes'}";
  const r = runner("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MAWF_PROCESS_PROJECT: dir } });
  return r.status === 0 && r.stdout?.trim() === "yes";
}

export function parsePortOwner(output, port) {
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "TCP" && fields[1]?.endsWith(`:${port}`) && fields[3] === "LISTENING" && /^\d+$/.test(fields[4])) return fields[4];
  }
  return null;
}
export function portOwner(port, runner = run) {
  const r = runner("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return r.status === 0 ? parsePortOwner(r.stdout, port) : null;
}
export function dshLaunch(pid) {
  return pid ? `Stop-Process -Id ${pid} -Force; dsh web` : "Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }; dsh web";
}
export const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
export const commandText = (command, args = []) => `& ${[command, ...args].map(quote).join(" ")}`;

// Claude's native Windows store encodes every non-alphanumeric character.
// Pi uses the portable separator/drive encoding and surrounding double dashes.
export function sessionSlugs(cwd) {
  return {
    claude: cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    pi: "--" + (cwd.replace(/[:/\\]/g, "-").replace(/^-+|-+$/g, "") || "root") + "--",
  };
}

export function pythonCommand(args, find = findExecutable) {
  const interpreter = find("python") || find("python3");
  if (interpreter) return commandText(interpreter, args);
  const launcher = find("py");
  return launcher ? commandText(launcher, ["-3", ...args]) : commandText("python", args);
}

// Windows ships bsdtar as %SystemRoot%\System32\tar.exe; prefer it to PATH
// order. Git Bash puts MSYS GNU tar first, which cannot read zip, takes the
// "C:" of an archive path for a remote host, and extracts a symlink to an
// existing file as a copy of that file, which a symlink scan of the extracted
// tree cannot see. Without the system tar, extraction refuses GNU tar.
export function tarCommand({ extract = false, env = process.env, exists = fs.existsSync, runner = run } = {}) {
  const bsdtar = path.win32.join(envValue(env, "SystemRoot") || "C:\\Windows", "System32", "tar.exe");
  if (exists(bsdtar)) return bsdtar;
  const fallback = findExecutable("tar", { env });
  if (!fallback) return "tar";
  if (extract && /GNU tar/.test(runner(fallback, ["--version"], { encoding: "utf8", env }).stdout ?? "")) {
    throw new Error(`${bsdtar} not found, and ${fallback} is GNU tar, which is not used to extract on Windows`);
  }
  return fallback;
}
