// Resolve the exact companion argv without a prompt. A qualified model string
// can itself be another provider's model ID; never infer the provider from it.
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpc } from './pi-rpc.js';
import { processIdentity } from '../atomic-state.js';
import { linuxProcess } from '../runtime.js';
const [binary, cwd, model, effort] = process.argv.slice(2);
const argv = ['--mode', 'rpc', '--no-session', '--model', model, ...(effort ? ['--thinking', effort] : [])];
const rpc = new PiRpc(binary, argv, cwd);
let identity;
try {
  await new Promise((resolve, reject) => { rpc.child.once('spawn', resolve); rpc.child.once('error', reject); });
  identity = processIdentity(rpc.child.pid);
  const state = await rpc.request('get_state', {}, 10000);
  process.stdout.write(JSON.stringify({ providerId: state.data?.model?.provider || null, modelId: state.data?.model?.id || null, sessionId: state.data?.sessionId || null, isStreaming: state.data?.isStreaming, promptSent: false, argv }) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ reasonCode: error.code || 'PI_PREFLIGHT_FAILED', reason: error.message }) + '\n'); process.exitCode = 1; }
finally {
  rpc.child.stdin.end();
  for (let wait = 0; wait < 5 && !rpc.closed; wait++) await delay(100);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const actual = linuxProcess(rpc.child.pid);
    if (!rpc.closed && actual?.startIdentity === identity?.startIdentity && actual.processGroup === rpc.child.pid) { try { process.kill(-rpc.child.pid, signal); } catch {} await delay(200); }
  }
}
