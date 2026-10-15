// @ts-check
// Small, dependency-free helpers shared across the engine.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** @returns {string} */
export function home() {
  return os.homedir();
}

/** @param {string} p */
export function expand(p) {
  if (!p) return p;
  if (p === "~") return home();
  if (p.startsWith("~/")) return path.join(home(), p.slice(2));
  if (p.startsWith("~" + path.sep)) return path.join(home(), p.slice(2));
  return path.resolve(p);
}

/** @param {string} dir */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} file @param {string} [data] @param {object} [opts] */
export function writeText(file, data, opts) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data ?? "", opts ?? {});
  return file;
}

/** @param {string} file */
export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/** @param {string} file @param {any} obj */
export function writeJson(file, obj) {
  return writeText(file, JSON.stringify(obj, null, 2) + "\n");
}

/** @param {string} file @param {any} [fallback] */
export function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

/** @param {string} file @returns {boolean} */
export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file @returns {boolean} */
export function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {unknown} v
 * @param {string} msg
 */
export function assert(v, msg) {
  if (!v) throw new Error(msg);
}

/** @param {number} n @param {number} d */
export function round(n, d = 4) {
  const m = 10 ** d;
  return Math.round((n + Number.EPSILON) * m) / m;
}

/** @param {string} s */
export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/** @param {string} s */
export function yamlQuote(s) {
  if (s == null) return "''";
  const str = String(s);
  if (/^[\d.\-+]/.test(str) || /[:#\[\]{},&\*!|>'"%@`]/.test(str) || str === "" || str === "true" || str === "false" || str === "null") {
    return JSON.stringify(str);
  }
  return str;
}

/**
 * @param {Record<string, any>} obj
 * @param {number} [indent]
 */
export function toYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  if (obj === null || obj === undefined) return "";
  if (typeof obj !== "object") return String(obj);
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${pad}${k}:`);
      for (const item of v) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          lines.push(`${pad}- `);
          const sub = toYaml(item, indent + 2).replace(new RegExp("^" + " ".repeat(indent + 2), "gm"), " ".repeat(indent + 2)).trimStart();
          // indent the nested block under the dash
          lines[lines.length - 1] += sub.replace(/\n/g, "\n" + " ".repeat(indent + 2));
        } else {
          lines.push(`${pad}- ${yamlQuote(String(item))}`);
        }
      }
    } else if (typeof v === "object") {
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 2));
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${pad}${k}: ${String(v)}`);
    } else {
      lines.push(`${pad}${k}: ${yamlQuote(String(v))}`);
    }
  }
  return lines.join("\n") + (indent === 0 ? "\n" : "");
}

/** @param {string[]} xs @param {string} sep */
export function joinNl(xs, sep = "\n") {
  return xs.join(sep);
}

/**
 * Minimal YAML-subset parser for READING small user-authored config files
 * (e.g. dsh `$DSH_HOME/settings.yaml`). Supports: nested mappings, lists of
 * scalars, lists of mappings (`- key: value`), quoted strings, plain scalars
 * (number/boolean/null), simple flow sequences (`[a, b]`), and comments.
 * NOT supported (throws loudly instead of silently mis-parsing): `!!` tags,
 * anchors/aliases (`&a`/`*a`), merge keys (`<<`), multi-document markers
 * (`---`), tabs in indentation.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseYamlSubset(text) {
  /** @param {string} raw */
  function stripComment(raw) {
    let out = "";
    let q = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q) {
        if (c === q && raw[i - 1] !== "\\") q = null;
        out += c;
        continue;
      }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) break; // rest is a comment
      out += c;
    }
    return out;
  }
  /** @param {string} s */
  function unquote(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    return s;
  }
  /** @param {string} rest */
  function parseScalar(rest) {
    if (/^[&*]/.test(rest) || rest.startsWith("<<")) {
      throw new Error(`parseYamlSubset: unsupported construct: ${rest.slice(0, 40)}`);
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s) => parseScalar(s.trim()));
    }
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
      return rest.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return unquote(rest);
    if (rest === "true") return true;
    if (rest === "false") return false;
    if (rest === "null" || rest === "~") return null;
    if (/^-?\d+$/.test(rest)) return parseInt(rest, 10);
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(rest)) return parseFloat(rest);
    return rest;
  }

  /** @type {{indent: number, body: string}[]} */
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripComment(raw.replace(/\s+$/, ""));
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)(.*)$/);
    const indentStr = m[1];
    if (indentStr.includes("\t")) throw new Error("parseYamlSubset: tabs in indentation are not supported");
    const body = m[2].trim();
    if (body.includes("!!") || /^&|^\*|^---$|^<<\b/.test(body)) {
      throw new Error(`parseYamlSubset: unsupported construct: ${body.slice(0, 40)}`);
    }
    lines.push({ indent: indentStr.length, body });
  }
  if (!lines.length) return {};

  let pos = 0;
  function parseBlock(indent) {
    const first = lines[pos];
    if (first.body === "-" || first.body.startsWith("- ")) return parseList(indent);
    return parseMap(indent);
  }
  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Error(`parseYamlSubset: bad indentation at "${l.body.slice(0, 30)}"`);
      if (l.body === "-" || l.body.startsWith("- ")) throw new Error(`parseYamlSubset: list item where mapping expected: "${l.body.slice(0, 30)}"`);
      const m = l.body.match(/^("[^"]+"|'[^']+'|[^:\s"'][^:]*):(?:\s+(.*))?$/);
      if (!m) throw new Error(`parseYamlSubset: cannot parse line "${l.body.slice(0, 30)}"`);
      const key = unquote(m[1].trim());
      const rest = m[2] ? m[2].trim() : "";
      pos++;
      if (rest === "") {
        const next = lines[pos];
        // nested block: deeper indent, OR a same-indent list (common YAML style:
        // `models:` with `- id:` items at the same column)
        if (next && (next.indent > indent || (next.indent === indent && (next.body === "-" || next.body.startsWith("- "))))) {
          obj[key] = parseBlock(next.indent);
        } else obj[key] = null;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Error(`parseYamlSubset: bad indentation at "${l.body.slice(0, 30)}"`);
      if (!(l.body === "-" || l.body.startsWith("- "))) break; // end of this list
      const rest = l.body === "-" ? "" : l.body.slice(2).trim();
      if (rest === "") {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) arr.push(parseBlock(lines[pos].indent));
        else arr.push(null);
      } else {
        const kv = rest.match(/^("[^"]+"|'[^']+'|[^:\s"'][^:]*):(\s+(.*))?$/);
        if (kv) {
          // `- key: value` opens an inline mapping; sibling keys sit at indent+2
          const saved = lines[pos];
          lines[pos] = { indent: l.indent + 2, body: rest };
          arr.push(parseMap(l.indent + 2));
          if (lines[pos] === undefined) { /* consumed to EOF */ }
          void saved;
        } else {
          arr.push(parseScalar(rest));
          pos++;
        }
      }
    }
    return arr;
  }

  const value = parseBlock(lines[0].indent);
  if (pos !== lines.length) throw new Error("parseYamlSubset: trailing content could not be parsed");
  return value;
}

/** @returns {number} epoch seconds */
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** @returns {string} ISO timestamp */
export function isoNow() {
  return new Date().toISOString();
}

/** Resolve the user-selected Pi home without reading its contents. */
export function resolvePiAgentRoot(piDir) {
  return piDir ?? (process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(home(), '.pi', 'agent'));
}
