import { describe, expect, it } from 'vitest';
import { limit, type ChannelData } from './limiter';

const SAMPLE_RATE = 48000;

function audioOf(...channels: Float32Array[]): ChannelData {
  return {
    numberOfChannels: channels.length,
    sampleRate: SAMPLE_RATE,
    length: channels[0].length,
    getChannelData: (channel) => channels[channel],
  };
}

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/** A 220 Hz tone with a loud burst in the middle. */
function toneWithBurst(quiet: number, loud: number): Float32Array {
  const data = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < data.length; i++) {
    const inBurst = i >= 20000 && i < 24000;
    data[i] = (inBurst ? loud : quiet) * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return data;
}

describe('limit', () => {
  it('never lets a sample past the ceiling', () => {
    const data = toneWithBurst(0.2, 3);
    const result = limit(audioOf(data), { ceilingDb: -1 });
    expect(peakOf(data)).toBeLessThanOrEqual(Math.pow(10, -1 / 20));
    expect(result.maxReductionDb).toBeGreaterThan(9);
  });

  it('holds the ceiling on noise with isolated spikes', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const data = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < data.length; i++) data[i] = random() * (i % 997 === 0 ? 5 : 0.5);
    limit(audioOf(data), { ceilingDb: -3 });
    expect(peakOf(data)).toBeLessThanOrEqual(Math.pow(10, -3 / 20));
  });

  it('leaves audio under the ceiling untouched', () => {
    const data = toneWithBurst(0.2, 0.5);
    const original = Float32Array.from(data);
    const result = limit(audioOf(data), { ceilingDb: -1 });
    expect(result.maxReductionDb).toBe(0);
    expect(data).toEqual(original);
  });

  it('only touches audio near the peak', () => {
    const data = toneWithBurst(0.2, 3);
    const original = Float32Array.from(data);
    limit(audioOf(data), { ceilingDb: -1, lookahead: 0.005, release: 0.05 });
    // Well before the burst, and a second's worth of release after it.
    expect(data.subarray(0, 19000)).toEqual(original.subarray(0, 19000));
    expect(data[47000]).toBeCloseTo(original[47000], 3);
  });

  it('applies the same gain to every channel', () => {
    const left = toneWithBurst(0.2, 3);
    const right = toneWithBurst(0.1, 0.1);
    const rightOriginal = Float32Array.from(right);
    limit(audioOf(left, right), { ceilingDb: -1 });
    // The right channel never needed limiting, but follows the left's gain.
    const index = 22000 + 55; // near a peak of the 220 Hz tone
    expect(Math.abs(right[index])).toBeLessThan(Math.abs(rightOriginal[index]) * 0.5);
    expect(peakOf(left)).toBeLessThanOrEqual(Math.pow(10, -1 / 20));
  });
});
