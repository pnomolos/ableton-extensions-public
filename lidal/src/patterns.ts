// Pattern engine — Tidal-flavored combinators over cycle-indexed event streams.
//
// Constructors:    n, s, silence, run, irand, choose, wchoose, chord
// Multi-pattern:   stack, cat, fastcat (alias: seq)
// Time-scaling:    fast, slow, density, sparsity
// Transforms:      rev, every, whenmod, sometimes, sometimesBy, often, rarely,
//                  chunk, iter, palindrome, mask, struct, stutter, inside, outside, rot
// Time-shift:      early, late, nudge
// Windowing:       linger, trunc, zoom, compress, off
// Routing:         ch / chan, jux, juxBy, juxTo
// Velocity:        gain, velocity, degrade, degradeBy
// Pitch math:      add, sub, mul, up, octave, range, range2
// Music theory:    scale, arp, chord (constructor), `'` chord shorthand in mini-notation
// Continuous sigs: sine/sine2, cosine/cosine2 (alias cos/cos2), tri/tri2,
//                  saw/saw2, isaw/isaw2, square/square2, rand, perlin, segment
//
// Most numeric args accept `Patternable<T>` — a value, mini-notation string,
// Pattern, or `ContinuousSignal` — letting structural ops vary over time
// (e.g. `fast "<2 3>"`) and per-event ops modulate smoothly (e.g. `gain sine`).
//
// Continuous signals (sine/cos/tri/saw/square/rand/perlin) are JS-only — they
// are NOT first-class in mini-notation strings. Use them as combinator args:
// `gain(sine)`, `add(range(0, 12, saw))`. Discretize via `segment(N, sig)` to
// turn a signal into a Pattern of N events per cycle.
//
// PRNG seed namespaces (kept distinct so unrelated random sources don't correlate):
//   degradeBy:           cycleN * 1009 + floor(slotStart * 1e6)
//   sometimesBy:         cycleN * 6997
//   `?` mini-notation:   cycleN * 7919 + floor(slotStart * 1e6)
//   irand:               cycleN * 4243
//   choose:              cycleN * 9281
//   wchoose:             cycleN * 8623
//   rand (signal):       cycleN * 5051 + floor(phase * 1e6)
//   perlin (signal):     cycleN * 3571 (lattice value seed)

import * as vm from "vm";
import { evaluatePattern } from "./parser.js";
import { SCALES, parseChordName } from "./music.js";
import { parseDrumMapSpec } from "./drums.js";
import {
  ctrl as ctrlConstructor,
  ControlPattern,
  learn as learnConstructor,
  ctrlStack,
  ctrlCat,
  ctrlFastcat,
} from "./control.js";

export type PortType = "notes" | "drums";

export interface Event {
  start: number;       // 0..1 within cycle
  duration: number;    // 0..1
  name: string;        // note/drum token
  velocity: number;    // 0..127
  // Channel routing — at most one of these should be set on a single event:
  //   `channel`        absolute MIDI channel (0..15) — set by per-part .ch() inside stack/cat
  //   `channelOffset`  relative to pattern.channel — set by jux's relative-offset path
  // Scheduler precedence: ev.channel > pattern.channel + ev.channelOffset > pattern.channel.
  channel?: number;
  channelOffset?: number;
  // Pitch offset in semitones, applied after `name` is resolved to a MIDI number.
  // Accumulated by add/sub/mul/up/octave. Final MIDI is clamped/dropped if out of [0,127].
  offset?: number;
}

// A ContinuousSignal is a function of (cycleN, phase) → number, used for smooth
// modulation sources (sine, saw, rand, etc.). Sampled directly by samplePatternable
// at the same (cycleN, phase) the consumer uses — per-event ops get smooth curves
// across a cycle; structural ops sample at phase 0.
export type ContinuousSignal = (cycleN: number, phase: number) => number;

// A Patternable<T> is a value that may be a constant T, a Pattern, a mini-notation
// string, or a ContinuousSignal. Combinators that previously took plain numbers can
// now take any of these, letting users write `fast("<2 3>")` or `gain(sine)`.
export type Patternable<T> = T | Pattern | string | ContinuousSignal;

// Sample a Patternable at the given (cycleN, phase). For constants, returns the value.
// For ContinuousSignals (functions), calls directly with (cycleN, phase).
// For string/Pattern, finds the event whose [start, start+duration) contains `phase`
// (defaulting to 0 = start-of-cycle for "structural" combinators like fast/every),
// and parses its name via `parse` (default: parseFloat).
//
// Falls back to the first event if no event covers the phase — defensive against
// patterns whose events don't span the whole cycle (e.g. `"~ x"` at phase 0).
export function samplePatternable<T>(
  p: Patternable<T>,
  cycleN: number,
  phase: number = 0,
  parse: (s: string) => T = (s) => Number.parseFloat(s) as unknown as T,
): T {
  // ContinuousSignal — must come before the constant-passthrough check below
  // (which would otherwise return the function itself as a "value").
  if (typeof p === "function") return (p as ContinuousSignal)(cycleN, phase) as unknown as T;
  if (typeof p !== "string" && !(p instanceof Pattern)) return p as T;
  const events = typeof p === "string" ? evaluatePattern(p, cycleN) : p.getEvents(cycleN);
  if (events.length === 0) throw new Error("samplePatternable: empty pattern (no events in cycle)");
  const found = events.find((e) => phase >= e.start && phase < e.start + e.duration) ?? events[0];
  return parse(found.name);
}

// ── User-facing arithmetic operators (transpiler-targeted) ──────────────
// The transpiler lowers `a + b` to `__add(a, b)` (and similarly for - * /, with
// `__neg(x)` for unary minus). These helpers dispatch on the runtime types of the
// operands so a single source-level operator works across numbers, ContinuousSignals,
// and Patterns. Clamping is intentionally left to the OUTPUT stage (scheduler velocity,
// CC clampCc) — arithmetic can freely overshoot and downstream MIDI emission clamps.
//
// Dispatch order, per binop:
//   number   × number   → number (arithmetic in the host language)
//   *        × function → ContinuousSignal (lift number to constant signal, combine per-sample)
//   Pattern  × *        → Pattern (lift right to a per-event sampler; structure comes from left)
//   *        × Pattern  → Pattern (structure comes from right)
//   anything else       → throw a typed error
//
// Strings are NOT auto-lifted (users should reach for `n "..."` explicitly).

function typeOf(x: unknown): string {
  if (x === null) return "null";
  if (x instanceof Pattern) return "Pattern";
  if (typeof x === "function") return "Signal";
  return typeof x;
}

// Wrap a number or ContinuousSignal so it's callable as (cycleN, phase) → number.
// Used to combine two operands when at least one is a ContinuousSignal.
function liftToSignal(x: unknown): ContinuousSignal {
  if (typeof x === "function") return x as ContinuousSignal;
  if (typeof x === "number") return () => x;
  throw new Error(`cannot lift ${typeOf(x)} to a ContinuousSignal`);
}

// Sample `x` against an event (uses event start as phase for Pattern/Signal lookup).
// Returns a number; throws if `x` resolves to a non-numeric payload.
function sampleForEvent(x: unknown, cycleN: number, evStart: number): number {
  if (typeof x === "number") return x;
  if (typeof x === "function") return (x as ContinuousSignal)(cycleN, evStart);
  if (x instanceof Pattern) {
    const events = x.getEvents(cycleN);
    if (events.length === 0) throw new Error("pattern arithmetic: empty pattern (no events to sample)");
    const found = events.find((e) => evStart >= e.start && evStart < e.start + e.duration) ?? events[0];
    const v = parseFloat(found.name);
    if (Number.isNaN(v)) throw new Error(`pattern arithmetic: non-numeric token '${found.name}'`);
    return v;
  }
  throw new Error(`pattern arithmetic: cannot sample ${typeOf(x)} as a number`);
}

// Combine two operands, at least one of which is a Pattern, into a new Pattern.
// Structure (event timing/duration/channel/velocity) comes from the Pattern side
// — if both are Patterns, `a` wins as the structure provider and `b` is sampled
// per-event at the left event's start phase.
function liftPatternBinop(a: unknown, b: unknown, fn: (x: number, y: number) => number): Pattern {
  const structure: Pattern = a instanceof Pattern ? a : (b as Pattern);
  return new Pattern(
    (cycleN) => structure.getEvents(cycleN).map((ev) => {
      const lv = sampleForEvent(a, cycleN, ev.start);
      const rv = sampleForEvent(b, cycleN, ev.start);
      const result = fn(lv, rv);
      return { ...ev, name: String(result) };
    }),
    structure.portType, structure.channel, structure.channelExplicit,
  );
}

function binop(op: string, a: unknown, b: unknown, fn: (x: number, y: number) => number): number | ContinuousSignal | Pattern {
  if (typeof a === "number" && typeof b === "number") return fn(a, b);
  if (a instanceof Pattern || b instanceof Pattern) return liftPatternBinop(a, b, fn);
  if (typeof a === "function" || typeof b === "function") {
    const fa = liftToSignal(a);
    const fb = liftToSignal(b);
    return (c, ph) => fn(fa(c, ph), fb(c, ph));
  }
  throw new Error(`(${op}): unsupported operand types (${typeOf(a)}, ${typeOf(b)})`);
}

export function __add(a: unknown, b: unknown): number | ContinuousSignal | Pattern {
  return binop("+", a, b, (x, y) => x + y);
}
export function __sub(a: unknown, b: unknown): number | ContinuousSignal | Pattern {
  return binop("-", a, b, (x, y) => x - y);
}
export function __mul(a: unknown, b: unknown): number | ContinuousSignal | Pattern {
  return binop("*", a, b, (x, y) => x * y);
}
export function __div(a: unknown, b: unknown): number | ContinuousSignal | Pattern {
  return binop("/", a, b, (x, y) => x / y);
}

export function __neg(x: unknown): number | ContinuousSignal | Pattern {
  if (typeof x === "number") return -x;
  if (typeof x === "function") return (c, ph) => -(x as ContinuousSignal)(c, ph);
  if (x instanceof Pattern) {
    return new Pattern(
      (cycleN) => x.getEvents(cycleN).map((ev) => {
        const v = parseFloat(ev.name);
        if (Number.isNaN(v)) throw new Error(`(-): non-numeric token '${ev.name}'`);
        return { ...ev, name: String(-v) };
      }),
      x.portType, x.channel, x.channelExplicit,
    );
  }
  throw new Error(`(-): unsupported operand type (${typeOf(x)})`);
}

// Shift event starts by `shift` (fractional cycles, can be positive or negative)
// and split events that span the wrap point. Used by iter/early/late/off.
function wrapShift(events: Event[], shift: number): Event[] {
  // Normalize shift into [0, 1) for stability — full-cycle shifts are no-ops.
  let normShift = shift % 1;
  if (normShift < 0) normShift += 1;
  if (normShift === 0) return events.slice().sort((a, b) => a.start - b.start);
  const out: Event[] = [];
  for (const ev of events) {
    const newStart = (ev.start + normShift) % 1;
    const end = newStart + ev.duration;
    if (end <= 1) {
      out.push({ ...ev, start: newStart });
    } else {
      out.push({ ...ev, start: newStart, duration: 1 - newStart });
      out.push({ ...ev, start: 0, duration: end - 1 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Inner time-scaling map. Pulled out so fast() AND slow() can share — and so
// combinators built on top (e.g. `linger`) can reuse the rate-scaling machinery.
// Despite the historical "fast" name, this is also the engine for `slow(n)` via
// `applyTimeScale(1/n, ...)`, hence the more neutral identifier.
function applyTimeScale(n: number, cycleN: number, inner: (c: number) => Event[]): Event[] {
  if (n === 1) return inner(cycleN);
  const out: Event[] = [];
  const startSrc = cycleN * n;
  const endSrc = (cycleN + 1) * n;
  const firstC = Math.floor(startSrc);
  const lastC = Math.ceil(endSrc) - 1;
  for (let c = firstC; c <= lastC; c++) {
    for (const ev of inner(c)) {
      const evStart = c + ev.start;
      const evEnd = evStart + ev.duration;
      if (evEnd <= startSrc || evStart >= endSrc) continue;
      const clippedStart = Math.max(evStart, startSrc);
      const clippedEnd = Math.min(evEnd, endSrc);
      out.push({
        ...ev,
        start: (clippedStart - startSrc) / n,
        duration: (clippedEnd - clippedStart) / n,
      });
    }
  }
  return out;
}

// Point-event variants of wrapShift / applyTimeScale for ControlPattern, whose
// events have only `start` (no duration). Same time-mapping math; events that
// land outside the host window are dropped rather than clipped.
export function wrapShiftPoint<E extends { start: number }>(events: E[], shift: number): E[] {
  let normShift = shift % 1;
  if (normShift < 0) normShift += 1;
  if (normShift === 0) return events.slice().sort((a, b) => a.start - b.start);
  return events
    .map((ev) => ({ ...ev, start: (ev.start + normShift) % 1 }))
    .sort((a, b) => a.start - b.start);
}

export function applyTimeScalePoint<E extends { start: number }>(
  n: number,
  cycleN: number,
  inner: (c: number) => E[],
): E[] {
  if (n === 1) return inner(cycleN);
  const out: E[] = [];
  const startSrc = cycleN * n;
  const endSrc = (cycleN + 1) * n;
  const firstC = Math.floor(startSrc);
  const lastC = Math.ceil(endSrc) - 1;
  for (let c = firstC; c <= lastC; c++) {
    for (const ev of inner(c)) {
      const evStart = c + ev.start;
      if (evStart < startSrc || evStart >= endSrc) continue;
      out.push({ ...ev, start: (evStart - startSrc) / n });
    }
  }
  return out;
}

// Exported PRNG so control.ts can match the same seed namespacing.
export function mulberry32Public(seed: number): () => number { return mulberry32(seed); }

// Brand for cross-bundle instanceof checks (see ControlPattern for the rationale).
const PATTERN_BRAND = "__lidal_Pattern__";

// A Pattern is a function from cycle index → events for that one host cycle.
// Combinators wrap that function; the scheduler just calls getEvents(cycleN).
export class Pattern {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static [Symbol.hasInstance](instance: any): boolean {
    if (instance == null || typeof instance !== "object") return false;
    return (instance as Record<string, unknown>)[PATTERN_BRAND] === true;
  }

  constructor(
    public readonly getEvents: (cycleN: number) => Event[],
    public readonly portType: PortType,
    public readonly channel: number,
    public readonly channelExplicit: boolean,
  ) {}

  private clone(props: Partial<{ getEvents: (n: number) => Event[]; portType: PortType; channel: number; channelExplicit: boolean }>): Pattern {
    return new Pattern(
      props.getEvents ?? this.getEvents,
      props.portType ?? this.portType,
      props.channel ?? this.channel,
      props.channelExplicit ?? this.channelExplicit,
    );
  }

  // ── Routing ────────────────────────────────────────────────────────────
  // `.ch(n)` takes a 1-indexed MIDI channel (1..16) and stores 0-indexed (0..15).
  // Values outside [1, 16] are CLAMPED to the nearest endpoint EXCEPT for `n=0`,
  // which is rejected — Tidal-flavoured users routinely confuse 0-based and
  // 1-based channels, and silently mapping `.ch(0)` to channel 1 (the previous
  // behaviour: `floor(0)-1 = -1` then clamped up to 0) hid that confusion.
  ch(n: number): Pattern {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`.ch() requires a number`);
    if (n === 0) throw new Error(`.ch() is 1-indexed (1..16) — '.ch(0)' is invalid; use .ch(1) for the first channel`);
    return this.clone({ channel: Math.max(0, Math.min(15, Math.floor(n) - 1)), channelExplicit: true });
  }

  chan(n: number): Pattern { return this.ch(n); }

  // ── Time scaling ───────────────────────────────────────────────────────
  // Continuous-time mapping: each host cycle covers `n` source-cycles worth of
  // pattern. Source events are clipped to the host cycle window and rescaled.
  // Works for any positive rational n (n>1 = faster, n<1 = slower). When `n`
  // is a Patternable, it is sampled once per host cycle at phase 0 (structural
  // ops change the time map itself, so per-event sampling is ill-defined).
  fast(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v > 0)) throw new Error(`.fast() requires positive number (got ${v})`);
        return applyTimeScale(v, cycleN, inner);
      },
    });
  }

  slow(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v > 0)) throw new Error(`.slow() requires positive number (got ${v})`);
        return applyTimeScale(1 / v, cycleN, inner);
      },
    });
  }

  // ── Transformations ────────────────────────────────────────────────────
  rev(): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN)
        .map((ev) => ({ ...ev, start: 1 - ev.start - ev.duration }))
        .sort((a, b) => a.start - b.start),
    });
  }

  every(n: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.every() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.every() callback must return a Pattern`);
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v >= 1)) throw new Error(`.every() requires N >= 1 (got ${v})`);
        const N = Math.max(1, Math.round(v));
        return cycleN % N === 0 ? altered(cycleN) : original(cycleN);
      },
    });
  }

  degradeBy(p: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).filter((ev) => {
        const prob = samplePatternable<number>(p, cycleN, ev.start);
        if (!(prob >= 0 && prob <= 1)) throw new Error(`.degradeBy() requires 0..1 (got ${prob})`);
        // Seed namespace: cycleN * 1009 + slot identity. Use the event's `start`
        // (quantised to ~1µs) as a stable per-slot identifier so that upstream
        // filtering (e.g. `.degradeBy(0.3).degradeBy(0.5)` or `.mask(...)`)
        // can't shift the seed by reindexing — the per-slot drop/keep decision
        // remains anchored to the event's time position. Matches the mini-
        // notation `?` operator's seed identity (see header comment).
        //
        // Note: events that share the same `start` (e.g. members of a
        // `stack([n("60"), n("64")])` chord, or any other simultaneous group)
        // hash to the same seed and therefore degrade or survive together.
        // This is intentional — correlated drops at the same time keep chord
        // voicings intact rather than producing partial chords — but it
        // differs from per-event independent decisions.
        const slotId = Math.floor(ev.start * 1e6);
        return mulberry32(cycleN * 1009 + slotId)() >= prob;
      }),
    });
  }

  degrade(): Pattern { return this.degradeBy(0.5); }

  gain(v: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const g = samplePatternable<number>(v, cycleN, ev.start);
        if (!(g >= 0)) throw new Error(`.gain() requires non-negative number (got ${g})`);
        return { ...ev, velocity: Math.max(0, Math.min(127, Math.round(ev.velocity * g))) };
      }),
    });
  }

  velocity(v: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const sampled = samplePatternable<number>(v, cycleN, ev.start);
        if (!(sampled >= 0)) throw new Error(`.velocity() requires non-negative number (got ${sampled})`);
        const target = Math.max(0, Math.min(127, Math.round(sampled <= 1 ? sampled * 127 : sampled)));
        return { ...ev, velocity: target };
      }),
    });
  }

  // ── Cycle-indexed combinators ─────────────────────────────────────────
  iter(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v >= 1)) throw new Error(`.iter() requires N >= 1 (got ${v})`);
        const N = Math.max(1, Math.round(v));
        // iter shifts events LEFT by 1/N each cycle (Tidal semantics).
        const shift = -((cycleN % N) / N);
        return wrapShift(inner(cycleN), shift);
      },
    });
  }

  whenmod(m: Patternable<number>, n: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.whenmod() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.whenmod() callback must return a Pattern`);
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const M = Math.max(1, Math.round(samplePatternable<number>(m, cycleN, 0)));
        const N = Math.max(0, Math.round(samplePatternable<number>(n, cycleN, 0)));
        return cycleN % M === N ? altered(cycleN) : original(cycleN);
      },
    });
  }

  sometimesBy(prob: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.sometimesBy() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.sometimesBy() callback must return a Pattern`);
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const p = samplePatternable<number>(prob, cycleN, 0);
        if (!(p >= 0 && p <= 1)) throw new Error(`.sometimesBy() requires 0..1 (got ${p})`);
        // Per-cycle PRNG flip. Seed namespace 6997 (distinct from degradeBy=1009
        // and parser `?`-degrade which uses 7919 + slot offset).
        return mulberry32(cycleN * 6997)() < p ? altered(cycleN) : original(cycleN);
      },
    });
  }

  // chunk(n, f) divides each cycle into N equal slices. On cycle c, applies `f` to
  // events whose start falls in slice (c % N); other slices remain untransformed.
  chunk(n: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.chunk() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.chunk() callback must return a Pattern`);
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const N = Math.max(1, Math.round(samplePatternable<number>(n, cycleN, 0)));
        const k = ((cycleN % N) + N) % N;
        const lo = k / N;
        const hi = (k + 1) / N;
        const out: Event[] = [];
        for (const ev of original(cycleN)) {
          if (ev.start < lo || ev.start >= hi) out.push(ev);
        }
        for (const ev of altered(cycleN)) {
          if (ev.start >= lo && ev.start < hi) out.push(ev);
        }
        return out.sort((a, b) => a.start - b.start);
      },
    });
  }

  early(t: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => wrapShift(inner(cycleN), -samplePatternable<number>(t, cycleN, 0)),
    });
  }

  late(t: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => wrapShift(inner(cycleN), samplePatternable<number>(t, cycleN, 0)),
    });
  }

  // nudge is a Tidal alias for late in fractional-cycle terms.
  nudge(t: Patternable<number>): Pattern { return this.late(t); }

  // linger(n) plays the first 1/n of the cycle, scaled to fill, repeated n times.
  // n must be a positive integer (round-clamped). Tidal allows fractional n; we don't.
  // Per-copy event duration is clipped to the slot width (1/N) so consecutive
  // copies don't overlap when a source event's duration runs past the slice
  // (e.g. `n("a").linger(4)` — the single full-cycle event would otherwise
  // bleed into the next copy on every repetition).
  linger(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v >= 1)) throw new Error(`.linger() requires N >= 1 (got ${v})`);
        const N = Math.max(1, Math.round(v));
        const slotWidth = 1 / N;
        // Take events from the first 1/N of the source.
        const slice = inner(cycleN).filter((ev) => ev.start < slotWidth);
        const out: Event[] = [];
        for (let k = 0; k < N; k++) {
          const offset = k / N;
          for (const ev of slice) {
            // Clip the event duration to fit within the slice window so its
            // tail doesn't overlap the next copy. The remaining width inside
            // the slice is (slotWidth - ev.start); cap the original duration
            // to that.
            const dur = Math.min(ev.duration, slotWidth - ev.start);
            out.push({ ...ev, start: offset + ev.start, duration: dur });
          }
        }
        return out.sort((a, b) => a.start - b.start);
      },
    });
  }

  trunc(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const v = samplePatternable<number>(n, cycleN, 0);
        if (!(v > 0 && v <= 1)) throw new Error(`.trunc() requires 0 < N <= 1 (got ${v})`);
        const out: Event[] = [];
        for (const ev of inner(cycleN)) {
          if (ev.start >= v) continue;
          const end = Math.min(ev.start + ev.duration, v);
          out.push({ ...ev, duration: end - ev.start });
        }
        return out;
      },
    });
  }

  zoom(a: Patternable<number>, b: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const lo = samplePatternable<number>(a, cycleN, 0);
        const hi = samplePatternable<number>(b, cycleN, 0);
        if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.zoom() requires 0 <= a < b <= 1`);
        const span = hi - lo;
        const out: Event[] = [];
        for (const ev of inner(cycleN)) {
          const evEnd = ev.start + ev.duration;
          if (evEnd <= lo || ev.start >= hi) continue;
          const cs = Math.max(ev.start, lo);
          const ce = Math.min(evEnd, hi);
          out.push({ ...ev, start: (cs - lo) / span, duration: (ce - cs) / span });
        }
        return out;
      },
    });
  }

  compress(a: Patternable<number>, b: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const lo = samplePatternable<number>(a, cycleN, 0);
        const hi = samplePatternable<number>(b, cycleN, 0);
        if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.compress() requires 0 <= a < b <= 1`);
        const span = hi - lo;
        return inner(cycleN).map((ev) => ({ ...ev, start: lo + ev.start * span, duration: ev.duration * span }));
      },
    });
  }

  off(t: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.off() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.off() callback must return a Pattern`);
    const inner = this.getEvents;
    const altInner = transformed.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const shift = samplePatternable<number>(t, cycleN, 0);
        const orig = inner(cycleN);
        const shifted = wrapShift(altInner(cycleN), shift);
        return [...orig, ...shifted].sort((a, b) => a.start - b.start);
      },
    });
  }

  // ── Structural combinators ────────────────────────────────────────────

  // palindrome: alternates forward and reversed per cycle. `cat [p, rev p]`.
  palindrome(): Pattern {
    return cat([this, this.rev()]);
  }

  // mask(p): keep only events whose start is covered by a (non-rest) event in p.
  // String args are promoted via `n()` so users can write `mask "x ~ x x"`. The
  // mask's note names don't have to resolve to MIDI — only their timing matters.
  mask(maskPat: Pattern | string): Pattern {
    const mp = typeof maskPat === "string" ? n(maskPat) : maskPat;
    if (!(mp instanceof Pattern)) throw new Error(`.mask() requires a Pattern or string`);
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const maskEvents = mp.getEvents(cycleN);
        return inner(cycleN).filter((ev) =>
          maskEvents.some((m) => ev.start >= m.start && ev.start < m.start + m.duration),
        );
      },
    });
  }

  // struct(p): use p's event timing as the rhythm structure; cycle this pattern's
  // values through p's slots. Useful for "play these notes on this rhythm."
  //
  // Channel routing: the source's per-event `channel` / `channelOffset` are NOT
  // carried into struct slots. struct reuses source events by index modulo the
  // source length, so a per-event channel — which was associated with that
  // source slot's position in time — has no meaningful relationship to the
  // struct slot it lands on. If the struct pattern itself has per-event
  // channel routing (e.g. its events were produced by `stack` with `.ch()`d
  // parts), that wins. Otherwise the slot inherits the outer Pattern.channel
  // (set by `d1..d16` or a chained `.ch()` on the struct result).
  struct(structPat: Pattern | string): Pattern {
    const sp = typeof structPat === "string" ? n(structPat) : structPat;
    if (!(sp instanceof Pattern)) throw new Error(`.struct() requires a Pattern or string`);
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const structEvents = sp.getEvents(cycleN);
        const sourceEvents = inner(cycleN);
        if (sourceEvents.length === 0) return [];
        return structEvents.map((se, i) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { channel: _srcCh, channelOffset: _srcOff, ...src } = sourceEvents[i % sourceEvents.length];
          const out: Event = {
            ...src,
            start: se.start,
            duration: se.duration,
          };
          // Re-apply channel routing from the struct event (if it has any).
          if (se.channel !== undefined) out.channel = se.channel;
          if (se.channelOffset !== undefined) out.channelOffset = se.channelOffset;
          return out;
        });
      },
    });
  }

  // stutter(n, time): repeat each event n times, each subsequent copy delayed by
  // `time` (fractional cycles). Copies extending past the cycle boundary are dropped.
  stutter(count: Patternable<number>, time: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const c = Math.max(1, Math.round(samplePatternable<number>(count, cycleN, 0)));
        const t = samplePatternable<number>(time, cycleN, 0);
        if (!(t >= 0)) throw new Error(`.stutter() requires non-negative time (got ${t})`);
        const out: Event[] = [];
        for (const ev of inner(cycleN)) {
          for (let k = 0; k < c; k++) {
            const start = ev.start + k * t;
            if (start >= 1) break;
            out.push({ ...ev, start, duration: Math.min(ev.duration, 1 - start) });
          }
        }
        return out.sort((a, b) => a.start - b.start);
      },
    });
  }

  // inside(n, fn): apply fn as if the pattern were n times faster. Equivalent to
  // `slow(n).fn().fast(n)`. Useful when fn's output depends on cycle structure.
  inside(n: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.inside() requires a function`);
    return fn(this.slow(n)).fast(n);
  }

  // outside(n, fn): opposite of inside — apply fn as if pattern were n times slower.
  outside(n: Patternable<number>, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof fn !== "function") throw new Error(`.outside() requires a function`);
    return fn(this.fast(n)).slow(n);
  }

  // rot(n): rotate event NAMES leftward by n positions (events keep their start times,
  // but the note values shift). Different from `iter`, which advances per cycle.
  rot(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const events = inner(cycleN);
        if (events.length === 0) return [];
        const v = samplePatternable<number>(n, cycleN, 0);
        const k = ((Math.round(v) % events.length) + events.length) % events.length;
        if (k === 0) return events;
        const sorted = events.slice().sort((a, b) => a.start - b.start);
        return sorted.map((ev, i) => ({
          ...sorted[(i + k) % sorted.length],
          start: ev.start,
          duration: ev.duration,
        }));
      },
    });
  }

  // ── Music theory ──────────────────────────────────────────────────────

  // scale(name): map this pattern's integer tokens (degrees) into semitones via
  // the named scale. Degrees outside the scale length octave-wrap (e.g. degree 7
  // in a 7-note scale → next octave root). See music.ts SCALES for available names.
  scale(name: string): Pattern {
    const intervals = SCALES[name];
    if (!intervals) throw new Error(`.scale(): unknown scale '${name}' (try: ${Object.keys(SCALES).slice(0, 4).join(", ")}, ...)`);
    const len = intervals.length;
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const degree = parseInt(ev.name, 10);
        if (Number.isNaN(degree)) throw new Error(`.scale(): non-integer token '${ev.name}'`);
        const octave = Math.floor(degree / len);
        const step = ((degree % len) + len) % len;
        return { ...ev, name: String(octave * 12 + intervals[step]) };
      }),
    });
  }

  // arp(direction): turn concurrent events (chord-style) into a sequence within
  // their shared duration. Direction: "up" (low→high), "down" (high→low),
  // "updown" (low→high→low without repeating peaks), "converge" (outer→inner).
  // Events with unique start times are passed through unchanged.
  arp(direction: "up" | "down" | "updown" | "converge" = "up"): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => {
        const events = inner(cycleN);
        if (events.length === 0) return [];
        // Group by start (rounded for FP safety — chord events share start exactly).
        const groups = new Map<string, Event[]>();
        const order: string[] = [];
        for (const ev of events) {
          const key = String(Math.round(ev.start * 1e6));
          if (!groups.has(key)) { groups.set(key, []); order.push(key); }
          groups.get(key)!.push(ev);
        }
        const out: Event[] = [];
        for (const key of order) {
          const group = groups.get(key)!;
          if (group.length === 1) { out.push(group[0]); continue; }
          // Sort low→high by note value (parsed name + offset).
          const sorted = group.slice().sort((a, b) => {
            const av = (parseFloat(a.name) || 0) + (a.offset ?? 0);
            const bv = (parseFloat(b.name) || 0) + (b.offset ?? 0);
            return av - bv;
          });
          let order2 = sorted;
          if (direction === "down") order2 = sorted.slice().reverse();
          else if (direction === "updown") {
            // up + middle-only descent (no repeated boundary notes). For length N:
            //   N=1 → [a]
            //   N=2 → [a, b, a]  (middle slice is empty, so we tack the low note back on)
            //   N=3 → [a, b, c, b]
            //   N=4 → [a, b, c, d, c, b], etc.
            if (sorted.length <= 1) {
              order2 = sorted;
            } else if (sorted.length === 2) {
              // .slice(1, -1) is [] for length 2 — bug fix per TOFIX #21. Close
              // the cycle back to the low note so a 2-note arp actually moves.
              order2 = [...sorted, sorted[0]];
            } else {
              order2 = [...sorted, ...sorted.slice(1, -1).reverse()];
            }
          } else if (direction === "converge") {
            order2 = [];
            let lo = 0, hi = sorted.length - 1;
            while (lo <= hi) {
              order2.push(sorted[lo++]);
              if (lo <= hi) order2.push(sorted[hi--]);
            }
          }
          const start = group[0].start;
          const totalDur = Math.max(...group.map((e) => e.duration));
          const slotDur = totalDur / order2.length;
          order2.forEach((ev, i) => {
            out.push({ ...ev, start: start + i * slotDur, duration: slotDur });
          });
        }
        return out.sort((a, b) => a.start - b.start);
      },
    });
  }

  // ── Pitch arithmetic ──────────────────────────────────────────────────
  // add/sub/mul accumulate into Event.offset. The scheduler applies offset to the
  // resolved MIDI number, then clamps/drops if out of [0,127]. Composes through chains.
  add(p: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const delta = samplePatternable<number>(p, cycleN, ev.start);
        if (Number.isNaN(delta)) throw new Error(`.add(): non-numeric value in pattern`);
        return { ...ev, offset: (ev.offset ?? 0) + delta };
      }),
    });
  }

  sub(p: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const delta = samplePatternable<number>(p, cycleN, ev.start);
        if (Number.isNaN(delta)) throw new Error(`.sub(): non-numeric value in pattern`);
        return { ...ev, offset: (ev.offset ?? 0) - delta };
      }),
    });
  }

  mul(p: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const factor = samplePatternable<number>(p, cycleN, ev.start);
        if (Number.isNaN(factor)) throw new Error(`.mul(): non-numeric value in pattern`);
        return { ...ev, offset: (ev.offset ?? 0) * factor };
      }),
    });
  }

  up(n: Patternable<number>): Pattern { return this.add(n); }

  octave(n: Patternable<number>): Pattern {
    const inner = this.getEvents;
    return this.clone({
      getEvents: (cycleN) => inner(cycleN).map((ev) => {
        const oct = samplePatternable<number>(n, cycleN, ev.start);
        if (Number.isNaN(oct)) throw new Error(`.octave(): non-numeric value in pattern`);
        return { ...ev, offset: (ev.offset ?? 0) + oct * 12 };
      }),
    });
  }

  // ── jux ────────────────────────────────────────────────────────────────
  // Run `fn` on a copy of this pattern; route the original on the current channel
  // and the transformed copy on `channel + offset` (default 1). For MIDI this is
  // the natural analog of Tidal's L/R panned jux. Per-event channel offset is
  // resolved at scheduler time, so the offset is RELATIVE to whatever channel
  // d1..d16 ultimately set (or to an explicit .ch() further out).
  //
  // If the transformed pattern has its own explicit channel (via .ch()), that
  // wins — events fire on that absolute channel regardless of orbit.
  jux(fn: (p: Pattern) => Pattern): Pattern {
    return this.juxBy(1, fn);
  }

  juxBy(offset: number, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof offset !== "number" || !Number.isFinite(offset)) throw new Error(`.juxBy() requires a number offset`);
    if (typeof fn !== "function") throw new Error(`.juxBy() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.juxBy() callback must return a Pattern`);
    // Wrap offset mod 16 so `juxBy(20, ...)` lands on +4 instead of being
    // clamped at scheduler time. The jux family is documented as relative
    // channel routing — overflow should wrap around the 16 MIDI channels.
    const wrappedOffset = ((Math.trunc(offset) % 16) + 16) % 16;
    const tagged = transformed.clone({
      getEvents: (cycleN) => transformed.getEvents(cycleN).map((ev) => {
        if (ev.channel !== undefined || ev.channelOffset !== undefined) return ev;
        if (transformed.channelExplicit) return { ...ev, channel: transformed.channel };
        return { ...ev, channelOffset: wrappedOffset };
      }),
    });
    return stack([this, tagged]);
  }

  juxTo(absChannel: number, fn: (p: Pattern) => Pattern): Pattern {
    if (typeof absChannel !== "number" || !Number.isFinite(absChannel)) throw new Error(`.juxTo() requires a channel number`);
    if (typeof fn !== "function") throw new Error(`.juxTo() requires a function`);
    const ch = Math.max(0, Math.min(15, Math.floor(absChannel) - 1));
    const transformed = fn(this);
    if (!(transformed instanceof Pattern)) throw new Error(`.juxTo() callback must return a Pattern`);
    const tagged = transformed.clone({
      getEvents: (cycleN) => transformed.getEvents(cycleN).map((ev) =>
        ev.channel === undefined ? { ...ev, channel: ch } : ev,
      ),
    });
    return stack([this, tagged]);
  }
}

// Plant the Pattern brand on the prototype (see PATTERN_BRAND).
(Pattern.prototype as unknown as Record<string, unknown>)[PATTERN_BRAND] = true;

// ── Multi-pattern combinators ──────────────────────────────────────────
// `stack` plays N patterns simultaneously. `cat` picks one per cycle (mod-N).
// `fastcat` / `seq` cram all N into one cycle.
//
// All require matching `portType` — mixing notes and drums into one orbit isn't
// supported because each orbit has one MIDI port. Per-part `.ch()` IS supported:
// events from a part with explicit channel are tagged absolute; events from
// non-explicit parts inherit the outer channel (set by d1..d16).

function validateAndShare(parts: Pattern[], who: string): { portType: PortType; channel: number; channelExplicit: boolean } {
  if (!Array.isArray(parts)) throw new Error(`${who}: requires an array`);
  if (parts.length === 0) throw new Error(`${who}: requires a non-empty array`);
  const portType = parts[0].portType;
  for (const p of parts) {
    if (!(p instanceof Pattern)) throw new Error(`${who}: all entries must be Patterns`);
    if (p.portType !== portType) throw new Error(`${who}: cannot mix notes and drums; use two orbits`);
  }
  // Only "fully explicit" (every part) makes the combined pattern explicit, so
  // d1 still overrides when at least one part is non-explicit.
  return {
    portType,
    channel: parts[0].channel,
    channelExplicit: parts.every((p) => p.channelExplicit),
  };
}

// Tag a part's events with its own channel iff that part had an explicit .ch().
// Otherwise leave events untagged so they inherit the outer channel.
function tagPartEvents(p: Pattern, events: Event[]): Event[] {
  if (!p.channelExplicit) return events;
  return events.map((ev) => ev.channel === undefined && ev.channelOffset === undefined
    ? { ...ev, channel: p.channel }
    : ev);
}

export function stack(parts: Pattern[]): Pattern {
  const meta = validateAndShare(parts, "stack()");
  return new Pattern(
    (cycleN) => {
      const out: Event[] = [];
      for (const p of parts) out.push(...tagPartEvents(p, p.getEvents(cycleN)));
      out.sort((a, b) => a.start - b.start);
      return out;
    },
    meta.portType, meta.channel, meta.channelExplicit,
  );
}

export function cat(parts: Pattern[]): Pattern {
  const meta = validateAndShare(parts, "cat()");
  return new Pattern(
    (cycleN) => {
      const idx = ((cycleN % parts.length) + parts.length) % parts.length;
      const p = parts[idx];
      return tagPartEvents(p, p.getEvents(cycleN));
    },
    meta.portType, meta.channel, meta.channelExplicit,
  );
}

export function fastcat(parts: Pattern[]): Pattern {
  const meta = validateAndShare(parts, "fastcat()");
  const N = parts.length;
  return new Pattern(
    (cycleN) => {
      const out: Event[] = [];
      for (let i = 0; i < N; i++) {
        const p = parts[i];
        const slotStart = i / N;
        const slotLen = 1 / N;
        for (const ev of tagPartEvents(p, p.getEvents(cycleN))) {
          out.push({
            ...ev,
            start: slotStart + ev.start * slotLen,
            duration: ev.duration * slotLen,
          });
        }
      }
      out.sort((a, b) => a.start - b.start);
      return out;
    },
    meta.portType, meta.channel, meta.channelExplicit,
  );
}

export const seq = fastcat;

// ── Constructors ─────────────────────────────────────────────────────────
function makeBaseEvents(source: string, cycleN: number): Event[] {
  return evaluatePattern(source, cycleN).map((e) => ({
    start: e.start,
    duration: e.duration,
    name: e.name,
    velocity: 100,
  }));
}

export function n(source: string): Pattern {
  if (typeof source !== "string") throw new Error("n() requires a string pattern");
  return new Pattern((cycleN) => makeBaseEvents(source, cycleN), "notes", 0, false);
}

export function s(source: string): Pattern {
  if (typeof source !== "string") throw new Error("s() requires a string pattern");
  return new Pattern((cycleN) => makeBaseEvents(source, cycleN), "drums", 0, false);
}

// Tidal-compat: `silence` is a value (a Pattern), not a function.
export const silence = new Pattern(() => [], "notes", 0, false);

// ── Value-pattern generators ───────────────────────────────────────────
// These return Patterns intended for use as arithmetic args (e.g. in `.add(...)`).
// They produce numeric `name` strings and `portType: "notes"`. They CAN be played
// directly via `d1` for melodic sequences too — `n` semantics treats numeric
// tokens as semitone offsets from C4.

// run(N) — sequence "0 1 2 ... N-1" filling one cycle.
export function run(n: number): Pattern {
  if (typeof n !== "number" || !(n >= 1)) throw new Error("run() requires N >= 1");
  const N = Math.max(1, Math.floor(n));
  const tokens = Array.from({ length: N }, (_, i) => String(i)).join(" ");
  return new Pattern((cycleN) => makeBaseEvents(tokens, cycleN), "notes", 0, false);
}

// irand(N) — one event per cycle, name = floor(rand() * N), seeded by cycleN.
export function irand(n: number): Pattern {
  if (typeof n !== "number" || !(n >= 1)) throw new Error("irand() requires N >= 1");
  const N = Math.max(1, Math.floor(n));
  return new Pattern((cycleN) => {
    const r = mulberry32(cycleN * 4243)();
    const v = Math.floor(r * N);
    return [{ start: 0, duration: 1, name: String(v), velocity: 100 }];
  }, "notes", 0, false);
}

// chord(name) — produce a Pattern whose getEvents emits the chord's notes
// concurrently (all at start=0, duration=1). Compose with `.arp()` for
// arpeggiation, or use directly with d1 to play the full chord on every cycle.
// Names: "Cmaj7", "F#m7", "Bb'9", "C4'maj" etc. Default octave is 4 if omitted.
export function chord(name: string): Pattern {
  if (typeof name !== "string") throw new Error("chord() requires a string name");
  const parsed = parseChordName(name);
  if (!parsed) throw new Error(`chord(): unrecognized chord '${name}'`);
  const offsets = parsed.intervals.map((iv) => parsed.root + iv - 60);
  return new Pattern(() => offsets.map((semitones) => ({
    start: 0, duration: 1, name: String(semitones), velocity: 100,
  })), "notes", 0, false);
}

// wchoose([(weight, value), ...]) — weighted random pick per cycle. Heavier
// entries are picked proportionally more often. Distinct seed namespace from
// `choose` so they don't correlate.
export function wchoose(arr: Array<[number, string | number | Pattern]>): Pattern {
  if (!Array.isArray(arr)) throw new Error("wchoose() requires an array");
  if (arr.length === 0) return silence;
  const total = arr.reduce((s, [w]) => s + w, 0);
  if (!(total > 0)) throw new Error("wchoose(): total weight must be positive");
  return new Pattern((cycleN) => {
    const target = mulberry32(cycleN * 8623)() * total;
    let cum = 0;
    for (const [w, val] of arr) {
      cum += w;
      if (target < cum) {
        if (val instanceof Pattern) return val.getEvents(cycleN);
        if (typeof val === "string" || typeof val === "number") {
          return [{ start: 0, duration: 1, name: String(val), velocity: 100 }];
        }
        throw new Error(`wchoose(): unsupported entry type ${typeof val}`);
      }
    }
    // Numerical fallback (target == total exactly): pick last entry.
    const fallback = arr[arr.length - 1][1];
    if (fallback instanceof Pattern) return fallback.getEvents(cycleN);
    return [{ start: 0, duration: 1, name: String(fallback), velocity: 100 }];
  }, "notes", 0, false);
}

// choose([...]) — one event per cycle picked from the array, seeded by cycleN.
// Entries can be strings (used as note tokens), numbers, or Patterns (which yield
// their full per-cycle event list).
export function choose(arr: Array<string | number | Pattern>): Pattern {
  if (!Array.isArray(arr)) throw new Error("choose() requires an array");
  if (arr.length === 0) return silence;
  return new Pattern((cycleN) => {
    const r = mulberry32(cycleN * 9281)();
    const idx = Math.floor(r * arr.length);
    const pick = arr[idx];
    if (pick instanceof Pattern) return pick.getEvents(cycleN);
    if (typeof pick === "string" || typeof pick === "number") {
      return [{ start: 0, duration: 1, name: String(pick), velocity: 100 }];
    }
    throw new Error(`choose(): unsupported entry type ${typeof pick}`);
  }, "notes", 0, false);
}

// range(lo, hi, src) — scale a unipolar [0,1] source to [lo, hi]. Polymorphic on
// the third arg: a Pattern (of numeric tokens) returns a Pattern; a ContinuousSignal
// returns a ContinuousSignal. Drives gain/velocity/pitch math from value or signal
// sources, e.g. `gain(range(0.3, 1, sine))` or `add(range(0, 12, n("0 0.5 1")))`.
export function range(
  lo: number,
  hi: number,
  src: Pattern | ContinuousSignal,
): Pattern | ContinuousSignal {
  if (typeof lo !== "number" || typeof hi !== "number") throw new Error("range() requires numeric lo, hi");
  if (typeof src === "function") {
    return (c, ph) => lo + (src as ContinuousSignal)(c, ph) * (hi - lo);
  }
  if (!(src instanceof Pattern)) throw new Error("range() requires a Pattern or ContinuousSignal as third arg");
  return new Pattern((cycleN) => src.getEvents(cycleN).map((ev) => {
    const v = parseFloat(ev.name);
    if (Number.isNaN(v)) throw new Error(`range(): non-numeric token '${ev.name}' in pattern`);
    const scaled = lo + v * (hi - lo);
    return { ...ev, name: String(scaled) };
  }), src.portType, src.channel, src.channelExplicit);
}

// range2(lo, hi, src) — scale a BIPOLAR [-1,1] source to [lo, hi]. Use with the
// `*2` signal variants (sine2/saw2/tri2/square2/cosine2/isaw2) so the output
// covers the full target range symmetrically. e.g. `add(range2(-7, 7, sine2))`.
export function range2(
  lo: number,
  hi: number,
  src: Pattern | ContinuousSignal,
): Pattern | ContinuousSignal {
  if (typeof lo !== "number" || typeof hi !== "number") throw new Error("range2() requires numeric lo, hi");
  if (typeof src === "function") {
    return (c, ph) => lo + ((src as ContinuousSignal)(c, ph) + 1) / 2 * (hi - lo);
  }
  if (!(src instanceof Pattern)) throw new Error("range2() requires a Pattern or ContinuousSignal as third arg");
  return new Pattern((cycleN) => src.getEvents(cycleN).map((ev) => {
    const v = parseFloat(ev.name);
    if (Number.isNaN(v)) throw new Error(`range2(): non-numeric token '${ev.name}' in pattern`);
    const scaled = lo + (v + 1) / 2 * (hi - lo);
    return { ...ev, name: String(scaled) };
  }), src.portType, src.channel, src.channelExplicit);
}

// ── Continuous signals ────────────────────────────────────────────────
// Functions of (cycleN, phase) → value. Unipolar variants output [0,1]; the `2`
// suffix versions output [-1,1]. `rand` and `perlin` are unipolar only.
//
// Sample at the SAME (cycleN, phase) the consumer uses — per-event combinators
// (gain/add/etc.) get smooth modulation; structural ops (fast/every) sample at
// phase 0 and effectively get a constant-per-cycle value.
const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);

export const sine:    ContinuousSignal = (_c, ph) => (Math.sin(TAU * ph) + 1) / 2;
export const sine2:   ContinuousSignal = (_c, ph) =>  Math.sin(TAU * ph);
export const cosine:  ContinuousSignal = (_c, ph) => (Math.cos(TAU * ph) + 1) / 2;
export const cosine2: ContinuousSignal = (_c, ph) =>  Math.cos(TAU * ph);
export const saw:     ContinuousSignal = (_c, ph) => fract(ph);
export const saw2:    ContinuousSignal = (_c, ph) => fract(ph) * 2 - 1;
export const isaw:    ContinuousSignal = (_c, ph) => 1 - fract(ph);
export const isaw2:   ContinuousSignal = (_c, ph) => 1 - fract(ph) * 2;
export const tri:     ContinuousSignal = (_c, ph) => {
  const f = fract(ph);
  return f < 0.5 ? f * 2 : (1 - f) * 2;
};
export const tri2:    ContinuousSignal = (_c, ph) => tri(_c, ph) * 2 - 1;
export const square:  ContinuousSignal = (_c, ph) => fract(ph) < 0.5 ? 0 : 1;
export const square2: ContinuousSignal = (_c, ph) => fract(ph) < 0.5 ? -1 : 1;

// rand: per-(cycle, phase) random in [0, 1). Quantizes phase to ~1µs resolution
// so adjacent phase queries return distinct values without unbounded seed growth.
export const rand: ContinuousSignal = (c, ph) =>
  mulberry32(c * 5051 + Math.floor(ph * 1e6))();

// perlin: 1D value noise — random scalars at integer cycle boundaries, smootherstep
// interpolation between adjacent points. Matches Tidal's `perlin` (which is also
// value noise, despite the name; classic gradient Perlin would use random vectors).
function smootherstep(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
function perlinSample(seed: number): number { return mulberry32(seed * 3571)(); }
export const perlin: ContinuousSignal = (c, ph) => {
  const a = perlinSample(c);
  const b = perlinSample(c + 1);
  return a + (b - a) * smootherstep(fract(ph));
};

// ── Signal time transforms ────────────────────────────────────────────
// Let time-scaling and shifting combinators (slow/fast/rev/early/late) accept
// a ContinuousSignal and return a ContinuousSignal. Tidal treats signals as
// patterns; we represent them as raw `(cycleN, phase) => number` functions, so
// these helpers explicitly remap that input. `n`/`t` accept any Patternable
// and are sampled per query at the current (cycleN, phase).
function scaleSignalTime(
  who: string,
  n: Patternable<number>,
  sig: ContinuousSignal,
  factor: (v: number) => number,
): ContinuousSignal {
  return (c, ph) => {
    const v = samplePatternable<number>(n, c, ph);
    if (!(v > 0)) throw new Error(`${who}: requires positive number (got ${v})`);
    const t = (c + ph) * factor(v);
    const vc = Math.floor(t);
    return sig(vc, t - vc);
  };
}

export function slowSignal(n: Patternable<number>, sig: ContinuousSignal): ContinuousSignal {
  return scaleSignalTime("slow", n, sig, (v) => 1 / v);
}

export function fastSignal(n: Patternable<number>, sig: ContinuousSignal): ContinuousSignal {
  return scaleSignalTime("fast", n, sig, (v) => v);
}

export function revSignal(sig: ContinuousSignal): ContinuousSignal {
  return (c, ph) => sig(c, 1 - ph);
}

function shiftSignal(t: Patternable<number>, sig: ContinuousSignal, sign: 1 | -1): ContinuousSignal {
  return (c, ph) => {
    const v = samplePatternable<number>(t, c, ph);
    const u = c + ph + sign * v;
    const vc = Math.floor(u);
    return sig(vc, u - vc);
  };
}

export function earlySignal(t: Patternable<number>, sig: ContinuousSignal): ContinuousSignal {
  return shiftSignal(t, sig, 1);
}

export function lateSignal(t: Patternable<number>, sig: ContinuousSignal): ContinuousSignal {
  return shiftSignal(t, sig, -1);
}

// segment(N, sig) — discretize a signal into a Pattern of N events per cycle.
// Each event covers 1/N of the cycle, named with the stringified sample at its
// start. Lets you play a signal directly (e.g. `n(segment(8, range(48, 84, saw)))`).
export function segment(n: number, sig: ContinuousSignal): Pattern {
  if (typeof n !== "number" || !(n >= 1)) throw new Error("segment() requires N >= 1");
  if (typeof sig !== "function") throw new Error("segment() requires a ContinuousSignal as second arg");
  const N = Math.max(1, Math.floor(n));
  return new Pattern((cycleN) => {
    const events: Event[] = [];
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      events.push({ start: ph, duration: 1 / N, name: String(sig(cycleN, ph)), velocity: 100 });
    }
    return events;
  }, "notes", 0, false);
}

// ── PRNG (cycleN-deterministic so .degradeBy is reproducible per cycle) ─
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Engine API exposed to user code via vm sandbox ──────────────────────
export interface Engine {
  setOrbit(orbit: number, pattern: Pattern): void;
  clearOrbit(orbit: number): void;
  setControlOrbit?(orbit: number, pattern: import("./control.js").ControlPattern): void;
  clearControlOrbit?(orbit: number): void;
  installLearn?(pattern: import("./control.js").ControlPattern, durationCycles: number): void;
  // Per-orbit drum-name → MIDI-note override. Wins over the global DRUM_MAP
  // for `s "..."` patterns on that orbit; unset names fall through to global.
  setDrumMap?(orbit: number, map: Record<string, number>): void;
  clearDrumMap?(orbit: number): void;
  // Introspect a Live track via the SDK, build a drum map from its first Drum
  // Rack's chains, and install it on `orbit`. Synchronous because all SDK
  // getters used (devices, chains, sample) are sync. Throws on lookup failure.
  autoMap?(orbit: number, trackName: string, aliasUnknown: boolean): AutoMapResult;
  hush(): void;
}

export interface AutoMapResult {
  trackName: string;
  map: Record<string, number>;
  // Sample basenames that didn't resolve to a known alias and were skipped
  // (only populated when aliasUnknown=false; in alias-all mode they're added
  // to the map instead).
  skipped: string[];
}

// Dispatch helper for polymorphic combinators that accept either a Pattern or
// a ControlPattern. The `noteFn` and `ctrlFn` callbacks receive the typed input
// and return any value (the return type is the union of the two branches).
// Anything else throws a clear type error.
type Either = Pattern | ControlPattern;
function dispatch<RP, RC>(
  name: string,
  p: Either,
  noteFn: (p: Pattern) => RP,
  ctrlFn: (p: ControlPattern) => RC,
): RP | RC {
  if (p instanceof Pattern) return noteFn(p);
  if (p instanceof ControlPattern) return ctrlFn(p);
  throw new Error(`${name}: requires a Pattern or ControlPattern (got ${typeof p})`);
}

// Polymorphic stack/cat/fastcat: accept a homogeneous array of Patterns or of
// ControlPatterns; mixing throws a clear error pointing at the orbit split.
function polyMulti(
  who: string,
  parts: unknown,
  patternFn: (parts: Pattern[]) => Pattern,
  controlFn: (parts: ControlPattern[]) => ControlPattern,
): Pattern | ControlPattern {
  if (!Array.isArray(parts)) throw new Error(`${who}: requires an array`);
  if (parts.length === 0) throw new Error(`${who}: requires a non-empty array`);
  const hasNote = parts.some((x) => x instanceof Pattern);
  const hasCtrl = parts.some((x) => x instanceof ControlPattern);
  if (hasNote && hasCtrl) {
    throw new Error(`${who}: cannot mix note Patterns and ControlPatterns — they emit on different ports; use two orbits (one d-, one c-)`);
  }
  if (hasCtrl) return controlFn(parts as ControlPattern[]);
  return patternFn(parts as Pattern[]);
}

// Refusal helper for pitch/velocity-specific combinators called on a CC stream.
function refuseOnCtrl(name: string): (p: Either) => never {
  return (_p: Either) => {
    throw new Error(`${name}: not meaningful on a ControlPattern (CC stream has no pitch/velocity); use ctrl with a numeric pattern instead`);
  };
}

export function buildSandbox(engine: Engine): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    n, s, silence, Pattern, run, irand, choose, wchoose, chord,
    // Continuous signal values (functions, used directly as combinator args).
    sine, sine2, cosine, cosine2, cos: cosine, cos2: cosine2,
    tri, tri2, saw, saw2, isaw, isaw2, square, square2, rand, perlin,
    // Control patterns (CC out). Curried for Tidal-style juxtaposition.
    ctrl: (cc: Patternable<number>) => (src: Patternable<number>) => ctrlConstructor(cc, src),
    ControlPattern,
    // Arithmetic operator helpers — transpiler lowers `+ - * /` and unary `-`
    // to these. `__`-prefixed so they don't shadow user-visible identifiers.
    __add, __sub, __mul, __div, __neg,
  };

  // Polymorphic multi-pattern combinators — accept either Pattern[] or ControlPattern[].
  sandbox.stack   = (parts: unknown) => polyMulti("stack()",   parts, stack,   ctrlStack);
  sandbox.cat     = (parts: unknown) => polyMulti("cat()",     parts, cat,     ctrlCat);
  sandbox.fastcat = (parts: unknown) => polyMulti("fastcat()", parts, fastcat, ctrlFastcat);
  sandbox.seq     = sandbox.fastcat;

  // d1..d16 — register pattern on orbit, default channel = orbit number unless overridden via .ch()
  for (let i = 1; i <= 16; i++) {
    sandbox[`d${i}`] = (p: Pattern | null | undefined) => {
      if (p == null) { engine.clearOrbit(i); return; }
      if (!(p instanceof Pattern)) throw new Error(`d${i}() requires a Pattern (got ${typeof p})`);
      const final = p.channelExplicit ? p : p.ch(i);
      engine.setOrbit(i, final);
      return final;
    };
  }

  // c1..c8 — register a ControlPattern on a control orbit. Default channel 1
  // (idx 0) unless overridden via .ch(). Distinct slot space from d1..d16:
  // re-evaluating c1 doesn't disturb a note orbit on the same number.
  // `c1 silence` and `c1 null` both clear the orbit (last value held).
  for (let i = 1; i <= 8; i++) {
    sandbox[`c${i}`] = (p: ControlPattern | Pattern | null | undefined) => {
      if (!engine.setControlOrbit || !engine.clearControlOrbit) {
        throw new Error(`c${i}: this engine does not support control patterns`);
      }
      if (p == null || p === silence) { engine.clearControlOrbit(i); return; }
      if (!(p instanceof ControlPattern)) {
        throw new Error(`c${i}() requires a ctrl pattern (got ${p instanceof Pattern ? "Pattern (use ctrl)" : typeof p})`);
      }
      const final = p.channelExplicit ? p : p.ch(1);
      engine.setControlOrbit(i, final);
      return final;
    };
  }

  // learn(cc, [chan]) — emit a slow triangle sweep on the given CC for ~8 cycles
  // so it can be MIDI-mapped in Live (Cmd+M, right-click destination, wiggle).
  // Tidal-style: `learn 74` and `learn 74 5` (channel 5) both work.
  const installLearnFor = (cc: number, chan: number) => {
    if (!engine.installLearn) {
      throw new Error("learn(): this engine does not support control patterns");
    }
    const req = learnConstructor(cc, chan);
    engine.installLearn(req.pattern, req.durationCycles);
    return req;
  };
  // Polymorphic call: `learn(74)` installs immediately on chan 1; `learn(74)(5)`
  // re-installs on chan 5. We return a callable result so the curried form Just Works.
  function learnCallable(cc: number) {
    const req = installLearnFor(cc, 1);
    const next = (chan: number) => installLearnFor(cc, chan);
    Object.assign(next, req);
    return next;
  }
  sandbox.learn = learnCallable;

  // drumMap N "bd:36 sn:38 tom1=41" — register a per-orbit drum-name override.
  // Empty spec (`drumMap 1 ""`) clears the override and reverts to the global
  // DRUM_MAP for that orbit. Curried so the Tidal-flavored `drumMap 1 "..."`
  // form transpiles to `drumMap(1)("...")` cleanly.
  sandbox.drumMap = (orbit: number) => (spec: string) => {
    if (typeof orbit !== "number" || !Number.isInteger(orbit) || orbit < 1) {
      throw new Error(`drumMap: orbit must be a positive integer (got ${orbit})`);
    }
    if (!engine.setDrumMap || !engine.clearDrumMap) {
      throw new Error("drumMap: this engine does not support drum-map overrides");
    }
    if (typeof spec !== "string") {
      throw new Error(`drumMap: spec must be a string like "bd:36 sn:38" (got ${typeof spec})`);
    }
    if (spec.trim().length === 0) { engine.clearDrumMap(orbit); return; }
    const map = parseDrumMapSpec(spec);
    engine.setDrumMap(orbit, map);
    return map;
  };

  // autoMap N "Track Name" — introspect a Live track, build a drum map from
  // its first Drum Rack's chains (using each chain's first Simpler sample
  // filename as the alias), and install it on orbit N. Sample names that
  // don't match a known drum alias are skipped; use autoMapAll to alias them
  // by sanitized filename basename instead.
  const runAutoMap = (orbit: number, trackName: string, aliasUnknown: boolean) => {
    if (typeof orbit !== "number" || !Number.isInteger(orbit) || orbit < 1) {
      throw new Error(`autoMap: orbit must be a positive integer (got ${orbit})`);
    }
    if (typeof trackName !== "string" || trackName.trim().length === 0) {
      throw new Error("autoMap: track name must be a non-empty string");
    }
    if (!engine.autoMap) {
      throw new Error("autoMap: this engine does not support track introspection");
    }
    return engine.autoMap(orbit, trackName, aliasUnknown);
  };
  sandbox.autoMap    = (orbit: number) => (trackName: string) => runAutoMap(orbit, trackName, false);
  sandbox.autoMapAll = (orbit: number) => (trackName: string) => runAutoMap(orbit, trackName, true);

  sandbox.hush = () => engine.hush();

  // Curried Tidal-style combinators — polymorphic over Pattern / ControlPattern.
  // Each returns a transformer that dispatches on the runtime type so a single
  // sandbox name (e.g. `fast 2`) works on both note streams and CC streams.
  sandbox.fast       = (n: Patternable<number>) => (p: Either | ContinuousSignal) =>
    typeof p === "function"
      ? fastSignal(n, p as ContinuousSignal)
      : dispatch("fast", p, (q) => q.fast(n), (q) => q.fast(n));
  sandbox.slow       = (n: Patternable<number>) => (p: Either | ContinuousSignal) =>
    typeof p === "function"
      ? slowSignal(n, p as ContinuousSignal)
      : dispatch("slow", p, (q) => q.slow(n), (q) => q.slow(n));
  sandbox.rev        = (p: Either | ContinuousSignal) =>
    typeof p === "function"
      ? revSignal(p as ContinuousSignal)
      : dispatch("rev", p, (q) => q.rev(), (q) => q.rev());
  sandbox.every      = (n: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("every", p,
      (q) => q.every(n, fn as (x: Pattern) => Pattern),
      (q) => q.every(n, fn as (x: ControlPattern) => ControlPattern));
  sandbox.degradeBy  = (amount: Patternable<number>) => (p: Either) => dispatch("degradeBy", p, (q) => q.degradeBy(amount), (q) => q.degradeBy(amount));
  sandbox.degrade    = (p: Either) => dispatch("degrade", p, (q) => q.degrade(), (q) => q.degrade());
  sandbox.chan       = (n: number) => (p: Either) => dispatch("chan", p, (q) => q.ch(n), (q) => q.ch(n));
  sandbox.ch         = (n: number) => (p: Either) => dispatch("ch",   p, (q) => q.ch(n), (q) => q.ch(n));
  sandbox.jux        = (fn: (p: Either) => Either) => (p: Either) => dispatch("jux", p,
    (q) => q.jux(fn as (x: Pattern) => Pattern),
    (q) => q.jux(fn as (x: ControlPattern) => ControlPattern));
  sandbox.juxBy      = (offset: number) => (fn: (p: Either) => Either) => (p: Either) => dispatch("juxBy", p,
    (q) => q.juxBy(offset, fn as (x: Pattern) => Pattern),
    (q) => q.juxBy(offset, fn as (x: ControlPattern) => ControlPattern));
  sandbox.juxTo      = (chan: number) => (fn: (p: Either) => Either) => (p: Either) => dispatch("juxTo", p,
    (q) => q.juxTo(chan, fn as (x: Pattern) => Pattern),
    (q) => q.juxTo(chan, fn as (x: ControlPattern) => ControlPattern));

  // Phase 4 cycle-indexed combinators
  sandbox.iter       = (n: Patternable<number>) => (p: Either) => dispatch("iter",  p, (q) => q.iter(n), (q) => q.iter(n));
  sandbox.density    = sandbox.fast;
  sandbox.sparsity   = sandbox.slow;
  sandbox.early      = (t: Patternable<number>) => (p: Either | ContinuousSignal) =>
    typeof p === "function"
      ? earlySignal(t, p as ContinuousSignal)
      : dispatch("early", p, (q) => q.early(t), (q) => q.early(t));
  sandbox.late       = (t: Patternable<number>) => (p: Either | ContinuousSignal) =>
    typeof p === "function"
      ? lateSignal(t, p as ContinuousSignal)
      : dispatch("late",  p, (q) => q.late(t),  (q) => q.late(t));
  sandbox.nudge      = (t: Patternable<number>) => (p: Either) => dispatch("nudge", p, (q) => q.nudge(t), (q) => q.nudge(t));
  sandbox.linger     = (n: Patternable<number>) => (p: Either) => dispatch("linger",p, (q) => q.linger(n),(q) => q.linger(n));
  sandbox.trunc      = (n: Patternable<number>) => (p: Either) => dispatch("trunc", p, (q) => q.trunc(n), (q) => q.trunc(n));
  sandbox.zoom       = (a: Patternable<number>) => (b: Patternable<number>) => (p: Either) =>
    dispatch("zoom", p, (q) => q.zoom(a, b), (q) => q.zoom(a, b));
  sandbox.compress   = (a: Patternable<number>) => (b: Patternable<number>) => (p: Either) =>
    dispatch("compress", p, (q) => q.compress(a, b), (q) => q.compress(a, b));
  sandbox.whenmod    = (m: Patternable<number>) => (n: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("whenmod", p,
      (q) => q.whenmod(m, n, fn as (x: Pattern) => Pattern),
      (q) => q.whenmod(m, n, fn as (x: ControlPattern) => ControlPattern));
  sandbox.chunk      = (n: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("chunk", p,
      (q) => q.chunk(n, fn as (x: Pattern) => Pattern),
      (q) => q.chunk(n, fn as (x: ControlPattern) => ControlPattern));
  sandbox.off        = (t: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("off", p,
      (q) => q.off(t, fn as (x: Pattern) => Pattern),
      (q) => q.off(t, fn as (x: ControlPattern) => ControlPattern));
  sandbox.sometimes   = (fn: (p: Either) => Either) => (p: Either) => dispatch("sometimes", p,
    (q) => q.sometimesBy(0.5, fn as (x: Pattern) => Pattern),
    (q) => q.sometimesBy(0.5, fn as (x: ControlPattern) => ControlPattern));
  sandbox.often       = (fn: (p: Either) => Either) => (p: Either) => dispatch("often", p,
    (q) => q.sometimesBy(0.75, fn as (x: Pattern) => Pattern),
    (q) => q.sometimesBy(0.75, fn as (x: ControlPattern) => ControlPattern));
  sandbox.rarely      = (fn: (p: Either) => Either) => (p: Either) => dispatch("rarely", p,
    (q) => q.sometimesBy(0.25, fn as (x: Pattern) => Pattern),
    (q) => q.sometimesBy(0.25, fn as (x: ControlPattern) => ControlPattern));
  sandbox.sometimesBy = (prob: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("sometimesBy", p,
      (q) => q.sometimesBy(prob, fn as (x: Pattern) => Pattern),
      (q) => q.sometimesBy(prob, fn as (x: ControlPattern) => ControlPattern));

  // Phase 5: pitch arithmetic — pitch-specific. Refuse on ControlPattern with
  // a clear hint pointing at ctrl.
  sandbox.add        = (v: Patternable<number>) => (p: Either) => dispatch("add",    p, (q) => q.add(v),    refuseOnCtrl("add"));
  sandbox.sub        = (v: Patternable<number>) => (p: Either) => dispatch("sub",    p, (q) => q.sub(v),    refuseOnCtrl("sub"));
  sandbox.mul        = (v: Patternable<number>) => (p: Either) => dispatch("mul",    p, (q) => q.mul(v),    refuseOnCtrl("mul"));
  sandbox.up         = (v: Patternable<number>) => (p: Either) => dispatch("up",     p, (q) => q.up(v),     refuseOnCtrl("up"));
  sandbox.octave     = (v: Patternable<number>) => (p: Either) => dispatch("octave", p, (q) => q.octave(v), refuseOnCtrl("octave"));
  // gain/velocity also pitch/payload-specific.
  sandbox.gain       = (v: Patternable<number>) => (p: Either) => dispatch("gain",     p, (q) => q.gain(v),     refuseOnCtrl("gain"));
  sandbox.velocity   = (v: Patternable<number>) => (p: Either) => dispatch("velocity", p, (q) => q.velocity(v), refuseOnCtrl("velocity"));
  sandbox.range      = (lo: number) => (hi: number) => (src: Pattern | ContinuousSignal) => range(lo, hi, src);
  sandbox.range2     = (lo: number) => (hi: number) => (src: Pattern | ContinuousSignal) => range2(lo, hi, src);
  sandbox.segment    = (n: number) => (sig: ContinuousSignal) => segment(n, sig);

  // Phase B structural combinators
  sandbox.palindrome = (p: Either) => dispatch("palindrome", p, (q) => q.palindrome(), (q) => q.palindrome());
  sandbox.mask       = (m: Pattern | string) => (p: Either) => dispatch("mask",   p, (q) => q.mask(m),   (q) => q.mask(m));
  sandbox.struct     = (m: Pattern | string) => (p: Either) => dispatch("struct", p, (q) => q.struct(m), (q) => q.struct(m));
  sandbox.stutter    = (n: Patternable<number>) => (t: Patternable<number>) => (p: Either) =>
    dispatch("stutter", p, (q) => q.stutter(n, t), (q) => q.stutter(n, t));
  sandbox.inside     = (n: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("inside", p,
      (q) => q.inside(n, fn as (x: Pattern) => Pattern),
      (q) => q.inside(n, fn as (x: ControlPattern) => ControlPattern));
  sandbox.outside    = (n: Patternable<number>) => (fn: (p: Either) => Either) =>
    (p: Either) => dispatch("outside", p,
      (q) => q.outside(n, fn as (x: Pattern) => Pattern),
      (q) => q.outside(n, fn as (x: ControlPattern) => ControlPattern));
  sandbox.rot        = (n: Patternable<number>) => (p: Either) => dispatch("rot", p, (q) => q.rot(n), (q) => q.rot(n));

  // Phase C music theory — pitch-specific. Refuse on ControlPattern.
  sandbox.scale      = (name: string) => (p: Either) => dispatch("scale", p, (q) => q.scale(name), refuseOnCtrl("scale"));
  sandbox.arp        = (dir: "up" | "down" | "updown" | "converge") =>
    (p: Either) => dispatch("arp", p, (q) => q.arp(dir), refuseOnCtrl("arp"));

  return sandbox;
}

import { transpile } from "./transpile.js";

export function runUserCode(code: string, sandbox: Record<string, unknown>): void {
  const trimmed = code.trim();
  if (!trimmed) return;
  const js = transpile(trimmed);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(js, ctx, { timeout: 1000 });
}
