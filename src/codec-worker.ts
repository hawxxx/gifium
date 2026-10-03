import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import createModule from 'gifsicle-wasm';
import { parseGif, resolveLimits } from './parse.js';
import { planFrameRate } from './timing.js';
import { GifiumError } from './types.js';
import type { BackendRequest, BackendResponse } from './backend-types.js';

const warnings: string[] = [];
const require = createRequire(import.meta.url);

async function run(input: Uint8Array, args: string[]): Promise<Uint8Array> {
  const diagnostic: string[] = [];
  const mod = await createModule({
    wasmBinary: await readFile(require.resolve('gifsicle-wasm/gifsicle.wasm')),
    print: () => {},
    printErr: value => { if (diagnostic.length < 20) diagnostic.push(String(value).slice(0,500)); },
  });
  mod.FS.writeFile('/input.gif', input);
  const argv = ['gifsicle', '--no-ignore-errors', '--conserve-memory', ...args, '/input.gif', '-o', '/output.gif'];
  const table = mod._malloc((argv.length + 1) * 4);
  if (!table) throw new GifiumError('Codec argument allocation failed');
  const pointers: number[] = [];
  try {
    argv.forEach((arg, i) => {
      const pointer = mod.stringToNewUTF8(arg);
      if (!pointer) throw new GifiumError('Codec string allocation failed');
      pointers.push(pointer); mod.setValue(table + i * 4, pointer, 'i32');
    });
    mod.setValue(table + argv.length * 4, 0, 'i32');
    const status = mod._run_gifsicle(argv.length, table);
    if (status !== 0) throw new GifiumError(`Codec failed (${status}): ${diagnostic.join(' ')}`);
    // Gifsicle can recover damaged LZW with a warning. Do not call this reliable
    // optimization: refuse damaged input rather than silently repair its pixels.
    if (diagnostic.some(s => /error|corrupt|invalid|missing|truncat|bad code|too (?:much|many|few)|not enough/i.test(s))) {
      throw new GifiumError(`Codec rejected input: ${diagnostic.join(' ')}`);
    }
    warnings.push(...diagnostic);
    return mod.FS.readFile('/output.gif').slice();
  } finally {
    for (const pointer of pointers) mod._free(pointer);
    mod._free(table);
  }
}

function retime(bytes: Uint8Array, request: BackendRequest): Uint8Array {
  const gif = parseGif(bytes, request.limits);
  const cap = resolveLimits(request.limits);
  const plan = planFrameRate(gif.info.delaysMs, request.fps!, cap.maxFrames);
  if (plan.length * gif.info.width * gif.info.height > cap.maxDecodedPixels) throw new GifiumError('Resampled animation exceeds maxDecodedPixels');
  const parts: Uint8Array[] = [gif.header, ...gif.extensions];
  let size = parts.reduce((n, p) => n + p.length, 0) + 1;
  for (const sample of plan) {
    const frame = gif.frames[sample.sourceIndex]!;
    if (frame.x || frame.y || frame.width !== gif.info.width || frame.height !== gif.info.height) {
      throw new GifiumError('Codec did not produce full composited frames for resampling');
    }
    const delay = sample.delayMs / 10;
    // Each unoptimized frame represents the full displayed picture. Clear it
    // before the next frame so previously opaque pixels cannot leak through.
    const flags = (2 << 2) | (frame.transparentIndex === null ? 0 : 1);
    const control = Uint8Array.of(0x21, 0xf9, 4, flags, delay & 255, delay >> 8, frame.transparentIndex ?? 0, 0);
    parts.push(control, frame.image); size += control.length + frame.image.length;
    if (size > cap.maxBytes) throw new GifiumError('Intermediate GIF exceeds maxBytes');
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  result[offset] = 0x3b;
  result.set([71,73,70,56,57,97]);
  return result;
}

try {
  const request = workerData as BackendRequest;
  const input = request.fps === undefined ? request.input
    : retime(await run(request.input, ['--unoptimize']), request);
  const output = await run(input, request.args);
  const response: BackendResponse = { output, warnings };
  parentPort!.postMessage(response, [output.buffer as ArrayBuffer]);
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies BackendResponse);
}
