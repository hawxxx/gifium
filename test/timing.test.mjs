import test from 'node:test';
import assert from 'node:assert/strict';
import { quantizeDelays, planFrameRate } from '../dist/index.js';

test('24 FPS timing preserves sequence duration instead of rounding each frame down', () => {
  const out = quantizeDelays(Array(240).fill(1000 / 24));
  assert.equal(out.reduce((a, b) => a + b, 0), 10000);
  assert.ok(out.every(n => n === 40 || n === 50));
});
test('matched rates sample the original clock without alternating duplicates', () => {
  const plan = planFrameRate(Array(349).fill(1000 / 24), 24);
  assert.deepEqual(plan.map(p => p.sourceIndex), Array.from({ length: 349 }, (_, i) => i));
  assert.equal(plan.reduce((a, p) => a + p.delayMs, 0), 14540);
});
test('long holds, nearest-frame ties, and short clips have defined behavior', () => {
  assert.deepEqual(planFrameRate([100, 100], 20).map(p => p.sourceIndex), [0, 0, 1, 1]);
  assert.deepEqual(planFrameRate([10], 1), [{ sourceIndex: 0, delayMs: 10 }]);
  assert.equal(planFrameRate([600000, 600000], 1).length, 1200);
});
test('unrepresentable and invalid timing fails explicitly', () => {
  for (const fps of [0, -1, NaN, Infinity, 101]) assert.throws(() => planFrameRate([40], fps));
  for (const delays of [[], [0], [-1], [NaN], [Infinity], [1, 1]]) {
    assert.throws(() => quantizeDelays(delays));
  }
  assert.throws(() => planFrameRate([655350], 100, 100));
});
