import { parseYamlSubset } from "./util.js";

// Read only component metadata from dsh's display dump. The payload may contain
// JS-tagged YAML: never evaluate it or treat nested config.disabled as a flag.
export function parseDshPlugins(dump) {
  const out = [];
  let origin = "";
  let current = null;
  const flush = () => {
    if (current?.id && current.name) out.push({
      id: current.id, name: current.name,
      status: current.disabled ? "disabled" : "active",
      origin: current.origin, source: "dump-config",
    });
    current = null;
  };
  const scalar = (raw) => {
    try { return parseYamlSubset(`value: ${raw}`).value; } catch { return undefined; }
  };
  for (const line of String(dump).split(/\r?\n/)) {
    const header = line.match(/^# == (.+)$/);
    if (header) { flush(); origin = header[1].trim(); continue; }
    const entry = line.match(/^- (id|name):[ \t]*(.+)$/);
    if (entry) {
      flush();
      const value = scalar(entry[2]);
      if (typeof value === "string" && value) current = { [entry[1]]: value, origin, disabled: false };
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("#")) { flush(); continue; }
    const field = line.match(/^ {2}(id|name|disabled):[ \t]*(.*)$/);
    if (!current || !field) continue;
    const value = scalar(field[2]);
    if (["id", "name"].includes(field[1]) && typeof value === "string") current[field[1]] = value;
    if (field[1] === "disabled") current.disabled = value === true;
  }
  flush();
  return out;
}
