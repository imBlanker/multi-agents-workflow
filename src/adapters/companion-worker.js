import fs from 'node:fs';
import { superviseCompanion } from './companion.js';
const result = await superviseCompanion(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.ok === false ? 1 : 0;
