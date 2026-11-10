/** A loudness target a station can aim its output at. */
export interface LoudnessTarget {
  id: string;
  label: string;
  /** Programme loudness in LUFS. */
  loudness: number;
  /** Highest permitted peak in dBFS. */
  peakCeiling: number;
}

/**
 * Sources:
 * - EBU R 128: -23 LUFS, maximum true peak -1 dBTP.
 * - ATSC A/85: -24 LKFS, maximum true peak -2 dBTP.
 * - AES TD1008 (streaming): -16 LUFS for music, -18 LUFS for speech. It gives
 *   no figure used here for peaks, so -1 dBFS is Segue's choice.
 * - Apple Podcasts: around -16 LKFS, true peak no higher than -1 dBFS.
 */
export const LOUDNESS_TARGETS: LoudnessTarget[] = [
  { id: 'ebu-r128', label: 'EBU R 128 broadcast (−23 LUFS)', loudness: -23, peakCeiling: -1 },
  { id: 'atsc-a85', label: 'ATSC A/85 broadcast (−24 LKFS)', loudness: -24, peakCeiling: -2 },
  { id: 'aes-music', label: 'AES streaming, music (−16 LUFS)', loudness: -16, peakCeiling: -1 },
  { id: 'aes-speech', label: 'AES streaming, speech (−18 LUFS)', loudness: -18, peakCeiling: -1 },
  { id: 'podcast', label: 'Apple Podcasts (−16 LKFS)', loudness: -16, peakCeiling: -1 },
];

export const DEFAULT_TARGET_ID = 'aes-music';
export const CUSTOM_TARGET_ID = 'custom';
