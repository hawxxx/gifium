import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from '../test/fixtures.mjs';

const tarball = (await readdir('.')).find(f => /^gifium-.*\.tgz$/.test(f));
if (!tarball) throw new Error('Run npm pack first');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run npm run verify:package so npm supplies its portable executable path');
const dir = await mkdtemp(join(tmpdir(), 'gifium package '));
try {
  const args = ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', resolve(tarball)];
  const install = spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(install.stderr || install.stdout || String(install.error));
  const input = join(dir, 'sample.gif');
  await writeFile(input, fixture());
  const consumer = join(dir, 'consumer.mjs');
  await writeFile(consumer, "import { inspect, optimize } from 'gifium';\nimport { readFile } from 'node:fs/promises';\nconst result = await optimize(await readFile(process.argv[2]));\nif (inspect(result.data).frameCount < 1) throw new Error('Invalid output');\n");
  const library = spawnSync(process.execPath, [consumer, input], { cwd: dir, encoding: 'utf8' });
  if (library.status !== 0) throw new Error(library.stderr || library.stdout);
  const cli = join(dir, 'node_modules', 'gifium', 'dist', 'cli.js');
  const run = spawnSync(process.execPath, [cli, 'optimize', input, '--json'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || String(run.error));
  const result = JSON.parse(run.stdout);
  if (result.output.bytes > result.input.bytes) throw new Error('Packaged optimizer grew the input');
  async function treeSize(path) {
    let bytes = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) bytes += await treeSize(child);
      else if (entry.isFile()) bytes += (await stat(child)).size;
    }
    return bytes;
  }
  console.log(JSON.stringify({ installedGifiumBytes: await treeSize(join(dir, 'node_modules', 'gifium')),
    installedBackendBytes: await treeSize(join(dir, 'node_modules', 'gifsicle-wasm')) }));
  console.log('Packed install verified: CLI, library worker, and WASM resolution work without dev dependencies.');
} finally { await rm(dir, { recursive: true, force: true }); }
