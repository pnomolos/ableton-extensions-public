// Control patterns — MIDI CC out, on a third virtual port "Lidal Control".
//
// User surface:
//   c1 $ ctrl 74 sine                      -- CC 74 swept by sine, ch 1, 64 steps/cycle
//   c2 $ ctrl 71 (range 30 90 saw)         -- explicit range, auto-scaling skipped
//   c3 $ ctrl 80 "0 64 127 64"             -- stepped pattern, 4 CCs/cycle (Tidal semantics)
//   c1 $ ctrl 74 sine # segment 128        -- override smooth-density (cap 1024)
//   c1 $ ctrl 74 sine # chan 3             -- explicit MIDI channel
//   c1 $ fast 2 (ctrl 74 sine)             -- combinators compose with ControlPattern
//   c1 $ stack [ctrl 74 sine, ctrl 71 saw] -- one orbit, two CCs at once
//   c1 $ jux rev (ctrl 74 sine)            -- modified copy on next channel up
//   learn 74                               -- transient slow sweep on CC 74 → MIDI-map in Live
//
// Architecture: a ControlPattern from a continuous signal carries a `signalSource`
// describing the underlying signal and a `timeMap` from output (cycleN, phase) to
// source (cycleN, phase). Time-related transforms compose `timeMap` rather than
// stretching a pre-rendered event array — so re-sampling always happens at the
// output cycle's `segN` density, eliminating the zipper artifact `slow 4 sine`
// used to produce. Pattern-sourced ControlPatterns and the constant case keep
// the discrete event-array path; their density is intrinsic to the source.

import {
  Pattern,
  samplePatternable,
  wrapShiftPoint,
  applyTimeScalePoint,
  mulberry32Public,
} from "./patterns.js";
import type { ContinuousSignal, Patternable } from "./patterns.js";
import { evaluatePattern } from "./parser.js";

export interface ControlEvent {
  start: number;     // 0..1 within cycle
  cc: number;        // 0..127
  value: number;     // 0..127 (rounded int — clamping done by clampCc)
  // Per-event channel routing (parallel to Pattern.Event). Set by stack/cat
  // when a part has its own .ch(), and by jux for relative-offset routing.
  channel?: number;       // absolute 0..15
  channelOffset?: number; // relative to pattern.channel (jux)
  // Optional duration (0..1, in cycles). ControlEvents are point samples by
  // default, so this is undefined for events built by ctrlFromSignal /
  // ctrlFromPattern. It exists so that combinators that *would* expose
  // durations on Pattern events (e.g. `linger` clipping a slice's tail) can
  // preserve / clip a duration field if upstream ever sets one — keeping
  // ControlPattern's combinator behaviour structurally parallel to Pattern's.
  duration?: number;
}

export const DEFAULT_SEGMENT = 64;
export const MAX_SEGMENT = 1024;

// Output (cycleN, phase) → source (cycleN, phase). Identity is the no-op.
export type TimeMap = (outCycle: number, outPhase: number) => { srcCycle: number; srcPhase: number };

const IDENTITY_TIME_MAP: TimeMap = (oc, ph) => ({ srcCycle: oc, srcPhase: ph });

// A signal-sourced ControlPattern's continuous representation. Density transforms
// (fast/slow/zoom/inside/outside/...) compose `timeMap`. Re-rendering at any
// output `segN` produces evenly-spaced samples of the underlying signal at the
// mapped source coordinates — smoothness preserved no matter how many time
// transforms compose.
interface SignalSource {
  ccPat: Patternable<number>;
  scaled: ContinuousSignal;
  timeMap: TimeMap;
}

// Brand on the prototype so cross-bundle instanceof checks (which fail when
// the same source is bundled twice with separate class identities — the offline
// test harness does this) can fall back to a structural check.
const CONTROL_PATTERN_BRAND = "__lidal_ControlPattern__";

export class ControlPattern {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static [Symbol.hasInstance](instance: any): boolean {
    if (instance == null || typeof instance !== "object") return false;
    return (instance as Record<string, unknown>)[CONTROL_PATTERN_BRAND] === true;
  }

  constructor(
    public readonly getEvents: (cycleN: number) => ControlEvent[],
    public readonly channel: number,            // 0..15
    public readonly channelExplicit: boolean,
    public readonly segmentN: number,
    public readonly signalSource: SignalSource | null = null,
    public readonly restValue: number | null = null,
  ) {}

  // Produce a new event-based ControlPattern, dropping the signal carrier.
  // Used by transforms that aren't expressible as a time-bijection on the
  // underlying signal (mask/struct/stack/cat/etc.). After this point, later
  // density transforms operate on the rendered events, not the signal.
  private withEvents(getEvents: (cycleN: number) => ControlEvent[]): ControlPattern {
    return new ControlPattern(
      getEvents,
      this.channel,
      this.channelExplicit,
      this.segmentN,
      null,
      this.restValue,
    );
  }

  // Compose a new (output → source) time map onto the existing signal carrier
  // and re-render at this.segmentN. Pattern/constant sources fall back to the
  // event-based path provided by `eventFallback`.
  private mapTime(
    compose: (prev: TimeMap) => TimeMap,
    eventFallback: () => ControlPattern,
  ): ControlPattern {
    if (!this.signalSource) return eventFallback();
    const src = this.signalSource;
    const newMap = compose(src.timeMap);
    return new ControlPattern(
      buildSignalGetEvents(src.ccPat, src.scaled, newMap, this.segmentN),
      this.channel,
      this.channelExplicit,
      this.segmentN,
      { ...src, timeMap: newMap },
      this.restValue,
    );
  }

  // `.ch(n)` takes a 1-indexed MIDI channel (1..16) and stores 0-indexed (0..15).
  // Values outside [1, 16] are CLAMPED; `n=0` is rejected (1-indexing typo).
  ch(n: number): ControlPattern {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`.ch() requires a number`);
    if (n === 0) throw new Error(`.ch() is 1-indexed (1..16) — '.ch(0)' is invalid; use .ch(1) for the first channel`);
    return new ControlPattern(
      this.getEvents,
      Math.max(0, Math.min(15, Math.floor(n) - 1)),
      true,
      this.segmentN,
      this.signalSource,
      this.restValue,
    );
  }

  chan(n: number): ControlPattern { return this.ch(n); }

  segment(n: number): ControlPattern {
    if (typeof n !== "number" || !(n >= 1)) throw new Error(`.segment() requires N >= 1`);
    if (n > MAX_SEGMENT) throw new Error(`.segment(): N must be <= ${MAX_SEGMENT}`);
    if (!this.signalSource) return this;
    const N = Math.max(1, Math.floor(n));
    const src = this.signalSource;
    return new ControlPattern(
      buildSignalGetEvents(src.ccPat, src.scaled, src.timeMap, N),
      this.channel,
      this.channelExplicit,
      N,
      src,
      this.restValue,
    );
  }

  rest(n: number): ControlPattern {
    if (typeof n !== "number" || !Number.isFinite(n) || Math.floor(n) !== n) {
      throw new Error(`.rest() requires an integer 0..127 (got ${n})`);
    }
    if (n < 0 || n > 127) throw new Error(`.rest() requires an integer 0..127 (got ${n})`);
    return new ControlPattern(
      this.getEvents,
      this.channel,
      this.channelExplicit,
      this.segmentN,
      this.signalSource,
      n,
    );
  }

  // ── Time scaling ──────────────────────────────────────────────────────
  // For signal sources, fast/slow compose a time map that scales source position
  // by n. Output is still segmentN samples per output cycle, evenly spaced — the
  // re-sampling rate stays high, so `slow 4 sine` is smooth, not stepped.
  fast(n: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const v = samplePatternable<number>(n, oc, ph);
        if (!(v > 0)) throw new Error(`.fast() requires positive number (got ${v})`);
        const t = (oc + ph) * v;
        const srcWhole = Math.floor(t);
        return prev(srcWhole, t - srcWhole);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) => {
          const v = samplePatternable<number>(n, cycleN, 0);
          if (!(v > 0)) throw new Error(`.fast() requires positive number (got ${v})`);
          return applyTimeScalePoint<ControlEvent>(v, cycleN, inner);
        });
      },
    );
  }

  slow(n: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const v = samplePatternable<number>(n, oc, ph);
        if (!(v > 0)) throw new Error(`.slow() requires positive number (got ${v})`);
        const t = (oc + ph) / v;
        const srcWhole = Math.floor(t);
        return prev(srcWhole, t - srcWhole);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) => {
          const v = samplePatternable<number>(n, cycleN, 0);
          if (!(v > 0)) throw new Error(`.slow() requires positive number (got ${v})`);
          return applyTimeScalePoint<ControlEvent>(1 / v, cycleN, inner);
        });
      },
    );
  }

  // ── Time reversal ─────────────────────────────────────────────────────
  // The mapped phase passes 1-ph (without mod) into the inner layer so a later
  // fast/slow time-map renormalizes it cleanly. Modding here would collapse
  // ph=0 to ph=0 (instead of phase-1 of the previous slot), creating a
  // discontinuity at the cycle boundary that breaks `inside(4, rev)` smoothness.
  rev(): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => prev(oc, 1 - ph),
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) =>
          inner(cycleN).map((ev) => ({ ...ev, start: (1 - ev.start) % 1 }))
            .sort((a, b) => a.start - b.start),
        );
      },
    );
  }

  palindrome(): ControlPattern { return ctrlCat([this, this.rev()]); }

  // ── Conditional transforms ────────────────────────────────────────────
  // every/whenmod/sometimesBy switch between the original and an altered branch
  // per cycle. If the altered branch is also a signal-source ControlPattern,
  // we keep both as signal carriers — but the runtime branch decision still
  // happens per cycle, so we render via the rendered getEvents of whichever
  // branch wins. This preserves smoothness when both branches are smooth.
  every(n: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.every() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.every() callback must return a ControlPattern`);
    }
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.withEvents((cycleN) => {
      const v = samplePatternable<number>(n, cycleN, 0);
      if (!(v >= 1)) throw new Error(`.every() requires N >= 1 (got ${v})`);
      const N = Math.max(1, Math.round(v));
      return cycleN % N === 0 ? altered(cycleN) : original(cycleN);
    });
  }

  whenmod(m: Patternable<number>, n: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.whenmod() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.whenmod() callback must return a ControlPattern`);
    }
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.withEvents((cycleN) => {
      const M = Math.max(1, Math.round(samplePatternable<number>(m, cycleN, 0)));
      const N = Math.max(0, Math.round(samplePatternable<number>(n, cycleN, 0)));
      return cycleN % M === N ? altered(cycleN) : original(cycleN);
    });
  }

  sometimesBy(prob: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.sometimesBy() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.sometimesBy() callback must return a ControlPattern`);
    }
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.withEvents((cycleN) => {
      const p = samplePatternable<number>(prob, cycleN, 0);
      if (!(p >= 0 && p <= 1)) throw new Error(`.sometimesBy() requires 0..1 (got ${p})`);
      return mulberry32Public(cycleN * 6997)() < p ? altered(cycleN) : original(cycleN);
    });
  }

  // ── Cycle-indexed combinators ─────────────────────────────────────────
  iter(n: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const v = samplePatternable<number>(n, oc, ph);
        if (!(v >= 1)) throw new Error(`.iter() requires N >= 1 (got ${v})`);
        const N = Math.max(1, Math.round(v));
        const shifted = (ph + (oc % N) / N) % 1;
        return prev(oc, shifted);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) => {
          const v = samplePatternable<number>(n, cycleN, 0);
          if (!(v >= 1)) throw new Error(`.iter() requires N >= 1 (got ${v})`);
          const N = Math.max(1, Math.round(v));
          const shift = -((cycleN % N) / N);
          return wrapShiftPoint<ControlEvent>(inner(cycleN), shift);
        });
      },
    );
  }

  chunk(n: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.chunk() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.chunk() callback must return a ControlPattern`);
    }
    const original = this.getEvents;
    const altered = transformed.getEvents;
    return this.withEvents((cycleN) => {
      const N = Math.max(1, Math.round(samplePatternable<number>(n, cycleN, 0)));
      const k = ((cycleN % N) + N) % N;
      const lo = k / N;
      const hi = (k + 1) / N;
      const out: ControlEvent[] = [];
      for (const ev of original(cycleN)) {
        if (ev.start < lo || ev.start >= hi) out.push(ev);
      }
      for (const ev of altered(cycleN)) {
        if (ev.start >= lo && ev.start < hi) out.push(ev);
      }
      return out.sort((a, b) => a.start - b.start);
    });
  }

  // ── Time-shift ────────────────────────────────────────────────────────
  early(t: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const shift = samplePatternable<number>(t, oc, ph);
        const total = oc + ph + shift;
        const w = Math.floor(total);
        return prev(w, total - w);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) =>
          wrapShiftPoint<ControlEvent>(inner(cycleN), -samplePatternable<number>(t, cycleN, 0)),
        );
      },
    );
  }

  late(t: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const shift = samplePatternable<number>(t, oc, ph);
        const total = oc + ph - shift;
        const w = Math.floor(total);
        return prev(w, total - w);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) =>
          wrapShiftPoint<ControlEvent>(inner(cycleN), samplePatternable<number>(t, cycleN, 0)),
        );
      },
    );
  }

  nudge(t: Patternable<number>): ControlPattern { return this.late(t); }

  // ── Windowing ─────────────────────────────────────────────────────────
  linger(n: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const v = samplePatternable<number>(n, oc, ph);
        if (!(v >= 1)) throw new Error(`.linger() requires N >= 1 (got ${v})`);
        const N = Math.max(1, Math.round(v));
        const slot = 1 / N;
        const inSlot = ph - Math.floor(ph / slot) * slot;
        return prev(oc, inSlot * N);
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) => {
          const v = samplePatternable<number>(n, cycleN, 0);
          if (!(v >= 1)) throw new Error(`.linger() requires N >= 1 (got ${v})`);
          const N = Math.max(1, Math.round(v));
          const slotWidth = 1 / N;
          // Take events from the first 1/N of the source.
          const slice = inner(cycleN).filter((ev) => ev.start < slotWidth);
          const out: ControlEvent[] = [];
          for (let k = 0; k < N; k++) {
            const offset = k / N;
            for (const ev of slice) {
              // Clip the event duration to fit within the slice window so its
              // tail doesn't overlap the next copy. ControlEvents are usually
              // point samples (no duration field) — in that case the spread
              // carries no duration and there's nothing to clip. When a
              // duration IS present (e.g. an event injected by an upstream
              // combinator), cap it to (slotWidth - ev.start), mirroring
              // Pattern.linger's behaviour exactly (see patterns.ts:551).
              const tail = slotWidth - ev.start;
              const copy: ControlEvent = { ...ev, start: offset + ev.start };
              if (ev.duration !== undefined) copy.duration = Math.min(ev.duration, tail);
              out.push(copy);
            }
          }
          return out.sort((a, b) => a.start - b.start);
        });
      },
    );
  }

  trunc(n: Patternable<number>): ControlPattern {
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const v = samplePatternable<number>(n, cycleN, 0);
      if (!(v > 0 && v <= 1)) throw new Error(`.trunc() requires 0 < N <= 1 (got ${v})`);
      return inner(cycleN).filter((ev) => ev.start < v);
    });
  }

  // zoom(a,b): output phase 0..1 maps to source phase a..b. For signal sources we
  // re-sample at segmentN within the zoomed window, so smoothness is preserved
  // even for a tight window like zoom(0.1, 0.2). For pattern/constant sources we
  // keep the discrete filter+remap behaviour.
  zoom(a: Patternable<number>, b: Patternable<number>): ControlPattern {
    return this.mapTime(
      (prev) => (oc, ph) => {
        const lo = samplePatternable<number>(a, oc, ph);
        const hi = samplePatternable<number>(b, oc, ph);
        if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.zoom() requires 0 <= a < b <= 1`);
        return prev(oc, lo + ph * (hi - lo));
      },
      () => {
        const inner = this.getEvents;
        return this.withEvents((cycleN) => {
          const lo = samplePatternable<number>(a, cycleN, 0);
          const hi = samplePatternable<number>(b, cycleN, 0);
          if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.zoom() requires 0 <= a < b <= 1`);
          const span = hi - lo;
          const out: ControlEvent[] = [];
          for (const ev of inner(cycleN)) {
            if (ev.start < lo || ev.start >= hi) continue;
            out.push({ ...ev, start: (ev.start - lo) / span });
          }
          return out;
        });
      },
    );
  }

  // compress(a,b): place the source signal into the sub-window [a, b]. For signal
  // sources we render segmentN samples confined to [a,b] (so sample density inside
  // the window matches the original full-cycle density). Pattern sources keep
  // their discrete remap.
  compress(a: Patternable<number>, b: Patternable<number>): ControlPattern {
    if (this.signalSource) {
      const src = this.signalSource;
      const prevMap = src.timeMap;
      const N = this.segmentN;
      const ccPat = src.ccPat;
      const scaled = src.scaled;
      const restValue = this.restValue;
      const channel = this.channel;
      const channelExplicit = this.channelExplicit;
      const newGetEvents = (cycleN: number): ControlEvent[] => {
        const lo = samplePatternable<number>(a, cycleN, 0);
        const hi = samplePatternable<number>(b, cycleN, 0);
        if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.compress() requires 0 <= a < b <= 1`);
        const span = hi - lo;
        const ccN = resolveCcNumber(ccPat, cycleN);
        const out: ControlEvent[] = [];
        for (let i = 0; i < N; i++) {
          const innerPh = i / N;
          const outPh = lo + innerPh * span;
          const mapped = prevMap(cycleN, innerPh);
          out.push({ start: outPh, cc: ccN, value: clampCc(scaled(mapped.srcCycle, mapped.srcPhase)) });
        }
        return out;
      };
      // compress is no longer a clean time-bijection on the full output cycle
      // (events are confined to [a,b]) — drop the signal carrier.
      return new ControlPattern(newGetEvents, channel, channelExplicit, N, null, restValue);
    }
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const lo = samplePatternable<number>(a, cycleN, 0);
      const hi = samplePatternable<number>(b, cycleN, 0);
      if (!(lo >= 0 && hi <= 1 && hi > lo)) throw new Error(`.compress() requires 0 <= a < b <= 1`);
      const span = hi - lo;
      return inner(cycleN).map((ev) => ({ ...ev, start: lo + ev.start * span }));
    });
  }

  off(t: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.off() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.off() callback must return a ControlPattern`);
    }
    const inner = this.getEvents;
    const altInner = transformed.getEvents;
    return this.withEvents((cycleN) => {
      const shift = samplePatternable<number>(t, cycleN, 0);
      const orig = inner(cycleN);
      const shifted = wrapShiftPoint<ControlEvent>(altInner(cycleN), shift);
      return [...orig, ...shifted].sort((a, b) => a.start - b.start);
    });
  }

  // ── Structural ────────────────────────────────────────────────────────
  mask(maskPat: Pattern | string): ControlPattern {
    const mp = typeof maskPat === "string" ? evalMaskString(maskPat) : maskPat;
    if (!(mp instanceof Pattern)) throw new Error(`.mask() requires a Pattern or string`);
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const maskEvents = mp.getEvents(cycleN);
      return inner(cycleN).filter((ev) =>
        maskEvents.some((m) => ev.start >= m.start && ev.start < m.start + m.duration),
      );
    });
  }

  // struct(p): use p's event timing as the rhythm structure; cycle this
  // ControlPattern's values through p's slots. Channel routing mirrors
  // Pattern.struct exactly: the source's per-event `channel` / `channelOffset`
  // are NOT carried into struct slots (a per-event channel attached to a source
  // slot's position in time has no meaningful relationship to the struct slot
  // it lands on under index-modulo cycling). If the struct event itself has
  // per-event channel routing, that wins. Otherwise the slot inherits the
  // outer ControlPattern.channel (set by `c1..c8` or a chained `.ch()`).
  struct(structPat: Pattern | string): ControlPattern {
    const sp = typeof structPat === "string" ? evalMaskString(structPat) : structPat;
    if (!(sp instanceof Pattern)) throw new Error(`.struct() requires a Pattern or string`);
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const structEvents = sp.getEvents(cycleN);
      const sourceEvents = inner(cycleN);
      if (sourceEvents.length === 0) return [];
      return structEvents.map((se, i) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { channel: _srcCh, channelOffset: _srcOff, ...src } = sourceEvents[i % sourceEvents.length];
        const out: ControlEvent = {
          ...src,
          start: se.start,
        };
        // Re-apply channel routing from the struct event (if it has any).
        if (se.channel !== undefined) out.channel = se.channel;
        if (se.channelOffset !== undefined) out.channelOffset = se.channelOffset;
        return out;
      });
    });
  }

  stutter(count: Patternable<number>, time: Patternable<number>): ControlPattern {
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const c = Math.max(1, Math.round(samplePatternable<number>(count, cycleN, 0)));
      const t = samplePatternable<number>(time, cycleN, 0);
      if (!(t >= 0)) throw new Error(`.stutter() requires non-negative time (got ${t})`);
      const out: ControlEvent[] = [];
      for (const ev of inner(cycleN)) {
        for (let k = 0; k < c; k++) {
          const start = ev.start + k * t;
          if (start >= 1) break;
          out.push({ ...ev, start });
        }
      }
      return out.sort((a, b) => a.start - b.start);
    });
  }

  inside(n: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.inside() requires a function`);
    return fn(this.slow(n)).fast(n);
  }

  outside(n: Patternable<number>, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof fn !== "function") throw new Error(`.outside() requires a function`);
    return fn(this.fast(n)).slow(n);
  }

  rot(n: Patternable<number>): ControlPattern {
    const inner = this.getEvents;
    return this.withEvents((cycleN) => {
      const events = inner(cycleN);
      if (events.length === 0) return [];
      const v = samplePatternable<number>(n, cycleN, 0);
      const k = ((Math.round(v) % events.length) + events.length) % events.length;
      if (k === 0) return events;
      const sorted = events.slice().sort((a, b) => a.start - b.start);
      return sorted.map((ev, i) => ({
        ...sorted[(i + k) % sorted.length],
        start: ev.start,
      }));
    });
  }

  // ── Probabilistic ─────────────────────────────────────────────────────
  // For a CC stream this means *occasionally drop a value* — leaves a gap in
  // the modulation curve. Seed namespace matches Pattern.degradeBy
  // (cycleN * 1009 + floor(slotStart * 1e6)) so that upstream filtering
  // (e.g. `.mask(...).degradeBy(...)`) can't reindex the per-slot draw, and
  // so degraded ctrl and degraded notes stay correlated at the same slot
  // start when the user wants that. See TOFIX #23.
  degradeBy(p: Patternable<number>): ControlPattern {
    const inner = this.getEvents;
    return this.withEvents((cycleN) => inner(cycleN).filter((ev) => {
      const prob = samplePatternable<number>(p, cycleN, ev.start);
      if (!(prob >= 0 && prob <= 1)) throw new Error(`.degradeBy() requires 0..1 (got ${prob})`);
      return mulberry32Public(cycleN * 1009 + Math.floor(ev.start * 1e6))() >= prob;
    }));
  }

  degrade(): ControlPattern { return this.degradeBy(0.5); }

  // ── jux ───────────────────────────────────────────────────────────────
  // Run `fn` on a copy of this control pattern, then route the original on
  // this.channel and the modified copy on `channel + offset` (default +1).
  // Uses the same channelOffset/channel-tagging machinery the scheduler reads
  // for note Patterns. Wrap mod 16 if offset pushes past channel 16.
  jux(fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    return this.juxBy(1, fn);
  }

  juxBy(offset: number, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof offset !== "number" || !Number.isFinite(offset)) throw new Error(`.juxBy() requires a number offset`);
    if (typeof fn !== "function") throw new Error(`.juxBy() requires a function`);
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.juxBy() callback must return a ControlPattern`);
    }
    // Wrap offset mod 16 so e.g. `juxBy(20, ...)` lands on +4 instead of
    // overflowing into clamped territory at scheduler time. The doc comment
    // above promises mod-16 behaviour; previously the raw offset was stored.
    const wrappedOffset = ((Math.trunc(offset) % 16) + 16) % 16;
    const tagged = new ControlPattern(
      (cycleN) => transformed.getEvents(cycleN).map((ev) => {
        if (ev.channel !== undefined || ev.channelOffset !== undefined) return ev;
        if (transformed.channelExplicit) return { ...ev, channel: transformed.channel };
        return { ...ev, channelOffset: wrappedOffset };
      }),
      transformed.channel,
      transformed.channelExplicit,
      transformed.segmentN,
      null,
      transformed.restValue,
    );
    return ctrlStack([this, tagged]);
  }

  juxTo(absChannel: number, fn: (p: ControlPattern) => ControlPattern): ControlPattern {
    if (typeof absChannel !== "number" || !Number.isFinite(absChannel)) throw new Error(`.juxTo() requires a channel number`);
    if (typeof fn !== "function") throw new Error(`.juxTo() requires a function`);
    const ch = Math.max(0, Math.min(15, Math.floor(absChannel) - 1));
    const transformed = fn(this);
    if (!(transformed instanceof ControlPattern)) {
      throw new Error(`.juxTo() callback must return a ControlPattern`);
    }
    const tagged = new ControlPattern(
      (cycleN) => transformed.getEvents(cycleN).map((ev) =>
        ev.channel === undefined ? { ...ev, channel: ch } : ev,
      ),
      transformed.channel,
      transformed.channelExplicit,
      transformed.segmentN,
      null,
      transformed.restValue,
    );
    return ctrlStack([this, tagged]);
  }
}

// Plant the brand on the prototype so [Symbol.hasInstance] above can recognize
// instances even when the class identity differs across bundles.
(ControlPattern.prototype as unknown as Record<string, unknown>)[CONTROL_PATTERN_BRAND] = true;

// Mask/struct patterns are interpreted purely for their event timing — the note
// names don't matter, only start/duration. We use a minimal local evaluator to
// avoid pulling in the n() Pattern constructor (circular import).
function evalMaskString(src: string): Pattern {
  return new Pattern(
    (cycleN) => evaluatePattern(src, cycleN).map((e) => ({
      start: e.start, duration: e.duration, name: e.name, velocity: 100,
    })),
    "notes", 0, false,
  );
}

// ── Multi-pattern combinators (ControlPattern) ─────────────────────────
function validateControlParts(parts: ControlPattern[], who: string): void {
  if (!Array.isArray(parts)) throw new Error(`${who}: requires an array`);
  if (parts.length === 0) throw new Error(`${who}: requires a non-empty array`);
  for (const p of parts) {
    if (!(p instanceof ControlPattern)) throw new Error(`${who}: all entries must be ControlPatterns`);
  }
}

// stack [ctrl 74 sine, ctrl 71 saw] — one orbit driving multiple CCs at once.
// Per-part .ch() carries through (events are tagged absolute), which lets the
// scheduler dedup correctly per (channel, cc).
export function ctrlStack(parts: ControlPattern[]): ControlPattern {
  validateControlParts(parts, "stack()");
  const channel = parts[0].channel;
  const channelExplicit = parts.every((p) => p.channelExplicit);
  // Carry through rest from the first part if any have one — replacing the
  // orbit with stack still respects an outer `# rest`. Inner parts' rests are
  // not separately addressable (one orbit, one rest) and so are dropped.
  const restValue = parts.find((p) => p.restValue !== null)?.restValue ?? null;
  return new ControlPattern(
    (cycleN) => {
      const out: ControlEvent[] = [];
      for (const p of parts) {
        for (const ev of p.getEvents(cycleN)) {
          if (p.channelExplicit && ev.channel === undefined && ev.channelOffset === undefined) {
            out.push({ ...ev, channel: p.channel });
          } else {
            out.push(ev);
          }
        }
      }
      return out.sort((a, b) => a.start - b.start);
    },
    channel,
    channelExplicit,
    parts[0].segmentN,
    null,
    restValue,
  );
}

export function ctrlCat(parts: ControlPattern[]): ControlPattern {
  validateControlParts(parts, "cat()");
  const channel = parts[0].channel;
  const channelExplicit = parts.every((p) => p.channelExplicit);
  const restValue = parts.find((p) => p.restValue !== null)?.restValue ?? null;
  return new ControlPattern(
    (cycleN) => {
      const idx = ((cycleN % parts.length) + parts.length) % parts.length;
      const p = parts[idx];
      return p.getEvents(cycleN).map((ev) =>
        p.channelExplicit && ev.channel === undefined && ev.channelOffset === undefined
          ? { ...ev, channel: p.channel }
          : ev,
      );
    },
    channel,
    channelExplicit,
    parts[0].segmentN,
    null,
    restValue,
  );
}

export function ctrlFastcat(parts: ControlPattern[]): ControlPattern {
  validateControlParts(parts, "fastcat()");
  const N = parts.length;
  const channel = parts[0].channel;
  const channelExplicit = parts.every((p) => p.channelExplicit);
  const restValue = parts.find((p) => p.restValue !== null)?.restValue ?? null;
  return new ControlPattern(
    (cycleN) => {
      const out: ControlEvent[] = [];
      for (let i = 0; i < N; i++) {
        const p = parts[i];
        const slotStart = i / N;
        const slotLen = 1 / N;
        for (const ev of p.getEvents(cycleN)) {
          const tagged: ControlEvent = p.channelExplicit && ev.channel === undefined && ev.channelOffset === undefined
            ? { ...ev, channel: p.channel, start: slotStart + ev.start * slotLen }
            : { ...ev, start: slotStart + ev.start * slotLen };
          out.push(tagged);
        }
      }
      return out.sort((a, b) => a.start - b.start);
    },
    channel,
    channelExplicit,
    parts[0].segmentN,
    null,
    restValue,
  );
}

// ── Construction helpers (unchanged) ───────────────────────────────────
function clampCc(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(127, Math.round(value)));
}

// Auto-scaling heuristic for `ctrl(cc, signal)` when the user passes a raw
// ContinuousSignal. We probe the signal at a small grid of (cycleN, phase)
// pairs and classify by observed value range:
//
//   max |v| > 1.5     → "already in CC range" — pass through unchanged
//                       (the user wrote their own scaling, e.g. `range(0, 127, ...)`,
//                       or fed a literal CC stream). Stretching this further would
//                       blow past 127 and clamp constantly.
//   min v < -1e-3     → bipolar [-1, 1] — remap to [0, 127] via (v+1)/2 * 127
//   otherwise         → unipolar [0, 1]  — scale to [0, 127] via v * 127
//
// Probes span both phase (within a cycle) AND multiple cycleN values so that
// time-stretched signals like `sine.slow(8)` (whose cycle-0 sample alone might
// look unipolar) are still classified correctly. Probes use NaN-safe checks;
// NaN/Infinity values are skipped rather than misclassifying the signal.
//
// Caveats:
//   - A signal that genuinely lives within [-1, 1] but happens to emit only
//     non-negative values at every probe will be classified as unipolar. Users
//     who need symmetric scaling should reach for `range2(-1, 1, signal)`
//     (or hand-write the formula) — auto-scale is convenience, not magic.
//   - The "already in CC range" branch triggers on absolute values above 1.5;
//     this means a unipolar signal that briefly exceeds 1.5 (rare for the
//     built-ins) would be left unscaled. The threshold is well above any of
//     lidal's built-in signals' natural maxima (1.0).
const AUTOSCALE_PHASE_PROBES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
const AUTOSCALE_CYCLE_PROBES = [0, 1, 2, 3, 7, 11];
const ALREADY_SCALED_THRESHOLD = 1.5;
const BIPOLAR_THRESHOLD = -1e-3;

type SignalShape = "alreadyScaled" | "bipolar" | "unipolar";

function classifySignal(sig: ContinuousSignal): SignalShape {
  let sawBipolar = false;
  let sawLarge = false;
  for (const c of AUTOSCALE_CYCLE_PROBES) {
    for (const ph of AUTOSCALE_PHASE_PROBES) {
      const v = sig(c, ph);
      if (!Number.isFinite(v)) continue;
      if (Math.abs(v) > ALREADY_SCALED_THRESHOLD) sawLarge = true;
      if (v < BIPOLAR_THRESHOLD) sawBipolar = true;
    }
  }
  if (sawLarge) return "alreadyScaled";
  if (sawBipolar) return "bipolar";
  return "unipolar";
}

// Visible for testing only — not part of the public surface.
export function detectBipolar(sig: ContinuousSignal): boolean {
  return classifySignal(sig) === "bipolar";
}

function autoScaleSignal(sig: ContinuousSignal): ContinuousSignal {
  const shape = classifySignal(sig);
  if (shape === "alreadyScaled") return sig;
  if (shape === "bipolar") return (c, ph) => ((sig(c, ph) + 1) / 2) * 127;
  return (c, ph) => sig(c, ph) * 127;
}

function resolveCcNumber(cc: Patternable<number>, cycleN: number): number {
  const v = samplePatternable<number>(cc, cycleN, 0);
  if (!Number.isFinite(v)) throw new Error(`ctrl(): cc must be a number (got ${v})`);
  const n = Math.round(v);
  if (n < 0 || n > 127) throw new Error(`ctrl(): cc must be 0..127 (got ${v})`);
  return n;
}

// Build the getEvents closure for a signal-sourced ControlPattern. Renders N
// evenly-spaced samples per output cycle, each looking up the source signal
// through the time map. This is the single point where time-map composition
// turns into actual sampling — every density transform routes here. Mapped
// phases are normalized to [0,1) and any whole part is folded into srcCycle so
// transforms like rev (which produces phase=1 at the cycle boundary) and
// composed time-maps (which can return any phase) sample correctly.
function buildSignalGetEvents(
  ccPat: Patternable<number>,
  scaled: ContinuousSignal,
  timeMap: TimeMap,
  N: number,
): (cycleN: number) => ControlEvent[] {
  return (cycleN: number): ControlEvent[] => {
    const ccN = resolveCcNumber(ccPat, cycleN);
    const out: ControlEvent[] = [];
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const mapped = timeMap(cycleN, ph);
      const wholeAdj = Math.floor(mapped.srcPhase);
      const normPhase = mapped.srcPhase - wholeAdj;
      const normCycle = mapped.srcCycle + wholeAdj;
      out.push({ start: ph, cc: ccN, value: clampCc(scaled(normCycle, normPhase)) });
    }
    return out;
  };
}

export function ctrl(cc: Patternable<number>, src: Patternable<number>): ControlPattern {
  if (cc === undefined || cc === null) throw new Error("ctrl(): cc number required");
  if (src === undefined || src === null) throw new Error("ctrl(): signal/value required");

  if (typeof cc === "number") {
    if (!Number.isFinite(cc) || cc < 0 || cc > 127 || Math.floor(cc) !== cc) {
      throw new Error(`ctrl(): cc must be an integer 0..127 (got ${cc})`);
    }
  }

  if (typeof src === "function") {
    return ctrlFromSignal(cc, src as ContinuousSignal, DEFAULT_SEGMENT);
  }
  if (typeof src === "number") {
    if (!Number.isFinite(src)) throw new Error(`ctrl(): value must be finite (got ${src})`);
    const v = clampCc(src);
    return new ControlPattern(
      (cycleN) => [{ start: 0, cc: resolveCcNumber(cc, cycleN), value: v }],
      0, false, 1, null,
    );
  }
  if (typeof src === "string" || src instanceof Pattern) {
    return ctrlFromPattern(cc, src);
  }
  throw new Error(`ctrl(): unsupported source type ${typeof src}`);
}

function ctrlFromSignal(cc: Patternable<number>, sig: ContinuousSignal, segN: number): ControlPattern {
  const N = Math.max(1, Math.min(MAX_SEGMENT, Math.floor(segN)));
  const scaled = autoScaleSignal(sig);
  const signalSource: SignalSource = {
    ccPat: cc,
    scaled,
    timeMap: IDENTITY_TIME_MAP,
  };
  return new ControlPattern(
    buildSignalGetEvents(cc, scaled, IDENTITY_TIME_MAP, N),
    0,
    false,
    N,
    signalSource,
  );
}

function ctrlFromPattern(cc: Patternable<number>, src: string | Pattern): ControlPattern {
  const isString = typeof src === "string";
  const getEvents = (cycleN: number): ControlEvent[] => {
    const ccN = resolveCcNumber(cc, cycleN);
    const events = isString
      ? evaluatePattern(src as string, cycleN)
      : (src as Pattern).getEvents(cycleN);
    return events.map((ev) => {
      const raw = parseFloat(ev.name);
      if (!Number.isFinite(raw)) {
        throw new Error(`ctrl(): non-numeric token '${ev.name}' in pattern`);
      }
      const offset = "offset" in ev && typeof (ev as { offset?: number }).offset === "number"
        ? (ev as { offset: number }).offset
        : 0;
      return { start: ev.start, cc: ccN, value: clampCc(raw + offset) };
    });
  };
  return new ControlPattern(getEvents, 0, false, 1, null);
}

// learn — transient slow triangle sweep on a CC, used for MIDI-map mode in Live.
export interface LearnOptions {
  cc: number;
  channel?: number;
  durationCycles?: number;
  segmentN?: number;
}

export function buildLearnPattern(opts: LearnOptions): ControlPattern {
  const { cc, channel = 1, durationCycles = 8, segmentN = 32 } = opts;
  if (typeof cc !== "number" || !Number.isFinite(cc) || cc < 0 || cc > 127 || Math.floor(cc) !== cc) {
    throw new Error(`learn(): cc must be an integer 0..127 (got ${cc})`);
  }
  if (typeof channel !== "number" || channel < 1 || channel > 16) {
    throw new Error(`learn(): channel must be 1..16 (got ${channel})`);
  }
  if (typeof durationCycles !== "number" || !(durationCycles >= 1)) {
    throw new Error(`learn(): durationCycles must be >= 1 (got ${durationCycles})`);
  }
  const N = Math.max(1, Math.min(MAX_SEGMENT, Math.floor(segmentN)));
  const D = Math.max(1, Math.floor(durationCycles));
  const getEvents = (cycleN: number): ControlEvent[] => {
    const out: ControlEvent[] = [];
    const phaseInSweep = (((cycleN % D) + D) % D) / D;
    for (let i = 0; i < N; i++) {
      const ph = i / N;
      const sweepPh = phaseInSweep + ph / D;
      const t = sweepPh < 0.5 ? sweepPh * 2 : (1 - sweepPh) * 2;
      out.push({ start: ph, cc, value: clampCc(t * 127) });
    }
    return out;
  };
  const chIdx = Math.max(0, Math.min(15, channel - 1));
  return new ControlPattern(getEvents, chIdx, true, N, null);
}

export interface LearnRequest {
  __lidalLearn: true;
  pattern: ControlPattern;
  durationCycles: number;
  cc: number;
}

export function learn(cc: number, channel: number = 1): LearnRequest {
  const pattern = buildLearnPattern({ cc, channel });
  return { __lidalLearn: true, pattern, durationCycles: 8, cc };
}
