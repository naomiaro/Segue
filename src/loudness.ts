/**
 * Programme loudness per ITU-R BS.1770: K-weighting, 400 ms blocks with 75%
 * overlap, an absolute gate at -70 LUFS and a relative gate 10 LU below the
 * absolute-gated level.
 *
 * Channels are weighted equally, which is correct for mono and stereo.
 * The peak reported is a sample peak, not an oversampled true peak.
 */

export interface AudioData {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export interface Loudness {
  /** Integrated loudness in LUFS. -Infinity when there is nothing to measure. */
  integrated: number;
  /** Highest absolute sample value in dBFS. */
  samplePeak: number;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Stage 1 of the K-weighting filter: a high shelf modelling the head. */
function shelfFilter(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Stage 2 of the K-weighting filter: a high-pass (the RLB curve). */
function highPassFilter(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const LOUDNESS_OFFSET = -0.691;

const energyToLufs = (energy: number) => LOUDNESS_OFFSET + 10 * Math.log10(energy);
const lufsToEnergy = (lufs: number) => Math.pow(10, (lufs - LOUDNESS_OFFSET) / 10);

/**
 * Measure a buffer, or the part of it starting at `startSample` and running
 * for `lengthSamples`.
 */
export function measureLoudness(
  audio: AudioData,
  startSample = 0,
  lengthSamples = audio.length - startSample
): Loudness {
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(audio.length, start + Math.max(0, Math.floor(lengthSamples)));
  const stepLength = Math.round(audio.sampleRate * 0.1);
  const stepCount = Math.floor((end - start) / stepLength);

  // Sum of squared K-weighted samples per 100 ms step, across all channels.
  const stepSums = new Float64Array(Math.max(0, stepCount));
  const shelf = shelfFilter(audio.sampleRate);
  const highPass = highPassFilter(audio.sampleRate);
  let peak = 0;

  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    let s1x1 = 0, s1x2 = 0, s1y1 = 0, s1y2 = 0;
    let s2x1 = 0, s2x2 = 0, s2y1 = 0, s2y2 = 0;

    for (let i = start; i < end; i++) {
      const x = data[i];
      const magnitude = x < 0 ? -x : x;
      if (magnitude > peak) peak = magnitude;

      const y1 = shelf.b0 * x + shelf.b1 * s1x1 + shelf.b2 * s1x2 - shelf.a1 * s1y1 - shelf.a2 * s1y2;
      s1x2 = s1x1; s1x1 = x; s1y2 = s1y1; s1y1 = y1;

      const y2 = highPass.b0 * y1 + highPass.b1 * s2x1 + highPass.b2 * s2x2 - highPass.a1 * s2y1 - highPass.a2 * s2y2;
      s2x2 = s2x1; s2x1 = y1; s2y2 = s2y1; s2y1 = y2;

      const step = Math.floor((i - start) / stepLength);
      if (step < stepCount) stepSums[step] += y2 * y2;
    }
  }

  const samplePeak = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

  // A 400 ms block is four consecutive 100 ms steps.
  const blockCount = stepCount - 3;
  if (blockCount < 1) return { integrated: -Infinity, samplePeak };

  const blockEnergies = new Float64Array(blockCount);
  for (let block = 0; block < blockCount; block++) {
    const sum = stepSums[block] + stepSums[block + 1] + stepSums[block + 2] + stepSums[block + 3];
    blockEnergies[block] = sum / (4 * stepLength);
  }

  const meanAbove = (thresholdEnergy: number) => {
    let total = 0;
    let count = 0;
    for (const energy of blockEnergies) {
      if (energy > thresholdEnergy) {
        total += energy;
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  };

  const absoluteGate = lufsToEnergy(ABSOLUTE_GATE_LUFS);
  const ungatedMean = meanAbove(absoluteGate);
  if (ungatedMean === 0) return { integrated: -Infinity, samplePeak };

  const relativeGate = lufsToEnergy(energyToLufs(ungatedMean) + RELATIVE_GATE_LU);
  const gatedMean = meanAbove(Math.max(absoluteGate, relativeGate));
  return {
    integrated: gatedMean > 0 ? energyToLufs(gatedMean) : -Infinity,
    samplePeak,
  };
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

export function formatLufs(lufs: number): string {
  return Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : 'silent';
}

export function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : 'silent';
}
