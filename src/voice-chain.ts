import { registerEffect } from '@dawcore/components';
import { dbToGain, measureLoudness } from './loudness';

/**
 * The processing every voice take goes through: gain to bring the raw take to
 * a nominal level, a high-pass to remove rumble, a compressor to even out
 * speech, make-up gain to reach the target, then a limiter to hold peaks
 * near the target's ceiling.
 *
 * The chain sits on the track, not on the clip, so the latest take sets the
 * level for every take on the voice track.
 */

export const GAIN_EFFECT = 'segue-gain';
export const HIGH_PASS_EFFECT = 'segue-high-pass';
export const COMPRESSOR_EFFECT = 'native-compressor';

export const HIGH_PASS_HZ = 80;
export const COMPRESSOR_PARAMS = {
  threshold: -24,
  knee: 12,
  ratio: 3,
  attack: 0.005,
  release: 0.2,
};

/** The limiter starts working this far below the peak ceiling. */
const LIMITER_HEADROOM_DB = 3;

export function limiterParams(peakCeiling: number) {
  return {
    threshold: peakCeiling - LIMITER_HEADROOM_DB,
    knee: 0,
    ratio: 20,
    attack: 0.001,
    release: 0.1,
  };
}

/**
 * Takes are brought to this level before the compressor, so it reacts the
 * same way to a quiet laptop microphone as to a hot studio one.
 */
export const PRE_COMPRESSOR_LUFS = -20;
/** Upper limit on gain applied to a raw take, so near-silence isn't amplified into noise. */
const MAX_PRE_GAIN_DB = 40;
/** Upper limit on make-up gain (+24 dB). */
const MAX_MAKE_UP_GAIN = 16;

let registered = false;

export function registerVoiceEffects() {
  if (registered) return;
  registered = true;

  registerEffect(HIGH_PASS_EFFECT, {
    label: 'High-pass',
    category: 'filter',
    defaults: { frequency: HIGH_PASS_HZ },
    params: { frequency: { min: 20, max: 400, step: 1, unit: 'Hz' } },
    create: (context) => {
      const node = context.createBiquadFilter();
      node.type = 'highpass';
      return {
        input: node,
        output: node,
        applyParams: (params) => {
          if (params.frequency !== undefined) node.frequency.value = params.frequency;
        },
      };
    },
  });

  registerEffect(GAIN_EFFECT, {
    label: 'Gain',
    category: 'dynamics',
    defaults: { gain: 1 },
    params: { gain: { min: 0, max: 100, step: 0.01 } },
    create: (context) => {
      const node = context.createGain();
      return {
        input: node,
        output: node,
        applyParams: (params) => {
          if (params.gain !== undefined) node.gain.value = params.gain;
        },
      };
    },
  });
}

export interface Take {
  buffer: AudioBuffer;
  offsetSamples: number;
  durationSamples: number;
}

export interface TakeLevels {
  /** Loudness of the raw take in LUFS. */
  rawLoudness: number;
  /** Linear gain applied before the high-pass and compressor. */
  preGain: number;
  /** Linear gain applied after the compressor, before the limiter. */
  makeUpGain: number;
  /** Loudness of the take after the whole chain, in LUFS. */
  loudness: number;
  /** Sample peak of the take after the whole chain, in dBFS. */
  peak: number;
}

function applyCompressor(node: DynamicsCompressorNode, params: typeof COMPRESSOR_PARAMS) {
  node.threshold.value = params.threshold;
  node.knee.value = params.knee;
  node.ratio.value = params.ratio;
  node.attack.value = params.attack;
  node.release.value = params.release;
}

/**
 * Run a take through the same nodes the voice track uses, offline. The track
 * pans before its effects, so a mono take reaches the chain as two channels;
 * the panner here reproduces that.
 */
async function renderChain(
  take: Take,
  preGain: number,
  makeUpGain: number,
  peakCeiling: number | null
): Promise<AudioBuffer> {
  const { buffer, offsetSamples, durationSamples } = take;
  const offline = new OfflineAudioContext(2, durationSamples, buffer.sampleRate);

  const source = offline.createBufferSource();
  source.buffer = buffer;
  const panner = offline.createStereoPanner();
  const pre = offline.createGain();
  pre.gain.value = preGain;
  const highPass = offline.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = HIGH_PASS_HZ;
  const compressor = offline.createDynamicsCompressor();
  applyCompressor(compressor, COMPRESSOR_PARAMS);
  const makeUp = offline.createGain();
  makeUp.gain.value = makeUpGain;

  let tail: AudioNode = source
    .connect(panner)
    .connect(pre)
    .connect(highPass)
    .connect(compressor)
    .connect(makeUp);
  if (peakCeiling !== null) {
    const limiter = offline.createDynamicsCompressor();
    applyCompressor(limiter, limiterParams(peakCeiling));
    tail = tail.connect(limiter);
  }
  tail.connect(offline.destination);

  source.start(0, offsetSamples / buffer.sampleRate);
  return offline.startRendering();
}

/**
 * Work out the gains that bring a take to `targetLoudness`. The compressor
 * and limiter are not linear, so the take is rendered offline through the
 * chain: once to find the make-up gain, once more to correct for the limiter,
 * and a last time to report where it landed.
 */
export async function analyseTake(
  take: Take,
  targetLoudness: number,
  peakCeiling: number
): Promise<TakeLevels> {
  const rawLoudness = measureLoudness(
    take.buffer,
    take.offsetSamples,
    take.durationSamples
  ).integrated;
  if (!Number.isFinite(rawLoudness)) {
    return { rawLoudness, preGain: 1, makeUpGain: 1, loudness: -Infinity, peak: -Infinity };
  }

  const preGain = dbToGain(Math.min(MAX_PRE_GAIN_DB, PRE_COMPRESSOR_LUFS - rawLoudness));

  const compressed = measureLoudness(await renderChain(take, preGain, 1, null)).integrated;
  let makeUpDb = targetLoudness - compressed;

  const limited = measureLoudness(
    await renderChain(take, preGain, dbToGain(makeUpDb), peakCeiling)
  ).integrated;
  makeUpDb += targetLoudness - limited;

  const makeUpGain = Math.min(MAX_MAKE_UP_GAIN, dbToGain(makeUpDb));
  const final = measureLoudness(await renderChain(take, preGain, makeUpGain, peakCeiling));

  return {
    rawLoudness,
    preGain,
    makeUpGain,
    loudness: final.integrated,
    peak: final.samplePeak,
  };
}
