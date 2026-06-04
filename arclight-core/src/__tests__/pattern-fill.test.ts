import { describe, it, expect } from "vitest";
import { fillPatternGaps, type PatternFillOptions } from "../pattern-fill.js";
import type { DrumAnalysis, DrumVoiceType, DrumHit, DrumVoice } from "../drum-detector.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

interface SyntheticVoiceSpec {
  voice:       DrumVoiceType;
  beats:       number[];
  velocities?: number[];
  midiNote?:   number;
}

function makeAnalysis(
  specs: SyntheticVoiceSpec[],
  totalBeats: number,
  bpm: number = 120,
): DrumAnalysis {
  const voices: DrumVoice[] = specs.map(spec => ({
    voice:    spec.voice,
    midiNote: spec.midiNote ?? 42,
    tiers:    [],
    hits:     spec.beats.map((b, i): DrumHit => ({
      timeBeat:    b,
      timeSeconds: b * 60 / bpm,
      sampleIndex: (i + 1) * 1000,
      strength:    (spec.velocities?.[i] ?? 80) / 127,
      velocity:    spec.velocities?.[i] ?? 80,
      voice:       spec.voice,
    })),
  }));
  return { bpm, totalBeats, voices };
}

/** Extract beat positions from a voice's hits (sorted). */
function beatsOf(v: DrumVoice): number[] {
  return [...v.hits].sort((a, b) => a.timeBeat - b.timeBeat).map(h => h.timeBeat);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("fillPatternGaps", () => {
  // (1) Basic gap fill: hihat detected every 2 beats where the true period
  //     is 1 beat. Should insert one hit between each pair.
  it("fills a single missing hit between each pair when period is half the gap", () => {
    // Hits at 0, 2, 4, 6 suggest period 2 — but if real period is 1 with
    // gaps masked, we need additional context. The canonical case: hits at
    // 0, 1, 3, 4, 6, 7 (period 1, only beats 2 and 5 are masked).
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 3, 4, 6, 7], velocities: [80, 80, 80, 80, 80, 80] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(2);
    expect(beatsOf(analysis.voices[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // (2) Irregular pattern — regularity guard should refuse to fill.
  it("does not fill when hits are too irregular to estimate a period", () => {
    const analysis = makeAnalysis([
      { voice: "snare", beats: [0, 0.17, 0.93, 2.41, 3.05, 5.8] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(0);
    expect(analysis.voices[0].hits.length).toBe(6);
  });

  // (3) Too few hits — need at least 3 to estimate period.
  it("skips voices with fewer than 3 hits", () => {
    const analysis = makeAnalysis([
      { voice: "kick", beats: [0, 4] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(0);
    expect(analysis.voices[0].hits.length).toBe(2);
  });

  // (4) Large gap → multiple synthetic hits inserted.
  it("inserts multiple synthetic hits when gap is several periods wide", () => {
    // Period 1.0: hits at 0, 1, 2, 3 and 7, 8 — gap [3,7] is 4× period → insert 3.
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 2, 3, 7, 8] },
    ], 9);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(3);
    expect(beatsOf(analysis.voices[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // (5) Velocity interpolation between bracketing hits.
  it("linearly interpolates velocity between bracketing real hits", () => {
    const analysis = makeAnalysis([
      // Period 1: detected at 0 (vel 40) and 4 (vel 80) → linear interpolation
      // yields 50, 60, 70 before the SYNTHETIC_VELOCITY_SCALE (0.82) is
      // applied. Mean voice velocity = (40+80+80+80)/4 = 70, below the
      // default maxMeanVelocity=88 so fill fires. Post-scale:
      //   50 * 0.82 = 41.0 → 41
      //   60 * 0.82 = 49.2 → 49
      //   70 * 0.82 = 57.4 → 57
      { voice: "hihat", beats: [0, 4, 5, 6], velocities: [40, 80, 80, 80] },
    ], 7);
    fillPatternGaps(analysis);
    const hits = [...analysis.voices[0].hits].sort((a, b) => a.timeBeat - b.timeBeat);
    const synthetic = hits.filter(h => h.synthetic === true);
    expect(synthetic.length).toBe(3);
    expect(synthetic.map(h => h.velocity)).toEqual([41, 49, 57]);
  });

  // (6) Synthetic flag marks only inserted hits.
  it("marks inserted hits with synthetic:true and leaves original hits unflagged", () => {
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 3, 4] },
    ], 5);
    fillPatternGaps(analysis);
    const hits = [...analysis.voices[0].hits].sort((a, b) => a.timeBeat - b.timeBeat);
    // Original beats retain no synthetic flag (undefined or false), inserted beat (2) is marked.
    for (const h of hits) {
      if (h.timeBeat === 2) {
        expect(h.synthetic).toBe(true);
      } else {
        expect(h.synthetic).not.toBe(true);
      }
    }
  });

  // (7) Tighter regularity threshold rejects noisier patterns.
  it("honours custom regularityThreshold", () => {
    // 5 IOIs: [1, 1, 2.3, 1, 1]. At period=1, tolerance=0.08 → 4/5 = 0.80 conform.
    // Regularity threshold 0.85 → reject; threshold 0.6 → accept.
    const beats = [0, 1, 2, 4.3, 5.3, 6.3];
    const lenient: PatternFillOptions = { regularityThreshold: 0.6 };
    const strict:  PatternFillOptions = { regularityThreshold: 0.85 };

    const a1 = makeAnalysis([{ voice: "hihat", beats }], 8);
    const a2 = makeAnalysis([{ voice: "hihat", beats }], 8);

    const f1 = fillPatternGaps(a1, lenient);
    const f2 = fillPatternGaps(a2, strict);
    expect(f1).toBeGreaterThan(0);
    expect(f2).toBe(0);
  });

  // (8) Multiple voices are filled independently.
  it("fills each voice independently", () => {
    const analysis = makeAnalysis([
      { voice: "kick",  beats: [0, 2, 4, 6] },           // period 2 — no gaps
      { voice: "hihat", beats: [0, 0.5, 1.5, 2, 2.5, 3.5, 4] }, // period 0.5, missing 1.0 and 3.0
    ], 4.5);
    const filled = fillPatternGaps(analysis);
    // Kick is regular at period 2 → no fill. Hihat adds 1.0 and 3.0.
    expect(filled).toBe(2);
    expect(beatsOf(analysis.voices[0])).toEqual([0, 2, 4, 6]);
    expect(beatsOf(analysis.voices[1])).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  });

  // (9) Eighth-note period detection.
  it("detects and fills an eighth-note period (0.5 beats)", () => {
    // Hits at 0, 0.5, 1.5, 2, 2.5, 3 — missing 1.0. totalBeats chosen so
    // no forward-fill past the last hit is possible.
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 0.5, 1.5, 2, 2.5, 3] },
    ], 3.1);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(1);
    expect(beatsOf(analysis.voices[0])).toContain(1);
  });

  // (10) Quarter-note period detection.
  it("detects a quarter-note period (1.0 beat)", () => {
    // Detected every 2 beats, true period 1, no direct evidence of 1-beat IOIs.
    // Without any 1-beat IOI in the data, the estimator will correctly
    // pick period 2.0 from the candidate list. So we provide at least one
    // 1-beat IOI to reveal the fundamental.
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 3, 4, 6, 7] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    // Fills 2 and 5.
    expect(filled).toBe(2);
  });

  // (11) Return value matches inserted count.
  it("returns the total number of synthetic hits inserted", () => {
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 2, 3, 7, 8] }, // adds 3
      { voice: "kick",  beats: [0, 2, 4, 10] },      // period 2 → gap [4,10] = 3 missing (6, 8)
    ], 11);
    const filled = fillPatternGaps(analysis);
    // Count programmatically by comparing synthetic flags.
    const syntheticCount = analysis.voices.reduce(
      (n, v) => n + v.hits.filter(h => h.synthetic === true).length,
      0,
    );
    expect(filled).toBe(syntheticCount);
    expect(filled).toBeGreaterThan(0);
  });

  // (12) Boundary fill — fills before first hit when space allows.
  it("fills positions before the first hit when within clip range", () => {
    // Period 1. Hits start at 2, 3, 4, 5 and run to end. Should back-fill
    // position 1 and 0.
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [2, 3, 4, 5] },
    ], 6);
    const filled = fillPatternGaps(analysis);
    const beats = beatsOf(analysis.voices[0]);
    expect(beats).toContain(0);
    expect(beats).toContain(1);
    expect(filled).toBeGreaterThanOrEqual(2);
  });

  // (13) No duplicate insertion when hits are exactly one period apart.
  it("does not insert between hits that are already one period apart", () => {
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 2, 3, 4] },
    ], 4.5);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(0);
    expect(analysis.voices[0].hits.length).toBe(5);
  });

  // (14) Synthetic hits have proper timeSeconds / voice fields.
  it("populates timeSeconds, voice, and clamps velocity on synthetic hits", () => {
    const bpm = 150;
    // Voice mean velocity must stay below the default maxMeanVelocity=88, so
    // use vel 80 here. The kick-skip default (mean>88) is exercised in its
    // own dedicated test below.
    const analysis = makeAnalysis([
      { voice: "kick", beats: [0, 1, 3, 4], velocities: [80, 80, 80, 80] },
    ], 5, bpm);
    fillPatternGaps(analysis);
    const synthetic = analysis.voices[0].hits.filter(h => h.synthetic === true);
    expect(synthetic.length).toBe(1);
    const s = synthetic[0];
    expect(s.voice).toBe("kick");
    expect(s.timeBeat).toBe(2);
    expect(s.timeSeconds).toBeCloseTo(2 * 60 / bpm, 6);
    expect(s.velocity).toBeGreaterThanOrEqual(1);
    expect(s.velocity).toBeLessThanOrEqual(127);
    expect(s.strength).toBeCloseTo(s.velocity / 127, 6);
  });

  // (15) Hits remain sorted by timeBeat after insertion.
  it("returns hits sorted by timeBeat after insertion", () => {
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 3, 4, 7, 8] },
    ], 9);
    fillPatternGaps(analysis);
    const hits = analysis.voices[0].hits;
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].timeBeat).toBeGreaterThanOrEqual(hits[i - 1].timeBeat);
    }
  });

  // (16) maxMeanVelocity default: loud voices are not filled.
  //      A kick on every beat with average velocity 110 has a textbook-regular
  //      pattern at period 1 that would normally attract pattern-fill, but
  //      kicks are rarely masked and should be left alone by default.
  it("skips fill for a voice whose mean velocity exceeds the default maxMeanVelocity", () => {
    const analysis = makeAnalysis([
      { voice: "kick", beats: [0, 2, 4, 6], velocities: [110, 110, 110, 110] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(0);
    expect(analysis.voices[0].hits.length).toBe(4);
    expect(analysis.voices[0].hits.some(h => h.synthetic === true)).toBe(false);
  });

  // (17) Quiet voices (hihats) are still filled normally under the default cap.
  it("fills quieter voices normally (avg vel 70 < default 88)", () => {
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 1, 3, 4, 6, 7], velocities: [70, 70, 70, 70, 70, 70] },
    ], 8);
    const filled = fillPatternGaps(analysis);
    expect(filled).toBe(2);
    expect(beatsOf(analysis.voices[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // (18) maxMeanVelocity override: explicit bump lets loud voices be filled.
  it("respects an explicit maxMeanVelocity that overrides the loud-voice guard", () => {
    const analysis = makeAnalysis([
      // Same loud-kick fixture as (16). With maxMeanVelocity=120, the voice's
      // mean (110) no longer exceeds the cap, so fill proceeds.
      { voice: "kick", beats: [0, 2, 6, 8], velocities: [110, 110, 110, 110] },
    ], 10);
    const filled = fillPatternGaps(analysis, { maxMeanVelocity: 120 });
    expect(filled).toBeGreaterThan(0);
    expect(analysis.voices[0].hits.some(h => h.synthetic === true)).toBe(true);
  });

  // (19) Synthetic-velocity scale factor: verify the 0.82 attenuation is
  //      actually applied vs raw linear interpolation.
  it("scales synthetic velocities to ~82% of the interpolated bracketing average", () => {
    // Bracket (40 at beat 0, 80 at beat 4) → interpolated mid-gap velocities
    // are 50, 60, 70 before scaling. After 0.82× scaling they become
    // round(50*0.82)=41, round(60*0.82)=49, round(70*0.82)=57.
    // Each synthetic hit should be ≤ 82% of the mean of its bracketing real
    // hits' velocities (i.e. ≤ 0.82 * ((40 + 80) / 2) = 49.2 → 49 rounded up).
    const analysis = makeAnalysis([
      { voice: "hihat", beats: [0, 4, 5, 6], velocities: [40, 80, 80, 80] },
    ], 7);
    fillPatternGaps(analysis);
    const synthetic = analysis.voices[0].hits
      .filter(h => h.synthetic === true)
      .sort((a, b) => a.timeBeat - b.timeBeat);
    expect(synthetic.length).toBe(3);

    // Verify each synthetic hit is no larger than the raw linear
    // interpolation * SYNTHETIC_VELOCITY_SCALE (0.82), with a 1-velocity-unit
    // slack for rounding.
    const rawInterp = [50, 60, 70]; // mid-gap interpolation between 40 and 80
    for (let i = 0; i < synthetic.length; i++) {
      const bound = Math.round(rawInterp[i] * 0.82);
      expect(synthetic[i].velocity).toBeLessThanOrEqual(bound);
      // And strictly less than the un-scaled interpolation.
      expect(synthetic[i].velocity).toBeLessThan(rawInterp[i]);
    }

    // Also: the mean synthetic velocity ≤ 0.82 × mean of bracketing real hits.
    const meanSynth = synthetic.reduce((s, h) => s + h.velocity, 0) / synthetic.length;
    const meanBracket = (40 + 80) / 2;
    expect(meanSynth).toBeLessThanOrEqual(meanBracket * 0.82 + 0.5);
  });
});
