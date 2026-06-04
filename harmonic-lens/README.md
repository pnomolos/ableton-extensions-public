# Harmonic Lens

An Ableton Live extension that reads the chords and key out of a MIDI clip, then lets you click-insert suggested next chords straight into the clip.

## What it does

Harmonic Lens looks at the notes in a MIDI clip and works out what's going on harmonically: it detects the most likely key and mode (major/minor and the church modes), walks the clip bar by bar to identify the chord playing in each bar, and — based on the detected key and the final chord — proposes a handful of musically sensible chords you could play next. It's meant for the moment when you've sketched a progression and want to know "what key am I in, and where could this go?" without leaving Live.

Everything happens locally in a modal dialog. The key detector, the bar-by-bar chord timeline, and the next-chord suggester are inlined into the webview, so there's no server round-trip and no network access — open the dialog, read the analysis, and optionally click one or more suggested chords to append them to the clip. When you press **Done**, any chords you appended are written back to the clip in a single transaction.

## Usage

Harmonic Lens registers one command, `harmonic-lens.analyze`, exposed as a context-menu action in two places:

| Context menu item | Appears on |
|-------------------|------------|
| **Analyze with Harmonic Lens** | MIDI Clip |
| **Analyze with Harmonic Lens** | MIDI Track |

- **On a MIDI clip**, the clicked clip is analyzed directly.
- **On a MIDI track**, the extension scans the track's session clip slots and analyzes the first clip that actually contains notes. If no clip in the track has any notes, a short modal explains that there's nothing to analyze.

The modal dialog shows:

- **Key bar** — the detected key and mode (e.g. "C Major") with a confidence read-out.
- **Chord chart** — a horizontal strip of chord blocks, one per detected chord, each labelled with the chord name and the bar where it starts.
- **Suggestion row ("Try next →")** — buttons for the suggested next chords. Click a button to append that chord to the clip; click several to build out a continuation.

Press **Done** to close. If you appended any chords, the expanded note set is written back to the clip (the write only happens when the note count actually grew, so closing without adding anything leaves the clip untouched).

## Requirements

- A build of Ableton Live whose Extension Host negotiates **Extensions API 1.0.0**.
- The Ableton Extensions SDK, set up locally. See **[../BUILDING.md](../BUILDING.md)**.

## Build & install

From the repo root:

```bash
pnpm install
pnpm run build
```

Then deploy this extension into your Live User Library:

```bash
cd harmonic-lens && pnpm run deploy
```

`deploy` builds the bundle and copies it (with `manifest.json`) into `Extensions/harmonic-lens/` in your Ableton User Library. Enable Developer Mode in Live → Preferences → Extensions to load it. See **[../BUILDING.md](../BUILDING.md)** for SDK setup and **[../DEVELOPMENT.md](../DEVELOPMENT.md)** for the development workflow.

## Development

After editing source, run `pnpm run deploy` (from `harmonic-lens/`) and then reload the Extension Host via the dev-launch workflow described in **[../DEVELOPMENT.md](../DEVELOPMENT.md)**. A bare `pnpm run build` is not enough — the Extension Host loads the *deployed* bundle from your User Library, not the repo's `dist/`, so you must deploy for changes to take effect.

### Source layout

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point — registers `harmonic-lens.analyze` and the MIDI Clip / MIDI Track context-menu actions; resolves the handle, runs analysis, shows the modal, and writes appended chords back within a transaction. |
| `src/webview-html.ts` | Builds the modal HTML; the music-theory engine (key detection, chord timeline, suggestions) is inlined here so the page is self-contained. |

## Limitations / notes

- Chord detection accuracy drops at fast tempos with dense polyphony.
- Chord-type coverage is limited (e.g. sus, add9, and slash chords are not modelled).
- Suggested chords are appended at the end of the clip; there's no way to insert them at an arbitrary beat position.

## License

GPL-3.0-or-later.
