// Persistent Pi RPC connection: correlated responses and full-chain idle events.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { stateError } from '../atomic-state.js';
export class PiRpc extends EventEmitter {
  constructor(binary, argv, cwd, onEvent = () => {}) {
    super(); this.pending = new Map(); this.buffer = ''; this.closed = false;
    this.child = spawn(binary, argv, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => { this.closed = true; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(stateError('RPC_CLOSED', 'Pi RPC exited before a response')); } this.pending.clear(); resolve({ code, signal }); }));
    this.child.once('error', error => { for (const item of this.pending.values()) item.reject(error); });
    this.child.stdout.on('data', bytes => {
      this.buffer += bytes.toString('utf8');
      if (this.buffer.length > 8 * 1024 * 1024) { this.emit('protocol-error', stateError('RPC_OUTPUT_LIMIT', 'Pi RPC frame exceeded 8 MiB')); this.buffer = ''; return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { this.emit('protocol-error', stateError('RPC_INVALID_JSON', 'Pi emitted a non-JSON RPC line')); continue; }
        onEvent(event); this.emit('event', event);
        if (event.type === 'response' && this.pending.has(event.id)) {
          const item = this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(item.timer);
          if (event.success === false) item.reject(stateError('RPC_COMMAND_FAILED', event.error || `${event.command} failed`)); else item.resolve(event);
        }
      }
    });
    this.child.stderr.on('data', bytes => this.emit('stderr', bytes));
  }
  request(type, fields = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(stateError('RPC_CLOSED', 'Pi RPC is closed'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(stateError('RPC_TIMEOUT', `${type} did not respond within ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...fields, type, id }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async stop() {
    const steps = [];
    for (const [type, fields] of [['prompt', { message: '/autoresearch off' }], ['clear_queue', {}], ['abort', {}]]) {
      try { steps.push({ type, response: await this.request(type, fields, 5000) }); } catch (error) { steps.push({ type, error: error.code || error.message }); }
    }
    try { steps.push({ type: 'get_state', response: await this.request('get_state', {}, 5000) }); } catch (error) { steps.push({ type: 'get_state', error: error.code || error.message }); }
    this.child.stdin.end();
    return steps;
  }
}
