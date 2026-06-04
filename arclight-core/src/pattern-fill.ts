// Pattern-fill: post-detection pass that estimates each voice's fundamental
// inter-onset interval (IOI) and extrapolates hits that were masked by louder
// simultaneous hits in the original audio.
//
// Motivation
// ──────────
// In mixed drum audio (e.g. "Awestruck 95 BPM.wav"), a hihat on every beat
// tends to be masked by louder kicks/snares that coincide with it. Detection
// recovers only the hihat hits between those louder hits, producing gaps of
// 2.0 beats where the true period is 1.0. Given a sufficiently regular
// pattern, we can confidently synthesise the missing hits from the observed
// ones.
//
// This module is intentionally a *pure* transform on `DrumAnalysis`: it never
// touches audio, file I/O, or the sample-extraction path. Synthetic hits are
// flagged via `synthetic: true` so downstream code can distinguish them.

import type { DrumAnalysis, DrumHit, DrumVoice } from "./drum-detector.js";

// ── Options ─────────────────────────────────────────────────────────────────

export interface PatternFillOptions {
  /** Minimum fraction of gaps that must conform to the period for fill to trigger (default 0.6) */
  regularityThreshold?: number;
  /** Tolerance for IOI matching as fraction of period (default 0.08 = ±8%) */
  tolerance?: number;
  /**
   * Skip pattern-fill for any voice whose mean observed velocity exceeds this
   * threshold (default 88). Loud voices — kicks above all — are rarely masked
   * by other hits in the mix, so their gaps represent true rests and should
   * not be filled. Quieter voices (hihats, ghost snares) are the natural
   * targets for pattern extrapolation.
   */
  maxMeanVelocity?: number;
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** Synthetic-hit velocity scale. Users reported interpolated hits landed a
 *  little too loud in the mix — shaving ~18% gives more musically appropriate
 *  pattern-fill velocities while still preserving the relative dynamics of
 *  the bracketing real hits. */
const SYNTHETIC_VELOCITY_SCALE = 0.82;

/** Minimum hit count required before we even attempt period estimation. */
const MIN_HITS_FOR_ESTIMATION = 3;

/** Candidate subdivision periods in beats. Ordered smallest → largest so the
 *  smallest period that still explains most gaps wins (preferring the
 *  fundamental over its multiples). */
const CANDIDATE_PERIODS = [0.25, 0.3333333333333333, 0.5, 0.6666666666666666, 1.0, 1.5, 2.0];

/** Gap must exceed this multiple of the period for us to consider it a
 *  missing-hit candidate. 1.4× gives a ~40% slack above the nominal period. */
const GAP_FILL_THRESHOLD = 1.4;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * For each voice in `analysis`, estimates the fundamental IOI and fills
 * positions where hits are expected but absent. Modifies
 * `analysis.voices[*].hits` in-place.
 *
 * @returns the total number of synthetic hits inserted across all voices.
 */
export function fillPatternGaps(
  analysis: DrumAnalysis,
  options: PatternFillOptions = {},
): number {
  const regularityThreshold = options.regularityThreshold ?? 0.6;
  const tolerance           = options.tolerance ?? 0.08;
  const maxMeanVelocity     = options.maxMeanVelocity ?? 88;

  let inserted = 0;
  for (const voice of analysis.voices) {
    inserted += fillVoiceGaps(voice, analysis, regularityThreshold, tolerance, maxMeanVelocity);
  }
  return inserted;
}

// ── Per-voice fill ──────────────────────────────────────────────────────────

function fillVoiceGaps(
  voice: DrumVoice,
  analysis: DrumAnalysis,
  regularityThreshold: number,
  tolerance: number,
  maxMeanVelocity: number,
): number {
  if (voice.hits.length < MIN_HITS_FOR_ESTIMATION) return 0;

  // Loud voices (e.g. kicks at avg velocity 110) are almost never masked by
  // other hits — their gaps are musical rests, not missed detections. Skip
  // fill entirely when the voice's mean velocity exceeds the threshold.
  const meanVel = averageVelocity(voice.hits);
  if (meanVel > maxMeanVelocity) return 0;

  // Sort existing hits by beat time (defensive — callers may provide
  // already-sorted hits, but we don't assume).
  const sorted = [...voice.hits].sort((a, b) => a.timeBeat - b.timeBeat);

  const period = estimatePeriod(sorted, regularityThreshold, tolerance);
  if (period === null) return 0;

  const synthetic: DrumHit[] = [];

  // Inter-hit gaps
  for (let i = 0; i < sorted.length - 1; i++) {
    const prev  = sorted[i];
    const next  = sorted[i + 1];
    const gap   = next.timeBeat - prev.timeBeat;
    if (gap <= GAP_FILL_THRESHOLD * period) continue;

    const missingCount = Math.round(gap / period) - 1;
    if (missingCount <= 0) continue;

    for (let k = 1; k <= missingCount; k++) {
      const tBeat = prev.timeBeat + period * k;
      // Linear interpolation of velocity between the two bracketing hits.
      const frac = k / (missingCount + 1);
      const vel  = Math.round(prev.velocity + (next.velocity - prev.velocity) * frac);
      synthetic.push(makeSyntheticHit(tBeat, vel, voice, analysis));
    }
  }

  // Before the first hit
  const avgVel = averageVelocity(sorted);
  const first  = sorted[0];
  let t        = first.timeBeat - period;
  while (t >= -0.5 * period) {  // allow one sub-period slack below zero
    if (t < 0) break;
    synthetic.push(makeSyntheticHit(t, avgVel, voice, analysis));
    t -= period;
  }

  // After the last hit — bounded by clip length.
  const last = sorted[sorted.length - 1];
  t = last.timeBeat + period;
  while (t <= analysis.totalBeats - 0.5 * period) {
    synthetic.push(makeSyntheticHit(t, avgVel, voice, analysis));
    t += period;
  }

  if (synthetic.length === 0) return 0;

  // Merge synthetic + real, then re-sort by beat.
  voice.hits = [...sorted, ...synthetic].sort((a, b) => a.timeBeat - b.timeBeat);
  return synthetic.length;
}

// ── Period estimation ───────────────────────────────────────────────────────
//
// Strategy
// ────────
// 1. Collect all consecutive inter-onset intervals (IOIs).
// 2. The fundamental period must (a) explain ≥ regularityThreshold of the
//    IOIs as near-integer multiples, AND (b) equal the smallest-observed
//    IOI (within tolerance). We take the *minimum* IOI that conforms to the
//    rest of the pattern as the period — the smallest actually-observed
//    inter-onset interval is a strong evidence-based candidate, whereas
//    picking smaller divisors (e.g. 0.25 divides all 1-beat gaps) would
//    hallucinate hits at positions for which we have zero direct evidence.
// 3. We then snap that minimum to the nearest musical subdivision candidate
//    for stability (so 0.98 and 1.02 both map to 1.0).
// 4. If the conforming ratio fails the threshold, return null.

function estimatePeriod(
  sorted: DrumHit[],
  regularityThreshold: number,
  tolerance: number,
): number | null {
  const iois: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    iois.push(sorted[i].timeBeat - sorted[i - 1].timeBeat);
  }
  if (iois.length === 0) return null;

  const minIoi = Math.min(...iois);
  if (minIoi <= 0) return null;

  // Snap the minimum IOI to the closest musical-subdivision candidate. A raw
  // minIoi of 0.98 should be treated as 1.0; a raw 0.51 as 0.5. If the raw
  // min is too far from any candidate, we fall back to the raw value —
  // that still produces a sensible period for arbitrary BPM-relative inputs.
  const snapped = snapToCandidate(minIoi, tolerance);
  const period  = snapped ?? minIoi;

  const conforming = iois.filter(ioi => isMultipleWithin(ioi, period, tolerance)).length;
  if (conforming / iois.length < regularityThreshold) return null;
  return period;
}

/** Return the nearest CANDIDATE_PERIODS entry within `tolerance * candidate`
 *  of `value`, or null if none are close enough. */
function snapToCandidate(value: number, tolerance: number): number | null {
  let best: number | null = null;
  let bestRel = Infinity;
  for (const c of CANDIDATE_PERIODS) {
    const rel = Math.abs(value - c) / c;
    if (rel <= tolerance && rel < bestRel) {
      best = c;
      bestRel = rel;
    }
  }
  return best;
}

/** Returns true if `ioi` is within `tolerance * period` of k·period for some
 *  positive integer k. */
function isMultipleWithin(ioi: number, period: number, tolerance: number): boolean {
  if (ioi <= 0) return false;
  const k = Math.round(ioi / period);
  if (k < 1) return false;
  const residual = Math.abs(ioi - k * period);
  return residual <= tolerance * period;
}

// ── Synthetic-hit construction ──────────────────────────────────────────────

function makeSyntheticHit(
  tBeat: number,
  velocity: number,
  voice: DrumVoice,
  analysis: DrumAnalysis,
): DrumHit {
  // Scale down synthetic velocities — interpolation from bracketing real hits
  // tends to overshoot what a listener expects from a masked hit (users
  // report "a little too loud"). SYNTHETIC_VELOCITY_SCALE gives some headroom
  // back without flattening the pattern's dynamics.
  const scaled  = velocity * SYNTHETIC_VELOCITY_SCALE;
  const clamped = Math.max(1, Math.min(127, Math.round(scaled)));
  return {
    timeBeat:    tBeat,
    timeSeconds: tBeat * 60 / analysis.bpm,
    sampleIndex: 0,  // synthetic — no corresponding audio sample position
    strength:    clamped / 127,
    velocity:    clamped,
    voice:       voice.voice,
    synthetic:   true,
  };
}

function averageVelocity(hits: DrumHit[]): number {
  if (hits.length === 0) return 80;
  let sum = 0;
  for (const h of hits) sum += h.velocity;
  return sum / hits.length;
}
