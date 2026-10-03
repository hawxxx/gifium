import { optimize, inspect } from '../dist/index.js';
import { fixture, render, atTime } from '../test/fixtures.mjs';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';

const corpus = [
  ['moving-sprite', { width: 96, height: 64, frames: 24, scene: 'sprite' }],
  ['repeated-still', { width: 96, height: 64, frames: 24, scene: 'still' }],
  ['gradient', { width: 96, height: 64, frames: 24, gradient: true }],
  ['palette-noise', { width: 96, height: 64, frames: 24, gradient: true, scene: 'noise' }],
  ['transparent-disposal', { width: 64, height: 48, frames: 24, partial: true, transparent: true, disposal: 3,
    delay: i => i % 3 === 0 ? 5 : 4 }],
];
const runs = 3;
const rows = [];
for (const [name, config] of corpus) {
  const input = fixture(config);
  const original = render(input);
  for (const preset of ['lossless', 'gentle', 'balanced', 'small']) {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await optimize(input, { preset }));
    const result = results[0];
    const decoded = render(result.data);
    let squared = 0, components = 0, mismatches = 0;
    const duration = inspect(input).durationMs;
    // Duration-weighted, straight RGBA channel error on the 10 ms GIF clock.
    // This is a pixel diagnostic, not a perceptual quality metric.
    for (let t = 0; t < duration; t += 10) {
      const a = atTime(original.frames, t), b = atTime(decoded.frames, t);
      for (let p = 0; p < a.length; p++) {
        const delta = a[p] - b[p]; squared += delta * delta; components++;
        if (delta !== 0) mismatches++;
      }
    }
    const times = results.map(r => r.elapsedMs).sort((a, b) => a - b);
    const hash = data => createHash('sha256').update(data).digest('hex');
    rows.push({ name, preset, inputSha256: hash(input), inputBytes: input.length,
      outputBytes: result.data.length, savedPercent: +result.savedPercent.toFixed(3),
      medianMs: +times[1].toFixed(3), firstMs: +results[0].elapsedMs.toFixed(3),
      rgbaRmse: +Math.sqrt(squared / components).toFixed(4),
      exactPixels: mismatches === 0, durationMs: result.output.durationMs,
      loopPreserved: decoded.loop === original.loop,
      deterministic: results.every(r => hash(r.data) === hash(result.data)),
      usedOriginal: result.usedOriginal, warnings: result.warnings });
  }
}
console.log(JSON.stringify({ methodologyVersion: 1, measuredAt: new Date().toISOString(),
  node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
  runsPerCase: runs, runtimeDependency: 'gifsicle-wasm@1.96.4',
  processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  memoryNote: 'Process lifetime peak includes Node, workers, independent decoding, fixtures, and all cases; not per-image codec memory.',
  rows }, null, 2));
