import { describe, expect, it } from 'vitest';
import { measureLoudness, type AudioData } from './loudness';

/** Stereo 1 kHz sine made of segments, each with a level in dBFS and a length in seconds. */
function tone(sampleRate: number, segments: Array<[levelDb: number, seconds: number]>): AudioData {
  const length = Math.round(segments.reduce((total, [, seconds]) => total + seconds, 0) * sampleRate);
  const channel = new Float32Array(length);
  let index = 0;
  for (const [levelDb, seconds] of segments) {
    const amplitude = Number.isFinite(levelDb) ? Math.pow(10, levelDb / 20) : 0;
    const count = Math.round(seconds * sampleRate);
    for (let i = 0; i < count && index < length; i++, index++) {
      channel[index] = amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate);
    }
  }
  return {
    numberOfChannels: 2,
    sampleRate,
    length,
    getChannelData: () => channel,
  };
}

describe('measureLoudness', () => {
  // EBU Tech 3341 case 1: a stereo 1 kHz sine at -23 dBFS reads -23.0 LUFS.
  it('reads -23 LUFS for a -23 dBFS stereo sine at 48 kHz', () => {
    const result = measureLoudness(tone(48000, [[-23, 20]]));
    expect(result.integrated).toBeCloseTo(-23, 1);
    expect(result.samplePeak).toBeCloseTo(-23, 1);
  });

  it('gives the same reading at 44.1 kHz', () => {
    expect(measureLoudness(tone(44100, [[-23, 20]])).integrated).toBeCloseTo(-23, 1);
  });

  // EBU Tech 3341 case 2: -33 dBFS reads -33.0 LUFS.
  it('tracks level changes one for one', () => {
    expect(measureLoudness(tone(48000, [[-33, 20]])).integrated).toBeCloseTo(-33, 1);
  });

  it('ignores silence through the absolute gate', () => {
    // Blocks straddling the edge are partly silent, so allow the EBU 0.1 LU tolerance.
    const result = measureLoudness(tone(48000, [[-23, 10], [-Infinity, 10]]));
    expect(Math.abs(result.integrated + 23)).toBeLessThanOrEqual(0.1);
  });

  // EBU Tech 3341 case 3: quiet passages either side are removed by the relative gate.
  it('ignores quiet passages through the relative gate', () => {
    const result = measureLoudness(tone(48000, [[-36, 10], [-23, 60], [-36, 10]]));
    expect(Math.abs(result.integrated + 23)).toBeLessThanOrEqual(0.1);
  });

  it('measures a sub-range of the buffer', () => {
    const audio = tone(48000, [[-40, 5], [-20, 10]]);
    const result = measureLoudness(audio, 5 * 48000, 10 * 48000);
    expect(result.integrated).toBeCloseTo(-20, 1);
  });

  it('reports silence and too-short audio as -Infinity', () => {
    expect(measureLoudness(tone(48000, [[-Infinity, 5]])).integrated).toBe(-Infinity);
    expect(measureLoudness(tone(48000, [[-20, 0.2]])).integrated).toBe(-Infinity);
  });
});
