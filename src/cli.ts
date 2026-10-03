#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { open, link, rename, unlink, access } from 'node:fs/promises';
import { dirname, basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect, optimize, DEFAULT_LIMITS, GifiumError, type OptimizeOptions,
  type OptimizeResult, type Limits } from './index.js';

const HELP = `gifium — timing-aware GIF optimization (Node.js 20+)

Usage:
  gifium info <input.gif> [--json]
  gifium optimize <input.gif> [-o output.gif] [options]
  gifium benchmark <input.gif> [--runs 3] [options]

Options:
  -o, --output PATH          Default: <input>.optimized.gif
  --overwrite               Allow replacement of an existing output
  --preset NAME             lossless (default), gentle, balanced, small
  --fps NUMBER              Export FPS (> 0, <= 100); preserves duration
  --colors NUMBER           Palette target (2..256; may add transparency)
  --lossy NUMBER            Lossy strength 0..200; disabled for transparency
  --dither METHOD           none (default), ordered, floyd-steinberg
  --level NUMBER            Lossless optimization level 1..3 (default 3)
  --timeout NUMBER          Per-operation deadline in ms (default 30000)
  --max-bytes NUMBER        Input/intermediate/output byte limit (67108864)
  --max-pixels NUMBER       Logical-screen pixel limit (16000000)
  --max-frames NUMBER       Frame limit (10000)
  --max-decoded-pixels N    Logical-screen pixels x frames (100000000)
  --runs NUMBER             Benchmark repetitions, 1..100 (default 3)
  --json                    Machine-readable report
  -h, --help                Show help
  -v, --version             Show version

Default optimization never returns a larger GIF. Explicit FPS/palette
transforms can grow the file. No FFmpeg or native executable is required.
Exit codes: 0 success, 1 processing/I/O failure, 2 usage error, 130 cancelled.
`;

class UsageError extends Error {}

async function readInput(path: string, maxBytes: number): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new GifiumError('Input must be a regular file');
    if (stat.size > maxBytes) throw new GifiumError('Input exceeds maxBytes');
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new GifiumError('Input changed while reading');
      offset += bytesRead;
    }
    const extra = await file.read(new Uint8Array(1), 0, 1, offset);
    if (extra.bytesRead) throw new GifiumError('Input changed while reading');
    return bytes;
  } finally { await file.close(); }
}

async function writeOutput(path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  const temp = join(dirname(path), `.gifium-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    // Linking is an atomic no-clobber publish on local Windows/macOS/Linux
    // filesystems. If unsupported, fail rather than risk replacing a file.
    if (overwrite) await rename(temp, path);
    else await link(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function report(result: OptimizeResult) {
  const { data: _data, ...stats } = result;
  return stats;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' }, overwrite: { type: 'boolean' },
      output: { type: 'string', short: 'o' }, preset: { type: 'string' },
      fps: { type: 'string' }, colors: { type: 'string' }, lossy: { type: 'string' },
      dither: { type: 'string' }, level: { type: 'string' }, timeout: { type: 'string' },
      runs: { type: 'string' }, 'max-bytes': { type: 'string' },
      'max-pixels': { type: 'string' }, 'max-frames': { type: 'string' },
      'max-decoded-pixels': { type: 'string' },
    } });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const { values, positionals } = parsed;
  if (values.help) { console.log(HELP); return; }
  if (values.version) { console.log('0.1.0'); return; }
  const [command, file] = positionals;
  if (!command || !['info', 'optimize', 'benchmark'].includes(command) || !file || positionals.length !== 2) {
    throw new UsageError('Expected info, optimize, or benchmark and one input path. Run gifium --help.');
  }
  const common = ['json', 'max-bytes', 'max-pixels', 'max-frames', 'max-decoded-pixels'];
  const processing = ['preset', 'fps', 'colors', 'lossy', 'dither', 'level', 'timeout'];
  const allowed = new Set([...common, ...(command === 'info' ? [] : processing),
    ...(command === 'optimize' ? ['output','overwrite'] : command === 'benchmark' ? ['runs'] : [])]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new UsageError(`--${name} is not valid for ${command}`);
  const numeric = (key: string): number | undefined => {
    const raw = values[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw))) throw new UsageError(`--${key} requires a finite number`);
    return Number(raw);
  };
  const limits: Limits = {};
  for (const [flag, key] of [['max-bytes','maxBytes'], ['max-pixels','maxPixels'],
    ['max-frames','maxFrames'], ['max-decoded-pixels','maxDecodedPixels']] as const) {
    const value = numeric(flag);
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1) throw new UsageError(`--${flag} must be a positive integer`);
      limits[key] = value;
    }
  }
  const options: OptimizeOptions = { limits };
  for (const [flag, key] of [['fps','fps'], ['colors','colors'], ['lossy','lossy'], ['timeout','timeoutMs']] as const) {
    const value = numeric(flag); if (value !== undefined) options[key] = value;
  }
  if (values.preset !== undefined) {
    if (typeof values.preset !== 'string' || !['lossless','gentle','balanced','small'].includes(values.preset)) throw new UsageError('Invalid preset');
    options.preset = values.preset as OptimizeOptions['preset'] & string;
  }
  if (values.dither !== undefined) {
    if (typeof values.dither !== 'string' || !['none','ordered','floyd-steinberg'].includes(values.dither)) throw new UsageError('Invalid dither');
    options.dither = values.dither as OptimizeOptions['dither'] & string;
  }
  const level = numeric('level');
  if (level !== undefined) {
    if (![1,2,3].includes(level)) throw new UsageError('--level must be 1, 2 or 3');
    options.optimizationLevel = level as 1 | 2 | 3;
  }
  for (const [key, min, max, integer] of [
    ['fps', Number.MIN_VALUE, 100, false], ['colors', 2, 256, true],
    ['lossy', 0, 200, true], ['timeoutMs', 1, 2147483647, true],
  ] as const) {
    const value = options[key];
    if (value !== undefined && (value < min || value > max || (integer && !Number.isInteger(value)))) throw new UsageError(`Invalid ${key}`);
  }
  const runs = numeric('runs') ?? 3;
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new UsageError('--runs must be an integer from 1 to 100');
  const inputPath = resolve(file);
  const bytes = await readInput(inputPath, limits.maxBytes ?? DEFAULT_LIMITS.maxBytes);
  if (command === 'info') {
    const info = inspect(bytes, limits);
    console.log(values.json ? JSON.stringify(info) :
      `${basename(inputPath)}: ${info.width}x${info.height}, ${info.frameCount} frames, ${info.durationMs} ms, ${info.bytes} bytes\nLoop: ${info.loopCount === null ? 'once' : info.loopCount === 0 ? 'infinite' : `${info.loopCount} repeats`}; transparency: ${info.hasTransparency}`);
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  options.signal = controller.signal;
  try {
    if (command === 'benchmark') {
      const first = await optimize(bytes, options);
      const times = [first.elapsedMs];
      const warnings = new Set(first.warnings);
      let deterministic = true;
      for (let i = 1; i < runs; i++) {
        const result = await optimize(bytes, options);
        times.push(result.elapsedMs);
        deterministic &&= Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength)
          .equals(Buffer.from(first.data.buffer, first.data.byteOffset, first.data.byteLength));
        for (const warning of result.warnings) warnings.add(warning);
      }
      times.sort((a, b) => a - b);
      const stats = { runs, inputBytes: bytes.length, outputBytes: first.data.length,
        savedPercent: first.savedPercent, coldMs: first.elapsedMs,
        medianMs: times.length % 2 ? times[Math.floor(times.length / 2)]! : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2,
        minMs: times[0]!, maxMs: times[times.length - 1]!,
        deterministic,
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        node: process.version, platform: process.platform, arch: process.arch,
        warnings: [...warnings] };
      console.log(values.json ? JSON.stringify(stats) :
        `${runs} runs: ${stats.inputBytes} → ${stats.outputBytes} bytes (${stats.savedPercent.toFixed(2)}% saved)\nMedian ${stats.medianMs.toFixed(2)} ms; first ${stats.coldMs.toFixed(2)} ms; deterministic: ${stats.deterministic}\nProcess peak RSS: ${stats.processPeakRssBytes} bytes (includes Node and workers)`);
      return;
    }
    const defaultOutput = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.optimized.gif`);
    const outputPath = typeof values.output === 'string' ? resolve(values.output) : defaultOutput;
    if (!values.overwrite) {
      const exists = await access(outputPath).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (exists) throw new GifiumError('Output exists; pass --overwrite to replace it');
    }
    const result = await optimize(bytes, options);
    if (controller.signal.aborted) throw new GifiumError('Operation aborted');
    await writeOutput(outputPath, result.data, Boolean(values.overwrite));
    console.log(values.json ? JSON.stringify({ path: outputPath, ...report(result) }) :
      `${outputPath}\n${result.input.bytes} → ${result.output.bytes} bytes (${result.savedPercent.toFixed(2)}% saved), ${result.output.durationMs} ms`);
    if (!values.json) for (const warning of result.warnings) console.error(`gifium: ${warning}`);
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

main().catch(error => {
  console.error(`gifium: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = /aborted/i.test(error?.message ?? '') ? 130 : error instanceof UsageError ? 2 : 1;
});
