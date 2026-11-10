/**
 * A look-ahead peak limiter that guarantees no sample leaves above the
 * ceiling. All channels share one gain, so the stereo image doesn't shift.
 *
 * For each sample it works out the gain needed to keep the loudest channel
 * at the ceiling, then:
 *
 * 1. takes the minimum of that gain over the next `lookahead` samples, so
 *    the gain starts to fall before a peak arrives;
 * 2. lets the gain recover gradually (release) but fall at once;
 * 3. averages the result over the last `lookahead` samples, which turns the
 *    sudden fall into a ramp.
 *
 * Every value averaged in step 3 is already low enough for the current
 * sample, so the average is too. That is what makes the ceiling exact.
 *
 * This version processes a whole buffer in place. It looks ahead in the
 * buffer itself, so it adds no delay.
 */

export interface LimiterOptions {
  /** Ceiling in dBFS. */
  ceilingDb: number;
  /** Look-ahead in seconds. */
  lookahead?: number;
  /** Time in seconds for the gain to recover most of the way after a peak. */
  release?: number;
}

export interface LimiterResult {
  /** Largest gain reduction applied, in dB (0 when nothing was limited). */
  maxReductionDb: number;
}

export interface ChannelData {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export function limit(audio: ChannelData, options: LimiterOptions): LimiterResult {
  const { length, numberOfChannels, sampleRate } = audio;
  // Samples are 32-bit floats. Aim a hair low so rounding can't land above the ceiling.
  const ceiling = Math.fround(Math.pow(10, options.ceilingDb / 20) * (1 - 2 ** -22));
  const lookahead = Math.max(1, Math.round((options.lookahead ?? 0.005) * sampleRate));
  const releaseCoefficient = 1 - Math.exp(-1 / ((options.release ?? 0.1) * sampleRate));

  const channels: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) channels.push(audio.getChannelData(c));

  // Gain each sample needs on its own.
  const required = new Float32Array(length);
  let limited = false;
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const data of channels) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
    if (peak > ceiling) {
      required[i] = ceiling / peak;
      limited = true;
    } else {
      required[i] = 1;
    }
  }
  if (!limited) return { maxReductionDb: 0 };

  // Step 1: minimum over [i, i + lookahead], using a monotonic queue of indices.
  const held = new Float32Array(length);
  const queue = new Int32Array(length);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < length; i++) {
    const end = Math.min(length - 1, i + lookahead);
    while (next <= end) {
      while (tail > head && required[queue[tail - 1]] >= required[next]) tail--;
      queue[tail++] = next++;
    }
    while (queue[head] < i) head++;
    held[i] = required[queue[head]];
  }

  // Step 2: fall at once, recover gradually.
  let previous = 1;
  for (let i = 0; i < length; i++) {
    const target = held[i];
    previous = target < previous ? target : previous + (target - previous) * releaseCoefficient;
    held[i] = previous;
  }

  // Step 3: average over the last `lookahead` samples, then apply.
  let sum = 0;
  let minGain = 1;
  for (let i = 0; i < length; i++) {
    sum += held[i];
    if (i >= lookahead) sum -= held[i - lookahead];
    const count = Math.min(i + 1, lookahead);
    // Guard against rounding in the running sum pushing the gain a hair high.
    const gain = Math.min(sum / count, required[i]);
    if (gain < minGain) minGain = gain;
    if (gain < 1) {
      for (const data of channels) {
        const sample = data[i] * gain;
        data[i] = sample > ceiling ? ceiling : sample < -ceiling ? -ceiling : sample;
      }
    }
  }

  return { maxReductionDb: -20 * Math.log10(minGain) };
}
