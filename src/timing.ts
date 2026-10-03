import { GifiumError } from './types.js';

export interface FrameSample { sourceIndex: number; delayMs: number }

/** Error diffusion on cumulative time; returned delays are milliseconds in 10 ms units. */
export function quantizeDelays(delaysMs: readonly number[]): number[] {
  if (!delaysMs.length) throw new GifiumError('At least one delay is required');
  let original = 0, emitted = 0;
  return delaysMs.map(delay => {
    if (!Number.isFinite(delay) || delay < 10 || delay > 655350) {
      throw new GifiumError('Each delay must be between 10 and 655350 ms');
    }
    original += delay;
    if (!Number.isSafeInteger(Math.round(original))) throw new GifiumError('Duration is too large');
    const end = Math.round(original / 10) * 10;
    const value = end - emitted;
    emitted = end;
    return value;
  });
}

/** Nearest original frame start; exact ties choose the earlier frame. */
export function planFrameRate(delaysMs: readonly number[], fps: number, maxFrames = 10000): FrameSample[] {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 100) throw new GifiumError('fps must be > 0 and <= 100');
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new GifiumError('maxFrames must be positive');
  quantizeDelays(delaysMs); // Validate without replacing the source clock.
  const starts: number[] = [];
  let total = 0;
  for (const delay of delaysMs) { starts.push(total); total += delay; }
  const count = Math.max(1, Math.round(total * fps / 1000));
  if (count > maxFrames) throw new GifiumError('Requested fps exceeds maxFrames');
  const period = 1000 / fps;
  const durations = Array.from({ length: count }, (_, i) => i === count - 1 ? total - i * period : period);
  // A rounded-up count can leave a sub-centisecond last frame. Spread the
  // representable total evenly in this case, rather than emitting a zero delay.
  if (durations[count - 1]! < 10) durations.fill(total / count);
  const outputDelays = quantizeDelays(durations);
  let sourceIndex = 0;
  return outputDelays.map((delayMs, i) => {
    const target = i * period;
    while (sourceIndex + 1 < starts.length &&
      Math.abs(starts[sourceIndex + 1]! - target) + 1e-7 < Math.abs(starts[sourceIndex]! - target)) sourceIndex++;
    return { sourceIndex, delayMs };
  });
}
