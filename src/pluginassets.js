import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BUNDLED_CLI = "node --input-type=commonjs -e \"Promise.resolve().then(()=>import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.CLAUDE_PLUGIN_ROOT,'../src/index.js')).href)).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})\" --";

// Copied command files have no CLAUDE_PLUGIN_ROOT. Resolve against the package
// that installed them; update/upgrade regenerates these paths for both hosts.
export function materializePluginAssets(files, packageRoot) {
  const entry = Buffer.from(pathToFileURL(path.join(packageRoot, "src", "index.js")).href).toString("base64");
  const invocation = `node --input-type=commonjs -e "import(Buffer.from('${entry}','base64').toString()).then(m=>m.main(process.argv.slice(1))).catch(e=>{console.error(e.message);process.exitCode=1})" --`;
  for (const file of files) {
    if (file.endsWith(".md")) {
      const source = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, source.replaceAll(BUNDLED_CLI, invocation));
    } else if (path.basename(file) === "hooks.json") {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      // URL encoded module name has no shell metacharacters; import invokes the
      // same guard as the bundled plugin, including stdin and fail-closed exit.
      const module = Buffer.from(pathToFileURL(path.join(packageRoot, "bin", "guard.mjs")).href).toString("base64");
      const launch = `node -e "import(Buffer.from('${module}','base64').toString()).then(m=>m.main()).catch(()=>process.exit(2))"`;
      for (const event of config.hooks.PreToolUse) for (const hook of event.hooks) hook.command = launch;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
  }
}
