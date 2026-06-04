# Conway Clips

An Ableton Live extension that grows, mutates, and evolves the contents of a MIDI clip by running Conway's Game of Life over its notes.

## What it does

Conway Clips treats a MIDI clip as a two-dimensional cellular automaton. Pitch is the vertical axis (16 rows, two octaves of the current scale) and time is the horizontal axis (one column per sixteenth note, up to two bars). Every note that lands on a pitch in the scale lights up a cell; everything else is dead space. Each "generation" applies the classic Game of Life rules — a live cell survives with two or three live neighbours, and a dead cell comes alive with exactly three — and the surviving cells are written back out as MIDI notes.

The result is a generative sketching tool: seed a clip with a few notes (or use the built-in randomizer), then step it forward to watch the pattern bloom, drift, stabilize into a loop, or die out. Because the time axis wraps around (the clip loops) while the pitch axis does not, gliders and oscillators travel through the bar and re-enter from the other side, producing evolving rhythmic-melodic phrases. Pitches are always quantized to Live's current Scale and root note, so the output stays in key as the song's scale changes.

The grid is fixed at 16 pitch rows (two octaves) starting at C4, with one column per sixteenth note. The number of columns follows the clip's loop length, capped at two bars (32 sixteenths); a clip with no loop or notes falls back to a single bar. Generated notes are written at velocity 100 with a duration of 90% of a sixteenth.

## Usage

Right-click any **MIDI clip** in Live. Conway Clips adds four context-menu items (all scoped to `MidiClip`):

- **Step Generation** — advances the clip by exactly one Game of Life generation and writes the result back to the clip.
- **Evolve 4 Generations** — runs four generations in a row and writes only the final state, for a larger jump in one action.
- **Randomize (Conway)** — replaces the clip's contents with a fresh random seed (~30% cell density) quantized to the current scale, giving you a starting pattern to evolve.
- **Auto-Tick…** — opens a small modal that automatically steps the clip on a timer. Pick a preset interval (250 ms, 500 ms, 1 s, 2 s, 4 s, 8 s) or enter a custom value in milliseconds, then **Start**. While running, the modal shows the active interval and offers a **Stop** button; **Cancel** dismisses without changing anything. The clip keeps evolving on its own until you stop it (or an error occurs), so you can watch it mutate while the transport plays.

All four read the song's current **Scale** (root note + mode) to build the pitch map, so the notes Conway writes always stay in the selected key. Supported scales include Major, Minor, the church modes (Dorian, Phrygian, Lydian, Mixolydian, Locrian), Pentatonic Major/Minor, Blues, Harmonic Minor, and Melodic Minor; an unrecognized scale falls back to Major.

## Requirements

- A build of Ableton Live whose Extension Host negotiates **Extensions API 1.0.0**.
- The Ableton Extensions SDK. See [../BUILDING.md](../BUILDING.md).

## Build & install

From the repo root:

```bash
pnpm install && pnpm run build
```

Then deploy this extension into your User Library:

```bash
cd conway-clips && pnpm run deploy
```

See [../BUILDING.md](../BUILDING.md) for SDK setup and the full build pipeline.

## Development

After editing source, run `pnpm run deploy` (not just `pnpm run build` — a bare build only writes to the repo's `dist/` and is never read by the Extension Host) and then reload the host via the dev-launch workflow described in [../DEVELOPMENT.md](../DEVELOPMENT.md).

## Limitations / notes

- The grid is fixed: 16 pitch rows (two octaves from C4) and a maximum of 32 columns (two bars of sixteenths). Notes outside the scale's pitch map, or beyond two bars, are not represented in the automaton.
- Each generation is destructive — the previous note content is replaced by the next generation. There is no built-in undo beyond Live's own undo history. Use **Randomize** to reseed if a pattern dies out or freezes into a static loop.
- Note velocity and duration are normalized on every step (velocity 100, 90% of a sixteenth); the automaton tracks only cell on/off state, not dynamics.
- Auto-Tick runs in the extension process; it stops automatically on error and when the extension unloads, but it does not persist across host reloads.

## License

GPL-3.0-or-later.
