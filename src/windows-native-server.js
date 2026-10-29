// Minimal MCP stdio transport; no HTTP listener, tokens, or ambient shell bridge.
import fs from 'node:fs';
import readline from 'node:readline';
import { WINDOWS_TOOLS, runWindowsTool } from './windows-native-tools.js';
const policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
// Serialize calls so per-invocation filesystem grants cannot overlap each other.
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try {
    if (line.length > 1024 * 1024) throw new Error('MCP request too large');
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mawf-windows', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: WINDOWS_TOOLS };
    else if (message.method === 'tools/call') {
      try {
        const output = await runWindowsTool(message.params.name, message.params.arguments || {}, policy);
        result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: output.code !== 0 };
      } catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32602, message: error.message } }); }
}
