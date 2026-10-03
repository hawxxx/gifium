import { GifWriter, GifReader } from 'omggif';

// Generated test images are original; no downloaded media or private projects.
export function fixture({ width = 16, height = 12, frames = 12, loop = 0,
  transparent = false, partial = false, disposal = 1, delay = 4, gradient = false,
  scene = 'stripes', localPalette = false, interlaced = false } = {}) {
  const out = Buffer.alloc(4 * 1024 * 1024);
  const palette = gradient
    ? Array.from({ length: 256 }, (_, i) => (i << 16) | ((255 - i) << 8) | i)
    : [0x000000, 0xff3030, 0x20cc60, 0x3050ff];
  const writer = new GifWriter(out, width, height, {
    ...(localPalette ? {} : { palette }), ...(loop === null ? {} : { loop }),
  });
  for (let f = 0; f < frames; f++) {
    const w = partial ? Math.max(1, width >> 1) : width;
    const h = partial ? Math.max(1, height >> 1) : height;
    const x = partial ? f % (width - w + 1) : 0;
    const y = partial ? f % (height - h + 1) : 0;
    const pixels = Uint8Array.from({ length: w * h }, (_, p) => {
      if (transparent && p % 5 === 0) return 0;
      if (scene === 'sprite') return Math.abs(p % w - (f * 3) % w) < 5 && Math.abs(Math.floor(p / w) - h / 2) < 5 ? 1 : 2;
      if (scene === 'still') return 1 + (p % 3);
      if (scene === 'noise') {
        let n = (p + f * w * h + 12345) | 0;
        n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
        n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
        return (n ^ (n >>> 16)) & 255;
      }
      return gradient ? (p + f * 7) % 256 : 1 + ((p % w + f) % 3);
    });
    let encodedPixels = pixels;
    if (interlaced) {
      encodedPixels = new Uint8Array(pixels.length);
      let offset = 0;
      for (const [start, step] of [[0,8],[4,8],[2,4],[1,2]]) {
        for (let row = start; row < h; row += step) {
          encodedPixels.set(pixels.subarray(row * w, (row + 1) * w), offset);
          offset += w;
        }
      }
    }
    const frameStart = writer.getOutputBufferPosition();
    writer.addFrame(x, y, w, h, encodedPixels, {
      delay: typeof delay === 'function' ? delay(f) : delay,
      disposal, ...(transparent ? { transparent: 0 } : {}),
      ...(localPalette ? { palette: palette.map((_, i) => palette[(i + f) % palette.length]) } : {}),
    });
    if (interlaced) out[frameStart + (out[frameStart] === 0x21 ? 8 : 0) + 9] |= 0x40;
  }
  return out.subarray(0, writer.end());
}

// Independent test oracle using omggif, never the production WASM decoder.
export function render(bytes) {
  const reader = new GifReader(bytes);
  let canvas = new Uint8Array(reader.width * reader.height * 4);
  const backgroundIndex = bytes[11];
  const background = bytes[10] & 0x80
    ? [...bytes.subarray(13 + backgroundIndex * 3, 16 + backgroundIndex * 3), 255] : [0,0,0,0];
  const fillBackground = (target, start, end, transparent) => {
    for (let p = start; p < end; p += 4) target.set(transparent ? [0,0,0,0] : background, p);
  };
  fillBackground(canvas, 0, canvas.length, reader.frameInfo(0).transparent_index !== null);
  const frames = [];
  for (let i = 0; i < reader.numFrames(); i++) {
    const before = canvas.slice();
    reader.decodeAndBlitFrameRGBA(i, canvas);
    const info = reader.frameInfo(i);
    frames.push({ rgba: canvas.slice(), delay: info.delay * 10 });
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y++) {
        fillBackground(canvas, (y * reader.width + info.x) * 4,
          (y * reader.width + info.x + info.width) * 4, info.transparent_index !== null);
      }
    } else if (info.disposal === 3) canvas = before;
  }
  return { frames, loop: reader.loopCount(), width: reader.width, height: reader.height };
}

export function atTime(frames, ms) {
  let t = 0;
  for (const frame of frames) {
    t += frame.delay;
    if (ms < t) return frame.rgba;
  }
  return frames.at(-1).rgba;
}
