# Beat Detective

An Ableton Live extension that detects transients in an audio clip and previews how they would snap to a rhythmic grid — a waveform-canvas onset analyzer.

## What it does

Warping audio by hand is tedious: you scrub the clip, hunt for each hit, and drop a warp marker on it before you can even think about quantizing. Beat Detective takes the first half of that work off your hands. Point it at an audio clip and it renders the clip's pre-FX audio, runs SuperFlux onset detection (from `@arclight/core`) over it, and opens a modal that draws the waveform with a vertical marker on every detected transient. You can overlay a grid (1/4, 1/8, 1/16, 1/32) and dial in a humanize amount to see, visually, where each hit sits relative to that grid.

The detection is tempo-aware — it reads the Live Set's current BPM so the grid lines and onset spacing line up with the project. The result is a fast way to audition a clip's groove and confirm Beat Detective finds the hits you expect.

## Usage

Right-click an audio clip (or an audio track) in Live. Beat Detective registers one context-menu item:

- **Smart Quantize (Beat Detective)** — appears on `AudioClip` and `AudioTrack`.

When invoked on a track, the extension picks the first session clip slot that holds an audio clip with a file path. A progress dialog walks through "Rendering audio… / Parsing audio… / Detecting transients… / Building waveform…", then the analysis modal opens (900×520):

- The **waveform canvas** shows the downsampled clip envelope with an orange triangle + line on each detected transient. Marker opacity reflects onset strength.
- **Grid** buttons (1/4, 1/8, 1/16, 1/32) redraw the subdivision lines; bar lines (every 4 beats) are drawn brighter.
- The **Humanize** slider (0–100%) and an **Info** readout (transient count · duration · BPM) round out the controls.
- **Apply Warp Markers** is present but disabled — see Limitations. **Close** dismisses the dialog.

## Requirements

- A build of Ableton Live whose Extension Host negotiates **Extensions API 1.0.0**.
- The Ableton Extensions SDK (`@ableton-extensions/sdk`). See [../BUILDING.md](../BUILDING.md) for how to obtain and reference it.
- Audio clips backed by a readable PCM WAV/AIFF file (the clip must have a file path the host can render).

## Build & install

From the repo root:

```bash
pnpm install
pnpm run build
```

Then deploy this extension into your Live User Library:

```bash
cd beat-detective && pnpm run deploy
```

`deploy` builds the bundle and copies `dist/extension.js` + `manifest.json` into the Live User Library `Extensions/` folder. Enable Developer Mode in Live → Preferences → Extensions to load it. See [../BUILDING.md](../BUILDING.md) for the full setup.

## Development

After editing source, run `pnpm run deploy` (from this directory) and reload the Extension Host using the dev-launch workflow described in [../DEVELOPMENT.md](../DEVELOPMENT.md). A bare `pnpm run build` is **not** enough — it only writes the repo's `dist/`, which the Extension Host never reads. You must deploy so the bundle lands in the User Library.

## Limitations / notes

- **Analyze / preview only on Extensions SDK 1.0.0.** SDK 1.0.0 made `AudioClip.warpMarkers` read-only and exposes **no** warp-marker write API (the 0.0.5-era `clip.setWarpMarkers` is gone). Beat Detective therefore detects transients and renders the full waveform + grid preview, but it **cannot write warp markers back to the clip**. The "Apply Warp Markers" button is disabled and the dialog explains why. Warp-write support can return as soon as the SDK exposes a setter — the marker-computation path (`transientFramesToWarpMarkers`) is still available in `@arclight/core`, ready to be re-wired in `src/extension.ts`.
- Detection runs on the clip's pre-FX rendered audio at the Set's current tempo; the waveform is downsampled to ~1000 points for display.
- WAV/AIFF PCM source only — the clip must resolve to a file path the host can render.

## License

GPL-3.0-or-later.
