# gifium

**Small, timing-aware GIF optimization for Node.js and the command line.**

Gifium brings lessons from [Gifio](https://github.com/hawxxx/GifIO) into a standalone library: preserve animation timing, coordinate palette and dithering decisions, and keep the original when a compression pass makes it bigger. It uses one portable WebAssembly dependency. No FFmpeg, native compilation, system Gifsicle, or network access is needed during optimization.

## Install

Requires **Node.js 20 or newer** on Windows, macOS, or Linux.

Install the release package:

```sh
npm install -g https://github.com/hawxxx/gifium/releases/download/v0.1.0/gifium-0.1.0.tgz
gifium --help
```

For a local library dependency, use the same URL without `-g`. Gifium is not published to the npm registry; `npm install gifium` is not the installation command for this release.

Or build from source:

```sh
git clone https://github.com/hawxxx/gifium.git
cd gifium
npm ci
npm run build
npm link
```

The same commands work in PowerShell, Command Prompt, and POSIX shells. The GitHub Actions matrix tests Node 20, 22, and 24 on all three operating systems. A Node runtime is required; these are not standalone native binaries.

## CLI

```sh
gifium info animation.gif
gifium optimize animation.gif -o smaller.gif
gifium optimize animation.gif -o balanced.gif --preset balanced
gifium optimize animation.gif -o retimed.gif --fps 15
gifium optimize animation.gif -o palette.gif --colors 128 --dither ordered
gifium benchmark animation.gif --runs 5 --json
```

Without `-o`, optimization writes `animation.optimized.gif`. Existing files are protected; `--overwrite` explicitly permits replacement, including in-place output. Quote paths containing spaces. `--json` produces one machine-readable result on stdout; errors go to stderr. Exit codes are 0 for success, 1 for processing/I/O errors, 2 for invalid usage, and 130 for cancellation.

`gifium --help` lists every option, including optimization level, lossy strength, deadline, and resource limits. `benchmark` reports the first operation, median, range, deterministic output, and process peak RSS. Each operation starts a fresh worker; “first” is not a separate cold-process startup measurement.

## Library

ES modules and TypeScript declarations are included.

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { inspect, optimize, planFrameRate, quantizeDelays } from 'gifium';

const input = await readFile('animation.gif');
console.log(inspect(input));

const result = await optimize(input, { preset: 'lossless' });
await writeFile('smaller.gif', result.data, { flag: 'wx' });
console.log(result.savedPercent, result.warnings);

const plan = planFrameRate([40, 50, 40, 40], 15);
const delays = quantizeDelays(Array(24).fill(1000 / 24));
```

- `inspect(bytes, limits?)` validates the GIF container and returns dimensions, frame delays, duration, transparency, byte count, and loop semantics. It does **not** decompress/validate LZW image data.
- `optimize(bytes, options?)` validates, compresses in a worker, checks output invariants, and returns bytes plus before/after metadata, savings, elapsed time, warnings, and `usedOriginal`. It snapshots caller-owned input. Options include `signal: AbortSignal` and `timeoutMs`.
- `planFrameRate(delaysMs, fps, maxFrames?)` returns source indices and quantized output delays, selecting the nearest original frame start; exact ties choose the earlier frame.
- `quantizeDelays(delaysMs)` rounds cumulative time to centiseconds. Inputs are 10–655350 ms; fractional millisecond delays are supported. Sequence duration is rounded to the nearest 10 ms rather than rounding each frame independently.
- `DEFAULT_LIMITS`, `PRESETS`, `GifiumError`, and public TypeScript interfaces are exported.

See [architecture](ARCHITECTURE.md) for ownership, worker lifetime, and resource behavior.

## Quality and compression

| Preset | Lossy strength | Palette target | Dithering |
| --- | ---: | ---: | --- |
| `lossless` (default) | 0 | Preserve | None |
| `gentle` | 10 | Preserve | None |
| `balanced` | 30 | Preserve | None |
| `small` | 60 | 128 | None |

Explicit options override preset values. These presets are engineering starting points, **not perceptual scores**. Gifsicle performs LZW encoding, delta-frame optimization, and palette reduction; Gifium supplies validation, timing, selection policy, isolation, and the interface.

Lossy compression is disabled when the source uses transparency; this emits a warning. Palette reduction can still change colors in transparent GIFs. `ordered` dithering can help gradients; `floyd-steinberg` trades smoothness for spatial/temporal noise. Dithering only applies when reducing a palette. A palette target can require an additional transparent entry.

Default optimization and lossy-only presets retain the original bytes if a candidate is no smaller. **Explicit FPS or palette transformations, including the `small` preset, can increase size** because silently undoing a requested transformation would be misleading. Savings can therefore be negative.

## Animation correctness

FPS conversion composes delta frames before selecting samples. GIF delays are multiples of 10 ms, so many requested rates require alternating delays. The final frame carries the remaining duration; if that would be shorter than 10 ms, timing is distributed over the representable sequence. Optimization may merge identical displayed frames, so output frame count need not equal requested FPS multiplied by duration. Inspect the duration, not just the number of stored frames.

Zero-delay GIFs can be optimized without retiming; FPS conversion rejects them because playback engines interpret them differently. User-input timing and plain-text rendering extensions are unsupported. Extremely low FPS over a long clip can require a hold exceeding GIF's 655350 ms limit and is rejected. Local-palette animations that cannot be losslessly expanded by the backend are rejected for FPS conversion rather than silently approximated.

## Limits and file safety

Defaults: 64 MiB input/intermediate/output, 16 million logical-screen pixels, 10,000 frames, 100 million logical-screen pixels across all frames, and a 30-second worker deadline. Raise limits explicitly through API `limits` or CLI flags. Resource limits bound accepted workloads; **they are not a hard process memory ceiling**. WASM memory is outside the worker's V8 heap limit, and worker setup/copying has overhead.

The CLI writes a temporary file alongside the destination, flushes it, and publishes it without clobbering an existing path. Default no-clobber publishing uses hard links: filesystems without hard-link support fail safely. `--overwrite` uses rename. Cancellation terminates codec work; once filesystem publication begins, it is allowed to finish.

## Evidence

On the included synthetic corpus, lossless optimization reduced a moving sprite by **67.4%** and repeated frames by **94.9%**; three other cases stayed unchanged. This is a small reproducible experiment, not a general compression promise. See [research.md](research.md), [raw measurements](benchmarks/results.json), and the [benchmark generator](scripts/benchmark.mjs).

```sh
npm test
npm run check
npm run benchmark
npm pack
npm run verify:package
```

Tests decode output with an independent JavaScript decoder and compare displayed pixels over time, not just file sizes or metadata. The package verification installs the tarball without development dependencies and exercises both API and CLI.

## License and provenance

GPL-2.0-only. Original Gifium code © 2026 hawxxx. The project applies lessons from Gifio without copying its application source or repository history. Gifsicle and its WebAssembly packaging remain the work of their respective authors. See [third-party notices and exact source references](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE).
