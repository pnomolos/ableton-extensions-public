# Petri

An Ableton Live Extension that treats your MIDI clips as an evolving ecology — mutate, breed, and continuously oscillate clip content using genetic-style operators.

## What it does

Petri turns a static MIDI clip into living material. Instead of editing notes by hand, you apply evolutionary operators to a clip and let variation emerge: nudge pitch, timing, duration, and velocity at a chosen mutation rate; cross-breed two clips so the offspring takes its rhythm from one parent and its pitch contour from the other; or set a clip "oscillating" so it re-mutates itself on a recurring interval while you work.

The genetics are deterministic and seedable — the same seed and settings always produce the same mutation — which makes **Mutate Again** a repeatable, evolving step rather than a fresh random roll each time. Optional **scale lock** snaps every mutated pitch back onto Live's current root note and scale, so the experiment stays musically in-key. All operators run inside the Extension Host and write results straight back to the clip via the SDK; the breeding and mutation previews are computed in the modal webview so you can audition variations before committing.

## Usage

Right-click any **MIDI clip** in Live to reach Petri's four context-menu actions (all registered on `MidiClip` in `src/extension.ts`):

| Context-menu item | What it does |
|-------------------|--------------|
| **Open Lab…** | Opens the Petri Lab — a session-wide browser of every MIDI clip that has notes. Pick **Parent A** and **Parent B**, preview the bred offspring (rhythm from B, pitch from A, with a mutation-rate slider and Re-roll), choose a target clip, then **Breed & Write** to commit the offspring into the selected clip. The clip you right-clicked is pre-selected as Parent A. |
| **Mutate…** | Opens the mutate modal for the clicked clip. Choose a mutation **rate** and which dimensions to vary (pitch, timing, duration, velocity), preview the result, Re-roll, then **Apply** to write the mutated notes back. The settings and next seed are remembered per clip. |
| **Mutate Again** | Re-applies the last mutation settings for that clip with the next seed — no dialog — so each invocation advances the evolution one deterministic step. If the clip has never been mutated, it falls back to the full Mutate modal. |
| **Oscillate…** | Opens the oscillation modal. Set an interval (in **bars**: ½/1/2/4/8, or **seconds**: 1–30), an **intensity**, and toggle **Scale lock** and **Transport sync**, then **Start**. Petri then re-mutates the clip in place on every interval. Re-opening the modal on a clip that is already oscillating lets you **Stop** it. |

### Modal flow

Each command opens a modal webview rendered by `src/webview-html.ts`. Breeding and mutation are previewed live in the webview (using the same seeded genetics as the host), and the chosen result is sent back through the `close_and_send` message protocol. The host then writes notes to the clip inside a transaction. Oscillation runs entirely in the host on a timer once started and persists until you stop it or the extension unloads.

## Requirements

- A build of Ableton Live whose Extension Host negotiates **Extensions API 1.0.0**.
- The Ableton Extensions SDK (`@ableton-extensions/sdk`). See [../BUILDING.md](../BUILDING.md) for the toolchain and SDK setup.

## Build & install

From the repo root:

```bash
pnpm install
pnpm run build
```

Then deploy this extension to your User Library:

```bash
cd petri
pnpm run deploy
```

`deploy` builds and copies `dist/extension.js` into `~/Music/Ableton Alpha/User Library/Extensions/petri/dist/`. The deployed folder must also contain `manifest.json`. See [../BUILDING.md](../BUILDING.md) for full build details.

## Development

After editing any source file under `src/`, run `pnpm run deploy` from the `petri/` directory and reload the running Extension Host via the dev-launch workflow described in [../DEVELOPMENT.md](../DEVELOPMENT.md). A bare `pnpm run build` is **not** enough — it only writes to the repo's `dist/`, which the Extension Host never reads, so you must deploy for changes to take effect.

## Limitations / notes

- **No transport gating.** The Oscillate modal still exposes a *Transport sync* toggle, but the SDK 1.0.0 migration removed `song.isPlaying` (transport play-state is no longer exposed), so oscillation cannot gate on whether Live is playing. Oscillation therefore runs on its own internal interval regardless of transport state, and the toggle has no effect on play-state gating.
- Oscillation mutates the clip **in place** — there is no automatic undo of an oscillation cycle, so use a duplicate clip if you want to preserve the original.
- The Lab browses MIDI clips with notes across the session; clips are capped at 128 notes for the preview.

## License

GPL-3.0-or-later.
