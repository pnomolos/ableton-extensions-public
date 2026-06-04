import { describe, it, expect } from "vitest";
import {
  planChainsForVoice,
  pickTierForVelocity,
  buildClipNotes,
} from "../drum-rack-builder.js";
import type { DrumAnalysis, VelocityTier } from "@arclight/core";

// ── planChainsForVoice ────────────────────────────────────────────────────────

describe("planChainsForVoice", () => {
  it("3 tiers × 1 sample each → 3 entries at baseNote, baseNote+1, baseNote+2", () => {
    const tiers: VelocityTier[] = [
      { velMin: 1,  velMax: 42,  samples: [{ filePath: "/a.wav", strength: 0.3 }] },
      { velMin: 43, velMax: 84,  samples: [{ filePath: "/b.wav", strength: 0.6 }] },
      { velMin: 85, velMax: 127, samples: [{ filePath: "/c.wav", strength: 0.9 }] },
    ];
    const result = planChainsForVoice("kick", tiers, 36);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ tierIndex: 0, midiNote: 36, filePath: "/a.wav" });
    expect(result[1]).toMatchObject({ tierIndex: 1, midiNote: 37, filePath: "/b.wav" });
    expect(result[2]).toMatchObject({ tierIndex: 2, midiNote: 38, filePath: "/c.wav" });
  });

  it("2 tiers, tier 0 has 1 sample, tier 1 has 2 samples → 2 entries (first sample per tier)", () => {
    const tiers: VelocityTier[] = [
      { velMin: 1,  velMax: 63,  samples: [{ filePath: "/a.wav", strength: 0.4 }] },
      { velMin: 64, velMax: 127, samples: [
        { filePath: "/b1.wav", strength: 0.7 },
        { filePath: "/b2.wav", strength: 0.8 },
      ]},
    ];
    const result = planChainsForVoice("snare", tiers, 36);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ tierIndex: 0, midiNote: 36, filePath: "/a.wav" });
    // Only b1.wav (index 0, most representative) — b2.wav is unused until SDK exposes multi-sample Simpler
    expect(result[1]).toMatchObject({ tierIndex: 1, midiNote: 37, filePath: "/b1.wav" });
  });

  it("1 tier × 1 sample → 1 entry at baseNote", () => {
    const tiers: VelocityTier[] = [
      { velMin: 1, velMax: 127, samples: [{ filePath: "/x.wav", strength: 0.5 }] },
    ];
    const result = planChainsForVoice("hihat", tiers, 44);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tierIndex: 0, midiNote: 44 });
  });

  it("empty tiers array → empty result", () => {
    const result = planChainsForVoice("kick", [], 36);
    expect(result).toHaveLength(0);
  });

  it("tier with 0 samples is skipped; tierIndex still increments correctly for subsequent non-empty tiers", () => {
    const tiers: VelocityTier[] = [
      { velMin: 1,  velMax: 42,  samples: [] },
      { velMin: 43, velMax: 84,  samples: [{ filePath: "/b.wav", strength: 0.6 }] },
      { velMin: 85, velMax: 127, samples: [{ filePath: "/c.wav", strength: 0.9 }] },
    ];
    const result = planChainsForVoice("kick", tiers, 36);
    // First non-empty tier is tier at index 1 → assigned tierIndex 0, midiNote 36
    // Second non-empty tier is tier at index 2 → assigned tierIndex 1, midiNote 37
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ tierIndex: 0, midiNote: 36, filePath: "/b.wav" });
    expect(result[1]).toMatchObject({ tierIndex: 1, midiNote: 37, filePath: "/c.wav" });
  });
});

// ── pickTierForVelocity ───────────────────────────────────────────────────────

const STANDARD_TIERS: VelocityTier[] = [
  { velMin: 1,  velMax: 42,  samples: [] },
  { velMin: 43, velMax: 84,  samples: [] },
  { velMin: 85, velMax: 127, samples: [] },
];

describe("pickTierForVelocity", () => {
  it("velocity 20 → tier 0", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 20)).toBe(0);
  });

  it("velocity 60 → tier 1", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 60)).toBe(1);
  });

  it("velocity 100 → tier 2", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 100)).toBe(2);
  });

  it("boundary: 42 → tier 0", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 42)).toBe(0);
  });

  it("boundary: 43 → tier 1", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 43)).toBe(1);
  });

  it("boundary: 84 → tier 1", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 84)).toBe(1);
  });

  it("boundary: 85 → tier 2", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 85)).toBe(2);
  });

  it("velocity 0 → tier 0 (clamp below)", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 0)).toBe(0);
  });

  it("velocity 128 → tier 2 (clamp above)", () => {
    expect(pickTierForVelocity(STANDARD_TIERS, 128)).toBe(2);
  });

  it("single tier → always returns 0", () => {
    const single: VelocityTier[] = [{ velMin: 1, velMax: 127, samples: [] }];
    expect(pickTierForVelocity(single, 1)).toBe(0);
    expect(pickTierForVelocity(single, 64)).toBe(0);
    expect(pickTierForVelocity(single, 127)).toBe(0);
  });
});

// ── buildClipNotes ────────────────────────────────────────────────────────────

function makeAnalysis(
  voice: "kick" | "snare" | "hihat",
  tiers: VelocityTier[],
  velocities: number[],
): DrumAnalysis {
  const hits = velocities.map((velocity, i) => ({
    timeSeconds: i * 0.5,
    timeBeat: i * 1.0,
    sampleIndex: i * 22050,
    strength: velocity / 127,
    velocity,
    voice: voice as "kick" | "snare" | "hihat",
  }));
  return {
    voices: [{ voice, midiNote: 36, tiers, hits }],
    bpm: 120,
    totalBeats: velocities.length,
  };
}

const THREE_TIER_SAMPLES: VelocityTier[] = [
  { velMin: 1,  velMax: 42,  samples: [{ filePath: "/a.wav", strength: 0.3 }] },
  { velMin: 43, velMax: 84,  samples: [{ filePath: "/b.wav", strength: 0.6 }] },
  { velMin: 85, velMax: 127, samples: [{ filePath: "/c.wav", strength: 0.9 }] },
];

describe("buildClipNotes", () => {
  it("single voice with 3 tiers, hits at velocities [20, 60, 100] → pitches [36, 37, 38]", () => {
    const analysis = makeAnalysis("kick", THREE_TIER_SAMPLES, [20, 60, 100]);
    const notes = buildClipNotes(analysis, { kick: 36, snare: 40, hihat: 44 }, { kick: 0.5, snare: 0.5, hihat: 0.25 });

    expect(notes).toHaveLength(3);
    expect(notes[0].pitch).toBe(36);  // velocity 20 → tier 0 → baseNote + 0
    expect(notes[1].pitch).toBe(37);  // velocity 60 → tier 1 → baseNote + 1
    expect(notes[2].pitch).toBe(38);  // velocity 100 → tier 2 → baseNote + 2
  });

  it("preserves hit.velocity in output note.velocity", () => {
    const analysis = makeAnalysis("kick", THREE_TIER_SAMPLES, [20, 60, 100]);
    const notes = buildClipNotes(analysis, { kick: 36, snare: 40, hihat: 44 }, { kick: 0.5, snare: 0.5, hihat: 0.25 });

    expect(notes[0].velocity).toBe(20);
    expect(notes[1].velocity).toBe(60);
    expect(notes[2].velocity).toBe(100);
  });

  it("uses correct VOICE_NOTE_DURATION per voice", () => {
    const analysis = makeAnalysis("hihat", THREE_TIER_SAMPLES, [60]);
    const notes = buildClipNotes(analysis, { kick: 36, snare: 40, hihat: 44 }, { kick: 0.5, snare: 0.5, hihat: 0.25 });

    expect(notes).toHaveLength(1);
    expect(notes[0].duration).toBe(0.25);
  });

  it("voice not in voiceBasePitch → filtered out (no notes emitted)", () => {
    const analysis = makeAnalysis("kick", THREE_TIER_SAMPLES, [60, 80]);
    // Pass an empty voiceBasePitch so kick is not included
    const notes = buildClipNotes(analysis, {}, { kick: 0.5 });

    expect(notes).toHaveLength(0);
  });

  it("uses hit.timeBeat as startTime", () => {
    const analysis = makeAnalysis("snare", THREE_TIER_SAMPLES, [64, 100]);
    const notes = buildClipNotes(analysis, { kick: 36, snare: 40, hihat: 44 }, { kick: 0.5, snare: 0.5, hihat: 0.25 });

    expect(notes[0].startTime).toBe(0);   // first hit at timeBeat 0
    expect(notes[1].startTime).toBe(1.0); // second hit at timeBeat 1.0
  });
});
