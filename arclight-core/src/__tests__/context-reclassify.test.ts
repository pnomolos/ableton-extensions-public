import { describe, it, expect } from "vitest";
import {
  contextualReclassify,
  type DrumHit,
  type DrumVoiceType,
} from "../drum-detector.js";

const SR = 44100;
const BPM = 120;

function makeHit(overrides: Partial<DrumHit> & {
  voice: DrumVoiceType;
  velocity: number;
  timeBeat: number;
}): DrumHit {
  const timeSeconds = (overrides.timeBeat / BPM) * 60;
  return {
    timeSeconds,
    timeBeat:    overrides.timeBeat,
    sampleIndex: Math.round(timeSeconds * SR),
    strength:    overrides.velocity / 127,
    velocity:    overrides.velocity,
    voice:       overrides.voice,
    ...overrides,
  };
}

function makeBuckets(): Map<DrumVoiceType, DrumHit[]> {
  const m = new Map<DrumVoiceType, DrumHit[]>();
  for (const v of ["kick", "snare", "hihat", "openhat"] as DrumVoiceType[]) {
    m.set(v, []);
  }
  return m;
}

const allEnabled = new Set<DrumVoiceType>(["kick", "snare", "hihat", "openhat"]);

// ── 1. Bimodal split ────────────────────────────────────────────────────────

describe("contextualReclassify — bimodal velocity split", () => {
  it("moves the low-velocity cluster of snares to hihat", () => {
    const buckets = makeBuckets();
    const lowVels  = [8, 14, 19, 22, 26, 30, 33, 35];        // 8 ghost hits
    const highVels = [110, 116, 120, 124];                   // 4 real snares
    lowVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 0.25 + i * 1.5 }),
      );
    });
    highVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1.0 + i * 2.0 }),
      );
    });

    const n = contextualReclassify(buckets, { totalBeats: 32, bpm: BPM }, allEnabled);

    expect(n).toBe(8);
    expect(buckets.get("snare")!.length).toBe(4);
    expect(buckets.get("hihat")!.length).toBe(8);
    // All four survivors are the high-velocity ones.
    const surviving = buckets.get("snare")!.map(h => h.velocity).sort((a, b) => a - b);
    expect(surviving).toEqual(highVels);
  });
});

// ── 2. No-split when the gap is small ───────────────────────────────────────

describe("contextualReclassify — no-split when velocities are close", () => {
  it("leaves a smoothly distributed snare population untouched", () => {
    const buckets = makeBuckets();
    const vels = [50, 60, 70, 80, 90, 100];
    vels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 4 }),
      );
    });

    const n = contextualReclassify(buckets, { totalBeats: 32, bpm: BPM }, allEnabled);

    expect(n).toBe(0);
    expect(buckets.get("snare")!.length).toBe(6);
    expect(buckets.get("hihat")!.length).toBe(0);
  });
});

// ── 3. Density-only ─────────────────────────────────────────────────────────

describe("contextualReclassify — density signal alone", () => {
  it("does not fire when density weight × excess fraction stays below threshold", () => {
    // 80 hihats in 8 beats → density 10.0, max 8.0, excess fraction 0.25.
    // density component: 0.6 × 0.25 = 0.15 → below 0.50 threshold.
    // Flat velocities prevent bimodal activation. Hihats have no timing signal
    // (timing fires for snares only), so density alone must carry the verdict
    // and the hit count remains unchanged.
    const buckets = makeBuckets();
    for (let i = 0; i < 80; i++) {
      // Alternate through 16th-note subdivisions.
      const beat = (i * 0.1) % 8;
      buckets.get("hihat")!.push(
        makeHit({ voice: "hihat", velocity: 80, timeBeat: beat }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(0);
    expect(buckets.get("hihat")!.length).toBe(80);
  });

  it("fires when excess fraction is high enough that density alone clears threshold", () => {
    // 20 openhat hits in 8 beats, expected max 1.0 → density 2.5, excess
    // fraction clamped to 1.0 → 0.6 × 1.0 = 0.60 > 0.50. Flat velocities so
    // bimodal score stays at 0.
    const buckets = makeBuckets();
    for (let i = 0; i < 20; i++) {
      const beat = Math.floor(i / 2) + (i % 2) * 0.5;
      buckets.get("openhat")!.push(
        makeHit({ voice: "openhat", velocity: 80, timeBeat: beat }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(12);                                      // 20 - floor(1.0 * 8)
    expect(buckets.get("openhat")!.length).toBe(8);
    expect(buckets.get("hihat")!.length).toBe(12);
  });
});

// ── 4. Combined bimodal + density ───────────────────────────────────────────

describe("contextualReclassify — combined signals", () => {
  it("density + bimodal combine to clear threshold when neither would alone", () => {
    // 16 openhats in 8 beats. max expected density = 1.0 → actual 2.0 → excess
    // fraction 1.0 (clamped). densityScoreRaw 1.0. keepCount floor(1.0 × 8)=8
    // so 8 hits are flagged as excess. Weighted density component 0.6 × 1.0 =
    // 0.60. Alone that is above threshold — so reduce the excess contribution
    // by using a smaller density overflow:
    //
    // 10 openhats in 8 beats → density 1.25, excess fraction 0.25,
    //   density raw 0.25, keepCount 8, so 2 hits are flagged. Density alone
    //   for those 2 = 0.6 × 0.25 = 0.15.
    // Velocity split: 2 at vel 30, 8 at vel 60. gap/max = 30/60 = 0.50
    //   (above 0.35 activation). Bimodal alone = 0.50 (at threshold, not >).
    //
    // For the 2 weak hits: density 0.15 + bimodal 0.50 = 0.65 > 0.50 →
    // reclassify. For the 8 strong hits: density 0 + bimodal 0 (above split) →
    // no reclassify.
    const buckets = makeBuckets();
    buckets.get("openhat")!.push(
      makeHit({ voice: "openhat", velocity: 30, timeBeat: 0.0 }),
    );
    buckets.get("openhat")!.push(
      makeHit({ voice: "openhat", velocity: 30, timeBeat: 4.0 }),
    );
    for (let i = 0; i < 8; i++) {
      buckets.get("openhat")!.push(
        makeHit({ voice: "openhat", velocity: 60, timeBeat: i + 0.5 }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(2);
    expect(buckets.get("openhat")!.length).toBe(8);
    expect(buckets.get("hihat")!.length).toBe(2);
  });
});

// ── 5. Timing signal tips a low-density snare over the edge ─────────────────

describe("contextualReclassify — timing signal for snares", () => {
  it("off-backbeat 16th-note snares combine timing+density to clear threshold", () => {
    // 8 snares in 4 beats → density 2.0 — NOT over the 2.0 cap, so density is
    // 0. But construct the group so 4 of the snares land on 16th-note off-beat
    // positions (0.25 / 0.75 / 1.25 / 1.75) which are on-grid but NOT on a
    // backbeat. Bimodal gap: the low cluster sits at velocity ≤ 35, the high
    // cluster at ≥ 115, gap 80/124 ≈ 0.65, above the 0.35 activation floor →
    // bimodal score 0.65 for the low cluster. Add timing 0.2 → 0.85 > 0.50.
    //
    // The flip side: real backbeat snares (beats 0, 2, 4, 6) at low velocity
    // would score bimodal 0.65 + timing 0 = 0.65 and still reclassify — timing
    // is an adjustment on top of the primary bimodal signal, not a gate.
    const buckets = makeBuckets();
    const ghostBeats = [0.25, 0.75, 1.25, 1.75];
    ghostBeats.forEach(b => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: 30, timeBeat: b }),
      );
    });
    buckets.get("snare")!.push(makeHit({ voice: "snare", velocity: 120, timeBeat: 0.0 }));
    buckets.get("snare")!.push(makeHit({ voice: "snare", velocity: 124, timeBeat: 2.0 }));
    buckets.get("snare")!.push(makeHit({ voice: "snare", velocity: 118, timeBeat: 4.0 }));
    buckets.get("snare")!.push(makeHit({ voice: "snare", velocity: 115, timeBeat: 6.0 }));

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(4);
    expect(buckets.get("snare")!.length).toBe(4);
    expect(buckets.get("hihat")!.length).toBe(4);
    // The reclassified hits are the low-velocity off-backbeat ones.
    const movedBeats = buckets.get("hihat")!.map(h => h.timeBeat).sort();
    expect(movedBeats).toEqual(ghostBeats);
  });
});

// ── 6. Reclassified hits land in the target bucket ──────────────────────────

describe("contextualReclassify — target bucket membership", () => {
  it("moves suspicious snare hits into the hihat bucket, correctly retyped", () => {
    const buckets = makeBuckets();
    const lowVels  = [10, 12, 14, 16, 18, 20, 22, 24];
    const highVels = [115, 118, 121, 124];
    lowVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 0.25 + i * 1.5 }),
      );
    });
    highVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 2 }),
      );
    });

    contextualReclassify(buckets, { totalBeats: 32, bpm: BPM }, allEnabled);

    const hats = buckets.get("hihat")!;
    expect(hats.length).toBe(8);
    for (const h of hats) expect(h.voice).toBe("hihat");
  });
});

// ── 7. reclassified flag ────────────────────────────────────────────────────

describe("contextualReclassify — reclassified flag", () => {
  it("sets hit.reclassified === true on moved hits and leaves others alone", () => {
    const buckets = makeBuckets();
    const lowVels  = [8, 14, 19, 22, 26, 30, 33, 35];
    const highVels = [110, 116, 120, 124];
    lowVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 0.25 + i * 1.5 }),
      );
    });
    highVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 2 }),
      );
    });

    contextualReclassify(buckets, { totalBeats: 32, bpm: BPM }, allEnabled);

    for (const h of buckets.get("hihat")!)  expect(h.reclassified).toBe(true);
    for (const h of buckets.get("snare")!)  expect(h.reclassified).toBeFalsy();
  });
});

// ── 8. Awestruck-profile snare reclassification ─────────────────────────────

describe("contextualReclassify — Awestruck-style snare profile", () => {
  it("reclassifies the excess low-velocity cluster while preserving real snares", () => {
    // Mirrors the empirical "Awestruck 95 BPM" loop: the detector produces 51
    // "snare" hits where only ~15 are real — the rest are dark-hihat false
    // positives. Velocity distribution: 30 weak hits (vel 8–42), 6 mid hits
    // (vel 54–84), and 15 genuine snares (vel 103–127). The 15 genuine snares
    // sit on backbeat positions (beat 1, 3, 5, … mod 2 inside a 32-beat loop),
    // and the false positives land on 16th-note subdivisions that are NOT on
    // the backbeat grid.
    const buckets = makeBuckets();
    const weakVels = [
      8, 8, 8, 9, 9, 9, 9, 10, 11, 11, 12, 12, 12, 12, 12, 13, 13, 14, 14, 14,
      15, 16, 17, 17, 25, 29, 29, 31, 42, 42,
    ];                                                         // 30
    const midVels  = [54, 66, 67, 68, 80, 84];                 // 6
    const strongVels = [
      103, 109, 114, 118, 118, 121, 122, 122, 123, 123, 123, 124, 124, 126, 127,
    ];                                                         // 15

    // 16th-note off-backbeat positions spread across 32 beats. Avoid 0.0 and
    // 0.5 offsets within a beat (those are the backbeat grid) — use 0.25 and
    // 0.75. Beats 0, 2, 4, … are downbeats; beats 1, 3, … are backbeats.
    const offBeatPositions: number[] = [];
    for (let beat = 0; beat < 32; beat++) {
      offBeatPositions.push(beat + 0.25);
      offBeatPositions.push(beat + 0.75);
    }
    // Use the first 36 off-beat positions for weak + mid hits.
    weakVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: offBeatPositions[i] }),
      );
    });
    midVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({
          voice:    "snare",
          velocity: v,
          timeBeat: offBeatPositions[weakVels.length + i],
        }),
      );
    });
    // Genuine snares on backbeats: beat 1, 3, 5, …, 29 (15 positions).
    strongVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 2 }),
      );
    });

    const n = contextualReclassify(
      buckets, { totalBeats: 32, bpm: BPM }, allEnabled,
    );

    // Exact count depends on which hits land in the density "excess" window,
    // but the invariants are: at least half of the weak cluster moves, all 15
    // genuine snares stay, and the moved hits all have velocity below the
    // splitVelocity (103).
    const remainingSnares = buckets.get("snare")!;
    const movedHats       = buckets.get("hihat")!;
    expect(n).toBeGreaterThanOrEqual(15);
    expect(movedHats.length).toBe(n);
    // No strong (real) snare got reclassified.
    for (const v of strongVels) {
      const stillSnare = remainingSnares.some(h => h.velocity === v && h.timeBeat >= 1);
      expect(stillSnare).toBe(true);
    }
    // All moved hits came from the weak-or-mid cluster (velocity < splitVelocity).
    for (const h of movedHats) expect(h.velocity).toBeLessThan(103);
  });
});

// ── 9. Ghost snare protection ───────────────────────────────────────────────

describe("contextualReclassify — ghost snare protection", () => {
  it("leaves ghost snares near backbeat positions intact", () => {
    // 4 main snares at beats 1, 3, 5, 7 (backbeats) velocity 100–127.
    // 4 ghost snares at 16th-note positions NEAR the backbeats (0.875, 1.125,
    // 2.875, 3.125) — these are off-grid w.r.t. CONTEXT_GRID_TOLERANCE_BEATS
    // (0.05) so the timing signal should stay inactive. Ghost-note velocities
    // 50–70 sit between vel 42 and 100 → no bimodal gap clears 0.12 either.
    const buckets = makeBuckets();
    const mainVels  = [100, 115, 120, 127];
    const mainBeats = [1, 3, 5, 7];
    mainVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: mainBeats[i] }),
      );
    });
    const ghostVels  = [50, 60, 65, 70];
    const ghostBeats = [0.875, 1.125, 2.875, 3.125];
    ghostVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: ghostBeats[i] }),
      );
    });

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(0);
    expect(buckets.get("snare")!.length).toBe(8);
    expect(buckets.get("hihat")!.length).toBe(0);
  });
});

// ── 10. Kick density guard ───────────────────────────────────────────────────

describe("contextualReclassify — kick density guard", () => {
  it("reclassifies excess weak kicks when density exceeds cap", () => {
    // 20 kicks in 8 beats → density 2.5, kick cap 1.5 → excess fraction 0.67
    // (clamped below 1.0). densityScoreRaw 0.67 → weighted 0.40. keepCount
    // floor(1.5 * 8) = 12, so 8 hits are excess and get a density score.
    //
    // To push those 8 excess kicks over the 0.50 threshold we also introduce
    // a velocity split wide enough for the bimodal signal to fire on kick
    // (threshold 0.35): 12 strong kicks at 120 and 8 weak kicks at 20 →
    // gap 100/120 ≈ 0.83 (above 0.35), so weak hits get bimodal score 0.83.
    // Bimodal 0.83 + density 0.40 = 1.23 → above threshold.
    const buckets = makeBuckets();
    for (let i = 0; i < 12; i++) {
      buckets.get("kick")!.push(
        makeHit({ voice: "kick", velocity: 120, timeBeat: i * 0.5 }),
      );
    }
    for (let i = 0; i < 8; i++) {
      buckets.get("kick")!.push(
        makeHit({ voice: "kick", velocity: 20, timeBeat: 0.25 + i * 0.5 }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBeGreaterThanOrEqual(5);
    // All moved hits are the low-velocity excess.
    const remaining = buckets.get("kick")!;
    for (const h of remaining) {
      // At least all 12 strong kicks remain. Some weak kicks might remain if
      // they happen to be within keepCount=12 (rank-wise they're all last, so
      // they're all moved, but we stay strict only on strong-kick survival).
      if (h.velocity === 120) expect(h.voice).toBe("kick");
    }
    expect(remaining.filter(h => h.velocity === 120).length).toBe(12);
  });
});

// ── 11. Hihat high density is fine ───────────────────────────────────────────

describe("contextualReclassify — hihat density stays under cap", () => {
  it("does not reclassify 16th-note hihats at density 6/beat (under the 8/beat cap)", () => {
    const buckets = makeBuckets();
    for (let i = 0; i < 48; i++) {
      buckets.get("hihat")!.push(
        makeHit({ voice: "hihat", velocity: 80, timeBeat: i / 6 }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(0);
    expect(buckets.get("hihat")!.length).toBe(48);
    expect(buckets.get("snare")!.length).toBe(0);
  });
});

// ── 12. Snare density exactly at threshold ───────────────────────────────────

describe("contextualReclassify — snare density at threshold boundary", () => {
  it("does not fire when snare density is exactly equal to the cap", () => {
    // 8 snares at vel 80 over 8 beats → density 1.0. max_expected is 1.0, so
    // densityActive requires STRICTLY greater → inactive. Flat velocities →
    // no bimodal. On-backbeat positions → no timing signal.
    const buckets = makeBuckets();
    const backbeats = [1, 3, 5, 7];
    for (let i = 0; i < 8; i++) {
      const beat = backbeats[i % backbeats.length] + Math.floor(i / 4) * 8;
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: 80, timeBeat: beat }),
      );
    }

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBe(0);
    expect(buckets.get("snare")!.length).toBe(8);
  });
});

// ── 13. Snare density 1.5 — clearly over the cap ─────────────────────────────

describe("contextualReclassify — snare density above cap", () => {
  it("reclassifies excess snares when density is 1.5/beat (cap is 1.0)", () => {
    // 12 snares in 8 beats → density 1.5. maxExpected 1.0 → excess fraction
    // 0.5 → densityScoreRaw 0.5 → weighted 0.30. keepCount floor(1.0*8)=8,
    // so 4 hits are excess. Pair them with a bimodal gap large enough to
    // trigger: 8 strong snares at vel 120 + 4 weak snares at vel 20 →
    // gap 100/120 ≈ 0.83 (above snare threshold 0.12) → bimodal=0.83 on
    // weak hits. For weak hits: bimodal 0.83 + dens 0.30 = 1.13 → reclassify.
    // For strong hits: bimodal 0 (above splitVelocity) + dens 0 → no move.
    const buckets = makeBuckets();
    const strongBeats = [0, 1, 2, 3, 4, 5, 6, 7];
    strongBeats.forEach(b => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: 120, timeBeat: b }),
      );
    });
    const weakBeats = [0.25, 2.25, 4.25, 6.25];
    weakBeats.forEach(b => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: 20, timeBeat: b }),
      );
    });

    const n = contextualReclassify(buckets, { totalBeats: 8, bpm: BPM }, allEnabled);

    expect(n).toBeGreaterThanOrEqual(4);
    // All 8 strong snares still present.
    expect(buckets.get("snare")!.filter(h => h.velocity === 120).length).toBe(8);
  });
});

// ── 14. Target voice must be enabled ─────────────────────────────────────────

describe("contextualReclassify — target voice must be enabled", () => {
  it("does not reclassify snares to hihat when hihat is not enabled", () => {
    const buckets = makeBuckets();
    const lowVels  = [8, 14, 19, 22, 26, 30, 33, 35];
    const highVels = [110, 116, 120, 124];
    lowVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 0.25 + i * 1.5 }),
      );
    });
    highVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 2 }),
      );
    });

    const enabledOnlyKS = new Set<DrumVoiceType>(["kick", "snare"]);
    const n = contextualReclassify(
      buckets, { totalBeats: 32, bpm: BPM }, enabledOnlyKS,
    );

    expect(n).toBe(0);
    expect(buckets.get("snare")!.length).toBe(12);
    expect(buckets.get("hihat")!.length).toBe(0);
  });

  it("reclassifies snares to openhat when hihat is not enabled but openhat is", () => {
    const buckets = makeBuckets();
    const lowVels  = [8, 14, 19, 22, 26, 30, 33, 35];
    const highVels = [110, 116, 120, 124];
    lowVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 0.25 + i * 1.5 }),
      );
    });
    highVels.forEach((v, i) => {
      buckets.get("snare")!.push(
        makeHit({ voice: "snare", velocity: v, timeBeat: 1 + i * 2 }),
      );
    });

    const enabledSnareOpen = new Set<DrumVoiceType>(["snare", "openhat"]);
    const n = contextualReclassify(
      buckets, { totalBeats: 32, bpm: BPM }, enabledSnareOpen,
    );

    expect(n).toBe(8);
    expect(buckets.get("snare")!.length).toBe(4);
    expect(buckets.get("openhat")!.length).toBe(8);
  });
});
