# Groove Transplant

An Ableton Live extension that extracts the timing and velocity "feel" of a MIDI or audio clip and stamps it onto other MIDI clips — and builds playable Drum Racks by slicing the individual drum voices out of an audio loop.

## What it does

Producers often have one clip that *grooves* — a drummed hi-hat pattern, a humanized bassline, a sampled break — and want everything else in the session to lock to that same pocket. Groove Transplant analyses a source clip, measures how far each hit sits ahead of or behind the grid and how its velocity varies, and saves that as a reusable groove profile. You can then apply it to any MIDI clip with adjustable timing and velocity strength, previewing the result before committing it as a single undo step. Extracted grooves are also written out as native Live `.agr` files so they show up in Live's browser and can be dragged straight into the Groove Pool.

It also goes the other direction with audio: point it at a drum loop and it detects the kick, snare, hi-hat and open-hat hits, slices each voice into its own WAV, and assembles a Drum Rack on a fresh MIDI track — turning a one-shot loop into a fully playable kit.

## Usage

All actions are reached by right-clicking an object in Live. The exact context-menu labels and the object types they appear on:

| Object type | Menu item | What happens |
|-------------|-----------|--------------|
| MIDI clip | **Copy Groove** | Detects the optimal grid resolution, extracts per-slot timing and velocity offsets, and opens a dialog with a bar chart, a resolution override, and a name field. Save stores the profile and exports a `.agr` to the Groove Pool. |
| MIDI clip | **Apply Groove…** | Opens a picker of saved grooves with **Timing strength** and **Velocity strength** sliders and a live before/after preview. Apply rewrites the clip's notes in one undo step. You can also delete a groove from this dialog, which reopens it with the updated list. |
| Audio clip | **Extract Groove from Audio…** | Reads the audio file, estimates BPM (from the clip/file name or by analysis), then shows a settings dialog (BPM, frequency band, sensitivity, resolution). Detects transients, builds a groove, and lets you save/export it as `.agr`. |
| Audio clip | **Build Drum Rack from Audio…** | Shows a settings dialog (BPM, sensitivity, which voices to detect, track name, fill-gaps). Detects drum voices, slices them to WAV, and creates a new MIDI track with a Drum Rack. |
| Audio track | **Manage Drum Rack Samples…** | Lists previously-created drum rack sample sets with size and date; select sets and delete them from disk. (The handler ignores the clicked track — it is surfaced here purely so the action is discoverable.) |

Audio commands accept **WAV and AIFF** (PCM 16-bit or 24-bit) only; MP3/AAC and 32-bit/compressed formats are rejected.

### Where files go

- Exported grooves: `~/Music/Ableton .../User Library/Grooves/Groove Transplant/<name>.agr`
- Drum rack sample sets: `~/Music/Ableton .../User Library/Samples/Groove Transplant/<loop name>/`
- Internal groove profiles (JSON): the extension's `storageDirectory`.

A groove profile records `offsets` (per-slot timing deviations in beats), `velocityOffsets` (per-slot velocity deviation, –1..+1), plus `resolution`, `swingAmount`, `tempo`, `name`, `id`, and `createdAt`.

## Requirements

- A build of **Ableton Live** whose Extension Host negotiates Extensions API **1.0.0**, with Developer Mode enabled (Live → Preferences → Extensions).
- The **Ableton Extensions SDK** (`@ableton-extensions/sdk`), which is proprietary and not bundled here — see [../BUILDING.md](../BUILDING.md) for how to obtain and place it.

## Build & install

From the repo root:

```bash
pnpm install
pnpm run build
```

Then deploy this extension into your Live User Library:

```bash
cd groove-transplant && pnpm run deploy
```

`deploy` rebuilds the bundle and copies `dist/extension.js` plus `manifest.json` into your Ableton `Extensions/` folder. See [../BUILDING.md](../BUILDING.md) for full prerequisites, the SDK setup, and per-extension build details.

## Development

After editing source, run `pnpm run deploy` again and reload the running Extension Host via the dev-launch workflow described in [../DEVELOPMENT.md](../DEVELOPMENT.md). A bare `pnpm run build` is **not** enough on its own — the Extension Host only loads the deployed copy in your User Library, so you must deploy before reloading.

## Limitations / notes

- Audio extraction and slicing support WAV/AIFF PCM 16-bit or 24-bit only; 32-bit int PCM and compressed AIFF are rejected with an error.
- At very high tempos (200 BPM+), tightly-spaced drum hits (16th-note doublets) may occasionally be merged by the transient deduplication pass.
- Building a Drum Rack does not roll back partial state: if a voice fails to load, an orphan MIDI track can be left in Live.
- The Apply Groove dialog previews timing/velocity visually but does not play back audio.
- CC/automation grooves are out of scope — this extension works on note timing and velocity only.

## License

GPL-3.0-or-later.
