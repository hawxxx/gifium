import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, optimize, planFrameRate } from '../dist/index.js';
import { fixture, render, atTime } from './fixtures.mjs';

test('inspect preserves exact delays, dimensions and loop semantics', () => {
  for (const loop of [null, 0, 3]) {
    const info = inspect(fixture({ loop, frames: 7 }));
    assert.equal(info.width, 16); assert.equal(info.height, 12);
    assert.equal(info.frameCount, 7); assert.equal(info.durationMs, 280);
    assert.equal(info.loopCount, loop);
  }
});
test('bounds checks reject truncation, bad headers, and resource exhaustion', () => {
  const bytes = fixture();
  for (const b of [bytes.subarray(0, 12), bytes.subarray(0, bytes.length - 3), new Uint8Array(40)]) {
    assert.throws(() => inspect(b));
  }
  assert.throws(() => inspect(bytes, { maxFrames: 2 }));
  assert.throws(() => inspect(bytes, { maxPixels: 4 }));
  assert.throws(() => inspect(bytes, { maxDecodedPixels: 100 }));
});
for (const disposal of [1, 2, 3]) {
  for (const transparent of [false, true]) {
    test(`lossless displayed pixels and timing: disposal ${disposal}, transparent ${transparent}`, async () => {
      const input = fixture({ disposal, transparent, partial: transparent });
      const result = await optimize(input);
      assert.ok(result.data.length <= input.length);
      const a = render(input), b = render(result.data);
      assert.equal(b.loop, a.loop);
      assert.equal(inspect(result.data).durationMs, inspect(input).durationMs);
      for (let t = 0; t < inspect(input).durationMs; t += 10) {
        assert.deepEqual(atTime(b.frames, t), atTime(a.frames, t));
      }
    });
  }
}
test('resampling composes partial transparent frames before dropping any', async () => {
  for (const disposal of [1, 2, 3]) {
    const input = fixture({ partial: true, transparent: true, disposal });
    const a = render(input);
    const plan = planFrameRate(a.frames.map(f => f.delay), 10);
    const result = await optimize(input, { fps: 10 });
    const b = render(result.data);
    let t = 0;
    for (const sample of plan) {
      assert.deepEqual(atTime(b.frames, t), a.frames[sample.sourceIndex].rgba);
      t += sample.delayMs;
    }
    assert.equal(inspect(result.data).durationMs, inspect(input).durationMs);
  }
});
test('zero-delay input is preserved losslessly but cannot be retimed ambiguously', async () => {
  const input = fixture({ delay: 0 });
  assert.equal(inspect((await optimize(input)).data).durationMs, 0);
  await assert.rejects(optimize(input, { fps: 10 }), /zero|positive/i);
});
test('abort and invalid options fail without launching uncontrolled work', async () => {
  const c = new AbortController(); c.abort();
  await assert.rejects(optimize(fixture(), { signal: c.signal }), /abort/i);
  await assert.rejects(optimize(fixture(), { colors: 1 }));
  await assert.rejects(optimize(fixture(), { lossy: -1 }));
  await assert.rejects(optimize(fixture(), { timeoutMs: 0 }));
});
test('concurrent calls isolate codec state and finite/no-loop animations', async () => {
  const results = await Promise.all([null, 0, 2].map(loop => optimize(fixture({ loop }))));
  assert.deepEqual(results.map(r => inspect(r.data).loopCount), [null, 0, 2]);
});
test('palette and lossy options are explicit, including the transparency safeguard', async () => {
  const input = fixture({ gradient: true, width: 32, height: 24 });
  for (const dither of ['none','ordered','floyd-steinberg']) {
    const result = await optimize(input, { colors: 16, lossy: 20, dither });
    assert.equal(result.output.durationMs, 480);
    assert.ok(render(result.data).frames.length > 0);
    assert.equal(result.usedOriginal, false);
  }
  const result = await optimize(fixture({ transparent: true }), { preset: 'balanced' });
  assert.match(result.warnings.join(' '), /disabled/);
});
test('active cancellation and timeouts terminate the worker', async () => {
  const c = new AbortController();
  const operation = optimize(fixture(), { signal: c.signal });
  c.abort();
  await assert.rejects(operation, /aborted/);
  await assert.rejects(optimize(fixture(), { timeoutMs: 1 }), /timed out/);
});
test('a corrupt LZW stream never silently succeeds', async () => {
  const input = fixture({ frames: 1 });
  // Descriptor starts after logical screen and global four-color table.
  const image = input.indexOf(0x2c, 25);
  const localBytes = input[image + 9] & 0x80 ? 3 * (1 << ((input[image + 9] & 7) + 1)) : 0;
  const start = image + 10 + localBytes;
  input.fill(0xff, start + 2, input.length - 2);
  await assert.rejects(optimize(input), /Codec|GIF|block|Truncated/);
});
test('mutating a caller buffer while optimization runs cannot corrupt fallback output', async () => {
  const input = (await optimize(fixture({ frames: 1, width: 1, height: 1 }))).data;
  const original = input.slice();
  const pending = optimize(input);
  input.fill(0);
  const result = await pending;
  assert.equal(result.usedOriginal, true);
  assert.deepEqual(result.data, original);
  assert.equal(inspect(result.data).bytes, result.output.bytes);
});
test('local palettes, interlacing, and nonuniform delays survive FPS conversion', async () => {
  const input = fixture({ localPalette: true, interlaced: true, height: 19, delay: i => i % 2 ? 5 : 4 });
  const original = render(input);
  const plan = planFrameRate(original.frames.map(f => f.delay), 15);
  const result = await optimize(input, { fps: 15 });
  const output = render(result.data);
  let t = 0;
  for (const sample of plan) {
    assert.deepEqual(atTime(output.frames, t), original.frames[sample.sourceIndex].rgba);
    t += sample.delayMs;
  }
  assert.equal(t, result.output.durationMs);
});
test('transparent moving sprite exercises a smaller codec result, not the original fallback', async () => {
  const input = fixture({ width: 96, height: 64, transparent: true, scene: 'sprite', disposal: 2 });
  const result = await optimize(input);
  assert.equal(result.usedOriginal, false);
  assert.ok(result.savedBytes > 0);
  const a = render(input), b = render(result.data);
  for (let t = 0; t < result.input.durationMs; t += 10) assert.deepEqual(atTime(a.frames, t), atTime(b.frames, t));
});
test('long identical holds preserve duration even when delay fields cannot be merged', async () => {
  const input = fixture({ frames: 2, delay: 60000, scene: 'still' });
  const result = await optimize(input);
  assert.equal(result.output.durationMs, 1200000);
  assert.ok(result.output.delaysMs.every(ms => ms <= 655350));
  const retimed = await optimize(input, { fps: 0.01 });
  assert.equal(retimed.output.durationMs, 1200000);
});
