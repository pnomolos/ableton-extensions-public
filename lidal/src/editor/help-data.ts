// Lidal help data — the single source of truth for combinator/constructor/
// signal documentation surfaced by the help overlay (Cmd+?), CM6 hover
// tooltips, and (post-merge) the autocomplete completion source.
//
// Design intent:
//   • One TypeScript module imported by every help surface so that updating
//     a description in one place propagates everywhere.
//   • Names here must match the runtime names exposed by patterns.ts /
//     control.ts. The hover tooltip uses identifier lookup keyed by `name`.
//   • `category` drives the section grouping in the help overlay. Categories
//     are intentionally fine-grained so the modal is scannable rather than a
//     single 80-row table.
//   • `signature` is a compact Haskell-ish type (matches Tidal idioms) —
//     never multi-line. `description` is one short sentence; `example` is
//     one runnable expression. Anything longer belongs in the README.
//
// The data here is referenced from non-bundled TypeScript files; the bundle
// size cost is the JSON-ish payload only (≈ 16 KB raw, gzip-friendly).

export type HelpKind = "orbit" | "constructor" | "combinator" | "signal" | "function";

export type HelpCategory =
  | "orbits"
  | "mini-notation"
  | "constructors"
  | "multi-pattern"
  | "transforms"
  | "time-scaling"
  | "time-shift"
  | "windowing"
  | "routing"
  | "velocity"
  | "pitch-math"
  | "music-theory"
  | "signals"
  | "drum-mapping"
  | "control"
  | "global";

export interface HelpEntry {
  name: string;
  kind: HelpKind;
  category: HelpCategory;
  signature: string;
  description: string;
  example: string;
}

// Section ordering for the help overlay. Categories not in this list fall back
// to alphabetical at the end (currently every category is enumerated).
export const HELP_CATEGORIES: { id: HelpCategory; title: string; blurb?: string }[] = [
  { id: "orbits",        title: "Orbits",        blurb: "Note streams (d1..d16) and CC streams (c1..c8). Each orbit is one pattern."  },
  { id: "constructors",  title: "Constructors",  blurb: "Pattern sources — strings, lists, or single values." },
  { id: "multi-pattern", title: "Multi-pattern", blurb: "Combine several patterns into one." },
  { id: "transforms",    title: "Transforms",    blurb: "Restructure a pattern (reverse, mask, chunk, every, etc.)." },
  { id: "time-scaling",  title: "Time-scaling",  blurb: "Speed up or slow down within a cycle." },
  { id: "time-shift",    title: "Time-shift",    blurb: "Move events earlier or later." },
  { id: "windowing",     title: "Windowing",     blurb: "Crop, stretch, or overlay a slice of a cycle." },
  { id: "routing",       title: "Routing",       blurb: "Pick MIDI channels; split into stereo-like pairs." },
  { id: "velocity",      title: "Velocity",      blurb: "Scale or drop notes." },
  { id: "pitch-math",    title: "Pitch math",    blurb: "Add semitones, shift octaves, map signal ranges." },
  { id: "music-theory",  title: "Music theory",  blurb: "Scales, chords, arpeggios." },
  { id: "signals",       title: "Signals",       blurb: "Continuous LFO-style sources usable as combinator args." },
  { id: "drum-mapping",  title: "Drum mapping",  blurb: "Per-orbit alias maps; introspect a Live Drum Rack." },
  { id: "control",       title: "Control (CC)",  blurb: "MIDI CC patterns: c1..c8." },
  { id: "global",        title: "Globals",       blurb: "Stand-alone functions and constants." },
  { id: "mini-notation", title: "Mini-notation", blurb: "Pattern-string syntax inside n/s/chord/mask/struct." },
];

// Helper used by both help overlay and hover tooltip.
export const HELP_BY_NAME: Map<string, HelpEntry> = new Map();

function add(...rows: HelpEntry[]): HelpEntry[] {
  for (const r of rows) HELP_BY_NAME.set(r.name, r);
  return rows;
}

// ── Entries ────────────────────────────────────────────────────────────────

// Orbits — d1..d16 + c1..c8. We generate the list to keep things in sync.
const NOTE_ORBITS: HelpEntry[] = Array.from({ length: 16 }, (_, i) => ({
  name: `d${i + 1}`,
  kind: "orbit" as const,
  category: "orbits" as const,
  signature: `d${i + 1} :: Pattern -> ()`,
  description: `Register a note/drum pattern on orbit ${i + 1}. n → Lidal Notes, s → Lidal Drums (ch ${i + 1}).`,
  example: `d${i + 1} $ s "bd ~ sd ~"`,
}));
const CTRL_ORBITS: HelpEntry[] = Array.from({ length: 8 }, (_, i) => ({
  name: `c${i + 1}`,
  kind: "orbit" as const,
  category: "orbits" as const,
  signature: `c${i + 1} :: ControlPattern -> ()`,
  description: `Register a CC pattern on control orbit ${i + 1} (Lidal Control, ch 1 by default).`,
  example: `c${i + 1} $ ctrl 74 sine`,
}));
add(...NOTE_ORBITS, ...CTRL_ORBITS);

const CONSTRUCTORS = add(
  { name: "n",        kind: "constructor", category: "constructors",
    signature: "n :: String -> Pattern",
    description: "Build a note pattern from mini-notation. Numbers are semitone offsets from C4.",
    example: `n "c4 e4 g4 c5"` },
  { name: "s",        kind: "constructor", category: "constructors",
    signature: "s :: String -> Pattern",
    description: "Build a drum pattern. Names like bd, sd, hh resolve through the active drumMap.",
    example: `s "bd ~ sd ~"` },
  { name: "silence",  kind: "constructor", category: "constructors",
    signature: "silence :: Pattern",
    description: "Empty pattern. Assigning silence to an orbit clears it.",
    example: `d2 silence` },
  { name: "run",      kind: "constructor", category: "constructors",
    signature: "run :: Int -> Pattern",
    description: "Numeric ramp 0..N-1, one event per slot.",
    example: `n (run 8) # scale "minor"` },
  { name: "irand",    kind: "constructor", category: "constructors",
    signature: "irand :: Int -> Pattern",
    description: "Per-cycle random integer in 0..N-1, seeded by cycleN.",
    example: `n (irand 12) # add 60` },
  { name: "choose",   kind: "constructor", category: "constructors",
    signature: "choose :: [a] -> Pattern",
    description: "Uniformly pick one element per cycle.",
    example: `n (choose ["c4","e4","g4"])` },
  { name: "wchoose",  kind: "constructor", category: "constructors",
    signature: "wchoose :: [(Weight, a)] -> Pattern",
    description: "Weighted version of choose. Heavier weights fire more often.",
    example: `n (wchoose [[3,"c4"],[1,"g4"]])` },
);

const MULTI = add(
  { name: "stack",    kind: "constructor", category: "multi-pattern",
    signature: "stack :: [Pattern] -> Pattern",
    description: "Play patterns simultaneously (all events from all patterns).",
    example: `stack [s "bd*4", s "~ sd"]` },
  { name: "cat",      kind: "constructor", category: "multi-pattern",
    signature: "cat :: [Pattern] -> Pattern",
    description: "Concatenate one pattern per cycle (round-robin).",
    example: `cat [n "c4", n "e4 g4"]` },
  { name: "fastcat",  kind: "constructor", category: "multi-pattern",
    signature: "fastcat :: [Pattern] -> Pattern",
    description: "Concatenate all patterns into a single cycle (alias seq).",
    example: `fastcat [s "bd", s "sd"]` },
  { name: "seq",      kind: "constructor", category: "multi-pattern",
    signature: "seq :: [Pattern] -> Pattern",
    description: "Alias for fastcat — sequentially within one cycle.",
    example: `seq [s "bd", s "sd"]` },
);

const TIME_SCALING = add(
  { name: "fast",     kind: "combinator", category: "time-scaling",
    signature: "fast :: Patternable<Number> -> Pattern -> Pattern",
    description: "Speed up by factor N (squeeze N cycles into one).",
    example: `fast 2 (s "bd sd")` },
  { name: "slow",     kind: "combinator", category: "time-scaling",
    signature: "slow :: Patternable<Number> -> Pattern -> Pattern",
    description: "Stretch by factor N (one event takes N cycles).",
    example: `slow 2 (n "c4 e4")` },
  { name: "density",  kind: "combinator", category: "time-scaling",
    signature: "density :: Number -> Pattern -> Pattern",
    description: "Alias for fast.",
    example: `density 4 (s "bd sd")` },
  { name: "sparsity", kind: "combinator", category: "time-scaling",
    signature: "sparsity :: Number -> Pattern -> Pattern",
    description: "Alias for slow.",
    example: `sparsity 2 (s "bd sd hh cp")` },
);

const TRANSFORMS = add(
  { name: "rev",        kind: "combinator", category: "transforms",
    signature: "rev :: Pattern -> Pattern",
    description: "Reverse events within each cycle.",
    example: `rev (n "c4 e4 g4 c5")` },
  { name: "palindrome", kind: "combinator", category: "transforms",
    signature: "palindrome :: Pattern -> Pattern",
    description: "Forward, then backward, alternating per cycle.",
    example: `palindrome (n "c4 e4 g4")` },
  { name: "every",      kind: "combinator", category: "transforms",
    signature: "every :: Patternable<Int> -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation once every Nth cycle.",
    example: `every 4 rev (s "bd sd hh cp")` },
  { name: "whenmod",    kind: "combinator", category: "transforms",
    signature: "whenmod :: Int -> Int -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation when cycleN mod N == M.",
    example: `whenmod 8 5 (fast 2) (s "bd*4")` },
  { name: "sometimes",  kind: "combinator", category: "transforms",
    signature: "sometimes :: (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation in ~50% of cycles (seeded).",
    example: `sometimes rev (n "c4 e4 g4")` },
  { name: "sometimesBy", kind: "combinator", category: "transforms",
    signature: "sometimesBy :: Number -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation with given probability (0..1).",
    example: `sometimesBy 0.3 rev (s "bd sd hh cp")` },
  { name: "often",      kind: "combinator", category: "transforms",
    signature: "often :: (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation in ~75% of cycles.",
    example: `often (fast 2) (s "bd cp")` },
  { name: "rarely",     kind: "combinator", category: "transforms",
    signature: "rarely :: (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Apply transformation in ~25% of cycles.",
    example: `rarely rev (n "c4 e4 g4")` },
  { name: "chunk",      kind: "combinator", category: "transforms",
    signature: "chunk :: Int -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Split cycle into N chunks; apply transformation to one per cycle (advances).",
    example: `chunk 4 rev (s "bd sd hh cp")` },
  { name: "iter",       kind: "combinator", category: "transforms",
    signature: "iter :: Int -> Pattern -> Pattern",
    description: "Rotate events by 1/N of a cycle per cycle.",
    example: `iter 4 (n "c4 e4 g4 c5")` },
  { name: "mask",       kind: "combinator", category: "transforms",
    signature: "mask :: Patternable -> Pattern -> Pattern",
    description: "Gate events: only fire where mask has non-rest.",
    example: `mask "1 ~ 1 1" (s "bd*4")` },
  { name: "struct",     kind: "combinator", category: "transforms",
    signature: "struct :: Patternable -> Pattern -> Pattern",
    description: "Graft a rhythm onto a value pattern — mask + map.",
    example: `struct "x ~ x x" (n "c4")` },
  { name: "stutter",    kind: "combinator", category: "transforms",
    signature: "stutter :: Int -> Number -> Pattern -> Pattern",
    description: "Repeat each event N times across t cycles (echo-like).",
    example: `stutter 4 0.125 (s "bd")` },
  { name: "inside",     kind: "combinator", category: "transforms",
    signature: "inside :: Int -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Slow by N, apply, speed back up — operates inside the time-scaled view.",
    example: `inside 2 rev (s "bd sd hh cp")` },
  { name: "outside",    kind: "combinator", category: "transforms",
    signature: "outside :: Int -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Speed by N, apply, slow back down — inverse of inside.",
    example: `outside 4 rev (s "bd sd")` },
  { name: "rot",        kind: "combinator", category: "transforms",
    signature: "rot :: Number -> Pattern -> Pattern",
    description: "Rotate events within the cycle by N (1.0 = full cycle).",
    example: `rot 0.25 (s "bd sd hh cp")` },
  { name: "degrade",    kind: "combinator", category: "velocity",
    signature: "degrade :: Pattern -> Pattern",
    description: "Drop ~50% of events (seeded per cycle).",
    example: `degrade (s "hh*8")` },
  { name: "degradeBy",  kind: "combinator", category: "velocity",
    signature: "degradeBy :: Number -> Pattern -> Pattern",
    description: "Drop given fraction (0..1) of events per cycle.",
    example: `degradeBy 0.3 (s "hh*16")` },
);

const TIME_SHIFT = add(
  { name: "early",  kind: "combinator", category: "time-shift",
    signature: "early :: Number -> Pattern -> Pattern",
    description: "Shift events earlier (left) by fraction of a cycle.",
    example: `early 0.125 (s "bd sd")` },
  { name: "late",   kind: "combinator", category: "time-shift",
    signature: "late :: Number -> Pattern -> Pattern",
    description: "Shift events later (right) by fraction of a cycle.",
    example: `late 0.125 (s "bd sd")` },
  { name: "nudge",  kind: "combinator", category: "time-shift",
    signature: "nudge :: Number -> Pattern -> Pattern",
    description: "Small time offset in beats (musical-time variant of early/late).",
    example: `nudge (-0.02) (s "bd*4")` },
);

const WINDOWING = add(
  { name: "linger",   kind: "combinator", category: "windowing",
    signature: "linger :: Number -> Pattern -> Pattern",
    description: "Loop the first fraction of a cycle for the rest of it.",
    example: `linger 0.25 (s "bd sd hh cp")` },
  { name: "trunc",    kind: "combinator", category: "windowing",
    signature: "trunc :: Number -> Pattern -> Pattern",
    description: "Keep only the first fraction of each cycle, leave rest silent.",
    example: `trunc 0.5 (s "bd sd hh cp")` },
  { name: "zoom",     kind: "combinator", category: "windowing",
    signature: "zoom :: Number -> Number -> Pattern -> Pattern",
    description: "Take the [a..b] slice and stretch it to fill the cycle.",
    example: `zoom 0.25 0.75 (s "bd sd hh cp")` },
  { name: "compress", kind: "combinator", category: "windowing",
    signature: "compress :: Number -> Number -> Pattern -> Pattern",
    description: "Squash the full cycle into the [a..b] sub-range.",
    example: `compress 0 0.5 (s "bd sd")` },
  { name: "off",      kind: "combinator", category: "windowing",
    signature: "off :: Number -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Overlay a delayed, transformed copy.",
    example: `off 0.125 (add 7) (n "c4 e4 g4")` },
);

const ROUTING = add(
  { name: "chan",   kind: "combinator", category: "routing",
    signature: "chan :: Int -> Pattern -> Pattern",
    description: "Set MIDI channel (1..16). Overrides the orbit default.",
    example: `d1 $ n "c4" # chan 4` },
  { name: "ch",     kind: "combinator", category: "routing",
    signature: "ch :: Int -> Pattern -> Pattern",
    description: "Alias of chan.",
    example: `d1 $ n "c4" # ch 4` },
  { name: "jux",    kind: "combinator", category: "routing",
    signature: "jux :: (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Stack original on this channel + transformed copy on channel+1.",
    example: `jux rev (s "bd sd hh cp")` },
  { name: "juxBy",  kind: "combinator", category: "routing",
    signature: "juxBy :: Number -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "jux with a 0..1 spread (currently routes copy to channel+1 like jux).",
    example: `juxBy 0.5 rev (s "bd sd hh cp")` },
  { name: "juxTo",  kind: "combinator", category: "routing",
    signature: "juxTo :: Int -> (Pattern -> Pattern) -> Pattern -> Pattern",
    description: "Like jux but route the transformed copy to an explicit MIDI channel.",
    example: `juxTo 5 rev (s "bd sd hh cp")` },
);

const VELOCITY = add(
  { name: "gain",     kind: "combinator", category: "velocity",
    signature: "gain :: Patternable<Number> -> Pattern -> Pattern",
    description: "Scale velocity by 0..1 (multiplicative; clamps at 1.0).",
    example: `s "bd*4" # gain 0.7` },
  { name: "velocity", kind: "combinator", category: "velocity",
    signature: "velocity :: Patternable<Number> -> Pattern -> Pattern",
    description: "Alias of gain.",
    example: `s "bd cp" # velocity (range 0.4 1 sine)` },
);

const PITCH_MATH = add(
  { name: "add",    kind: "combinator", category: "pitch-math",
    signature: "add :: Patternable<Number> -> Pattern -> Pattern",
    description: "Add semitones to every event in a note pattern.",
    example: `n "c4 e4 g4" # add 12` },
  { name: "sub",    kind: "combinator", category: "pitch-math",
    signature: "sub :: Patternable<Number> -> Pattern -> Pattern",
    description: "Subtract semitones from every event.",
    example: `n "c4 e4 g4" # sub 5` },
  { name: "mul",    kind: "combinator", category: "pitch-math",
    signature: "mul :: Patternable<Number> -> Pattern -> Pattern",
    description: "Multiply pitch numbers (rarely useful for notes; useful for CC math).",
    example: `n (run 4) # mul 2` },
  { name: "up",     kind: "combinator", category: "pitch-math",
    signature: "up :: Patternable<Number> -> Pattern -> Pattern",
    description: "Alias of add.",
    example: `n "c4 e4 g4" # up 7` },
  { name: "octave", kind: "combinator", category: "pitch-math",
    signature: "octave :: Patternable<Number> -> Pattern -> Pattern",
    description: "Transpose by N octaves (multiples of 12 semitones).",
    example: `n "c4 e4" # octave 1` },
  { name: "range",  kind: "combinator", category: "pitch-math",
    signature: "range :: Number -> Number -> Signal -> Pattern",
    description: "Map unipolar signal [0..1] to [lo..hi].",
    example: `range 30 90 sine` },
  { name: "range2", kind: "combinator", category: "pitch-math",
    signature: "range2 :: Number -> Number -> Signal -> Pattern",
    description: "Map bipolar signal [-1..1] to [lo..hi].",
    example: `range2 (-7) 7 sine2` },
);

const MUSIC_THEORY = add(
  { name: "scale", kind: "constructor", category: "music-theory",
    signature: "scale :: String -> Pattern -> Pattern",
    description: "Quantize numeric pattern to a named scale (major, minor, dorian, phrygian, …).",
    example: `n "0 2 4 7" # scale "minor"` },
  { name: "chord", kind: "constructor", category: "music-theory",
    signature: "chord :: String -> Pattern",
    description: "Build a chord pattern from a name like Cmaj7, f#min, Db13.",
    example: `chord "Cmaj7"` },
  { name: "arp",   kind: "combinator", category: "music-theory",
    signature: 'arp :: "up"|"down"|"updown"|"converge" -> Pattern -> Pattern',
    description: "Convert chord events into arpeggios in the given direction.",
    example: `chord "Cmaj7" # arp "up"` },
);

const SIGNALS = add(
  { name: "sine",    kind: "signal", category: "signals",
    signature: "sine :: ContinuousSignal -- [0..1]",
    description: "Unipolar sine wave, one cycle per pattern cycle.",
    example: `c1 $ ctrl 74 sine` },
  { name: "sine2",   kind: "signal", category: "signals",
    signature: "sine2 :: ContinuousSignal -- [-1..1]",
    description: "Bipolar sine wave.",
    example: `n "c4 e4 g4" # add (range2 (-7) 7 sine2)` },
  { name: "cosine",  kind: "signal", category: "signals",
    signature: "cosine :: ContinuousSignal -- [0..1]",
    description: "Unipolar cosine — sine shifted by a quarter cycle.",
    example: `c1 $ ctrl 71 cosine` },
  { name: "cos",     kind: "signal", category: "signals",
    signature: "cos :: ContinuousSignal -- alias",
    description: "Alias of cosine.",
    example: `c1 $ ctrl 71 cos` },
  { name: "cos2",    kind: "signal", category: "signals",
    signature: "cos2 :: ContinuousSignal -- [-1..1]",
    description: "Bipolar cosine.",
    example: `c1 $ ctrl 71 (range 30 90 cos2)` },
  { name: "tri",     kind: "signal", category: "signals",
    signature: "tri :: ContinuousSignal -- [0..1]",
    description: "Unipolar triangle wave.",
    example: `c1 $ ctrl 74 tri` },
  { name: "tri2",    kind: "signal", category: "signals",
    signature: "tri2 :: ContinuousSignal -- [-1..1]",
    description: "Bipolar triangle.",
    example: `c1 $ ctrl 74 tri2` },
  { name: "saw",     kind: "signal", category: "signals",
    signature: "saw :: ContinuousSignal -- [0..1]",
    description: "Ramp up 0→1 per cycle.",
    example: `c1 $ ctrl 74 (range 30 90 saw)` },
  { name: "saw2",    kind: "signal", category: "signals",
    signature: "saw2 :: ContinuousSignal -- [-1..1]",
    description: "Bipolar ramp -1→1.",
    example: `c1 $ ctrl 74 saw2` },
  { name: "isaw",    kind: "signal", category: "signals",
    signature: "isaw :: ContinuousSignal -- [0..1]",
    description: "Inverse saw (ramp down 1→0).",
    example: `c1 $ ctrl 74 isaw` },
  { name: "isaw2",   kind: "signal", category: "signals",
    signature: "isaw2 :: ContinuousSignal -- [-1..1]",
    description: "Bipolar inverse saw.",
    example: `c1 $ ctrl 74 isaw2` },
  { name: "square",  kind: "signal", category: "signals",
    signature: "square :: ContinuousSignal -- {0,1}",
    description: "0/1 square wave.",
    example: `c1 $ ctrl 80 square` },
  { name: "square2", kind: "signal", category: "signals",
    signature: "square2 :: ContinuousSignal -- {-1,+1}",
    description: "Bipolar square wave.",
    example: `c1 $ ctrl 80 (range 30 90 square2)` },
  { name: "rand",    kind: "signal", category: "signals",
    signature: "rand :: ContinuousSignal -- [0..1]",
    description: "Per-cycle pseudo-random value, seeded by cycleN.",
    example: `s "bd*8" # gain rand` },
  { name: "perlin",  kind: "signal", category: "signals",
    signature: "perlin :: ContinuousSignal -- [0..1]",
    description: "Smoothed pseudo-random (Perlin-style), seeded by cycleN.",
    example: `s "hh*16" # velocity (range 0.4 1 perlin)` },
  { name: "segment", kind: "combinator", category: "signals",
    signature: "segment :: Int -> Signal -> Pattern",
    description: "Discretize a continuous signal into N events per cycle.",
    example: `segment 8 sine` },
);

const DRUM_MAPPING = add(
  { name: "drumMap",    kind: "combinator", category: "drum-mapping",
    signature: "drumMap :: Int -> String -> ()",
    description: "Install a per-orbit alias map: \"bd:36 sn:38 tom1=41\". Empty spec clears.",
    example: `drumMap 1 "bd:36 sn:38 hh:42"` },
  { name: "autoMap",    kind: "combinator", category: "drum-mapping",
    signature: "autoMap :: Int -> String -> ()",
    description: "Walk a Live track for its Drum Rack and build a map from each chain's first Simpler.",
    example: `autoMap 1 "909 Kit"` },
  { name: "autoMapAll", kind: "combinator", category: "drum-mapping",
    signature: "autoMapAll :: Int -> String -> ()",
    description: "Like autoMap, but also alias unknown pads by sanitized filename.",
    example: `autoMapAll 1 "909 Kit"` },
);

const CONTROL = add(
  { name: "ctrl",  kind: "constructor", category: "control",
    signature: "ctrl :: CC -> Patternable -> ControlPattern",
    description: "Build a control (CC) pattern. CC is 0..127; arg is a signal, pattern, or number.",
    example: `c1 $ ctrl 74 sine` },
  { name: "learn", kind: "function", category: "control",
    signature: "learn :: CC -> ()",
    description: "Wiggle a CC slowly so Live's MIDI-Map mode (Cmd+M) can bind it to a knob.",
    example: `learn 74` },
);

const GLOBAL = add(
  { name: "hush",     kind: "function",    category: "global",
    signature: "hush :: ()",
    description: "Stop every active orbit immediately.",
    example: `hush` },
);

// ── Re-export the full sorted list (orbits first, then alphabetical) ───────

export const HELP_ENTRIES: HelpEntry[] = [
  ...NOTE_ORBITS,
  ...CTRL_ORBITS,
  ...CONSTRUCTORS,
  ...MULTI,
  ...TIME_SCALING,
  ...TRANSFORMS,
  ...TIME_SHIFT,
  ...WINDOWING,
  ...ROUTING,
  ...VELOCITY,
  ...PITCH_MATH,
  ...MUSIC_THEORY,
  ...SIGNALS,
  ...DRUM_MAPPING,
  ...CONTROL,
  ...GLOBAL,
];

// ── Keyboard shortcuts ────────────────────────────────────────────────────

export interface ShortcutEntry {
  keys: string;        // already-formatted (Mac-style ⌘ in primary slot)
  altKeys?: string;    // optional secondary form (e.g. Ctrl on non-Mac)
  description: string;
  category: "editor" | "playback" | "ui";
}

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "⌘↵",        altKeys: "Ctrl+↵",       description: "Eval block under cursor",       category: "playback" },
  { keys: "⇧⌘↵",       altKeys: "Ctrl+Shift+↵", description: "Eval entire buffer",            category: "playback" },
  { keys: "⌘.",        altKeys: "Ctrl+.",       description: "Hush all orbits",               category: "playback" },
  { keys: "⌘B",        altKeys: "Ctrl+B",       description: "Bake last N cycles to MIDI clip", category: "playback" },
  { keys: "⌘/",        altKeys: "Ctrl+/",       description: "Toggle line comment",           category: "editor" },
  { keys: "⌘?",        altKeys: "Ctrl+?",       description: "Show / hide this help overlay", category: "ui" },
  { keys: "⌘P",        altKeys: "Ctrl+P",       description: "Open command palette",          category: "ui" },
  { keys: "⌃Space",    altKeys: "Ctrl+Space",   description: "Trigger autocomplete",          category: "editor" },
  { keys: "Tab",                                description: "Indent line / selection",       category: "editor" },
  { keys: "⇧Tab",                               description: "Outdent line / selection",      category: "editor" },
  { keys: "Esc",                                description: "Close overlay / clear search",  category: "ui" },
];

// ── Mini-notation cheat sheet ─────────────────────────────────────────────

export interface MiniNotationRow {
  syntax: string;
  meaning: string;
  example: string;
}

export const MINI_NOTATION: MiniNotationRow[] = [
  { syntax: "a b c",      meaning: "Sequence — N items split a cycle into N equal slots", example: `s "bd sd hh cp"` },
  { syntax: "[a b]",      meaning: "Subdivision — children share their parent's slot",    example: `s "bd [hh hh] sd cp"` },
  { syntax: "[a, b]",     meaning: "Parallel-in-slot — events fire simultaneously",       example: `s "[bd, hh] sd"` },
  { syntax: "<a b c>",    meaning: "Alternation — one child per cycle (cycleN % len)",    example: `n "<c4 e4 g4>"` },
  { syntax: "{a b, c d}", meaning: "Polyrhythm — each lane plays one cycle independently",example: `s "{bd cp, hh hh hh}"` },
  { syntax: "{a b c}%4",  meaning: "Polymeter — force lane(s) to N slots",                 example: `s "{bd cp hh}%4"` },
  { syntax: "a*N",        meaning: "Repeat N× within the slot",                            example: `s "bd*4"` },
  { syntax: "~",          meaning: "Rest (silence)",                                       example: `s "bd ~ sd ~"` },
  { syntax: "a _ _ b",    meaning: "Elongate — `_` extends previous element",              example: `s "bd _ _ sd"` },
  { syntax: "bd(3,8)",    meaning: "Euclidean — 3 hits across 8 slots",                    example: `s "bd(3,8)"` },
  { syntax: "bd(3,8,2)",  meaning: "Euclidean with rotation — left-rotate by N",           example: `s "bd(3,8,2)"` },
  { syntax: "a?",         meaning: "Degrade — element drops in 50% of cycles",             example: `s "bd hh?"` },
  { syntax: "a?0.3",      meaning: "Degrade with probability",                             example: `s "hh?0.3"` },
  { syntax: "a@2 b",      meaning: "Weighted slot — `a` takes 2/3 of cycle",               example: `s "bd@2 sd"` },
  { syntax: "a ! b",      meaning: "Replicate previous element",                           example: `s "bd ! sd"` },
  { syntax: "a !*3 b",    meaning: "Replicate previous N times",                           example: `s "bd !*3 sd"` },
  { syntax: "0 .. 7",     meaning: "Numeric range expansion (= 0 1 2 3 4 5 6 7)",          example: `n "0 .. 7" # scale "minor"` },
  { syntax: "a b | c d",  meaning: "Random pick — one whole sequence per cycle (seeded)",  example: `s "bd sd | cp hh"` },
  { syntax: "c'maj",      meaning: "Chord shorthand — fires chord intervals concurrently", example: `n "c4'maj e4'min"` },
];

// ── Drum names reference (built-in DRUM_MAP) ──────────────────────────────

export const DRUM_ALIASES: { name: string; midi: number; desc: string }[] = [
  { name: "bd",   midi: 36, desc: "Kick drum" },
  { name: "sd",   midi: 38, desc: "Snare drum" },
  { name: "hh",   midi: 42, desc: "Closed hi-hat" },
  { name: "oh",   midi: 46, desc: "Open hi-hat" },
  { name: "cp",   midi: 39, desc: "Clap" },
  { name: "rim",  midi: 37, desc: "Rim shot" },
  { name: "cy",   midi: 49, desc: "Crash cymbal" },
  { name: "ride", midi: 51, desc: "Ride cymbal" },
  { name: "tom1", midi: 41, desc: "Low tom" },
  { name: "tom2", midi: 45, desc: "Mid tom" },
  { name: "tom3", midi: 48, desc: "High tom" },
  { name: "cb",   midi: 56, desc: "Cowbell" },
];
