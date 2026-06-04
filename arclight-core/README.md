# @arclight/core

A dependency-free TypeScript library shared by the Arclight Ableton extensions. It bundles the audio-analysis algorithms, music-theory utilities, groove math, and small HTML/webview helpers that the extensions build on top of.

`@arclight/core` is **not itself an Ableton extension** — it never imports the Extensions SDK and has no runtime dependencies. Everything operates on plain data (MIDI note arrays, raw PCM samples, groove profiles), so it can be unit-tested with vanilla Node.js and reused across extensions without dragging in host APIs.

- **License:** GPL-3.0-or-later
- **Package name:** `@arclight/core`
- **Entry point:** `dist/index.js` (built from `src/index.ts`, which re-exports every module)

## What it provides

| Module | Purpose | Key exports |
|--------|---------|-------------|
| `music-theory.ts` | Key/scale detection, per-bar chord identification, diatonic next-chord suggestions, MIDI-note generation from chords. | `detectKey`, `identifyChord`, `buildChordTimeline`, `suggestNextChords`, `getScaleNotes`, `chordToNotes`, `NOTE_NAMES`, `SCALE_PATTERNS`, `CHORD_TYPES` |
| `transient-detector.ts` | SuperFlux spectral-flux onset detection on PCM/AIFF audio, plus WAV/AIFF parsing, a bandpass filter, an FFT, and a tempo estimator. | `parseWav`, `parseAiff`, `parseAudio`, `detectTransients`, `detectTransientsSuperFlux`, `applyBandpassFilter`, `fft`, `estimateTempo` |
| `drum-detector.ts` | Multi-pass drum-voice classifier that separates kick, snare, hi-hat, and open-hat hits from a mixed drum loop, with contextual reclassification passes. | `detectDrumVoices`, `computeDrumFeatures`, `classifyDrumVoice`, `classifyDrumVoiceEx`, `contextualReclassify`, plus the `DrumAnalysis`/`DrumVoice`/`DrumHit`/`DrumFeatures` types |
| `warp-utils.ts` | Groove math: extract a `GrooveProfile` from MIDI or audio, apply its timing/velocity character back onto notes, pick a grid resolution, and turn transients into warp markers. | `computeGrooveFromMidi`, `computeGrooveFromAudio`, `computeGrooveProfile`, `applyGrooveToNotes`, `applyVelocityGroove`, `detectOptimalResolution`, `transientFramesToWarpMarkers` |
| `pattern-fill.ts` | Post-detection pass that infers each drum voice's periodic IOI and synthesises hits masked by louder simultaneous hits, flagging them `synthetic`. | `fillPatternGaps`, `PatternFillOptions` |
| `music-theory.ts` types &nbsp;/&nbsp; `types.ts` | Shared data shapes used across modules and extensions. | `MidiNote`, `ChordInfo`, `KeyInfo`, `TransientFrame`, `WarpMarkerData`, `GrooveProfile`, `FrequencyBand`, `AudioGrooveOptions`, `WebviewMessage` |
| `webview.ts` | Builds self-contained HTML `data:` URLs for the SDK modal dialog, wired to the host's `close_and_send` postMessage protocol. | `buildWebviewDataUrl`, `buildErrorDataUrl` |
| `text-utils.ts` | Extract a BPM (60–220) from clip names / filenames using common sample-pack conventions. | `extractBpmFromText` |
| `write-wav.ts` | Write a mono `Float32Array` as a 32-bit-float PCM WAV (used when slicing drum voices to disk). | `writeWav` |

Everything is re-exported from `src/index.ts`, so consumers import from the package root:

```ts
import { detectKey, computeGrooveFromMidi, detectDrumVoices } from "@arclight/core";
```

### Groove pipeline at a glance

1. `detectOptimalResolution` scores candidate grids `[1, 1/2, 1/4, 1/8, 1/3, 1/6]` by mean `(deviation / resolution)²` so finer grids don't auto-win.
2. `computeGrooveFromMidi` / `computeGrooveFromAudio` fold notes (or detected transients) into per-slot timing **and** velocity offsets within one bar, interpolating empty slots from nearest neighbours (circular), and emit a `GrooveProfile`.
3. `applyGrooveToNotes` and `applyVelocityGroove` blend a profile back onto a fresh set of notes by a `strength` factor, with a minimum-gap sweep that prevents grooved notes from colliding.

## How extensions consume it

`@arclight/core` is an internal workspace package. Extensions that depend on it declare:

```jsonc
// <extension>/package.json
"dependencies": {
  "@arclight/core": "workspace:*"
}
```

The package manager resolves `workspace:*` to this directory, and the extension's bundler reads the compiled output from `dist/`. Current consumers in this monorepo: **harmonic-lens**, **groove-transplant**, **beat-detective**, and **petri**. (lidal is standalone and does not depend on it.)

> Because consumers read `dist/`, run `pnpm -C arclight-core run build` after changing `src/` so dependents see your edits. An extension's own build/pack step also rebuilds `@arclight/core` first.

## Building

```bash
pnpm -C arclight-core run build   # tsc --build → dist/
pnpm -C arclight-core run dev     # tsc --build --watch
```

`dist/` (with `index.js` + `index.d.ts`) is the package entry point declared in `package.json` (`main` / `types`).

## Testing

```bash
pnpm -C arclight-core run test         # vitest run (single pass)
pnpm -C arclight-core run test:watch   # vitest watch
```

```
src/__tests__/
  drum-detector.test.ts          Drum-detector unit tests
  drum-detector-corpus.test.ts   Corpus accuracy tests against WAV+JSON fixtures
  classify-voice.test.ts         Voice-classification unit tests
  context-reclassify.test.ts     Context-aware reclassification tests
  hf-decay.test.ts               High-frequency decay analysis tests
  transient-detector.test.ts     SuperFlux onset-detection tests
  warp-utils.test.ts             Groove math + computeGrooveFromAudio integration
  pattern-fill.test.ts           Gap-interpolation tests
  text-utils.test.ts             BPM-extraction tests
  write-wav.test.ts              WAV-writer tests
  corpus/loops/                  Committed WAV+JSON corpus fixtures
  diag/                          One-off diagnostic scripts (not part of the suite)
```

Most tests are self-contained: audio fixtures are either committed under `corpus/loops/` or synthesised in-process (sine tones, pulse trains, hand-built WAV/AIFF buffers), so the suite runs offline with no setup.

A handful of cases reach for **local sample files that are not committed** (e.g. private drum one-shots, Groove Transplant slice output). These use `describe.skipIf(!existsSync(path))`, so they **skip silently when those files are absent** and only run on a machine that has them. The corpus harness likewise degrades gracefully — if `corpus/loops/` contains no `.wav` files it emits a single "run generate-corpus.ts first" placeholder instead of failing.

### Diagnostic scripts

`src/__tests__/diag/` holds standalone `tsx` scripts for debugging the drum detector against specific audio files. They are not part of the vitest suite — run them directly, e.g.:

```bash
pnpm -C arclight-core exec tsx src/__tests__/diag/diag-break.ts path/to/file.wav
```

Each prints detailed pass-by-pass output for a particular problem case. Some hard-code private sample paths and are intended for the original author's machine.

## Notes & known limitations

- **No runtime dependencies** — only TypeScript, vitest, and tsx as dev dependencies. Audio processing operates on raw PCM from `parseWav` / `parseAiff` with no external decoding library.
- **Supported audio formats:** 16- and 24-bit integer PCM WAV and 32-bit float WAV (mono/stereo, any sample rate), plus AIFF via `parseAiff`. 32-bit integer PCM, 8-bit PCM, and compressed formats throw a descriptive error.
- `applyBandpassFilter` with `lowHz ≤ 20` silently degrades to low-pass only — the high-pass stage is skipped and the resulting band label is misleading (tracked as **W6**).
- At 200 BPM and above, intentional 16th-note doublet hits can still be collapsed by the drum detector's late re-deduplication pass despite the doublet-rescue fixes (tracked as **R3**).
