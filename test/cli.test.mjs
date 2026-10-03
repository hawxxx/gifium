import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './fixtures.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });

test('CLI help and version need no input', () => {
  assert.match(run('--help').stdout, /gifium optimize/);
  assert.match(run('--version').stdout, /^0\.1\.0/);
});
test('CLI info, optimize, benchmark, spaces and protected output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gifium test '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source image.gif'), output = join(dir, 'output image.gif');
  const original = fixture(); await writeFile(input, original);
  const info = run('info', input, '--json');
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).frameCount, 12);
  const result = run('optimize', input, '-o', output, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).output.bytes <= original.length);
  const protectedResult = run('optimize', input, '-o', output);
  assert.equal(protectedResult.status, 1);
  assert.match(protectedResult.stderr, /exist|overwrite/i);
  const sourceProtection = run('optimize', input, '-o', input);
  assert.equal(sourceProtection.status, 1);
  assert.deepEqual(await readFile(input), original);
  const overwrite = run('optimize', input, '-o', output, '--overwrite', '--fps', '10');
  assert.equal(overwrite.status, 0, overwrite.stderr);
  const bench = run('benchmark', input, '--runs', '2', '--json');
  assert.equal(bench.status, 0, bench.stderr);
  assert.equal(JSON.parse(bench.stdout).runs, 2);
  assert.equal((await readdir(dir)).filter(f => f.endsWith('.tmp')).length, 0);
});
test('CLI rejects missing paths, unknown options, bad numbers and wrong-command flags', () => {
  for (const args of [[], ['unknown'], ['optimize'], ['info','none','--fps','10'],
    ['optimize','none','--fps','abc'], ['optimize','none','--typo'], ['benchmark','none','--runs','0']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.ok(result.stderr.length > 0);
  }
});
