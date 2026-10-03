# Gifium: investigating GIF compression without losing the animation

**Author:** hawxxx

**Project:** Gifium 0.1.0

**Measurement snapshot:** 3 October 2026 (UTC)

## Abstract

My starting point for Gifium is the export work in Gifio. I want a small library that makes the useful parts of that work available without requiring an editor: deliberate frame timing, conservative defaults, explicit compression tradeoffs, and a command-line interface that works across operating systems. I treat a GIF as a timed sequence of displayed images rather than merely a collection of compressed frames. This investigation evaluates a portable Gifsicle WebAssembly backend with original timing, validation, isolation and selection logic. In a five-case synthetic corpus, lossless optimization reduced a moving sprite by 67.405% and repeated imagery by 94.877%, while three cases remained unchanged under a no-growth policy. These are bounded engineering results, not evidence of a universal compression advantage. The experiment also exposes the cost of more aggressive settings, the limits of a small corpus, and the difference between a lightweight package and low runtime memory use.

## 1. Why I wanted to separate this from the editor

Working on GIF export in Gifio brought my attention to details that are easy to overlook when the only visible outcome is a download button. A file can become smaller and still be a worse export. It may play too quickly, choose the wrong source frames, introduce unstable dithering, or mishandle the transparent regions that connect one frame to the next.

For Gifium, my central question is therefore not simply “How many bytes can I remove?” It is: **What can I change while keeping the animation's intended behavior understandable and testable?** I want a tool I can use from a script as readily as from an application, with enough reporting to explain its decisions.

This document is my project narrative and interpretation of the repository's executable evidence. The timing failure modes discussed below come from prior Gifio engineering observations; the numerical compression results come from Gifium's committed benchmark harness. I distinguish those sources because a design rationale is not itself a measurement.

## 2. Research questions and expectations

I organized the work around four questions:

1. Can lossless structural optimization reduce size while preserving displayed pixels, duration and loop behavior?
2. Can a requested export rate be represented without the cumulative timing drift caused by independent frame rounding?
3. How do palette reduction and lossy strength trade bytes against observable pixel error?
4. Can the implementation remain small and portable without hiding its dependency or resource costs?

My expectations were deliberately modest. I expected repeated content and mostly static scenes to compress well. I did not expect incompressible or already efficient inputs to improve consistently. I also expected aggressive settings to show different outcomes across content types. These expectations inform the experiment; they are not substitutes for its results.

## 3. The format constraints that shaped the design

### 3.1 Time is stored in centiseconds

GIF89a encodes graphic-control delays in units of one hundredth of a second [1]. A 24 FPS interval is approximately 41.667 ms, which cannot be stored exactly in an individual GIF frame. Rounding each interval to 40 ms makes a sequence of 240 frames last 9,600 ms instead of 10,000 ms. The file's duration is 4% shorter; the corresponding playback rate is about 4.17% faster.

My implementation rounds cumulative endpoints. For positive source delays $d_i$, it emits:

$$
q_i = 10\operatorname{round}\left(\frac{\sum_{j=0}^{i}d_j}{10}\right)
      -10\operatorname{round}\left(\frac{\sum_{j=0}^{i-1}d_j}{10}\right).
$$

This keeps total quantization error within 5 ms of the requested sequence duration, subject to the accepted per-frame bounds. The unit test uses 240 intervals at 24 FPS and obtains exactly 10,000 ms, with 40 and 50 ms delays. This is an arithmetic regression result, not a claim about how every browser schedules playback.

### 3.2 Sampling must use the original clock

Export timing and source selection are related but distinct. Once a target time is chosen, Gifium selects the nearest source frame start on the **original** time axis. Exact ties choose the earlier frame. It does not locate source frames by accumulating already-quantized output delays.

This distinction comes directly from the class of export problems encountered in Gifio: changing the clock used for selection can introduce duplicate/drop pairs even when nominal source and target rates match. The regression here uses 349 intervals at 24 FPS and checks that the selected indices are exactly 0 through 348. The emitted duration is 14,540 ms, the centisecond representation of an approximately 14,541.667 ms sequence.

For finite clips, the requested rate does not imply a fractional frame count. Gifium rounds the count to the nearest integer, keeps at least one frame, and assigns the remaining duration to the final interval. A residual shorter than 10 ms is handled by distributing duration across the representable sequence. Long intervals beyond GIF's delay field and ambiguous zero-delay retiming are rejected. Later lossless optimization may merge identical displayed images, so stored frame count alone cannot describe playback rate.

### 3.3 A stored frame is not necessarily a complete image

An animation can store a small rectangle and rely on the previously displayed canvas. Disposal modes specify how that canvas changes before the next frame [1]. Dropping such a rectangle directly can change every subsequent picture.

Gifium therefore asks Gifsicle to unoptimize the animation before FPS selection. The documented purpose of this operation is to recover complete representations of the displayed images [2]. Gifium verifies full-screen frame rectangles, selects the needed images, writes new delays, and then applies compression again. If the backend cannot represent the expansion faithfully—for example, a difficult combination of local palettes—the operation should fail instead of quietly substituting an approximate reconstruction.

## 4. What is original, and what is reused

I did not set out to reinvent LZW or claim a new GIF codec. Gifsicle supplies mature encoding, palette and delta-frame optimization [2, 3]. The `gifsicle-wasm` package provides an Emscripten build with a Node-compatible entry point [4]. Gifium's contribution is the surrounding system: a strict container parser, timing planner, compression policy, independent verification harness, isolated execution, bounded inputs, typed API, and safe CLI.

This is also why I chose one portable backend over separately maintained native binaries. The portability question becomes whether the Node/WebAssembly integration behaves consistently, rather than whether installation found a working executable on each machine. The tradeoff is real: every operation starts a worker and loads a codec instance. Very small images can spend more time on setup than compression.

The source uses GPL-2.0-only and records exact upstream source commits and build references in `THIRD_PARTY_NOTICES.md`. Gifio's application code and repository history are not copied. Learning from a prior application and acknowledging an established backend are compatible with writing an original library; claiming ownership of the backend would not be.

## 5. Compression policy

I keep lossless optimization as the default. Palette reduction, dithering and lossy compression are explicit choices because they alter different properties of the image.

- **Structural optimization** exploits repeated or unchanged regions while preserving displayed content.
- **Palette reduction** maps colors into a smaller set. A transparency entry may require an extra palette slot.
- **Dithering** represents unavailable colors through spatial patterns. The Gifsicle manual notes its size cost and possible animation artifacts [2].
- **Lossy compression** allows image changes in exchange for more compressible data. Its numerical strength is not a perceptual quality score.

The presets deliberately start without dithering. A transparent source disables lossy compression and produces a warning, carrying forward a conservative policy from Gifio. This is a safety policy, not proof that every transparent GIF fails with lossy compression. Palette reduction remains possible and can still change colors.

Another policy matters just as much: if default optimization produces a larger file, Gifium returns the original. The same applies to lossy-only presets. I do not use this fallback to undo an explicit FPS or palette request; those transformations can produce larger files and report negative savings. A reliable tool should expose that outcome rather than silently ignore its options.

## 6. Experimental method

The committed generator creates five original synthetic GIFs. There are no downloaded videos or private editor projects in the experiment:

| Case | Dimensions | Frames | Purpose |
| --- | --- | ---: | --- |
| Moving sprite | 96 × 64 | 24 | Mostly static content with localized motion |
| Repeated still | 96 × 64 | 24 | Redundant complete images |
| Gradient | 96 × 64 | 24 | Smooth changes across a 256-color palette |
| Palette noise | 96 × 64 | 24 | Deterministic high-variation content |
| Transparent disposal | 64 × 48 | 24 | Partial rectangles, transparency, disposal-to-previous, variable delays |

Each case is optimized with `lossless`, `gentle`, `balanced` and `small`, three times per setting. The harness records input hashes, output size, timing, deterministic bytes, loop preservation, duration, fallback use, and warnings. `omggif` independently decodes source and output; it is not used in production [5]. Displayed RGBA values are compared every 10 ms, so longer holds contribute proportionally more observations.

The reported error is root-mean-square channel error across those RGBA observations, on a 0–255 channel scale. I use it as a diagnostic, **not as a perceptual similarity score**. Exact equality is more meaningful for lossless cases. This comparison covers the generated corpus's initial-canvas conventions; it is not a general conformance suite for every historical GIF decoder behavior.

Measurements were taken on Linux x64, Node v22.23.1, with an AMD Ryzen 9 9950X3D. Timings are per-call wall time including worker startup, with no process restart between cases. OS and filesystem caches may be warm. Three repetitions support a small median summary, not a statistically strong performance claim.

Reproduction:

```sh
npm ci
npm test
npm run benchmark
```

`node scripts/benchmark.mjs` prints JSON without npm's script banner. The source, options and input hashes make the experiment inspectable; raw measurements are preserved in `benchmarks/results.json`. Timing and memory values will vary by machine and run.

## 7. Results

### 7.1 Lossless outcomes

| Case | Input bytes | Returned bytes | Savings | Median ms | Exact displayed pixels |
| --- | ---: | ---: | ---: | ---: | --- |
| Moving sprite | 3,160 | 1,030 | 67.405% | 87.680 | Yes |
| Repeated still | 4,509 | 231 | 94.877% | 84.614 | Yes |
| Gradient | 52,809 | 52,809 | 0% | 89.951 | Yes |
| Palette noise | 201,250 | 201,250 | 0% | 90.671 | Yes |
| Transparent disposal | 3,405 | 3,405 | 0% | 84.529 | Yes |

The unchanged cases used the original-byte fallback. Their equality demonstrates the returned-output contract; it does **not** independently establish pixel correctness of the discarded candidate. Separate forced-transformation and disposal tests exercise backend output.

What I take from this table is a narrower conclusion than “GIF compression works well.” It works particularly well when there is exploitable redundancy in these inputs. Returning an unchanged file for a difficult case is a valid outcome of a conservative optimizer.

### 7.2 The quality tradeoff is content-dependent

| Case and setting | Returned bytes | Savings | RGBA RMSE |
| --- | ---: | ---: | ---: |
| Gradient, `small` | 50,749 | 3.901% | 0.6690 |
| Palette noise, `balanced` | 198,092 | 1.569% | 0.1058 |
| Palette noise, `small` | 162,451 | 19.279% | 32.2890 |

The last row is the result I most want to keep visible. The more aggressive preset saves substantially more bytes on noise, but the error rises sharply. A single “quality” label would hide this difference. These results do not show that `small` is acceptable for every use; they show why the default should remain conservative and why previewing transformed output matters.

All 20 case/preset combinations produced deterministic bytes over their three repetitions, preserved loop counts, and retained their source duration: 960 ms for the first four cases and 1,040 ms for the transparent case. Determinism here is scoped to this pinned backend and environment.

### 7.3 Lightweight is more than one number

The installed backend's JavaScript and WASM files measured 64,414 and 236,944 bytes respectively: 301,358 bytes combined, excluding its README and package metadata. Gifium has one runtime dependency; its independent decoder and TypeScript toolchain are development-only. Release-package size is reported separately in `benchmarks/package-size.json` because compressed tarball size and installed footprint are different measurements.

The entire benchmark process reached 159,039,488 bytes of peak RSS. That includes Node, workers, fixture generation, independent decoding, and all cases. It is **not** a per-image codec allocation, and it is not evidence of a hard memory bound. For this small corpus, median call times were roughly 84–161 ms. I interpret the setup cost as a tradeoff for isolation and predictable cancellation, not as a reason to describe the library as universally fast.

## 8. Reliability beyond compression ratio

The tests cover duration, sample indices, loop absence versus finite/infinite looping, transparency and disposal, malformed containers, damaged compressed data, worker timeout, active cancellation, concurrent calls, and safe CLI output handling. A review also found a buffer-ownership error: if the caller changed the input while optimization was awaiting the worker, the fallback could return the modified buffer. The regression now mutates the caller buffer deliberately, and the implementation snapshots input before yielding.

A second review finding was in the benchmark itself: retaining every output made memory consumption scale with repetition count. The CLI now retains only the reference output and scalar statistics while comparing later results immediately. That correction matters because a measurement harness can create the very problem it appears to measure.

A long-hold regression exposed a separate backend issue. Two identical 600,000 ms frames were merged into one hold whose 16-bit GIF delay wrapped: the output lasted 544,640 ms instead of 1,200,000 ms. Invoking the pinned backend with `--optimize=keep-empty` retained both holds and the full duration. Gifium applies that safeguard when total duration could exceed a single delay field, and also retains empty frames when zero delays have player-dependent significance. This result is a useful reminder that a mature codec still needs checks at the library boundary.

Cross-platform behavior is exercised by a GitHub Actions matrix for Windows, macOS and Linux across Node 20, 22 and 24. The numerical tables above remain Linux-only measurements; a passing portability test does not make them cross-platform performance results.

## 9. Limitations and what I would investigate next

This is a small synthetic study. It lacks photographic/video-derived GIFs, a broad collection of independently produced legacy files, human quality judgments, power measurements, and competitor benchmarks. It cannot establish a perceptual quality threshold or state-of-the-art compression claim.

The inspector validates structure without decompressing pixels. The optimizer delegates pixel correctness to the backend and rejects reported corruption; it does not independently decode every result in production. Byte/pixel/frame limits and timeouts constrain work, but WASM memory is outside V8's worker heap limit. Applications processing untrusted files at scale still need a concurrency and process-isolation policy appropriate to their environment.

Zero-delay playback, user-input extensions and plain-text rendering complicate claims of exact behavior. The first release rejects ambiguous retiming and unsupported rendering rather than guessing. Browser scheduling can also clamp very short delays. Raw timing preservation therefore remains distinct from a guarantee that every player displays the animation identically.

My next useful investigation would expand the corpus before expanding the API: licensed photographic material, more local-palette/interlaced inputs, adversarial decoder cases, and controlled comparisons of ordered versus error-diffusion dithering. I would also measure worker reuse against the current fresh-instance design, but only after proving that backend state cannot leak between operations. For now, I prefer a small interface whose promises I can explain and test.

## References

1. CompuServe. *Graphics Interchange Format, Version 89a*. 1989. W3C archival copy: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
2. Eddie Kohler. *Gifsicle manual*: optimization, unoptimization, palette reduction, dithering, and frame selection. https://www.lcdf.org/gifsicle/man.html
3. Eddie Kohler and contributors. *Gifsicle source*. Pinned backend source: https://github.com/kohler/gifsicle/tree/a08e0f6686d467bb8b9e4715b1f1835f12984fb0
4. ysamlan and contributors. *gifsicle-bin / WebAssembly packaging*, v1.96.4. https://github.com/ysamlan/gifsicle-bin/tree/v1.96.4/wasm
5. Dean McNamee. *omggif*: JavaScript GIF encoder/decoder. https://github.com/deanm/omggif
6. hawxxx. *Gifio*: prior application context for timing and optimization policy. https://github.com/hawxxx/GifIO

Primary technical sources and package metadata were consulted during implementation. Reproducible code and raw results accompany this document so its interpretations can be checked independently.
