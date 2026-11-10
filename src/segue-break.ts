import { LitElement, html, nothing } from 'lit';
import '@dawcore/components';
import type {
  DawClipElement,
  DawEditorElement,
  DawRecordingCompleteDetail,
  DawTrackElement,
} from '@dawcore/components';
import { NativePlayoutAdapter } from '@dawcore/transport';
import { dbToGain, formatDb, formatLufs, measureLoudness } from './loudness';
import {
  CUSTOM_TARGET_ID,
  DEFAULT_TARGET_ID,
  LOUDNESS_TARGETS,
  type LoudnessTarget,
} from './targets';
import {
  COMPRESSOR_EFFECT,
  COMPRESSOR_PARAMS,
  GAIN_EFFECT,
  HIGH_PASS_EFFECT,
  analyseTake,
  limiterParams,
  registerVoiceEffects,
  type Take,
  type TakeLevels,
} from './voice-chain';
import { encodeWav } from './wav';

/** Seconds of the outgoing song shown before its end. */
const TAIL_SECONDS = 30;
/** Seconds of the next song shown from its start. */
const HEAD_SECONDS = 30;
/** Seconds of outro the presenter hears before the join when playback starts. */
const PREROLL_SECONDS = 8;
const DEFAULT_OVERLAP_SECONDS = 4;

interface Song {
  name: string;
  /** Loudness of the whole file in LUFS. */
  loudness: number;
  trackId: string;
  clipId: string;
}

/**
 * One break: the end of the outgoing song, the start of the next one, and a
 * voice track to record the link on. Levels everything against a loudness
 * target and renders the join to a single WAV file.
 */
export class SegueBreak extends LitElement {
  static properties = {
    outgoing: { state: true },
    next: { state: true },
    overlap: { state: true },
    targetId: { state: true },
    customLoudness: { state: true },
    levelSongs: { state: true },
    songs: { state: true },
    levels: { state: true },
    ready: { state: true },
    recording: { state: true },
    busy: { state: true },
    message: { state: true },
  };

  private outgoing: File | null = null;
  private next: File | null = null;
  private overlap = DEFAULT_OVERLAP_SECONDS;
  private targetId = DEFAULT_TARGET_ID;
  private customLoudness = -16;
  private levelSongs = true;
  private songs: Song[] = [];
  private take: Take | null = null;
  private levels: TakeLevels | null = null;
  private ready = false;
  private recording = false;
  private busy = false;
  private message = '';

  private audioContext = new AudioContext();
  private micStream: MediaStream | null = null;
  private voiceTrack: DawTrackElement | null = null;
  private preGainEffectId: string | null = null;
  private makeUpEffectId: string | null = null;
  private limiterEffectId: string | null = null;
  private objectUrls: string[] = [];

  // Light DOM: <daw-transport for="..."> finds its editor by id in the document.
  protected createRenderRoot() {
    return this;
  }

  private get editor(): DawEditorElement {
    return this.querySelector('daw-editor') as DawEditorElement;
  }

  private get target(): LoudnessTarget {
    const preset = LOUDNESS_TARGETS.find((target) => target.id === this.targetId);
    return (
      preset ?? {
        id: CUSTOM_TARGET_ID,
        label: 'Custom',
        loudness: this.customLoudness,
        peakCeiling: -1,
      }
    );
  }

  /**
   * The level the voice should reach. With song levelling on, that is the
   * target. With it off, the songs keep their own levels, so the voice is
   * matched to them instead.
   */
  private get voiceTargetLoudness(): number {
    if (this.levelSongs) return this.target.loudness;
    const measured = this.songs.map((song) => song.loudness).filter(Number.isFinite);
    if (measured.length === 0) return this.target.loudness;
    return measured.reduce((total, value) => total + value, 0) / measured.length;
  }

  protected firstUpdated() {
    registerVoiceEffects();
    const editor = this.editor;
    editor.adapter = new NativePlayoutAdapter(this.audioContext);
    editor.addEventListener('daw-recording-start', () => {
      this.recording = true;
    });
    editor.addEventListener('daw-recording-complete', (event) => {
      this.recording = false;
      void this.levelTake((event as CustomEvent<DawRecordingCompleteDetail>).detail);
    });
    editor.addEventListener('daw-recording-error', (event) => {
      this.recording = false;
      this.message = `Recording failed: ${describe((event as CustomEvent).detail)}`;
    });
    editor.addEventListener('daw-track-error', (event) => {
      this.message = `Could not load a track: ${describe((event as CustomEvent).detail)}`;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.revokeObjectUrls();
  }

  private revokeObjectUrls() {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  private objectUrl(file: File): string {
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    return url;
  }

  private async decode(file: File): Promise<AudioBuffer> {
    return this.audioContext.decodeAudioData(await file.arrayBuffer());
  }

  private onFile(which: 'outgoing' | 'next', event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    if (which === 'outgoing') this.outgoing = file;
    else this.next = file;
    void this.buildJoin();
  }

  private onOverlap(event: Event) {
    this.overlap = Number((event.target as HTMLInputElement).value);
    void this.buildJoin();
  }

  private onTarget(event: Event) {
    this.targetId = (event.target as HTMLSelectElement).value;
    void this.relevel();
  }

  private onCustomLoudness(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      this.customLoudness = Math.min(0, Math.max(-40, value));
      void this.relevel();
    }
  }

  private onLevelSongs(event: Event) {
    this.levelSongs = (event.target as HTMLInputElement).checked;
    void this.relevel();
  }

  /** Lay out the outgoing tail, the next song's head and an empty voice track. */
  private async buildJoin() {
    if (!this.outgoing || !this.next || this.busy) return;
    this.busy = true;
    this.ready = false;
    this.message = 'Loading and measuring audio…';

    try {
      const editor = this.editor;
      editor.stop();
      for (const track of [...editor.tracks]) editor.removeTrack(track.trackId);
      this.revokeObjectUrls();
      this.songs = [];
      this.take = null;
      this.levels = null;

      const [outgoingBuffer, nextBuffer] = await Promise.all([
        this.decode(this.outgoing),
        this.decode(this.next),
      ]);
      const tail = Math.min(TAIL_SECONDS, outgoingBuffer.duration);
      const head = Math.min(HEAD_SECONDS, nextBuffer.duration);
      const overlap = Math.min(this.overlap, tail, head);
      const joinTime = tail - overlap;

      const outgoingTrack = await editor.addTrack({
        name: 'Outgoing',
        clips: [
          {
            src: this.objectUrl(this.outgoing),
            name: this.outgoing.name,
            start: 0,
            offset: outgoingBuffer.duration - tail,
            duration: tail,
            fadeOut: overlap,
          },
        ],
      });
      const nextTrack = await editor.addTrack({
        name: 'Next',
        clips: [
          {
            src: this.objectUrl(this.next),
            name: this.next.name,
            start: joinTime,
            offset: 0,
            duration: head,
          },
        ],
      });
      // Songs are measured whole, the way a playout system would measure them.
      this.songs = [
        this.describeSong(this.outgoing.name, outgoingBuffer, outgoingTrack),
        this.describeSong(this.next.name, nextBuffer, nextTrack),
      ];

      const voice = await editor.addTrack({ name: 'Voice' });
      this.preGainEffectId = voice.addEffect(GAIN_EFFECT, { gain: 1 });
      voice.addEffect(HIGH_PASS_EFFECT);
      voice.addEffect(COMPRESSOR_EFFECT, COMPRESSOR_PARAMS);
      this.makeUpEffectId = voice.addEffect(GAIN_EFFECT, { gain: 1 });
      this.limiterEffectId = voice.addEffect(
        COMPRESSOR_EFFECT,
        limiterParams(this.target.peakCeiling)
      );
      this.voiceTrack = voice;

      this.applyLevels();
      editor.seekTo(Math.max(0, joinTime - PREROLL_SECONDS));
      this.ready = true;
      this.message = 'Put headphones on, then press Record and talk over the join.';
    } catch (error) {
      this.message = `Could not build the join: ${describe(error)}`;
    } finally {
      this.busy = false;
    }
  }

  private describeSong(name: string, buffer: AudioBuffer, track: DawTrackElement): Song {
    const clip = track.querySelector('daw-clip') as DawClipElement;
    return {
      name,
      loudness: measureLoudness(buffer).integrated,
      trackId: track.trackId,
      clipId: clip.clipId,
    };
  }

  private songGain(song: Song): number {
    if (!this.levelSongs || !Number.isFinite(song.loudness)) return 1;
    return dbToGain(this.target.loudness - song.loudness);
  }

  /** Push the current target and switch settings to the songs and the voice chain. */
  private applyLevels() {
    const editor = this.editor;
    for (const song of this.songs) {
      editor.updateClip(song.trackId, song.clipId, { gain: this.songGain(song) });
    }
    const voice = this.voiceTrack;
    if (voice && this.preGainEffectId && this.makeUpEffectId && this.limiterEffectId) {
      voice.setEffectParams(this.preGainEffectId, { gain: this.levels?.preGain ?? 1 });
      voice.setEffectParams(this.makeUpEffectId, { gain: this.levels?.makeUpGain ?? 1 });
      voice.setEffectParams(this.limiterEffectId, limiterParams(this.target.peakCeiling));
    }
  }

  /** Measure a finished take and set the voice chain so it reaches the voice target. */
  private async levelTake(detail: DawRecordingCompleteDetail) {
    if (!this.voiceTrack) return;
    this.take = {
      buffer: detail.audioBuffer,
      offsetSamples: detail.offsetSamples,
      durationSamples: detail.durationSamples,
    };
    this.message = 'Levelling the take…';
    await this.relevel();
    if (this.levels && !Number.isFinite(this.levels.rawLoudness)) {
      this.message = 'That take was silent. Check the microphone and record again.';
    } else if (this.levels) {
      this.message = 'Link recorded and levelled. Drag the clips to adjust the timing.';
    }
  }

  /** Recompute every level after a new take or a change of target. */
  private async relevel() {
    if (this.take) {
      try {
        this.levels = await analyseTake(
          this.take,
          this.voiceTargetLoudness,
          this.target.peakCeiling
        );
      } catch (error) {
        this.levels = null;
        this.message = `Levelling the take failed: ${describe(error)}`;
      }
    }
    this.applyLevels();
  }

  private async toggleRecording() {
    const editor = this.editor;
    if (this.recording) {
      await editor.stopRecording();
      editor.stop();
      return;
    }
    if (!this.voiceTrack) return;

    try {
      this.micStream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
      await editor.startRecording(this.micStream, {
        trackId: this.voiceTrack.trackId,
        overdub: true,
        clipName: 'Link',
      });
    } catch (error) {
      this.message = `Could not start recording: ${describe(error)}`;
    }
  }

  private async exportJoin() {
    this.busy = true;
    this.message = 'Rendering…';
    try {
      const buffer = await this.editor.exportAudio();
      const measured = measureLoudness(buffer);
      const url = URL.createObjectURL(encodeWav(buffer));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'segue-transition.wav';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      const summary = `Transition rendered: ${formatLufs(measured.integrated)}, peak ${formatDb(measured.samplePeak)}.`;
      this.message =
        measured.samplePeak > this.target.peakCeiling
          ? `${summary} The peak is above the ${this.target.peakCeiling} dBFS ceiling for this target.`
          : summary;
    } catch (error) {
      this.message = `Could not render the transition: ${describe(error)}`;
    } finally {
      this.busy = false;
    }
  }

  private renderLevels() {
    if (this.songs.length === 0) return nothing;
    const gainDb = (gain: number) => {
      const db = 20 * Math.log10(gain);
      return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
    };
    return html`
      <dl class="levels">
        ${this.songs.map(
          (song) => html`
            <div>
              <dt>${song.name}</dt>
              <dd>${formatLufs(song.loudness)}, ${gainDb(this.songGain(song))}</dd>
            </div>
          `
        )}
        ${this.levels
          ? html`
              <div>
                <dt>Voice</dt>
                <dd>
                  ${formatLufs(this.levels.rawLoudness)} recorded, levelled to
                  ${formatLufs(this.levels.loudness)}, peak ${formatDb(this.levels.peak)}
                  ${Math.abs(this.levels.loudness - this.voiceTargetLoudness) > 1
                    ? html`<span class="note">
                        (aiming for ${formatLufs(this.voiceTargetLoudness)}; the limiter is holding
                        the peaks back)
                      </span>`
                    : nothing}
                </dd>
              </div>
            `
          : nothing}
      </dl>
    `;
  }

  protected render() {
    return html`
      <section class="inputs">
        <label>
          <span>Outgoing song</span>
          <input
            type="file"
            accept="audio/*"
            @change=${(event: Event) => this.onFile('outgoing', event)}
          />
        </label>
        <label>
          <span>Next song</span>
          <input
            type="file"
            accept="audio/*"
            @change=${(event: Event) => this.onFile('next', event)}
          />
        </label>
        <label>
          <span>Overlap: ${this.overlap} s</span>
          <input
            type="range"
            min="0"
            max="15"
            step="0.5"
            .value=${String(this.overlap)}
            @change=${this.onOverlap}
          />
        </label>
      </section>

      <section class="inputs">
        <label>
          <span>Loudness target</span>
          <select @change=${this.onTarget}>
            ${LOUDNESS_TARGETS.map(
              (target) => html`
                <option value=${target.id} ?selected=${target.id === this.targetId}>
                  ${target.label}
                </option>
              `
            )}
            <option value=${CUSTOM_TARGET_ID} ?selected=${this.targetId === CUSTOM_TARGET_ID}>
              Custom
            </option>
          </select>
        </label>
        ${this.targetId === CUSTOM_TARGET_ID
          ? html`
              <label>
                <span>Custom target (LUFS)</span>
                <input
                  type="number"
                  min="-40"
                  max="0"
                  step="0.5"
                  .value=${String(this.customLoudness)}
                  @change=${this.onCustomLoudness}
                />
              </label>
            `
          : nothing}
        <label class="checkbox">
          <input type="checkbox" .checked=${this.levelSongs} @change=${this.onLevelSongs} />
          <span>Level songs to target</span>
        </label>
        ${this.renderLevels()}
      </section>

      <daw-editor
        id="segue-editor"
        samples-per-pixel="2048"
        wave-height="96"
        timescale
        clip-headers
        interactive-clips
        eager-resume
      >
        <daw-keyboard-shortcuts playback undo></daw-keyboard-shortcuts>
      </daw-editor>

      <section class="controls">
        <daw-transport for="segue-editor">
          <daw-play-button></daw-play-button>
          <daw-pause-button></daw-pause-button>
          <daw-stop-button></daw-stop-button>
          <daw-time-display></daw-time-display>
        </daw-transport>
        <button
          class=${this.recording ? 'record recording' : 'record'}
          ?disabled=${!this.ready || this.busy}
          @click=${this.toggleRecording}
        >
          ${this.recording ? 'Stop recording' : 'Record link'}
        </button>
        <button ?disabled=${!this.ready || this.busy || this.recording} @click=${this.exportJoin}>
          Render transition
        </button>
      </section>

      ${this.message ? html`<p class="message" role="status">${this.message}</p>` : nothing}
    `;
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    const detail = value as { message?: unknown; error?: unknown };
    if (typeof detail.message === 'string') return detail.message;
    if (detail.error instanceof Error) return detail.error.message;
  }
  return String(value);
}

customElements.define('segue-break', SegueBreak);

declare global {
  interface HTMLElementTagNameMap {
    'segue-break': SegueBreak;
  }
}
