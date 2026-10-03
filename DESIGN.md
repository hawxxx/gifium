# Gifium — design decisions

The original design was approved before implementation. See `ARCHITECTURE.md` for the implemented structure and `research.md` for measurements and limitations.

## Purpose

Gifium is a standalone open-source GIF optimization library and command-line tool, informed by the export work in Gifio. It should install consistently on Windows, Linux, and macOS, have a small dependency footprint, and preserve animation semantics by default.

## Architecture choices

1. **Recommended: TypeScript library and Node.js CLI, portable WebAssembly compression backend.** One portable backend avoids native installation scripts and system codec dependencies. The library exposes typed byte-buffer APIs. Backend size, Node compatibility, license obligations, and initialization cost must be checked before adoption.
2. **Native Gifsicle adapter.** Potentially smaller JavaScript package and straightforward mature compression, but requires system installation or maintained binaries for each platform and architecture.
3. **Entirely new GIF codec and optimizer.** Maximum ownership and no codec dependency, but significantly more correctness work for LZW, disposal, palettes, and delta frames. This is a poor first release trade-off for reliable optimization.

The selected approach creates original orchestration, timing, policy, inspection, and CLI code; it does not claim authorship of an existing compression engine. Codec licenses and attribution accompany distribution. The implementation applies Gifio's engineering lessons without copying application source; `THIRD_PARTY_NOTICES.md` records provenance.

## Initial public surface

- Library: inspect GIF metadata; optimize GIF bytes; select export FPS; configure palette size, dithering, lossless or explicitly lossy compression; receive output bytes and structured statistics.
- CLI: `gifium info`, `gifium optimize`, and `gifium benchmark`, with human-readable and JSON reporting.
- Safe default: lossless optimization, preserved dimensions, loop behavior, transparency, displayed frames, and duration. Return the original GIF if a semantics-preserving candidate is larger. Explicit transformations such as FPS changes must not silently revert to the original.
- Explicit lossy controls: quality presets backed by documented settings, not a claim that a numeric quality value is a perceptual score. Transparent animations require conservative handling and dedicated fixtures.
- File handling: no input overwrite by default; explicit overwrite option, validated paths, temporary output followed by atomic replacement where supported, meaningful exit codes.
- Bounded processing: byte, dimension, decoded-pixel, and frame limits, cancellation, and deterministic failures for malformed files.

## Timing and compositing

GIF delays are centiseconds. Quantize cumulative timing rather than independently rounding each frame. Select output samples against the original unquantized source clock, with a documented nearest-frame tie rule. Preserve total duration within representable GIF precision and explicitly define behavior for zero-delay inputs, very short clips, long holds, and excessive target FPS.

Resampling must operate on composited frames so disposal methods and transparent delta rectangles retain their meaning. Preserve loop-count semantics, including the distinction between no loop extension and infinite looping. Do not claim fixed FPS is exactly representable when centisecond timing requires alternating delays.

## Verification and release

Use focused unit tests plus decoder-based integration tests for visual equivalence, duration, loop count, transparency, disposal, malformed input, and CLI output protection. Include static images, full and partial frames, local palettes, long holds, and non-integer frame durations. An independent decoder should validate optimized output where practical.

Run the same test suite in GitHub Actions on Windows, macOS, and Linux. Measure npm tarball size, installed footprint, cold start, execution time, peak memory where measurable, and compression ratio on a committed redistributable synthetic corpus. Report results as measurements, not universal guarantees. Publish the GitHub repository after checks and a scan of distributable files and history for credentials and unrelated private material. npm publication is outside the currently requested scope.

## research.md

Write in first person with a personal but academic tone: motivation from Gifio, research questions, GIF format constraints, hypotheses, implementation choices, reproducible experimental methods, measured results, limitations, and references to primary sources. Attribute established codecs and algorithms. Distinguish prior project observations from experiments actually run for Gifium; do not invent biographical details, dates, measurements, or claim the author personally ran work that is only proposed.

## Scope boundary

The initial release distributes through GitHub. Publishing to the npm registry, shipping a browser API, and producing standalone native executables are separate future work.
