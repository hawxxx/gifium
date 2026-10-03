export interface Limits {
  maxBytes?: number;
  maxPixels?: number;
  maxFrames?: number;
  /** Logical-screen pixels multiplied by frame count, before decompression. */
  maxDecodedPixels?: number;
}

export interface GifInfo {
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  delaysMs: number[];
  /** null = no loop extension; 0 = repeat forever; n = n repeats. */
  loopCount: number | null;
  hasTransparency: boolean;
  hasUserInput: boolean;
  bytes: number;
}

export type Preset = 'lossless' | 'gentle' | 'balanced' | 'small';
export type Dither = 'none' | 'floyd-steinberg' | 'ordered';

export interface OptimizeOptions {
  preset?: Preset;
  /** Export frame rate, > 0 and <= 100. */
  fps?: number;
  /** Palette reduction target, 2..256. May require an extra transparent entry. */
  colors?: number;
  /** Gifsicle lossy strength, 0..200. Disabled for transparent input. */
  lossy?: number;
  dither?: Dither;
  optimizationLevel?: 1 | 2 | 3;
  timeoutMs?: number;
  limits?: Limits;
  signal?: AbortSignal;
}

export interface OptimizeResult {
  data: Uint8Array;
  input: GifInfo;
  output: GifInfo;
  savedBytes: number;
  savedPercent: number;
  elapsedMs: number;
  usedOriginal: boolean;
  warnings: string[];
}

export class GifiumError extends Error {
  constructor(message: string) { super(message); this.name = 'GifiumError'; }
}
