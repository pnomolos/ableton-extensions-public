// Focused regression tests for the [PAT] subsystem fixes from TOFIX.md.
// Each describe block corresponds to one finding so failures point straight
// at the matching item in the doc.

import { describe, it, expect } from "vitest";
import { n, s, stack, sine, sine2, saw, slowSignal, mulberry32Public } from "../../src/patterns.ts";
import { ctrl, ControlPattern, detectBipolar } from "../../src/control.ts";
import { expectEventsMatch } from "./helpers.mjs";

// ──────────────────────────────────────────────────────────────────────
// #5 — ControlPattern auto-scaling
//
// Behaviour we settled on (documented in control.ts autoScaleSignal):
//   * "Already-scaled" signals (max |v| > 1.5 anywhere on the probe grid)
//     are passed through unchanged — no further *127 multiplication.
//   * Bipolar [-1, 1] signals are remapped to [0, 127] via (v+1)/2 * 127.
//   * Unipolar [0, 1] signals are scaled to [0, 127] via v * 127.
//   * Probes span multiple cycleN values so a time-stretched bipolar signal
//     (e.g. sine.slow(8)) is still classified bipolar at cycleN=0.
// ──────────────────────────────────────────────────────────────────────
describe("#5 ControlPattern auto-scaling", () => {
  it("detects bipolar signal across multiple cycleN values (sine.slow(8))", () => {
    const stretched = slowSignal(8, sine2);
    expect(detectBipolar(stretched)).toBe(true);
  });

  it("does NOT re-scale a signal already emitting in CC range (0..127)", () => {
    // A user-built signal that emits raw CC values. The prior heuristic would
    // multiply by 127 and clamp to 127 every sample.
    const ccSig = (_c, ph) => 64 + 32 * Math.sin(2 * Math.PI * ph); // ~[32, 96]
    const cp = ctrl(74, ccSig);
    const events = cp.getEvents(0);
    // The signal hits ~96 at phase 0.25 — without the fix this would clamp to 127.
    // With the fix the value is passed through and rounded to ~96.
    const peak = events.reduce((m, e) => Math.max(m, e.value), 0);
    expect(peak).toBeGreaterThan(80);
    expect(peak).toBeLessThan(110);
  });

  it("does NOT re-scale a signal emitting in 0..100 range", () => {
    const ccSig = (_c, ph) => 50 + 50 * ((Math.sin(2 * Math.PI * ph) + 1) / 2); // ~[50, 100]
    const cp = ctrl(74, ccSig);
    const peak = cp.getEvents(0).reduce((m, e) => Math.max(m, e.value), 0);
    // Without the heuristic, 100 * 127 → clamped to 127.
    expect(peak).toBeGreaterThan(80);
    expect(peak).toBeLessThan(110);
  });

  it("still scales a unipolar [0,1] signal up to [0,127]", () => {
    const cp = ctrl(74, sine);
    const events = cp.getEvents(0);
    const peak = events.reduce((m, e) => Math.max(m, e.value), 0);
    // sine peaks at 1.0 → 127 after *127.
    expect(peak).toBeGreaterThanOrEqual(120);
    expect(peak).toBeLessThanOrEqual(127);
  });

  it("still maps a bipolar [-1,1] signal to [0,127]", () => {
    const cp = ctrl(74, sine2);
    const events = cp.getEvents(0);
    const peak = events.reduce((m, e) => Math.max(m, e.value), 0);
    const trough = events.reduce((m, e) => Math.min(m, e.value), 127);
    expect(peak).toBeGreaterThanOrEqual(120);
    expect(trough).toBeLessThanOrEqual(7);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #16 — linger clips per-copy duration to slot width
// ──────────────────────────────────────────────────────────────────────
describe("#16 linger duration clipping", () => {
  it("linger(4) on a single full-cycle event clips dur to 1/4 per copy", () => {
    const events = n("a").linger(4).getEvents(0);
    expect(events.length).toBe(4);
    for (const ev of events) {
      // Each copy should fit inside its 1/4 slot — no overlap.
      expect(ev.duration).toBeCloseTo(1 / 4, 9);
    }
    // Starts at 0, 1/4, 1/2, 3/4.
    expectEventsMatch(events, [
      { start: 0,   duration: 1/4, name: "a" },
      { start: 1/4, duration: 1/4, name: "a" },
      { start: 1/2, duration: 1/4, name: "a" },
      { start: 3/4, duration: 1/4, name: "a" },
    ]);
  });

  it("linger(2) preserves intra-slot durations when source events fit", () => {
    // Source has 4 evenly-spaced events of dur 1/4. First half (start<1/2)
    // contains events at 0 (dur 1/4) and 1/4 (dur 1/4). Each fits inside the
    // 1/2-width slot, so durations are unchanged.
    const events = n("a b c d").linger(2).getEvents(0);
    expect(events.length).toBe(4);
    for (const ev of events) expect(ev.duration).toBeCloseTo(1/4, 9);
  });

  // ControlPattern.linger had a parity drift relative to Pattern.linger:
  // ControlEvents are point samples by default (no duration), but if an upstream
  // combinator injects a duration field, the spread inside linger's discrete
  // branch carried it through unchanged — so a full-cycle event passed through
  // linger(4) emitted four copies with duration 1.0, bleeding past slot
  // boundaries. The fix clips the per-copy duration to (slotWidth - ev.start),
  // mirroring patterns.ts:551 exactly.
  it("ControlPattern.linger clips duration to slot width when source events carry duration", () => {
    // Build a ControlPattern whose getEvents emits a single full-cycle event
    // with duration=1.0. We bypass the ctrl() constructors (which strip
    // duration) and instantiate ControlPattern directly.
    const getEvents = () => [{ start: 0, cc: 74, value: 64, duration: 1.0 }];
    const cp = new ControlPattern(getEvents, 0, false, 1, null, null);

    const events = cp.linger(4).getEvents(0);
    expect(events.length).toBe(4);
    // Each copy must fit inside its 1/4 slot — no bleed.
    for (const ev of events) {
      expect(ev.duration).toBeCloseTo(1/4, 9);
    }
    // Starts at 0, 1/4, 1/2, 3/4.
    const starts = events.map((e) => Math.round(e.start * 1e6) / 1e6);
    expect(starts).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it("ControlPattern.linger leaves duration undefined for point-sample events", () => {
    // Regression: standard ctrl(...) output has no duration field. linger must
    // not invent one (which would change downstream behaviour).
    const cp = ctrl(74, "10 20 30 40"); // 4 point events on starts 0, 1/4, 1/2, 3/4
    const events = cp.linger(2).getEvents(0);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.duration).toBeUndefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// #21 — arp("updown") on 2-note groups
// ──────────────────────────────────────────────────────────────────────
describe("#21 arp(\"updown\") with length 2", () => {
  it("emits low, high, low (three slots) for a 2-note chord", () => {
    // Two simultaneous events at start=0; arp partitions duration into N slots.
    const chord = stack([n("60"), n("64")]); // C, E at the same time
    const events = chord.arp("updown").getEvents(0);
    // updown for [60, 64] should be [60, 64, 60] — three slots of 1/3.
    expect(events.length).toBe(3);
    expect(events.map((e) => e.name)).toEqual(["60", "64", "60"]);
    for (const ev of events) expect(ev.duration).toBeCloseTo(1/3, 9);
  });

  it("matches up direction for length 1 (degenerate)", () => {
    const events = n("60").arp("updown").getEvents(0);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("60");
  });

  it("emits low, mid, high, mid for a 3-note chord (regression check)", () => {
    const chord = stack([n("60"), n("64"), n("67")]);
    const events = chord.arp("updown").getEvents(0);
    expect(events.map((e) => e.name)).toEqual(["60", "64", "67", "64"]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #22 — mask/struct channel inheritance
//
// Behaviour we settled on:
//   * `mask` passes source events through unchanged — including any per-event
//     channel/channelOffset they carried in. Mask is a filter, not a rewrite.
//   * `struct` rebuilds events by re-timing source values onto struct slots.
//     The source's per-event channel/channelOffset is INTENTIONALLY DROPPED;
//     routing comes from the struct event (if it has its own channel/offset)
//     or, failing that, the outer Pattern.channel (set by d1..d16 / .ch()).
//
// Rationale: a per-event channel on a source event is associated with that
// source slot's *position in time*. When struct cycles through source events
// by index modulo source-length, that position is meaningless at the new
// slot, so carrying the channel would leak stale routing.
// ──────────────────────────────────────────────────────────────────────
describe("#22 mask/struct channel inheritance", () => {
  it("struct drops source per-event channel from stacked .ch() parts", () => {
    // Stack-with-.ch() tags events with explicit channel.
    const sourceStack = stack([n("60"), n("64").ch(5)]); // 64 events tagged ch=4
    const events = sourceStack.struct("1 1 1 1").getEvents(0);
    // No struct slot should inherit ch=4 from the source.
    for (const ev of events) {
      expect(ev.channel).toBeUndefined();
      expect(ev.channelOffset).toBeUndefined();
    }
  });

  it("struct picks up channel from the struct pattern itself when present", () => {
    // Struct pattern's events come from a stack with explicit .ch() — those
    // per-event channels DO get applied to the resulting slots.
    const sourceStack = stack([n("60"), n("64").ch(5)]);
    const structPat = stack([n("x").ch(7), n("x").ch(8)]);
    const events = sourceStack.struct(structPat).getEvents(0);
    // The struct pattern's per-event channels (6 and 7 in 0-idx) should drive routing.
    const chans = new Set(events.map((e) => e.channel));
    expect(chans.has(6)).toBe(true);
    expect(chans.has(7)).toBe(true);
    // None should leak the source-side ch 4.
    expect(chans.has(4)).toBe(false);
  });

  it("mask passes source events through unchanged (channel preserved)", () => {
    const sourceStack = stack([n("60"), n("64").ch(5)]);
    const events = sourceStack.mask("x x").getEvents(0);
    // 64-event should still carry channel=4 (inherited at stack time).
    const sixtyFour = events.find((e) => e.name === "64");
    expect(sixtyFour).toBeDefined();
    expect(sixtyFour.channel).toBe(4);
  });

  // The original #22 fix only touched Pattern.struct; ControlPattern.struct
  // still spread `{ ...sourceEvents[i % len], start: se.start }` — carrying
  // the source event's channel/channelOffset positionally. After the
  // follow-up fix, ControlPattern.struct destructures channel/channelOffset
  // out of the source event and re-applies only from the struct event,
  // matching Pattern.struct exactly (patterns.ts:671-680).
  it("ControlPattern.struct drops source per-event channel", () => {
    // Build a source ControlPattern whose events carry channel=4 directly.
    // We construct it manually so we have explicit control of the channel
    // tag — ctrl()'s constructors don't normally attach channel to events.
    const sourceGetEvents = () => [
      { start: 0,   cc: 74, value: 10, channel: 4 },
      { start: 0.5, cc: 74, value: 20, channel: 4 },
    ];
    const source = new ControlPattern(sourceGetEvents, 0, false, 1, null, null);

    // Struct pattern with no per-event channel routing — slots should fall
    // through to the outer ControlPattern.channel (undefined here, meaning
    // the scheduler later applies the orbit default).
    const events = source.struct("1 0 1").getEvents(0);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      // Pre-fix: ev.channel === 4 (leaked from source). Post-fix: undefined.
      expect(ev.channel).toBeUndefined();
      expect(ev.channelOffset).toBeUndefined();
    }
  });

  it("ControlPattern.struct takes channel from the struct pattern when present", () => {
    // Source has its own channel=4 per event. Struct pattern's events carry
    // channel=7 (1-idx → 0-idx 6). The struct event's channel should win.
    const sourceGetEvents = () => [
      { start: 0,   cc: 74, value: 10, channel: 4 },
      { start: 0.5, cc: 74, value: 20, channel: 4 },
    ];
    const source = new ControlPattern(sourceGetEvents, 0, false, 1, null, null);

    // struct pattern from a stack with .ch(7) — its events carry channel=6 (0-idx).
    const structPat = stack([n("x").ch(7), n("x").ch(7)]);
    const events = source.struct(structPat).getEvents(0);
    expect(events.length).toBeGreaterThan(0);
    const chans = new Set(events.map((e) => e.channel));
    // Struct's channel wins.
    expect(chans.has(6)).toBe(true);
    // None should leak the source-side ch 4.
    expect(chans.has(4)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #23 — degradeBy seeds on slot identity (event start), not array index
// ──────────────────────────────────────────────────────────────────────
describe("#23 degradeBy slot-stable seed", () => {
  it("degradeBy is stable for a given (cycleN, slot start) — no array-index shift", () => {
    // Construct a pattern, then degrade it. The seed for each event must be
    // anchored to that event's `start`, not its array position, so that any
    // upstream filtering can't reindex the random stream.
    const base = s("bd bd bd bd"); // 4 events at starts 0, 0.25, 0.5, 0.75
    const seed = (cycleN, ev) => cycleN * 1009 + Math.floor(ev.start * 1e6);

    // For prob=0.5, the keep/drop decision for the event at start=0.5 must
    // match mulberry32(seed(c, evAt0.5))() >= 0.5, regardless of how many
    // earlier events were dropped.
    for (let c = 0; c < 20; c++) {
      const filtered = base.degradeBy(0.5).getEvents(c);
      for (const ev of filtered) {
        const r = mulberry32Public(seed(c, ev))();
        // Event survived → its random draw was >= 0.5.
        expect(r).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it("two patterns differing only in upstream filter share per-slot draws", () => {
    // The "upstream filter" here is a simple .mask() that drops some slots.
    // For slots that survive both, degradeBy's decision should be identical.
    // (Pre-fix, the masked pattern's degradeBy would reindex.)
    const base = s("bd bd bd bd");
    const masked = base.mask("x ~ x x"); // keeps slots 0, 2, 3 (starts 0, 0.5, 0.75)

    const baseDegraded = base.degradeBy(0.5);
    const maskedDegraded = masked.degradeBy(0.5);

    for (let c = 0; c < 30; c++) {
      const baseEvents = baseDegraded.getEvents(c);
      const maskedEvents = maskedDegraded.getEvents(c);

      // For each surviving masked event, find the equivalent base event by start;
      // both must agree on whether it survived (since the seed depends only on
      // cycleN and start now).
      const baseStarts = new Set(baseEvents.map((e) => Math.round(e.start * 1e6)));
      for (const ev of maskedEvents) {
        const key = Math.round(ev.start * 1e6);
        expect(baseStarts.has(key)).toBe(true);
      }
    }
  });

  // The original PAT fix only touched Pattern.degradeBy; ControlPattern carried
  // a duplicated implementation that still seeded on the filter callback's
  // array index `i`. After the follow-up fix, ControlPattern.degradeBy uses the
  // same slot-stable seed (cycleN * 1009 + floor(start * 1e6)), so upstream
  // filtering that reindexes events no longer perturbs the per-slot draw.
  it("ControlPattern.degradeBy is slot-stable across upstream filters", () => {
    // Use a low segment count so we get a manageable number of CC events.
    const base    = ctrl(74, sine).segment(8);
    const masked  = ctrl(74, sine).segment(8).mask("x ~ x x x ~ x x");

    const baseDegraded   = base.degradeBy(0.5);
    const maskedDegraded = masked.degradeBy(0.5);

    for (let c = 0; c < 20; c++) {
      const baseEvents   = baseDegraded.getEvents(c);
      const maskedEvents = maskedDegraded.getEvents(c);

      // Every event that survived in the masked stream must also have survived
      // in the base stream at the same slot start. Pre-fix this would flake
      // because masked events would be reindexed and seeded differently.
      const baseStarts = new Set(baseEvents.map((e) => Math.round(e.start * 1e6)));
      for (const ev of maskedEvents) {
        const key = Math.round(ev.start * 1e6);
        expect(baseStarts.has(key)).toBe(true);
      }
    }
  });

  it("ControlPattern.degradeBy keep/drop matches mulberry32(cycleN*1009 + floor(start*1e6))", () => {
    // Direct seed-formula check: every surviving event must have drawn r >= 0.5.
    const cp = ctrl(74, sine).segment(8).degradeBy(0.5);
    for (let c = 0; c < 20; c++) {
      const events = cp.getEvents(c);
      for (const ev of events) {
        const seed = c * 1009 + Math.floor(ev.start * 1e6);
        const r = mulberry32Public(seed)();
        expect(r).toBeGreaterThanOrEqual(0.5);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Smaller — juxBy wraps mod 16
// ──────────────────────────────────────────────────────────────────────
describe("juxBy wraps offset mod 16", () => {
  it("juxBy(20) on a note pattern tags channelOffset=4 (20 mod 16)", () => {
    const events = n("a").juxBy(20, (p) => p).getEvents(0);
    const tagged = events.find((e) => e.channelOffset === 4);
    expect(tagged).toBeDefined();
    // The raw 20 must not be stored.
    expect(events.find((e) => e.channelOffset === 20)).toBeUndefined();
  });

  it("juxBy(-1) tags channelOffset=15 (wrapped)", () => {
    const events = n("a").juxBy(-1, (p) => p).getEvents(0);
    const tagged = events.find((e) => e.channelOffset === 15);
    expect(tagged).toBeDefined();
    expect(events.find((e) => e.channelOffset === -1)).toBeUndefined();
  });

  it("ControlPattern.juxBy wraps offset mod 16 too", () => {
    const cp = ctrl(74, sine).juxBy(20, (p) => p);
    const events = cp.getEvents(0);
    const tagged = events.find((e) => e.channelOffset === 4);
    expect(tagged).toBeDefined();
    expect(events.find((e) => e.channelOffset === 20)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Smaller — Pattern.ch(0) and ControlPattern.ch(0) reject
// ──────────────────────────────────────────────────────────────────────
describe(".ch(0) is rejected as a 1-indexing typo", () => {
  it("Pattern.ch(0) throws", () => {
    expect(() => n("a").ch(0)).toThrow(/1-indexed/);
  });

  it("ControlPattern.ch(0) throws", () => {
    expect(() => ctrl(74, sine).ch(0)).toThrow(/1-indexed/);
  });

  it("Pattern.ch(1) still works (first channel, 0-indexed internally)", () => {
    expect(n("a").ch(1).channel).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Smaller — applyFast renamed to applyTimeScale; smoke test that slow()
// still works (regression guard for the rename touching both fast/slow)
// ──────────────────────────────────────────────────────────────────────
describe("time-scale engine (applyTimeScale)", () => {
  it("fast(2) and slow(2) both flow through the renamed helper", () => {
    const fastEvents = n("a b c d").fast(2).getEvents(0);
    expect(fastEvents.length).toBe(8);
    const slowEvents = n("a b c d").slow(2).getEvents(0);
    // slow(2) shows half the source events per host cycle (2 of the 4).
    expect(slowEvents.length).toBe(2);
  });
});
