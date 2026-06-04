# Lidal

A TidalCycles-flavored live-coding extension for Ableton Live. Write patterns in
a browser-based editor; they stream out as MIDI to three virtual ports (notes +
drums + control) that you route to instruments, drum racks, and mapped
parameters inside Live.

## What it does

Lidal turns Live into a live-coding environment. Instead of drawing clips, you
type terse TidalCycles-style pattern expressions (`d1 $ s "bd ~ sd ~"`) in a
browser editor served on **`http://localhost:7654`** and evaluate them on the
fly; the running pattern engine schedules the resulting MIDI in real time,
cycle by cycle, locked to Live's transport (or Ableton Link, or an external MIDI
clock). Editing and re-evaluating an orbit swaps the pattern without dropping a
beat, so you can build up and mutate a piece interactively while it plays.

Lidal produces **no sound on its own** — it emits MIDI on three virtual output
ports (**Lidal Notes**, **Lidal Drums**, **Lidal Control**) that you route to
instruments, Drum Racks, and MIDI-mapped parameters inside Live. Note and drum
orbits (`d1`–`d16`) carry melodic/percussive patterns; control orbits (`c1`–`c8`)
emit continuous or stepped MIDI CC you can map to any Live or plugin parameter.
You can also **bake** the last few cycles of an orbit into ordinary MIDI clips
on per-orbit tracks for further editing in Live.

## Usage

Lidal registers two context-menu actions in Live:

| Menu item | Appears on | What it does |
|---|---|---|
| **Open Lidal Editor** | MidiClip, AudioClip, MidiTrack, AudioTrack, ClipSlot, Scene | Opens the browser-based editor (`http://localhost:7654`) in your default browser. The clicked object is only the menu anchor — the editor controls all orbits regardless of what you right-clicked. |
| **Lidal: Auto-map drums…** | MidiClip, MidiTrack | Walks the clicked clip's track (or the track itself) for its first Drum Rack, prompts for an orbit and whether to alias unknown samples, then pushes a `drumMap …` snippet into the editor buffer and installs it immediately so the running orbit re-routes without a re-eval. |

In the editor, `Cmd+Enter` evaluates the block under the cursor,
`Cmd+Shift+Enter` evaluates the whole buffer, `Cmd+B` bakes, and `hush`
silences everything. See **Quick start** and **What's implemented** below for
the pattern language. Before any of this makes sound, set up the MIDI routing
described next.

## Setting up MIDI routing in Live

Lidal does not produce sound on its own — it emits MIDI on virtual ports that
you route to instruments inside Live. Do this once, after installing/deploying
the extension and restarting Live.

### 1. Confirm the ports

After Live launches with the extension loaded, three virtual MIDI output ports
appear in **Live → Settings → Link, Tempo & MIDI**:

| Port | Used by | Default channel |
|---|---|---|
| **Lidal Notes** | `dN $ n "..."` (melodic patterns) | `dN` → MIDI ch `N` (so `d1` → ch 1, `d2` → ch 2, … `d16` → ch 16) |
| **Lidal Drums** | `dN $ s "..."` (drum patterns) | same per-orbit mapping as above |
| **Lidal Control** | `cN $ ctrl …` (CC patterns) | MIDI ch 1 for every `cN` |

(A fourth port, **Lidal Clock In**, only matters when you switch the sync mode
to `midi-clock`. Ignore it unless you're driving Lidal from external clock.)

If the ports don't appear: make sure the extension actually loaded (check
Live's status bar for `[Lidal] Ready …`), then restart Live. Virtual ports are
created at extension activation, so a reload via `SIGHUP` is enough during
development but a fresh Live launch is the safest first-time check.

### 2. Make Live listen to each port

In Live's MIDI preferences pane, find each Lidal port row under **Input** /
**Output** (the exact labels vary by Live version) and toggle **Track** on so
Live will accept MIDI from it.

Then create a MIDI track per port:

- **Notes track** — new MIDI track → **MIDI From: Lidal Notes**. Drop your
  favourite instrument plugin on it (Operator, Wavetable, Serum, anything that
  takes MIDI). All channels in (or pick a specific channel if you want to
  isolate one orbit).
- **Drums track** — new MIDI track → **MIDI From: Lidal Drums**. Drop a **Drum
  Rack** on it. Use the `drumMap` combinator (or right-click on the track's
  clip → **Lidal: Auto-map drums…**) to alias names like `bd`, `sd`, `hh` to
  the rack's actual MIDI notes. See "Drum mapping" further down for details.
- **Control track** — new MIDI track → **MIDI From: Lidal Control**. Arm it.
  Run a `c1 $ ctrl 74 sine` or use `learn 74` and then press `Cmd+M` in Live to
  enter MIDI Map mode; click the destination knob/slider and the wiggle binds
  it. Press `Cmd+M` again to exit. Repeat with a fresh CC number per
  parameter — Live remembers each mapping.

You don't need a separate track per orbit unless you want them on different
instruments. For melodic patterns, you can split orbits across multiple tracks
by setting each track's **MIDI From** channel to the matching orbit number
(`d3` → ch 3, etc.).

### Troubleshooting routing

- **Ports not appearing** — confirm `[Lidal] Ready …` in the console (or
  `tail -f` on the extension log). If Live shows no Lidal rows in MIDI prefs,
  check that the extension actually loaded and that no other instance is
  holding the ports.
- **No sound but the editor says it's playing** — the orbit's port + channel
  must match what the receiving track listens to. `d2 $ n "c4"` goes out on
  **Lidal Notes**, MIDI channel 2, by default; if your instrument track is set
  to channel 1 only, it'll never hear that orbit. Either set **MIDI From** to
  "All Channels", set the track to channel 2, or pin the orbit with `.ch(1)`.
- **Drum names produce no notes** — the built-in `DRUM_MAP` uses GM-ish
  defaults (`bd`=36, `sd`=38, `hh`=42 …). If your Drum Rack uses different
  pads, install a `drumMap` for that orbit or use **Lidal: Auto-map drums…**
  on a clip in the rack's track.
- **CC moves nothing** — confirm the control track is **armed** (MIDI Map mode
  in Live only sees CC traffic from armed tracks for live mapping). If the CC
  was already mapped, the arm doesn't matter for playback, only for fresh
  mapping.

## Quick start

```
d1 $ s "bd ~ sd ~" # gain 0.9
d2 $ n "c4 e4 g4" # every 4 (fast 2)
d3 $ chord "Cmaj7" # arp "up"
c1 $ ctrl 74 sine            -- sweep CC 74 with a sine, route to a Live param
```

`d1`–`d16` register a note pattern on an "orbit" (Tidal terminology — one orbit
≈ one MIDI channel). `c1`–`c8` are the same idea for control (CC) patterns.
`hush` silences everything. `Cmd+Enter` evaluates the block under the cursor;
`Cmd+Shift+Enter` evaluates the whole buffer.

## Bake

Press `Cmd+B` (or `Ctrl+B`) to bake the last N cycles of the orbits in the
current block into MIDI clips on per-orbit tracks (one track per orbit, clips
stack in successive session-view slots). N defaults to 4 (header control).
Patterns keep playing throughout — bake is fire-and-forget. CC orbits are not
yet bakeable (the SDK 1.0.0 surface has no automation/envelope API; bridge CCs
through a Max for Live device if you need them captured).

## Architecture

A `Pattern` is a function from cycle index → events for that one host cycle.
Combinators wrap that function. A continuous-signal modulation source is just
`(cycleN, phase) => number`. The scheduler calls `getEvents(cycleN)` once per
cycle and emits MIDI noteon/noteoff via `easymidi`.

Sync sources include manual BPM, LOM (Live's transport), MIDI clock input, and
Ableton Link. Cycle length is `quantum * (60_000 / bpm)`.

**Determinism.** Patterns are stateless and every random source (`degrade`,
`sometimes`, `choose`, `irand`, `perlin`, etc.) is seeded by `cycleN`. Reloading
the extension or re-evaluating an unchanged orbit produces the **same sequence
at the same cycle position** — this is intentional. If you want non-repeating
randomness, change the pattern (e.g. compose in another random source, or
modulate with `slow N` to spread it across more cycles).

## What's implemented

### Mini-notation (string patterns inside `n` / `s`)

| Syntax | Meaning |
|---|---|
| `a b c` | Sequence — N items split a cycle into N equal slots |
| `[a b]` | Subdivision — children share their parent's slot |
| `[a, b]` | Parallel-in-slot — `a` and `b` fire simultaneously in the slot |
| `<a b c>` | Alternation — picks `children[cycleN % len]` each cycle |
| `{a b, c d}` | Polyrhythm — each lane plays one cycle independently |
| `{a b c}%4` | Polymeter — force lane(s) to N slots regardless of element count |
| `a*N` | Repeat N× within the slot |
| `~` | Rest (silence) |
| `a _ _ b` | Elongate — `_` extends the previous element by one slot |
| `bd(3,8)` | Euclidean — 3 hits distributed across 8 slots |
| `bd(3,8,2)` | Euclidean with rotation — left-rotate the slot array by 2 |
| `a?` / `a?0.3` | Degrade — element drops in 50% (or N%) of cycles |
| `a@2 b` | Weighted slot — `a` takes 2/3 of cycle, `b` takes 1/3 |
| `a ! b` / `a !*3 b` | Replicate previous element |
| `0 .. 7` | Numeric range expansion — equivalent to `0 1 2 3 4 5 6 7` |
| `a b \| c d` | Random pick (chooseTail) — picks one whole sequence per cycle, seeded |
| `c'maj` / `f#3'min7` | Chord shorthand — fires chord intervals concurrently |

Numeric tokens (e.g. `n "0 7 12"`) are interpreted as semitone offsets from C4.

### Combinators

**Constructors:** `n`, `s`, `silence`, `run`, `irand`, `choose`, `wchoose`, `chord`

**Multi-pattern:** `stack`, `cat`, `fastcat` (alias `seq`)

**Time-scaling:** `fast`, `slow`, `density`, `sparsity`

**Transforms:** `rev`, `every`, `whenmod`, `sometimes`, `sometimesBy`, `often`,
`rarely`, `chunk`, `iter`, `palindrome`, `mask`, `struct`, `stutter`, `inside`,
`outside`, `rot`

**Time-shift:** `early`, `late`, `nudge`

**Windowing:** `linger`, `trunc`, `zoom`, `compress`, `off`

**Routing:** `ch` / `chan`, `jux`, `juxBy`, `juxTo`

**Velocity:** `gain`, `velocity`, `degrade`, `degradeBy`

**Pitch math:** `add`, `sub`, `mul`, `up`, `octave`, `range`, `range2`

**Music theory:** `scale`, `arp`, `chord` (constructor), `'` chord shorthand
in mini-notation. 14 scales (major, minor, modes, harmonic/melodic minor,
pentatonics, blues, chromatic) and ~20 chord types (triads, 7ths, 9ths, 6ths,
sus, dim, aug).

**Drum mapping:** `drumMap N "bd:36 sn:38 tom1=41"` installs a per-orbit
drum-alias map (empty spec clears the override). `autoMap N "909 Kit"` walks
the named Live track for its first Drum Rack and builds a map from each
chain's first Simpler sample filename (skipping samples that don't match a
known drum alias). `autoMapAll` does the same but aliases unknown samples by
sanitized filename instead of skipping them. Both are also available via the
right-click **Lidal: Auto-map drums…** menu on a MIDI clip — Lidal walks the
clip's track and pushes the resulting `drumMap …` snippet into the editor
buffer (and installs it immediately so the running patterns route correctly
without needing a re-eval).

**Continuous signals** (modulation sources, used directly as combinator args):
`sine` / `sine2`, `cosine` / `cosine2` (alias `cos` / `cos2`), `tri` / `tri2`,
`saw` / `saw2`, `isaw` / `isaw2`, `square` / `square2`, `rand`, `perlin`. The
`2` suffix is the bipolar `[-1, 1]` form. `segment(N, sig)` discretizes a
signal into a Pattern of N events per cycle.

### Control patterns (MIDI CC out)

Output a continuous (or stepped) signal on a MIDI CC, route it to any Live or
VST parameter via Live's MIDI Map mode (Cmd+M).

```
c1 $ ctrl 74 sine                        -- CC 74, sine sweep, ch 1, 64 steps/cycle
c2 $ ctrl 71 (range 30 90 saw)           -- explicit 30..90 range
c3 $ ctrl 80 "0 64 127 64"               -- stepped pattern, 4 CCs/cycle
c1 $ ctrl 74 sine # segment 128          -- override smooth-density (max 1024)
c1 $ ctrl 74 sine # chan 5               -- explicit MIDI channel
c1 $ ctrl 74 sine # rest 0               -- snap CC 74 to 0 when this orbit clears
c1 $ fast 2 (ctrl 74 sine)               -- combinators compose
c1 $ every 4 rev (ctrl 74 sine)          -- conditional transforms work
c1 $ jux rev (ctrl 74 sine)              -- modified copy on next channel up
c1 silence                               -- clear; fires `# rest` if set, else holds
```

**Combinators compose.** All time-scaling and structural combinators —
`fast`, `slow`, `density`, `sparsity`, `every`, `whenmod`, `rev`, `palindrome`,
`jux`, `juxBy`, `juxTo`, `stack`, `cat`, `fastcat`/`seq`, `mask`, `struct`,
`chunk`, `iter`, `early`, `late`, `nudge`, `linger`, `trunc`, `zoom`,
`compress`, `off`, `stutter`, `inside`, `outside`, `rot`, `degrade`,
`degradeBy`, `sometimes` / `often` / `rarely`, `sometimesBy` — work on control
patterns. `stack [ctrl 74 sine, ctrl 71 saw]` drives two CCs from one orbit;
`jux rev` emits the modified copy on `channel + 1`. Pitch-specific combinators
(`scale`, `chord`, `arp`, `add`, `sub`, `mul`, `up`, `octave`, `gain`,
`velocity`) refuse on a control pattern — use `ctrl` with a numeric pattern
to drive CC values instead.

**Auto-scaling.** Continuous signals like `sine`/`saw`/`tri` ([0..1]) and the
bipolar `sine2`/`saw2` ([-1..1]) are auto-mapped to [0..127] when used directly.
Wrap in `range lo hi sig` (or `range2`) to pick your own range. Pattern/string
sources are taken in CC range as-is (e.g. `"0 64 127"` emits exactly those
values).

**Stepped vs smooth.** Patterns and mini-notation strings produce one CC event
per pattern slot (Tidal-correct). Continuous signals are sampled at 64 phases
per cycle by default; override with `# segment N`.

**Resting behavior.** By default, removing or replacing a control orbit holds
the last value (no snap). Add `# rest N` (integer 0..127) to snap that CC to a
chosen value when the orbit is *cleared* (`c1 silence` or `c1 null`); replacing
one orbit with another never fires the outgoing rest, so re-evals stay smooth.
Re-evaluating a control orbit clears the dedup cache so identical values re-fire
— useful for verifying mappings after a reload.

**MIDI mapping a CC in Live.** Type `learn 74` and evaluate. Lidal emits a
slow triangle sweep on CC 74 for ~8 cycles. In Live, press Cmd+M to enter MIDI
Map mode, click the destination knob/slider, and the wiggle binds it. Press
Cmd+M again to exit. Use a different CC number per parameter — Lidal hands
CCs out, Live remembers the mapping.

The control port is named **Lidal Control**. Channel defaults to 1; orbit
slots `c1..c8` are independent of `d1..d16` (you can re-evaluate either without
disturbing the other).

### Patternable arguments

Most numeric combinator args accept a `Patternable<T>` — a constant, a
mini-notation string, a Pattern, or a ContinuousSignal. So `fast "<2 3>"`
alternates speed per cycle, `gain sine` sweeps velocity smoothly across each
cycle, and `add (range 0 12 saw)` ramps pitch up by an octave per cycle.

## Examples

```
-- Drums with continuous velocity modulation
d1 $ s "bd*16" # gain (range 0.4 1 sine)

-- Pitch wobble in a melody
d2 $ n "c4 e4 g4 c5" # add (range2 (-7) 7 sine2)

-- Euclidean rhythm with random jitter
d3 $ s "cp(3,8) hh(5,16)" # velocity (range 0.5 1 perlin)

-- Chord arpeggio with structural variation
d4 $ chord "Cmaj7" # arp "up" # every 4 (fast 2)

-- Polyrhythm
d5 $ s "{bd cp, hh hh hh hh, ~ rim ~ rim}"

-- Degree-based melody in a scale
d6 $ n "0 2 4 7 4 2" # scale "dorian" # add 7

-- jux for stereo-style splits across MIDI channels
d7 $ s "bd sd hh cp" # jux rev    -- original on ch 1, reversed on ch 2

-- mask + struct: combine rhythmic gating
d8 $ n "0 .. 7" # scale "minor" # mask "x ~ x ~ x x ~ x"
```

## Requirements

- A build of **Ableton Live** whose Extension Host negotiates Extensions API
  **1.0.0**, with Developer Mode enabled (Live → Preferences → Extensions).
- The **Ableton Extensions SDK** (`@ableton-extensions/sdk`), which is
  proprietary and not bundled here — see [../BUILDING.md](../BUILDING.md) for
  how to obtain and place it.
- The native dependencies `easymidi` and `abletonlink` build prebuilt bindings
  against Live's bundled node; the build externalizes them and ships the
  binaries with the deployed bundle.

## Build & install

From the repo root:

```bash
pnpm install
pnpm run build
```

Then deploy this extension:

```bash
cd lidal
pnpm run deploy   # bundles dist/extension.js + manifest.json into your User Library
pnpm test         # optional: offline + vitest spec suites
```

`deploy` builds the bundle and copies it (with `manifest.json` and the
externalized native modules) into `Extensions/lidal/` in your Ableton User
Library. Enable Developer Mode in Live → Preferences → Extensions to load it.
See [../BUILDING.md](../BUILDING.md) for full SDK setup and prerequisites.

## Development

After editing source, run `pnpm run deploy` (from `lidal/`) and then reload the
running Extension Host via the dev-launch workflow described in
[../DEVELOPMENT.md](../DEVELOPMENT.md). A bare `pnpm run build` is **not** enough
— the Extension Host loads the *deployed* bundle from your User Library, not the
repo's `dist/`, so you must deploy before reloading. Because the virtual MIDI
ports are created at activation, a `SIGHUP` reload is enough to re-evaluate
patterns, but a first-time port check is most reliable after a fresh Live
launch.

## Limitations / notes (deferred features)

The following Tidal/mini-notation items would be useful but are not yet
implemented:

### Mini-notation

- **`/N` slow notation** (`"bd/2"` plays bd over 2 cycles) — needs multi-cycle
  pattern support that our cycle-indexed model doesn't currently express.
- **`:N` sample/note selector** (`"bd:2"`) — semantically maps to specific
  drum-rack samples, less critical for MIDI workflows.

### Combinators

- **`firstOf` / `lastOf`** — minor variants of `every`/`whenmod`; you can build
  them from existing pieces.
- **`slice` / `bite`** — sample-cutup oriented; more useful for audio than MIDI.
- **`loopFirst` / `loopBack`** — niche pattern lifecycle ops.
- **`swing` / `swingBy`** — quantization-style swing; could be added but
  `late`/`stutter` cover much of the territory.

### Operators

- **Tidal `|+`, `|*`, `|+|`, `|*|`** value-pattern operators — intentionally
  skipped. The method form (`.add`, `.mul`) covers the same ground; supporting
  the operators would require transpiler work without much added expressiveness.

### Audio-only Tidal features (out of scope)

Effect controls don't map to MIDI: `room`, `lpf`/`hpf`/`bpf`, `chop`,
`striate`, `crush`, `coarse`, `shape`, `delay` / `delayfb`, `accelerate`,
sample `speed`, `cut`, `legato`, `loop`, `begin` / `end`, `pan` (replaced by
`jux` channel routing), `vowel`, `crispy`, etc. If you need these, send the
MIDI to an instrument plugin in Live and modulate the plugin's parameters
there.

### Continuous signals

- **2D Perlin** (`perlin2`, `perlinWith`) — only 1D ships.
- **Audio-rate signals** — sample density is bounded by per-event resolution;
  we don't interpolate inside an event. Use a finer `segment N` if you need
  more resolution.

### Control patterns

- **14-bit (high-resolution) CCs** — only standard 7-bit CCs (values 0..127)
  are emitted. NRPN/RPN are out of scope; bridge via a Max for Live device if
  you need them.
- **Inline monitor widget** — orbit names show up in the editor status pill,
  but a per-CC live-value display would be nicer. Deferred.

## Notes for contributors

- The Extension Host VM sandbox doesn't have `Request`, `Response`, `URL`,
  `TextEncoder`, `setImmediate`, `performance` — the build polyfills those.
- Patterns are stateless. Every random source is seeded by `cycleN` so a reload
  produces the same sequence at the same cycle position.
- Distinct PRNG seed namespaces are documented at the top of `src/patterns.ts`
  — pick a fresh prime when adding new random sources.
- Mini-notation parsing and combinator implementation are split: parser.ts
  builds the AST and emits events; patterns.ts wraps event streams in
  combinators. Music theory tables live in music.ts.

## License

GPL-3.0-or-later.

