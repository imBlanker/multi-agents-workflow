// The upstream client returns a sanitized auth/provider summary. Never expose
// raw account/config responses or read credential files in this wrapper.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [pluginRoot, cwd] = process.argv.slice(2);
const { getCodexAuthStatus } = await import(pathToFileURL(path.join(pluginRoot, 'scripts', 'lib', 'codex.mjs')).href);
const result = await getCodexAuthStatus(cwd);
process.stdout.write(JSON.stringify({ available: result.available, loggedIn: result.loggedIn, authMethod: result.authMethod, verified: result.verified, requiresOpenaiAuth: result.requiresOpenaiAuth, provider: result.provider, source: result.source }) + '\n');
