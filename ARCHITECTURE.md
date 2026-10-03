# Architecture

Gifium is a Node.js ESM package with TypeScript declarations and a CLI. Its sole runtime dependency is `gifsicle-wasm@1.96.4`. No editor, framework, browser DOM, canvas package, native subprocess, or downloaded media is included.

## Data flow

`Uint8Array → private snapshot → bounded container parser → option policy → isolated worker → Gifsicle WASM → output validation → size policy → result`

For FPS conversion the worker first invokes `--unoptimize`, parses the composited GIF, selects frames on their original time axis, reconstructs graphic-control/image blocks with centisecond delays, then optimizes the reconstructed animation. Selected frames must occupy the entire logical screen. Disposal-to-background prevents opaque pixels from an earlier selected frame leaking into a later transparent one.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public limits, options, result types and errors |
| `src/parse.ts` | Bounds-checked GIF container parsing; dimensions, frames, delays, loop extension |
| `src/timing.ts` | Cumulative delay quantization and nearest-source frame-rate planning |
| `src/index.ts` | Public API, presets, input ownership, invariants and size policy |
| `src/codec-worker.ts` | WASM invocation, argument allocation, diagnostic handling, retiming |
| `src/cli.ts` | Argument validation, bounded reads, atomic output publication and benchmark reporting |

## State and lifetime

Each operation starts a worker. Each codec invocation creates a fresh WASM instance, avoiding global Gifsicle state leaking between operations. The input is copied before asynchronous processing. Concurrent callers use independent workers. Worker timeout and AbortSignal listeners terminate codec execution; callers remain responsible for limiting application-wide concurrency.

The parser uses views into the owned byte array, never decoded RGBA canvases. Parsing precedes codec execution. Pixel/frame/byte caps bound normal workloads; they do not sandbox total native/WASM allocation. CLI benchmarks retain the first output for deterministic comparison and scalar timings from subsequent runs, rather than all output buffers.

## Preserved semantics

The output must retain logical-screen dimensions, loop count and duration. Loop absence, infinite looping, and a finite repeat count remain distinct. Pixel equivalence for default compression is the codec's lossless contract and is exercised with an independent decoder in tests; Gifium does not perform an expensive independent pixel comparison on every production call.

When total duration exceeds 655350 ms, the backend receives `--optimize=keep-empty` to prevent merging repeated holds beyond GIF's 16-bit delay field. Zero-delay input also enables that flag because dropping those frames has player-dependent consequences.

Exact bytes and frame count may change. Comments and application extensions are passed to the backend, but byte-level ordering is not guaranteed. Unsupported rendering/interactive extensions are rejected explicitly. The parser is strict about truncation, reserved flags, missing color tables, image bounds, duplicate looping extensions and trailing data. `inspect` validates structure only; optimization also asks the backend to decode and rejects detected corruption.

## Portability and distribution

All production code uses Node built-ins and WebAssembly. `createRequire(...).resolve` locates the installed WASM file; no network fetch occurs at runtime. The CLI's npm bin entry provides the platform-specific command shim. Tests are listed explicitly instead of relying on shell wildcard expansion. GitHub Actions covers Windows, macOS and Linux on Node 20, 22 and 24.

The release tarball contains compiled code, declarations, original TypeScript source, build configuration, README, architecture, research, licensing and notices. Tests, benchmark fixtures and development dependencies remain in the source repository. Source availability and third-party build references are documented in `THIRD_PARTY_NOTICES.md`.
