import { LitElement, html, nothing } from 'lit';
import '@dawcore/components';
import type { DawEditorElement } from '@dawcore/components';
import { NativePlayoutAdapter } from '@dawcore/transport';
import { encodeWav } from './wav';

/** Seconds of the outgoing song shown before its end. */
const TAIL_SECONDS = 30;
/** Seconds of the next song shown from its start. */
const HEAD_SECONDS = 30;
/** Seconds of outro the presenter hears before the join when playback starts. */
const PREROLL_SECONDS = 8;
const DEFAULT_OVERLAP_SECONDS = 4;

/**
 * One break: the end of the outgoing song, the start of the next one, and a
 * voice track to record the link on. Renders the join to a single WAV file.
 */
export class SegueBreak extends LitElement {
  static properties = {
    outgoing: { state: true },
    next: { state: true },
    overlap: { state: true },
    ready: { state: true },
    recording: { state: true },
    busy: { state: true },
    message: { state: true },
  };

  private outgoing: File | null = null;
  private next: File | null = null;
  private overlap = DEFAULT_OVERLAP_SECONDS;
  private ready = false;
  private recording = false;
  private busy = false;
  private message = '';

  private audioContext = new AudioContext();
  private micStream: MediaStream | null = null;
  private voiceTrackId: string | null = null;
  private objectUrls: string[] = [];

  // Light DOM: <daw-transport for="..."> finds its editor by id in the document.
  protected createRenderRoot() {
    return this;
  }

  private get editor(): DawEditorElement {
    return this.querySelector('daw-editor') as DawEditorElement;
  }

  protected firstUpdated() {
    const editor = this.editor;
    editor.adapter = new NativePlayoutAdapter(this.audioContext);
    editor.addEventListener('daw-recording-start', () => {
      this.recording = true;
    });
    editor.addEventListener('daw-recording-complete', () => {
      this.recording = false;
      this.message = 'Link recorded. Drag the clips to adjust the timing.';
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

  private async durationOf(file: File): Promise<number> {
    const buffer = await this.audioContext.decodeAudioData(await file.arrayBuffer());
    return buffer.duration;
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

  /** Lay out the outgoing tail, the next song's head and an empty voice track. */
  private async buildJoin() {
    if (!this.outgoing || !this.next || this.busy) return;
    this.busy = true;
    this.ready = false;
    this.message = 'Loading audio…';

    try {
      const editor = this.editor;
      editor.stop();
      for (const track of [...editor.tracks]) editor.removeTrack(track.trackId);
      this.revokeObjectUrls();

      const [outgoingDuration, nextDuration] = await Promise.all([
        this.durationOf(this.outgoing),
        this.durationOf(this.next),
      ]);
      const tail = Math.min(TAIL_SECONDS, outgoingDuration);
      const head = Math.min(HEAD_SECONDS, nextDuration);
      const overlap = Math.min(this.overlap, tail, head);
      const joinTime = tail - overlap;

      await editor.addTrack({
        name: 'Outgoing',
        clips: [
          {
            src: this.objectUrl(this.outgoing),
            name: this.outgoing.name,
            start: 0,
            offset: outgoingDuration - tail,
            duration: tail,
            fadeOut: overlap,
          },
        ],
      });
      await editor.addTrack({
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
      const voice = await editor.addTrack({ name: 'Voice' });
      this.voiceTrackId = voice.trackId;

      editor.seekTo(Math.max(0, joinTime - PREROLL_SECONDS));
      this.ready = true;
      this.message = 'Put headphones on, then press Record and talk over the join.';
    } catch (error) {
      this.message = `Could not build the join: ${describe(error)}`;
    } finally {
      this.busy = false;
    }
  }

  private async toggleRecording() {
    const editor = this.editor;
    if (this.recording) {
      await editor.stopRecording();
      editor.stop();
      return;
    }
    if (!this.voiceTrackId) return;

    try {
      this.micStream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
      await editor.startRecording(this.micStream, {
        trackId: this.voiceTrackId,
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
      const url = URL.createObjectURL(encodeWav(buffer));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'segue-transition.wav';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.message = 'Transition rendered.';
    } catch (error) {
      this.message = `Could not render the transition: ${describe(error)}`;
    } finally {
      this.busy = false;
    }
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
