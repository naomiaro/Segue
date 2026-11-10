# Segue

> Working title. Browser-based voice tracking for community, campus and internet radio.

Segue lets a presenter record or type the links between songs from a browser, and turns them into finished audio that a station's existing playout system can play.

**Status: early prototype.** One break can be loaded, recorded and rendered in the browser. Everything else in this README describes what the project intends to build and in what order. Feedback from people who run or volunteer at stations is the most useful contribution right now.

## Why

Voice tracking means recording the talk between songs ahead of time, so an automated hour sounds presented. Commercial radio has done it for decades. For volunteer-run stations the options are a paid suite, or a desktop tool installed in the studio.

Segue aims to make it something a volunteer can do from home in a browser tab, with results that sound consistent whatever microphone they own.

## What it does

### Recorded breaks

- Shows the end of the outgoing song and the start of the next one, overlapped on one screen.
- Suggests two markers: where the outgoing song winds down, and where the next song's vocals begin.
- The presenter listens to the outro, talks, and starts the next song under their voice.
- The voice clip and the next song's start point can be dragged afterwards. Music ducks under speech automatically.

### Typed breaks

- A break can be a script, read by a synthetic voice.
- The editor shows how long a script will run against the intro it has to fit.
- Templates such as `That was {previous.artist}, next up {next.title}` can fill unstaffed hours with no writing at all.
- Each station keeps a pronunciation dictionary for artist and track names.

### Consistent sound

- Every voice gets the same processing: rumble filter, compression, and loudness matched to the music.
- Tracks are loudness-normalised on import.
- Fades can align to bars.

### Output

Segue hands over audio and stops there. Depending on the playout system:

- a voice clip with timing data,
- a rendered transition (outro, link and intro in one file), or
- a whole hour as one file, with a timestamped track list for licence reporting.

### Team features

- A producer builds the hour and assigns breaks.
- Each break can carry a prompt: an event to mention, a sponsor line, what's on next.
- Someone can review and approve before it airs.

## What it does not do

- Stream, schedule or play out audio. Use AzuraCast, LibreTime, kast, Rivendell or whatever you already run.
- Live broadcasting.
- Voice cloning. This may be revisited later, and only with the recorded consent of the person whose voice it is.
- Replace presenters. Recorded humans are the default. Synthetic voices are for hours nobody is available to cover.

## Roadmap

### 1. One break

- [x] Load two audio files and show the join
- [x] Record a voice link over the join in the browser
- [ ] Drag to adjust timing, with automatic ducking
- [x] Render the transition to a single file

### 2. Typed breaks

- [ ] Script field per break, with estimated duration against intro length
- [ ] Pluggable text-to-speech engine, with one local model and one hosted API
- [ ] Templates with track, time and station variables
- [ ] Pronunciation dictionary
- [ ] Synthetic breaks labelled in the log

### 3. The hour

- [ ] Import a running order (M3U, or upload tracks)
- [ ] Loudness normalisation on import
- [ ] Automatic marker suggestions (beats, vocal entry)
- [ ] Voice processing chain
- [ ] Running time for the hour, over or under
- [ ] Export a full hour with a track list

### 4. Teams

- [ ] Accounts and stations
- [ ] Assign breaks, with prompts
- [ ] Review and approval

### 5. Playout integrations

- [ ] AzuraCast
- [ ] kast
- [ ] LibreTime

These are intentions. None has been checked against the target system's API yet.

### 6. Hosted service

- [ ] Paid hosting for stations that don't want to run it themselves
- [ ] Usage metering for rendering and premium voices

### Exploring

- Serverless playout: a station served as a computed HLS playlist over pre-rendered segments, with no always-running encoder.
- Stream monitor: loudness, dead air and speech-to-music logging for any stream.

## How it's built

Planned, and subject to change:

- **Editor:** [dawcore](https://github.com/naomiaro/waveform-playlist) web components (`@dawcore/components`, `@dawcore/transport`) for multitrack display, editing, recording and playback.
- **App:** Vite, TypeScript and Lit.
- **Analysis:** [Beat This!](https://github.com/CPJKU/beat_this) for beats and downbeats, and [Demucs](https://github.com/adefossez/demucs) to find where vocals enter.
- **Rendering:** dawcore's offline export in the browser for a single break. ffmpeg on a server once whole hours need rendering.
- **Speech:** engine-agnostic. Candidate models are still being evaluated, including their licences.
- **Hosted version:** Cloudflare Workers, R2, Durable Objects and Queues, with billing through Polar.

The core (edit, analyse, render) should run from a single Docker Compose file with no Cloudflare account. How much of the team layer can be self-hosted the same way is an open question.

## Development

Requires Node.js 20.19 or newer (22.12 or newer on the 22 line).

```bash
npm install
npm run dev
```

Open the address Vite prints, choose an outgoing song and a next song, then record a link over the join. Use headphones, so the music doesn't leak into the microphone.

`npm run build` type-checks and builds to `dist/`.

## Music licensing

Segue is a production tool. Stations are responsible for holding the licences needed to broadcast the music they play.

## Licence

[AGPL-3.0](LICENSE).

## Get involved

If you run, programme or present at a station, open a [station feedback issue](../../issues/new?template=station-feedback.yml) and describe how links get recorded today and what gets in the way. That will shape the order of the roadmap more than anything else.
