// Product measurement only: correctness is independently supplied by a Hacker.
import { performance } from 'node:perf_hooks';
import { sumTo } from './target.mjs';
const inputs = [1000003, 2357113, 4987651, 8000009];
let sink = 0;
for (let warmup = 0; warmup < 3; warmup++) for (const n of inputs) sink += sumTo(n);
const samples = [];
for (let sample = 0; sample < 7; sample++) {
  const started = performance.now();
  for (const n of inputs) sink += sumTo(n + sample);
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
console.log(`METRIC median_ms=${samples[3]}`);
console.log(JSON.stringify({ samplesMs: samples, inputs, sink }));
