import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { inspect, resolveLimits } from './parse.js';
import { planFrameRate } from './timing.js';
import { GifiumError, type OptimizeOptions, type OptimizeResult } from './types.js';
import type { BackendRequest, BackendResponse } from './backend-types.js';

export { inspect, DEFAULT_LIMITS } from './parse.js';
export { quantizeDelays, planFrameRate } from './timing.js';
export type { FrameSample } from './timing.js';
export * from './types.js';

export const PRESETS = Object.freeze({
  lossless: Object.freeze({ lossy: 0, dither: 'none' as const }),
  gentle: Object.freeze({ lossy: 10, dither: 'none' as const }),
  balanced: Object.freeze({ lossy: 30, dither: 'none' as const }),
  small: Object.freeze({ lossy: 60, colors: 128, dither: 'none' as const }),
});

function backend(request: BackendRequest, timeoutMs: number, signal?: AbortSignal): Promise<BackendResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./codec-worker.js', import.meta.url), {
      workerData: request,
      // WASM memory is outside V8's heap limit; input limits are separate.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: [],
    });
    let settled = false;
    const finish = (error?: Error, response?: BackendResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(response!);
    };
    const abort = () => finish(new GifiumError('Operation aborted'));
    const timer = setTimeout(() => finish(new GifiumError(`Codec timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once('error', error => finish(new GifiumError(error.message)));
    worker.once('exit', code => { if (!settled) finish(new GifiumError(`Codec worker exited unexpectedly (${code})`)); });
    worker.once('message', (response: BackendResponse) => {
      if (response.error) finish(new GifiumError(response.error));
      else if (!response.output) finish(new GifiumError('Codec returned no output'));
      else finish(undefined, response);
    });
  });
}

/** Optimize locally. No network, native process, or filesystem output is used. */
export async function optimize(bytes: Uint8Array, options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const started = performance.now();
  if (options.signal?.aborted) throw new GifiumError('Operation aborted');
  const limits = resolveLimits(options.limits);
  if (!(bytes instanceof Uint8Array)) throw new GifiumError('Input must be a Uint8Array or Buffer');
  if (bytes.byteLength > limits.maxBytes) throw new GifiumError('Input exceeds maxBytes');
  // Own the input before yielding: callers may reuse or mutate their buffers.
  bytes = Uint8Array.from(bytes);
  const input = inspect(bytes, limits);
  const presetName = options.preset ?? 'lossless';
  if (!Object.hasOwn(PRESETS, presetName)) throw new GifiumError('Unknown preset');
  const preset: { lossy: number; colors?: number; dither: string } = PRESETS[presetName];
  const colors = options.colors ?? preset.colors;
  let lossy = options.lossy ?? preset.lossy;
  const dither = options.dither ?? preset.dither;
  const level = options.optimizationLevel ?? 3;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (colors !== undefined && (!Number.isInteger(colors) || colors < 2 || colors > 256)) throw new GifiumError('colors must be an integer from 2 to 256');
  if (!Number.isInteger(lossy) || lossy < 0 || lossy > 200) throw new GifiumError('lossy must be an integer from 0 to 200');
  if (!['none', 'floyd-steinberg', 'ordered'].includes(dither)) throw new GifiumError('Unknown dither method');
  if (![1,2,3].includes(level)) throw new GifiumError('optimizationLevel must be 1, 2, or 3');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new GifiumError('timeoutMs must be 1..2147483647');
  if (input.hasUserInput) throw new GifiumError('Interactive GIF user-input timing is not supported');
  if (options.fps !== undefined) {
    if (input.delaysMs.some(d => d === 0)) throw new GifiumError('Cannot resample zero-delay frames; supply a GIF with positive delays');
    const plan = planFrameRate(input.delaysMs, options.fps, limits.maxFrames);
    if (plan.length * input.width * input.height > limits.maxDecodedPixels) throw new GifiumError('Requested fps exceeds maxDecodedPixels');
  }
  const warnings: string[] = [];
  if (input.hasTransparency && lossy > 0) {
    lossy = 0;
    warnings.push('Lossy compression disabled for transparent input; palette reduction may still change colors.');
  }
  if (dither !== 'none' && colors === undefined) warnings.push('Dithering has no effect without palette reduction.');
  const args = [`-O${level}`, '--careful'];
  // The pinned backend can merge identical holds past GIF's 16-bit delay
  // field, wrapping their duration. Keep frames whenever overflow is possible.
  // Zero-delay frames also have player-dependent significance; do not merge.
  if (input.durationMs > 655350 || input.delaysMs.includes(0)) args.push('--optimize=keep-empty');
  if (lossy) args.push(`--lossy=${lossy}`);
  if (colors !== undefined) args.push(`--colors=${colors}`, '--color-method=blend-diversity');
  args.push(dither === 'none' ? '--no-dither' : `--dither=${dither}`);
  const request: BackendRequest = { input: bytes, args, limits,
    ...(options.fps === undefined ? {} : { fps: options.fps }) };
  const response = await backend(request, timeoutMs, options.signal);
  const candidate = response.output!;
  const outputInfo = inspect(candidate, limits);
  if (outputInfo.width !== input.width || outputInfo.height !== input.height ||
      outputInfo.loopCount !== input.loopCount || outputInfo.durationMs !== input.durationMs) {
    throw new GifiumError('Codec output failed dimension, loop, or duration invariants');
  }
  // Keep the smaller file unless the user asked for an explicit transformation.
  // Presets/lossy strength are preferences; FPS and palette size are constraints.
  const usedOriginal = options.fps === undefined && colors === undefined && candidate.length >= bytes.length;
  const data = usedOriginal ? bytes.slice() : candidate;
  const output = usedOriginal ? input : outputInfo;
  const savedBytes = input.bytes - output.bytes;
  return { data, input, output, savedBytes, savedPercent: savedBytes / input.bytes * 100,
    elapsedMs: performance.now() - started, usedOriginal,
    warnings: [...warnings, ...(response.warnings ?? [])] };
}
