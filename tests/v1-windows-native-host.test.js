import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateSettings } from '../src/settings.js';
import { createRun, addTask, runtimeStatus } from '../src/runtime.js';
import { executeNative } from '../src/native-host.js';

test('Windows native controller uses the broker, captures actual host events and releases its job', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mawf-win-host-')));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin'), project = path.join(root, 'project');
  for (const dir of [home, bin, project]) fs.mkdirSync(dir);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + process.env.PATH });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0fixture.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'fixture.cjs'), `
    const {spawn}=require('child_process');
    if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'firstParty'}));process.exit(0);}
    const args=process.argv.slice(2);
    if(args[args.indexOf('--tools')+1]!=='Agent,TaskOutput,TaskStop')process.exit(2);
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-host-session',model:'fixture-model'}));
    const config=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.mawf_windows;
    const server=spawn(config.command,config.args,{stdio:['pipe','pipe','inherit']});
    let buffer='';server.stdout.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\\n'))>=0){
      const reply=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(reply.id===1)server.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'core',arguments:{args:['task','status','--task-id','controller']}}})+'\\n');
      if(reply.id===2){if(reply.result.isError){console.error(JSON.stringify(reply));process.exitCode=3;}server.stdin.end();}
    }});
    server.on('close',code=>{console.log(JSON.stringify({type:'result',is_error:code!==0,result:'fixture produced'}));});
    server.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})+'\\n');
  `);
  updateSettings(project, draft => {
    draft.integrations['host.claude-code'] = { enabled: true, options: {} };
    draft.pricing.unknownPricePolicy = draft.pricing.unknownCoveragePolicy = 'bounded';
    draft.pricing.bounds = { maxConcurrency: 2, maxDurationMs: 15000 };
    draft.cost.enforcement = 'best_effort';
    draft.verification.minIndependentHackers = 0;
    draft.verification.requireRealUserPath = false;
    draft.verification.requireCounterexamples = false;
    draft.verification.requiredCapabilities = [];
  });
  await createRun({ project, runId: 'native-windows' });
  addTask({ project, runId: 'native-windows', taskId: 'controller', adapter: 'claude-native', coordinationOnly: true, role: 'orchestrator', providerId: 'anthropic', modelId: 'fixture-model', billingMode: 'subscription', maxDurationMs: 15000 });
  const result = await executeNative({ project, runId: 'native-windows', taskId: 'controller', description: 'No-model broker integration fixture' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const state = runtimeStatus({ project, runId: 'native-windows', taskId: 'controller' });
  assert.equal(state.leases[0].status, 'released');
  assert.equal(state.task.adapterState.sessionId, 'fixture-host-session');
  assert.equal(state.task.adapterState.selectionGate.allowed, true);
});
