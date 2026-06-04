// Static completion source for Lidal identifiers — about 100 user-facing names
// drawn from patterns.ts. Each completion carries a 1-line type/use signature
// shown in the completion details popup. Combinators with multiple arguments
// are exposed as snippetCompletion entries with tab-stop placeholders so the
// user can press Tab to step through the holes.

import { snippetCompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";

type EntryType = "orbit" | "constructor" | "combinator" | "signal" | "function";

interface PlainEntry {
  kind: "plain";
  label: string;
  type: EntryType;
  info: string;
  boost?: number;
}

interface SnippetEntry {
  kind: "snippet";
  label: string;
  type: EntryType;
  info: string;
  /** CM6 snippet template — ${1:placeholder} for tab stops, ${} for the final cursor position. */
  snippet: string;
  boost?: number;
}

type Entry = PlainEntry | SnippetEntry;

// Snippet-style helpers. Use ${1:...} for the first tab stop, etc.
// We keep the snippet to a single line so it inserts cleanly mid-expression.
const ENTRIES: Entry[] = [
  // ── Orbits ───────────────────────────────────────────────────────────────
  // Note orbits: d1..d4 get a snippet expansion (the most common ones); the
  // rest stay as plain identifiers so the popup isn't a wall of noise when
  // the user just wants to type `d12` quickly.
  ...Array.from({ length: 4 }, (_, i) => ({
    kind: "snippet" as const,
    label: `d${i + 1}`,
    type: "orbit" as const,
    info: `register a pattern on note orbit ${i + 1}   d${i + 1} $ s "bd ~ sd ~"`,
    snippet: `d${i + 1} \$ \${1:s "bd ~ sd ~"}`,
    boost: 1,
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    kind: "plain" as const,
    label: `d${i + 5}`,
    type: "orbit" as const,
    info: `register a pattern on note orbit ${i + 5}   d${i + 5} $ s "bd ~ sd ~"`,
    boost: 1,
  })),
  // Control orbits: c1, c2 get a snippet; c3..c8 stay plain.
  ...Array.from({ length: 2 }, (_, i) => ({
    kind: "snippet" as const,
    label: `c${i + 1}`,
    type: "orbit" as const,
    info: `register a control pattern on CC orbit ${i + 1}   c${i + 1} $ ctrl 74 sine`,
    snippet: `c${i + 1} \$ \${1:ctrl 74 sine}`,
    boost: 1,
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    kind: "plain" as const,
    label: `c${i + 3}`,
    type: "orbit" as const,
    info: `register a control pattern on CC orbit ${i + 3}   c${i + 3} $ ctrl 74 sine`,
    boost: 1,
  })),

  // ── Constructors / pattern sources ───────────────────────────────────────
  { kind: "snippet", label: "n",       type: "constructor",
    info: `n :: String -> Pattern   n "c4 e4 g4"`,
    snippet: `n "\${1:c4 e4 g4}"` },
  { kind: "snippet", label: "s",       type: "constructor",
    info: `s :: String -> Pattern   s "bd ~ sd ~"`,
    snippet: `s "\${1:bd ~ sd ~}"` },
  { kind: "snippet", label: "chord",   type: "constructor",
    info: `chord :: String -> Pattern   chord "Cmaj7"`,
    snippet: `chord "\${1:c'maj7}"` },
  { kind: "snippet", label: "arp",     type: "constructor",
    info: `arp :: "up"|"down"|"updown"|"converge" -> Pattern -> Pattern`,
    snippet: `arp "\${1:up}"` },
  { kind: "snippet", label: "scale",   type: "constructor",
    info: `scale :: String -> Pattern -> Pattern   scale "dorian" p`,
    snippet: `scale "\${1:dorian}"` },
  { kind: "snippet", label: "ctrl",    type: "constructor",
    info: `ctrl :: CC -> Pattern -> ControlPattern   ctrl 74 sine`,
    snippet: `ctrl \${1:74} \${2:sine}` },
  { kind: "plain",   label: "silence", type: "constructor", info: `silence : empty Pattern (clear an orbit)` },
  { kind: "plain",   label: "hush",    type: "function",    info: `hush : stop all orbits` },
  { kind: "snippet", label: "stack",   type: "constructor",
    info: `stack :: [Pattern] -> Pattern   stack [p, q, r]`,
    snippet: `stack [\${1:p1}, \${2:p2}]` },
  { kind: "snippet", label: "cat",     type: "constructor",
    info: `cat :: [Pattern] -> Pattern   one-per-cycle concatenation`,
    snippet: `cat [\${1:p1}, \${2:p2}]` },
  { kind: "snippet", label: "fastcat", type: "constructor",
    info: `fastcat :: [Pattern] -> Pattern   all per cycle (alias seq)`,
    snippet: `fastcat [\${1:p1}, \${2:p2}]` },
  { kind: "snippet", label: "seq",     type: "constructor",
    info: `seq = fastcat   sequential within one cycle`,
    snippet: `seq [\${1:p1}, \${2:p2}]` },
  { kind: "snippet", label: "run",     type: "constructor",
    info: `run :: Int -> Pattern   0..N-1 per cycle`,
    snippet: `run \${1:8}` },
  { kind: "snippet", label: "irand",   type: "constructor",
    info: `irand :: Int -> Pattern   random int 0..N-1`,
    snippet: `irand \${1:8}` },
  { kind: "snippet", label: "choose",  type: "constructor",
    info: `choose :: [a] -> Pattern   uniform pick per cycle`,
    snippet: `choose [\${1:a}, \${2:b}]` },
  { kind: "snippet", label: "wchoose", type: "constructor",
    info: `wchoose :: [(Weight, a)] -> Pattern   weighted pick`,
    snippet: `wchoose [[\${1:2}, \${2:a}], [\${3:1}, \${4:b}]]` },

  // ── Combinators (time) ───────────────────────────────────────────────────
  { kind: "snippet", label: "fast",       type: "combinator",
    info: `fast :: Number -> Pattern -> Pattern   fast 2 p`,
    snippet: `fast \${1:2} \${2:p}` },
  { kind: "snippet", label: "slow",       type: "combinator",
    info: `slow :: Number -> Pattern -> Pattern   slow 2 p`,
    snippet: `slow \${1:2} \${2:p}` },
  { kind: "snippet", label: "density",    type: "combinator",
    info: `density = fast`,
    snippet: `density \${1:2} \${2:p}` },
  { kind: "snippet", label: "sparsity",   type: "combinator",
    info: `sparsity = slow`,
    snippet: `sparsity \${1:2} \${2:p}` },
  { kind: "plain",   label: "rev",        type: "combinator",
    info: `rev :: Pattern -> Pattern   reverse within each cycle` },
  { kind: "plain",   label: "palindrome", type: "combinator",
    info: `palindrome :: Pattern -> Pattern   forward then reverse` },
  { kind: "snippet", label: "every",      type: "combinator",
    info: `every :: Int -> (Pattern -> Pattern) -> Pattern -> Pattern   every 4 rev p`,
    snippet: `every \${1:4} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "whenmod",    type: "combinator",
    info: `whenmod :: Int -> Int -> (P -> P) -> P -> P   whenmod 8 5 (fast 2)`,
    snippet: `whenmod \${1:8} \${2:5} \${3:(fast 2)} \${4:p}` },
  { kind: "snippet", label: "iter",       type: "combinator",
    info: `iter :: Int -> Pattern -> Pattern   rotate by 1/N per cycle`,
    snippet: `iter \${1:4} \${2:p}` },
  { kind: "snippet", label: "chunk",      type: "combinator",
    info: `chunk :: Int -> (P -> P) -> P -> P   apply fn to one chunk per cycle`,
    snippet: `chunk \${1:4} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "inside",     type: "combinator",
    info: `inside :: Int -> (P -> P) -> P -> P   compress, apply, expand`,
    snippet: `inside \${1:2} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "outside",    type: "combinator",
    info: `outside :: Int -> (P -> P) -> P -> P   expand, apply, compress`,
    snippet: `outside \${1:2} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "rot",        type: "combinator",
    info: `rot :: Number -> Pattern -> Pattern   rotate event positions`,
    snippet: `rot \${1:1} \${2:p}` },
  { kind: "snippet", label: "early",      type: "combinator",
    info: `early :: Number -> Pattern -> Pattern   shift left in cycles`,
    snippet: `early \${1:0.125} \${2:p}` },
  { kind: "snippet", label: "late",       type: "combinator",
    info: `late :: Number -> Pattern -> Pattern   shift right in cycles`,
    snippet: `late \${1:0.125} \${2:p}` },
  { kind: "snippet", label: "nudge",      type: "combinator",
    info: `nudge :: Number -> Pattern -> Pattern   small offset in beats`,
    snippet: `nudge \${1:0.02} \${2:p}` },
  { kind: "snippet", label: "linger",     type: "combinator",
    info: `linger :: Number -> Pattern -> Pattern   hold first 1/N of a cycle`,
    snippet: `linger \${1:0.25} \${2:p}` },
  { kind: "snippet", label: "trunc",      type: "combinator",
    info: `trunc :: Number -> Pattern -> Pattern   keep first N of a cycle`,
    snippet: `trunc \${1:0.5} \${2:p}` },
  { kind: "snippet", label: "zoom",       type: "combinator",
    info: `zoom :: Number -> Number -> Pattern -> Pattern   zoom into [a..b]`,
    snippet: `zoom \${1:0} \${2:0.5} \${3:p}` },
  { kind: "snippet", label: "compress",   type: "combinator",
    info: `compress :: Number -> Number -> Pattern -> Pattern   squash into [a..b]`,
    snippet: `compress \${1:0} \${2:0.5} \${3:p}` },
  { kind: "snippet", label: "off",        type: "combinator",
    info: `off :: Number -> (P -> P) -> P -> P   delayed-copy overlay`,
    snippet: `off \${1:0.125} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "stutter",    type: "combinator",
    info: `stutter :: Int -> Number -> Pattern -> Pattern   N taps every t cycles`,
    snippet: `stutter \${1:4} \${2:0.125} \${3:p}` },
  { kind: "plain",   label: "degrade",    type: "combinator",
    info: `degrade :: Pattern -> Pattern   drop ~50% of events` },
  { kind: "snippet", label: "degradeBy",  type: "combinator",
    info: `degradeBy :: Number -> Pattern -> Pattern   drop fraction of events`,
    snippet: `degradeBy \${1:0.5}` },

  // ── Variation ────────────────────────────────────────────────────────────
  { kind: "snippet", label: "sometimes",   type: "combinator",
    info: `sometimes :: (P -> P) -> P -> P   apply ~50%`,
    snippet: `sometimes \${1:rev} \${2:p}` },
  { kind: "snippet", label: "often",       type: "combinator",
    info: `often :: (P -> P) -> P -> P   apply ~75%`,
    snippet: `often \${1:rev} \${2:p}` },
  { kind: "snippet", label: "rarely",      type: "combinator",
    info: `rarely :: (P -> P) -> P -> P   apply ~25%`,
    snippet: `rarely \${1:rev} \${2:p}` },
  { kind: "snippet", label: "sometimesBy", type: "combinator",
    info: `sometimesBy :: Number -> (P -> P) -> P -> P   apply with probability`,
    snippet: `sometimesBy \${1:0.5} \${2:rev} \${3:p}` },

  // ── Multi-pattern ────────────────────────────────────────────────────────
  { kind: "snippet", label: "jux",     type: "combinator",
    info: `jux :: (P -> P) -> P -> P   stack original + transformed (pan via channel)`,
    snippet: `jux \${1:rev} \${2:p}` },
  { kind: "snippet", label: "juxBy",   type: "combinator",
    info: `juxBy :: Number -> (P -> P) -> P -> P`,
    snippet: `juxBy \${1:0.5} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "juxTo",   type: "combinator",
    info: `juxTo :: Int -> (P -> P) -> P -> P   right copy on channel N`,
    snippet: `juxTo \${1:2} \${2:rev} \${3:p}` },
  { kind: "snippet", label: "mask",    type: "combinator",
    info: `mask :: String|Pattern -> Pattern -> Pattern   gate events`,
    snippet: `mask "\${1:x ~ x ~}"` },
  { kind: "snippet", label: "struct",  type: "combinator",
    info: `struct :: String|Pattern -> Pattern -> Pattern   rhythm grafted onto values`,
    snippet: `struct "\${1:x ~ x ~}"` },

  // ── Pitch / payload arithmetic ───────────────────────────────────────────
  { kind: "snippet", label: "add",      type: "combinator",
    info: `add :: Number -> Pattern -> Pattern   add semitones`,
    snippet: `add \${1:7}` },
  { kind: "snippet", label: "sub",      type: "combinator",
    info: `sub :: Number -> Pattern -> Pattern   subtract semitones`,
    snippet: `sub \${1:7}` },
  { kind: "snippet", label: "mul",      type: "combinator",
    info: `mul :: Number -> Pattern -> Pattern   multiply pitch (rare)`,
    snippet: `mul \${1:2}` },
  { kind: "snippet", label: "up",       type: "combinator",
    info: `up :: Number -> Pattern -> Pattern   alias of add`,
    snippet: `up \${1:7}` },
  { kind: "snippet", label: "octave",   type: "combinator",
    info: `octave :: Number -> Pattern -> Pattern   shift by N octaves`,
    snippet: `octave \${1:1}` },
  { kind: "snippet", label: "range",    type: "combinator",
    info: `range :: Number -> Number -> Signal -> Pattern   map [0..1] sig to [lo..hi]`,
    snippet: `range \${1:0} \${2:127} \${3:sine}` },
  { kind: "snippet", label: "range2",   type: "combinator",
    info: `range2 :: Number -> Number -> Signal -> Pattern   for bipolar signals`,
    snippet: `range2 \${1:-1} \${2:1} \${3:sine}` },
  { kind: "snippet", label: "gain",     type: "combinator",
    info: `gain :: Number -> Pattern -> Pattern   scale velocity 0..1`,
    snippet: `gain \${1:0.8}` },
  { kind: "snippet", label: "velocity", type: "combinator",
    info: `velocity :: Number -> Pattern -> Pattern   alias of gain`,
    snippet: `velocity \${1:0.8}` },
  { kind: "snippet", label: "chan",     type: "combinator",
    info: `chan :: Int -> Pattern -> Pattern   set MIDI channel`,
    snippet: `chan \${1:1}` },
  { kind: "snippet", label: "ch",       type: "combinator",
    info: `ch :: Int -> Pattern -> Pattern   alias of chan`,
    snippet: `ch \${1:1}` },

  // ── Drum-rack ────────────────────────────────────────────────────────────
  { kind: "snippet", label: "drumMap",     type: "combinator",
    info: `drumMap :: Int -> String -> ()   drumMap 1 "bd:36 sn:38"`,
    snippet: `drumMap \${1:1} "\${2:bd:36 sn:38 hh:42}"` },
  { kind: "snippet", label: "autoMap",     type: "combinator",
    info: `autoMap :: Int -> String -> ()   introspect a Live Drum Rack`,
    snippet: `autoMap \${1:1} "\${2:909 Kit}"` },
  { kind: "snippet", label: "autoMapAll",  type: "combinator",
    info: `autoMapAll :: Int -> String -> ()   like autoMap, alias every pad`,
    snippet: `autoMapAll \${1:1} "\${2:909 Kit}"` },
  { kind: "snippet", label: "learn",       type: "combinator",
    info: `learn :: CC -> ()   wiggle a CC for Live's MIDI-map`,
    snippet: `learn \${1:74}` },

  // ── Signals (no snippets — trivial atoms) ────────────────────────────────
  { kind: "plain", label: "sine",    type: "signal", info: `sine : continuous [0..1]` },
  { kind: "plain", label: "sine2",   type: "signal", info: `sine2 : continuous bipolar [-1..1]` },
  { kind: "plain", label: "cosine",  type: "signal", info: `cosine : continuous [0..1]` },
  { kind: "plain", label: "cos",     type: "signal", info: `cos = cosine` },
  { kind: "plain", label: "cos2",    type: "signal", info: `cos2 : bipolar cosine` },
  { kind: "plain", label: "tri",     type: "signal", info: `tri : triangle [0..1]` },
  { kind: "plain", label: "tri2",    type: "signal", info: `tri2 : bipolar triangle` },
  { kind: "plain", label: "saw",     type: "signal", info: `saw : ramp up [0..1]` },
  { kind: "plain", label: "saw2",    type: "signal", info: `saw2 : bipolar saw` },
  { kind: "plain", label: "isaw",    type: "signal", info: `isaw : ramp down [0..1]` },
  { kind: "plain", label: "isaw2",   type: "signal", info: `isaw2 : bipolar inverse saw` },
  { kind: "plain", label: "square",  type: "signal", info: `square : 0/1 square wave` },
  { kind: "plain", label: "square2", type: "signal", info: `square2 : -1/+1 square wave` },
  { kind: "plain", label: "rand",    type: "signal", info: `rand : per-cycle pseudo-random [0..1]` },
  { kind: "plain", label: "perlin",  type: "signal", info: `perlin : smooth random [0..1]` },
  { kind: "snippet", label: "segment", type: "combinator",
    info: `segment :: Int -> Signal -> Pattern   discretize signal into N steps/cycle`,
    snippet: `segment \${1:8} \${2:sine}` },
];

const COMPLETIONS: Completion[] = ENTRIES.map((e) => {
  const baseBoost = e.boost ?? (e.type === "orbit" ? 1 : 0);
  if (e.kind === "snippet") {
    return snippetCompletion(e.snippet, {
      label: e.label,
      type: e.type,
      info: e.info,
      boost: baseBoost,
    });
  }
  return {
    label: e.label,
    type: e.type,
    info: e.info,
    boost: baseBoost,
  };
});

// Quick scan to decide whether `pos` sits inside a "..." string literal on
// the same line. Mirrors the logic in hover.ts so autocomplete stays
// consistent with the tooltip's gating (TOFIX #24). The autocomplete used to
// fire inside `s "b<Ctrl-Space>"`, offering `chord`/`chan`/etc. — those
// aren't identifiers in mini-notation, so we suppress.
function insideMiniNotationString(context: CompletionContext): boolean {
  const doc = context.state.doc;
  const pos = context.pos;
  const line = doc.lineAt(pos);
  const upToCursor = doc.sliceString(line.from, pos);
  let count = 0;
  for (let i = 0; i < upToCursor.length; i++) {
    if (upToCursor[i] === '"') count++;
  }
  return count % 2 === 1;
}

export function lidalCompletions(context: CompletionContext): CompletionResult | null {
  // [ED-agent fix #24] Don't offer identifier completions inside a
  // mini-notation string. Mirrors the hover.ts insideString gate.
  if (insideMiniNotationString(context)) return null;
  // Match identifier prefix at the cursor — ignore mini-notation strings
  // entirely, since identifiers inside strings aren't real names.
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;
  if (word && word.from === word.to && !context.explicit) return null;
  return {
    from: word ? word.from : context.pos,
    options: COMPLETIONS,
    validFor: /^[A-Za-z0-9_]*$/,
  };
}
