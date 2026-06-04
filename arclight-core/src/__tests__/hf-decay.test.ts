/**
 * Tests for the HF temporal-decay feature (hfDecayRatio) added to
 * `computeDrumFeatures` and used by `classifyDrumVoiceEx` to discriminate
 * dark vintage hihats from thin snares.
 *
 * Covers three layers:
 *   1. Synthetic audio → verifies the raw ratio matches expected ranges for
 *      fast-decaying, sustained, and silent-late-window inputs.
 *   2. Real BWB one-shots → verifies the feature is computed on realistic
 *      material and that the HF-sustain classifier rule doesn't misfire on
 *      known-good snares.
 *   3. Real Awestruck extracted samples → locks in the behaviour the feature
 *      was designed to improve (the "dark hihat misclassified as snare" case
 *      now routes to hihat, while the true snare stays a snare).
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import {
  computeDrumFeatures,
  classifyDrumVoice,
} from "../drum-detector.js";
import { parseAudio, detectTransientsSuperFlux } from "../transient-detector.js";

/**
 * Run onset detection on a one-shot WAV and compute features anchored at the
 * real attack. `detectDrumVoices` does this shift internally; tests mirror it
 * so the feature window spans the transient instead of landing in pre-attack
 * silence/bleed. The `- 512` matches `ONSET_DETECTOR_HALF_WINDOW` in
 * drum-detector.ts: the SuperFlux sampleIndex points at the frame CENTER,
 * half a window past the attack.
 */
function featuresAtFirstOnset(path: string) {
  const wav = parseAudio(path);
  const transients = detectTransientsSuperFlux(wav, {
    bpm:           120,
    threshold:     0.16,
    windowSize:    1024,
    hopSize:       256,
    minGapSeconds: 0.04,
  });
  if (transients.length === 0) {
    // Fall back to t=0 if no transient was detected (very quiet / short clip).
    return computeDrumFeatures(wav.samples, wav.sampleRate, 0);
  }
  const idx = Math.max(0, transients[0].sampleIndex - 512);
  return computeDrumFeatures(wav.samples, wav.sampleRate, idx);
}

const SR = 44100;

// ── Synthetic audio helpers ─────────────────────────────────────────────────

/** Fast-decaying HF (snare-like): white-noise burst for first 15 ms, silent
 *  after. We seed Math.random indirectly by running a deterministic number of
 *  calls per element — Vitest does not need exact reproducibility here, but we
 *  avoid flakiness by keeping amplitudes well above the silence floor. */
function makeSnapAudio(sampleRate: number, durationSamples: number): Float32Array {
  const snap = Math.round(0.015 * sampleRate);
  const s = new Float32Array(durationSamples);
  for (let i = 0; i < snap; i++) s[i] = (Math.random() * 2 - 1) * 0.8;
  return s;
}

/** Snap audio with a tiny residual HF tail so the late window has non-zero
 *  energy — otherwise the ratio is NaN rather than a large finite number. */
function makeSnapWithResidualAudio(
  sampleRate:      number,
  durationSamples: number,
): Float32Array {
  const snap = Math.round(0.015 * sampleRate);
  const s = new Float32Array(durationSamples);
  for (let i = 0; i < snap; i++) s[i]      = (Math.random() * 2 - 1) * 0.8;
  // ~50 dB quieter residual throughout — small enough that early/late ratio
  // is large (> 2), but large enough that the late window is NOT silent.
  for (let i = 0; i < durationSamples; i++) s[i] += (Math.random() * 2 - 1) * 0.003;
  return s;
}

/** Sustained HF (hihat-like): white noise throughout. */
function makeSustainAudio(sampleRate: number, durationSamples: number): Float32Array {
  const s = new Float32Array(durationSamples);
  for (let i = 0; i < durationSamples; i++) s[i] = (Math.random() * 2 - 1) * 0.5;
  return s;
}

// ── 1. Synthetic tests ──────────────────────────────────────────────────────

describe("hfDecayRatio — synthetic audio", () => {
  it("fast-decaying HF (snap + small residual) → hfDecayRatio > 2.0", () => {
    // Use a snap-with-residual so the late window has finite non-silent energy
    // and the ratio is a real number rather than NaN. Task-spec notes: "values
    // > 2.0 indicate fast decay (snare-like)".
    const samples = makeSnapWithResidualAudio(SR, Math.round(0.2 * SR));
    const f = computeDrumFeatures(samples, SR, 0);
    expect(f).not.toBeNull();
    expect(Number.isFinite(f!.hfDecayRatio)).toBe(true);
    expect(f!.hfDecayRatio).toBeGreaterThan(2.0);
  });

  it("sustained HF (continuous white noise) → hfDecayRatio < 1.5", () => {
    // Early window RMS ≈ late window RMS → ratio ≈ 1.0.
    const samples = makeSustainAudio(SR, Math.round(0.2 * SR));
    const f = computeDrumFeatures(samples, SR, 0);
    expect(f).not.toBeNull();
    expect(Number.isFinite(f!.hfDecayRatio)).toBe(true);
    expect(f!.hfDecayRatio).toBeLessThan(1.5);
  });

  it("silent late window → hfDecayRatio is NaN (indeterminate)", () => {
    // Pure 15 ms burst with no residual — late window drops below the 1e-6
    // silence floor and the ratio is flagged NaN rather than a runaway
    // divide-by-near-zero value. Classifier treats NaN as indeterminate.
    const samples = makeSnapAudio(SR, Math.round(0.2 * SR));
    const f = computeDrumFeatures(samples, SR, 0);
    expect(f).not.toBeNull();
    expect(Number.isNaN(f!.hfDecayRatio)).toBe(true);
  });
});

// ── 2. Real BWB one-shot tests ──────────────────────────────────────────────

/** BWB SNARE (3) — one of the corpus-confirmed real snares.  Reported in the
 *  task brief as having centroid=3969 Hz with fast-decay characteristics; we
 *  verify the HF-sustain rule does not route it to hihat. */
const BWB_SNARE_3_PATH =
  "/Users/you/Music/Local Samples/BWB SZN 26/BWB SZN 26 SNARES/BWB SZN 26 SNARE (3).wav";

/** BWB HI HAT (1) — canonical bright one-shot hihat. */
const BWB_HIHAT_1_PATH =
  "/Users/you/Music/Local Samples/BWB SZN 26/BWB SZN 26 HATS/BWB SZN 26 HI HAT/BWB SZN 26 HI HAT (1).wav";

describe.skipIf(!existsSync(BWB_HIHAT_1_PATH))(
  "hfDecayRatio — real BWB hihat sample", () => {
    it("BWB HI HAT (1) has HF content in the late window (finite ratio)", () => {
      // One-shot hihats sustain HF energy well past 30 ms, so the late RMS is
      // above the silence floor and the ratio is finite.
      const f = featuresAtFirstOnset(BWB_HIHAT_1_PATH);
      expect(f).not.toBeNull();
      expect(Number.isFinite(f!.hfDecayRatio)).toBe(true);
    });
  },
);

describe.skipIf(!existsSync(BWB_SNARE_3_PATH))(
  "hfDecayRatio — real BWB snare sample (SNARE 3)", () => {
    it("BWB SNARE (3) is not misrouted to hihat by the HF-sustain rule", () => {
      // SNARE (3) sits below the HF_SUSTAIN_MIN_CENTROID=4800 threshold
      // (centroid ≈ 3969), so the HF-sustain rule does not fire regardless of
      // its decay profile. The important guarantee: the classifier does not
      // call this a hihat.
      const f = featuresAtFirstOnset(BWB_SNARE_3_PATH);
      expect(f).not.toBeNull();
      expect(classifyDrumVoice(f!)).not.toBe("hihat");
    });
  },
);

// ── 3. Real Awestruck extracted-sample tests ───────────────────────────────

/** The Awestruck dark-hihat one-shot the user confirmed is actually a hihat,
 *  not a snare. Before the parallel `SNARE_VINTAGE_HAT_CENTROID` drop to 4800
 *  and/or the HF-sustain rule it was classified as "snare"; after, it falls
 *  to "hihat". */
const AWESTRUCK_FAKE_SNARE_PATH =
  "/Users/you/Music/Ableton Alpha/User Library/Samples/Groove Transplant/Awestruck 95 BPM/snare_t0_s0.wav";

/** The Awestruck true-snare one-shot the user confirmed is a snare. */
const AWESTRUCK_TRUE_SNARE_PATH =
  "/Users/you/Music/Ableton Alpha/User Library/Samples/Groove Transplant/Awestruck 95 BPM/snare_t2_s0.wav";

describe.skipIf(!existsSync(AWESTRUCK_FAKE_SNARE_PATH))(
  "hfDecayRatio — Awestruck dark hihat (was misclassified as snare)", () => {
    it("snare_t0_s0 (actually a hihat) is not classified as snare", () => {
      const f = featuresAtFirstOnset(AWESTRUCK_FAKE_SNARE_PATH);
      expect(f).not.toBeNull();
      // Task's acceptance criterion: "verify classifyDrumVoice returns 'hihat'
      // (or at least not 'snare')".
      expect(classifyDrumVoice(f!)).not.toBe("snare");
    });
  },
);

describe.skipIf(!existsSync(AWESTRUCK_TRUE_SNARE_PATH))(
  "hfDecayRatio — Awestruck true snare", () => {
    it("snare_t2_s0 (the real snare) is still classified as snare", () => {
      const f = featuresAtFirstOnset(AWESTRUCK_TRUE_SNARE_PATH);
      expect(f).not.toBeNull();
      expect(classifyDrumVoice(f!)).toBe("snare");
    });
  },
);
