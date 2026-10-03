import { GifiumError, type GifInfo, type Limits } from './types.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxPixels: 16_000_000,
  maxFrames: 10_000,
  maxDecodedPixels: 100_000_000,
});

export function resolveLimits(limits: Limits = {}): Required<Limits> {
  const result = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new GifiumError(`${key} must be a positive safe integer`);
  }
  return result;
}

export interface ParsedFrame {
  image: Uint8Array;
  delayMs: number;
  disposal: number;
  transparentIndex: number | null;
  userInput: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedGif {
  info: GifInfo;
  header: Uint8Array;
  extensions: Uint8Array[];
  frames: ParsedFrame[];
}

/** Container validation, not LZW decoding. Views reference the supplied bytes. */
export function parseGif(bytes: Uint8Array, limits: Limits = {}): ParsedGif {
  const cap = resolveLimits(limits);
  if (!(bytes instanceof Uint8Array)) throw new GifiumError('Input must be a Uint8Array or Buffer');
  if (bytes.byteLength > cap.maxBytes) throw new GifiumError('Input exceeds maxBytes');
  let offset = 0;
  const need = (n: number) => {
    if (offset + n > bytes.length) throw new GifiumError(`Truncated GIF at byte ${offset}`);
  };
  const read = () => { need(1); return bytes[offset++]!; };
  const word = () => read() | (read() << 8);
  const skip = (n: number) => { need(n); offset += n; };
  const subblocks = () => {
    const first = offset;
    for (;;) { const n = read(); if (n === 0) break; skip(n); }
    return bytes.subarray(first, offset);
  };
  need(13);
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new GifiumError('Input is not a GIF87a/GIF89a file');
  offset = 6;
  const width = word(), height = word(), packed = read();
  const background = read(); read();
  if (width === 0 || height === 0) throw new GifiumError('GIF dimensions must be nonzero');
  if (width * height > cap.maxPixels) throw new GifiumError('Logical screen exceeds maxPixels');
  const globalColors = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  if (globalColors && background >= globalColors) throw new GifiumError('Invalid background palette index');
  skip(globalColors * 3);
  const header = bytes.subarray(0, offset);
  const frames: ParsedFrame[] = [], extensions: Uint8Array[] = [];
  let loopCount: number | null = null;
  let control = { delayMs: 0, disposal: 0, transparentIndex: null as number | null, userInput: false };
  let pendingControl = false;
  for (;;) {
    const start = offset, block = read();
    if (block === 0x3b) {
      if (offset !== bytes.length) throw new GifiumError('Trailing data after GIF trailer is not supported');
      if (pendingControl) throw new GifiumError('Graphic control without an image');
      break;
    }
    if (block === 0x21) {
      const label = read();
      if (label === 0xf9) {
        if (pendingControl) throw new GifiumError('Repeated graphic control before an image');
        if (read() !== 4) throw new GifiumError('Invalid graphic control size');
        const flags = read(), delay = word(), index = read();
        if (read() !== 0 || flags & 0xe0 || ((flags >> 2) & 7) > 3) throw new GifiumError('Invalid graphic control flags or terminator');
        control = { delayMs: delay * 10, disposal: (flags >> 2) & 7,
          transparentIndex: flags & 1 ? index : null, userInput: Boolean(flags & 2) };
        pendingControl = true;
      } else if (label === 0x01) {
        throw new GifiumError('GIF plain-text rendering extensions are not supported');
      } else {
        const blocks = subblocks();
        if (label === 0xff) {
          if (blocks[0] !== 11) throw new GifiumError('Invalid application extension');
          const app = String.fromCharCode(...blocks.subarray(1, 12));
          if (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') {
            if (blocks.length !== 17 || blocks[12] !== 3 || blocks[13] !== 1) throw new GifiumError('Invalid loop extension');
            if (loopCount !== null) throw new GifiumError('Multiple loop extensions are ambiguous');
            loopCount = blocks[14]! | (blocks[15]! << 8);
          }
        }
        extensions.push(bytes.subarray(start, offset));
      }
      continue;
    }
    if (block !== 0x2c) throw new GifiumError(`Unknown GIF block at byte ${start}`);
    const x = word(), y = word(), w = word(), h = word(), flags = read();
    if (w === 0 || h === 0 || x + w > width || y + h > height) throw new GifiumError('Image rectangle exceeds logical screen');
    if (flags & 0x18) throw new GifiumError('Invalid image descriptor flags');
    const colors = flags & 0x80 ? 1 << ((flags & 7) + 1) : globalColors;
    if (!colors) throw new GifiumError('Image has no color table');
    if (control.transparentIndex !== null && control.transparentIndex >= colors) throw new GifiumError('Invalid transparent palette index');
    if (flags & 0x80) skip(colors * 3);
    const minCodeSize = read();
    if (minCodeSize < 2 || minCodeSize > 8) throw new GifiumError('Invalid LZW minimum code size');
    const data = subblocks();
    if (data.length === 1) throw new GifiumError('Image has no compressed data');
    if (frames.length >= cap.maxFrames) throw new GifiumError('Animation exceeds maxFrames');
    if ((frames.length + 1) * width * height > cap.maxDecodedPixels) throw new GifiumError('Animation exceeds maxDecodedPixels');
    frames.push({ image: bytes.subarray(start, offset), ...control, x, y, width: w, height: h });
    control = { delayMs: 0, disposal: 0, transparentIndex: null, userInput: false };
    pendingControl = false;
  }
  if (!frames.length) throw new GifiumError('GIF contains no image frames');
  const delaysMs = frames.map(f => f.delayMs);
  return { header, extensions, frames, info: {
    width, height, frameCount: frames.length, durationMs: delaysMs.reduce((a, b) => a + b, 0),
    delaysMs, loopCount, hasTransparency: frames.some(f => f.transparentIndex !== null),
    hasUserInput: frames.some(f => f.userInput), bytes: bytes.length,
  } };
}

export function inspect(bytes: Uint8Array, limits?: Limits): GifInfo {
  return parseGif(bytes, limits).info;
}
