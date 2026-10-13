import fs from 'node:fs';
import { superviseExperiment } from './session.js';
try { process.stdout.write(JSON.stringify(await superviseExperiment(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, reasonCode: error.code || 'EXPERIMENT_WORKER_ERROR', reason: error.message, resourcesMayRemainReserved: true }) + '\n'); process.exitCode = 1; }
