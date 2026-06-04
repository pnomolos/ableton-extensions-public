import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parseAudio, detectTransientsSuperFlux, fft, applyBandpassFilter } from "./transient-detector.js";
import { writeWav } from "./write-wav.js";

export type DrumVoiceType = "kick" | "snare" | "hihat" | "openhat";

export interface DrumHit {
  timeSeconds: number;
  timeBeat:    number;
  sampleIndex: number;
  strength:    number;
  velocity:    number;   // 1–127
  voice:       DrumVoiceType;
  /** True for hits inserted by pattern-fill extrapolation rather than observed
   *  audio onsets. Synthetic hits have no meaningful sampleIndex and should
   *  not be used to drive sample extraction. */
  synthetic?:  boolean;
  /** True for hits moved by Pass 2.97 contextual reclassification from one
   *  voice's hit list to another. Diagnostic only — downstream code treats
   *  reclassified hits the same as natively classified ones. */
  reclassified?: boolean;
}

export interface DrumSample {
  filePath: string;
  strength: number;
}

export interface VelocityTier {
  velMin:  number;
  velMax:  number;
  samples: DrumSample[];  // > 1 → use round-robin
}

export interface DrumVoice {
  voice:    DrumVoiceType;
  midiNote: number;
  tiers:    VelocityTier[];
  hits:     DrumHit[];
}

export interface DrumAnalysis {
  voices:     DrumVoice[];
  bpm:        number;
  totalBeats: number;
}

// ── File-scope helpers ──────────────────────────────────────────────────────

/**
 * RMS of `band` within a symmetric window of `windowSize` samples centered on
 * `centerIdx`. Clamps window bounds to [0, band.length). Returns 0 for a
 * zero-length intersection.
 *
 * Used by Pass 2.95 (spectral masked-hihat rescue) to measure HF energy at
 * arbitrary sample positions.
 */
function windowRms(band: Float32Array, centerIdx: number, windowSize: number): number {
  const half  = windowSize >> 1;
  const start = Math.max(0, centerIdx - half);
  const end   = Math.min(band.length, centerIdx + half);
  let sum = 0;
  for (let i = start; i < end; i++) sum += band[i] * band[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

/** Median of a numeric array (non-destructive). Returns NaN for an empty array. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Context passed to the contextual reclassification pass. Supplies enough
 * loop-level information to compute density and timing signals without
 * requiring the full audio or wav buffer.
 */
export interface ContextualReclassifyContext {
  /** Total beats in the loop (used as the denominator for density). */
  totalBeats: number;
  /** Tempo. Not currently read by the pass, but kept for symmetry with
   *  DrumAnalysis and so future signals (e.g. swing detection) can reuse this
   *  shape without a breaking change. */
  bpm:        number;
}

/**
 * Largest gap between consecutive sorted velocity values. Returns both the gap
 * magnitude and the splitting index — all hits with velocity strictly less
 * than `splitVelocity` fall into the low cluster. Degenerate inputs (0 or 1
 * hit) return gap=0 and splitIndex=0.
 */
function largestVelocityGap(hits: DrumHit[]): {
  gap:           number;
  splitVelocity: number;
  maxVelocity:   number;
} {
  if (hits.length < 2) {
    return {
      gap:           0,
      splitVelocity: 0,
      maxVelocity:   hits.length === 1 ? hits[0].velocity : 0,
    };
  }
  const sorted = [...hits].sort((a, b) => a.velocity - b.velocity);
  let maxGap      = 0;
  let splitVel    = sorted[sorted.length - 1].velocity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].velocity - sorted[i - 1].velocity;
    if (d > maxGap) {
      maxGap   = d;
      splitVel = sorted[i].velocity;
    }
  }
  return {
    gap:           maxGap,
    splitVelocity: splitVel,
    maxVelocity:   sorted[sorted.length - 1].velocity,
  };
}

/** Offset (in beats) from the nearest integer multiple of `subdivision`. */
function offsetFromSubdivision(beat: number, subdivision: number): number {
  const rem = beat - Math.round(beat / subdivision) * subdivision;
  return Math.abs(rem);
}

/** Minimum offset across all standard musical subdivisions. */
function minGridOffset(beat: number): number {
  let min = Infinity;
  for (const sub of CONTEXT_SUBDIVISIONS) {
    const o = offsetFromSubdivision(beat, sub);
    if (o < min) min = o;
  }
  return min;
}

/**
 * Resolve the voice to reclassify a suspicious hit INTO. Honours the caller's
 * enabled-voices set so we never introduce hits for voices the caller didn't
 * ask for. Returns null if no suitable alternative voice is enabled.
 */
function reclassifyTarget(
  from:    DrumVoiceType,
  enabled: Set<DrumVoiceType>,
): DrumVoiceType | null {
  // Preference ordering per source voice. The first enabled target wins.
  const preferences: Record<DrumVoiceType, DrumVoiceType[]> = {
    snare:   ["hihat", "openhat"],
    hihat:   ["snare"],
    kick:    ["hihat", "openhat"],
    openhat: ["hihat"],
  };
  for (const target of preferences[from]) {
    if (target !== from && enabled.has(target)) return target;
  }
  return null;
}

/**
 * Pass 2.97: contextual reclassification. Moves hits that look suspicious in
 * the context of the full loop from their assigned voice to a more plausible
 * voice. Three signals are combined:
 *
 *   1. Velocity bimodality — if the voice's velocity distribution has a large
 *      gap, the low cluster is likely a different voice entirely.
 *   2. Voice density       — more hits per beat than musically plausible
 *      implies over-detection; the weakest hits are suspicious.
 *   3. Timing grid         — snares landing on 16th-note off-grid positions
 *      that do NOT coincide with typical backbeats get a small nudge toward
 *      hihat.
 *
 * Returns the count of hits that were reclassified. Mutates `hitsByVoice`
 * in place.
 */
export function contextualReclassify(
  hitsByVoice: Map<DrumVoiceType, DrumHit[]>,
  context:     ContextualReclassifyContext,
  enabled:     Set<DrumVoiceType>,
): number {
  const totalBeats = Math.max(1, context.totalBeats);
  type Move = { from: DrumVoiceType; to: DrumVoiceType; hit: DrumHit };
  const moves: Move[] = [];

  for (const voice of Array.from(hitsByVoice.keys())) {
    const hits = hitsByVoice.get(voice);
    if (!hits || hits.length === 0) continue;

    // Signal 1: velocity bimodality.
    const { gap, splitVelocity, maxVelocity } = largestVelocityGap(hits);
    const bimodalActive = maxVelocity > 0 &&
                          gap / maxVelocity > CONTEXT_BIMODAL_GAP_THRESHOLD[voice];
    const bimodalScore  = bimodalActive && maxVelocity > 0
                          ? gap / maxVelocity
                          : 0;

    // Signal 2: density. Rank hits by velocity descending; anything beyond
    // the max-expected-count is "excess" and scored uniformly.
    const maxExpected   = CONTEXT_MAX_DENSITY[voice];
    const density       = hits.length / totalBeats;
    const densityActive = density > maxExpected;
    const keepCount     = Math.floor(maxExpected * totalBeats);
    const densityScoreRaw = densityActive && maxExpected > 0
                            ? Math.min(1, (density - maxExpected) / maxExpected)
                            : 0;
    const velocityRank = new Map<DrumHit, number>();
    if (densityActive) {
      const byStrength = [...hits].sort((a, b) => b.velocity - a.velocity);
      byStrength.forEach((h, i) => velocityRank.set(h, i));
    }

    // Signal 3: timing (snare-only). Snares that don't land near a backbeat
    // position (0.0 or 0.5 within a beat) get a small nudge toward hihat.
    const timingActive = voice === "snare";

    for (const hit of hits) {
      let bimodal = 0;
      if (bimodalActive && hit.velocity < splitVelocity) bimodal = bimodalScore;

      let dens = 0;
      if (densityActive) {
        const rank = velocityRank.get(hit) ?? 0;
        if (rank >= keepCount) dens = densityScoreRaw;
      }

      let timing = 0;
      if (timingActive) {
        const beatMod = ((hit.timeBeat % 1) + 1) % 1;
        const distToDown = Math.min(beatMod, 1 - beatMod);
        const distToBack = Math.abs(beatMod - 0.5);
        const onBackbeat = distToDown < CONTEXT_BACKBEAT_TOLERANCE_BEATS ||
                           distToBack < CONTEXT_BACKBEAT_TOLERANCE_BEATS;
        const onGrid     = minGridOffset(hit.timeBeat) < CONTEXT_GRID_TOLERANCE_BEATS;
        if (onGrid && !onBackbeat) timing = 1;
      }

      const suspicion = bimodal * CONTEXT_WEIGHT_BIMODAL
                      + dens    * CONTEXT_WEIGHT_DENSITY
                      + timing  * CONTEXT_WEIGHT_TIMING;

      if (suspicion <= CONTEXT_RECLASSIFY_THRESHOLD) continue;
      // Support requirement: the bimodal velocity signal is unreliable on its
      // own because real drum voices (especially hihats) naturally produce
      // wide, bimodal velocity distributions for accent patterns. To avoid
      // reclassifying legit ghost/accent hits, require at least one of the
      // corroborating signals (density over cap or timing-suspicious
      // position) to also fire. Pure-density cases (timing inactive for the
      // voice AND bimodal inactive) are allowed to trigger on density alone,
      // since density over a voice's expected max already means the weakest
      // hits cannot all be real for that voice.
      //
      // Exception — snares with off-backbeat timing: dark-hihat false
      // positives show up as snares much more often than real voice-snare
      // ghost notes land on non-backbeat 16th positions. When the voice is
      // snare, bimodal has fired, AND the hit is off-grid-backbeat, the
      // bimodal signal alone is trusted even without density corroboration.
      const bimodalSufficient = voice === "snare" &&
                                bimodalScore > 0.10 &&
                                timing > 0;
      const hasSupport = dens > 0 || timing > 0 || bimodalSufficient;
      if (!hasSupport) continue;

      const target = reclassifyTarget(voice, enabled);
      if (!target) continue;

      moves.push({ from: voice, to: target, hit });
    }
  }

  if (moves.length === 0) return 0;

  // Apply moves. Remove by identity from the source bucket, push into the
  // target bucket with voice + reclassified metadata updated. Re-sort both
  // buckets by sampleIndex afterwards so downstream passes see a stable order.
  const touched = new Set<DrumVoiceType>();
  for (const { from, to, hit } of moves) {
    const src = hitsByVoice.get(from);
    if (src) {
      const idx = src.indexOf(hit);
      if (idx >= 0) src.splice(idx, 1);
    }
    hit.voice = to;
    hit.reclassified = true;
    const dst = hitsByVoice.get(to) ?? [];
    dst.push(hit);
    hitsByVoice.set(to, dst);
    touched.add(from);
    touched.add(to);
  }
  for (const v of touched) {
    const bucket = hitsByVoice.get(v);
    if (bucket) bucket.sort((a, b) => a.sampleIndex - b.sampleIndex);
  }
  return moves.length;
}

/** Per-onset spectral features used for voice classification. */
export interface DrumFeatures {
  centroidHz:   number;
  rolloff85Hz:  number;
  flatness:     number;
  zcr:          number;
  /** Energy ratio per band over the early window: [20–150, 150–500, 500–2k, 2k–6k, 6k–20k] Hz */
  subBandRatio: [number, number, number, number, number];
  /** Same bands measured ~23 ms BEFORE the onset — catches kick attacks that
   * are clipped/distorted in the early window but show clean sub-bass just
   * before the SuperFlux frame center (which lags real attacks by ~1–4 hops). */
  preSubBandRatio: [number, number, number, number, number];
  /** Same bands measured ~23 ms AFTER the onset — catches the kick rumble that
   * outlasts a co-occurring hi-hat tick (broadband-bleed solver). */
  lateSubBandRatio: [number, number, number, number, number];
  /** Log ratio of RMS over the first ~3ms vs the first ~12ms after the onset.
   * High values (> 0) indicate a sharp, percussive attack (kicks, snares);
   * low/negative values indicate a gradual ramp-up (reverb tails, sustained
   * bleed). Used as a tie-breaker in the snare/hi-hat classifier. */
  attackSlope:  number;
  /**
   * High-frequency (4–16 kHz) RMS decay ratio: earlyHfRms / lateHfRms where
   * "late" is ~40 ms after onset. Values > 2.0 indicate fast decay (snare-like);
   * values < 1.5 indicate sustained HF (hihat-like). NaN if the late window is
   * silent (treat as indeterminate — do not use for classification).
   */
  hfDecayRatio: number;
}

// ── Tunable classifier thresholds ────────────────────────────────────────────
// All hand-tuned constants in one place so corpus testing can adjust them.
//
// Empirically derived from per-sample diagnostics on BWB SZN 26 one-shots and
// from per-onset diagnostics on the corpus loops (see
// src/__tests__/corpus/diagnose-features.ts).
//
// Key empirical observations:
//   • clean BWB kicks  → centroid 68–300 Hz, sb[0] 0.5–0.98 (some "punchy" kicks
//     reach centroid 1100 Hz with sb[0] only 0.2 — those are caught by the
//     late-window kick rule, since their low-end rumble outlasts the click).
//   • BWB snares       → centroid 4–7 kHz, sb[3] dominant (0.33–0.61), sb[4]
//     0.19–0.46, zcr 0.12–0.18. Note: sb[1] is only 0.02–0.15 — the original
//     snare rule using sb[1]>0.20 caught essentially nothing. Snares are
//     dominated by the 2-6 kHz "snap" band, not the 150-500 Hz body.
//   • BWB hi-hats      → centroid 8.5–12 kHz, sb[4] 0.7+, zcr 0.24–0.56.
//     Snares and hats overlap in centroid+sb[4]+flatness — zcr is the cleanest
//     discriminator (snare ≤ 0.20, hat ≥ 0.22).
//   • In a mixed loop, a kick that fires under a hi-hat looks all-hat in the
//     early window because the hat dominates the high-frequency mass. The late
//     window (23 ms after onset) shows the kick rumble alone — solving the
//     bleed problem.

// Kick rule A (clean kick — no overlapping hat): early window is dominated by
// the sub-bass band on its own.
const KICK_MAX_CENTROID_HZ      = 2000;
const KICK_MIN_SUBBAND0_RATIO   = 0.40;  // band[0] = 20–150 Hz

// Kick rule B (kick beneath hat — broadband bleed): EITHER the LATE window
// (catches kick rumble that outlasts the overlapping hi-hat) OR the PRE
// window (catches kicks where the SuperFlux frame center lags the actual
// attack — common with clipped/saturated kicks) shows sub-bass dominance.
// We don't require absolute energy — the FFT of a silent slice gives all-zero
// magnitudes, which fall below the ratio threshold automatically.
const KICK_NEIGHBOR_MIN_SUBBAND0 = 0.55;  // band[0] dominance in pre or late window

// Hi-hat rule: high spectral centroid + dominant 6k–20k band.
// zcr would discriminate isolated snares (≤0.20) from isolated hats (≥0.22),
// but in mixed loops the hi-hat window often picks up kick/snare tails that
// drag its zcr down — so we rely on centroid + sb[4] alone.
const HIHAT_MIN_CENTROID_HZ     = 6500;
const HIHAT_MIN_SUBBAND4_RATIO  = 0.45;  // band[4] = 6k–20k Hz

// Snare rule: mid-range centroid + sb[3] dominance (the "snap" / 2–6 kHz body)
// + zcr inside the snare band (rejects hats which have higher zcr, kicks which
// have near-zero zcr).
const SNARE_MIN_CENTROID_HZ     = 2500;
const SNARE_MAX_CENTROID_HZ     = 8000;
const SNARE_MIN_SUBBAND3_RATIO  = 0.19;  // band[3] = 2k–6k Hz (slack for FP precision)
// sb[2] body-band gate: empirically derived from Aloe Vera 98BPM vintage break.
//   Real snares:          sb[2] = 0.195–0.285 (snare shell resonance fills 500–2k band)
//   Hihat/cymbal hits:    sb[2] = 0.095–0.156 (hihats have almost no energy here)
// Threshold of 0.16 gives a clean split with ≥15 count margin on each side.
// Also used as the vintage-hihat gate boundary (rule 4b below).
const SNARE_MIN_SUBBAND2_RATIO  = 0.08;
// Vintage-hihat rejection guard (see classifyDrumVoiceEx): hits with
// centroid ≥ THRESHOLD AND sb[2] < SB2_MAX AND sb[3] > sb[4] are dark/vintage
// hihats whose energy concentrates in the 2–6 kHz snap band (sb[3]) without
// the sub-bass body of a real snare.
//
// Tuning history:
//   centroid: 5100 → 4800.  False snares in Awestruck 95 BPM (dark vintage
//     hihats) have centroid 4600–5100 Hz; real corpus snares (Cymatics) reach
//     4639-4734 Hz, so 4800 is the lowest safe boundary.
//   sb[2]:    raised 0.16 → 0.18.  Aloe Vera bars 2–4 hihat FPs had
//     sb[2]=0.162–0.177 and slipped through the 0.16 gate.
//     Kept at 0.18 to preserve BWB snares in punchy-groove mix (sb[2]=0.195+).
const SNARE_VINTAGE_HAT_CENTROID = 4800;
const SNARE_VINTAGE_HAT_SB2_MAX  = 0.18;
// HF-sustain vintage-hat guard: catches dark hihats that slip below the
// centroid / sb[2] thresholds above by measuring temporal HF decay directly.
// A real snare's 4–16 kHz crack dies within ~20–30 ms; a hihat's shimmer
// sustains well past 40 ms. When HF doesn't decay fast AND the spectrum looks
// bright-but-body-light, classify as hihat even if the centroid/sb[2] rule
// would otherwise pass.
/** HF decay ratio below which the hit is flagged as hihat-like (HF is sustained). */
const HF_SUSTAIN_SNARE_MIN_DECAY = 2.0;
/**
 * Minimum centroid for the HF sustain rule.
 *
 * Nominal spec value is 3500 Hz, but empirical tuning against corpus loops
 * (cymatics-velocity-dynamic has snares at centroid 4639–4734 Hz with
 * sustained HF that would otherwise fire this rule). Kept at 4800 to match
 * the existing `SNARE_VINTAGE_HAT_CENTROID` boundary — above this the rule
 * acts as an HF-sustain-evidence amplifier for borderline vintage-hat hits
 * that the existing guard misses (sb[2] just below 0.18 with indeterminate
 * sb[3]/sb[4]).
 */
const HF_SUSTAIN_MIN_CENTROID    = 4800;
/**
 * Maximum sb[2] (500-2k body) for the HF sustain rule; real snares have more body.
 *
 * Nominal spec value is 0.25, but empirical tuning against corpus loops
 * (punchy-groove snares at sb[2]=0.19-0.20, centroid=5201) shows that a 0.25
 * ceiling absorbs several legit sizzle-heavy snares. Tightened to 0.18 to
 * match the existing `SNARE_VINTAGE_HAT_SB2_MAX` boundary — scopes the rule
 * to the body-light region where dark vintage hihats actually live.
 */
const HF_SUSTAIN_MAX_SB2         = 0.18;
// zcr ceiling: ghost snares (brushy, low-velocity hits) push zcr up to 0.29.
// The vintage-hat guard above now handles most false positives so the zcr
// check can remain permissive at 0.30.
const SNARE_MAX_ZCR             = 0.30;
// Bright-decay hat guard: catches vintage hihat hits with centroid clearly
// above real snare body range (> 4700Hz), fast HF decay (> 3× from early to
// late window, characteristic of a hat tick), and limited mid-body presence
// (sb[2] < 0.20). Snares with comparable centroid always carry more body
// (sb[2] ≥ 0.21 in corpus, e.g. hihat-heavy at 0.29-0.30). Targets soft
// ghost hits in vintage breaks (e.g. Awestruck) that slip past isVintageHatFP
// when sb[2] lands right at the 0.18 boundary.
const BRIGHT_DECAY_HAT_CENTROID_HZ = 4700;   // Hz — above real snare body range
// Low-centroid vintage hat: softer ghost hits land in 4400–4850 Hz with high
// upper-mid (sb3) and moderate air (sb4>=0.27). Corpus snares in this centroid
// range have sb4<0.27 (cymatics-velocity-dynamic: 0.24) so the sb4 gate is safe.
const LOW_CENTROID_HAT_MIN_HZ   = 4400;    // Hz
const LOW_CENTROID_HAT_MAX_HZ   = 4850;    // Hz — punchy-groove snare starts at 5200
const LOW_CENTROID_HAT_SB2_MAX  = 0.22;    // limited mid-body energy
const LOW_CENTROID_HAT_SB4_MIN  = 0.27;    // distinguishes hats from snares in this range
// At detection time the feature window starts 11.6 ms (512 samples at 44.1 kHz)
// BEFORE the actual onset, so the "early" HF window captures pre-onset content
// and the ratio is lower than in a from-onset diagnostic. Empirical range for
// Awestruck-style ghost-hihat false-positives: 1.40–2.81 at detection time;
// real snares (which have rising HF from the sizzle) land 0.12–1.22.
const BRIGHT_DECAY_HAT_HFDECAY_MIN = 0.95;   // × — fast HF decay like a hat tick
const BRIGHT_DECAY_HAT_SB2_MAX     = 0.22;   // fraction — limited body energy
// Snap-heavy hat: hits in the 3–4.4 kHz centroid range with extreme sb3
// dominance, limited body (sb2), and elevated zcr. Vintage-break hi-hat ticks
// that ring in the low-mid range pass all other snare tests because their
// centroid looks snare-like. The centroid ceiling (< 4400 Hz) keeps the guard
// off high-centroid snares (BWB SZN 26, Cymatics) that also have high sb3 but
// live at 4500–7000 Hz.
//   Real low-centroid snares:  sb3 ≤ 0.30, centroid 2900–3600 Hz
//   Awestruck false hits:      sb3 ≥ 0.38, centroid 3576–3944 Hz, sb2 ≤ 0.16, zcr ≥ 0.12
//   BWB/Cymatics corpus snares: centroid ≥ 4503 Hz — never reaches this guard
const SNAP_HEAVY_HAT_CENTROID_MAX = 4400;  // Hz — all corpus snares are above this
const SNAP_HEAVY_HAT_SB3_MIN      = 0.36;  // far above real low-centroid snare sb3 max (0.30)
const SNAP_HEAVY_HAT_SB2_MAX      = 0.17;  // below real snare sb2 min (0.18)
const SNAP_HEAVY_HAT_ZCR_MIN      = 0.10;  // above real snare zcr max (0.09)

// Sub-band edges in Hz (5 bands → 6 edges)
const SUB_BAND_EDGES_HZ: readonly number[] = [20, 150, 500, 2000, 6000, 20000];

// Onset analysis window — 2048 samples ≈ 46ms at 44.1kHz, fits the spec.
const FEATURE_WINDOW_SIZE = 2048;
// Neighbor-window probes: ~23ms before and ~23ms after the onset, 1024 samples
// each (≈23ms). The late probe lands AFTER a typical hi-hat's perceptual decay
// but during a kick's fundamental rumble. The pre probe catches kicks whose
// SuperFlux onset frame lags the actual attack (clipped/saturated material).
const NEIGHBOR_WINDOW_OFFSET = 1024;
const NEIGHBOR_WINDOW_SIZE   = 1024;

// HF temporal-decay probe. Measures how quickly 4–16 kHz RMS drops after an
// onset — the key discriminator between a snare's ~20–30 ms crack/snap and a
// hihat's 100 ms+ shimmer even in closed articulations. `hfDecayRatio` =
// earlyHfRms / lateHfRms; > 2.0 is snare-like (fast decay), < 1.5 is hihat-like
// (sustained HF). The "late" window starts 30 ms after onset, well past a
// snare's shell resonance but during a hihat's sustain.
const HF_DECAY_EARLY_MS       = 20;    // ms from onset for "early" HF window
const HF_DECAY_LATE_START_MS  = 30;    // ms: start of "late" window
const HF_DECAY_LATE_END_MS    = 60;    // ms: end of "late" window
const HF_DECAY_LO_HZ          = 4000;
const HF_DECAY_HI_HZ          = 16000;
/** RMS floor below which the late HF window is considered silent — returns
 * NaN so callers can treat the decay as indeterminate rather than using a
 * runaway divide-by-small-number value. */
const HF_DECAY_SILENCE_FLOOR  = 1e-6;

const MIDI_NOTE: Record<DrumVoiceType, number> = {
  kick:    36,  // C1
  snare:   38,  // D1
  hihat:   42,  // F#1 (closed)
  openhat: 46,  // A#1 (GM open hi-hat)
};

// Max sample slice lengths per voice (in seconds) — used as an absolute cap
// on the output file; the real endpoint comes from an energy-envelope decay
// search (see findDecayEnd).
const MAX_HIT_SECONDS: Record<DrumVoiceType, number> = {
  kick:    0.5,
  snare:   0.3,
  hihat:   0.15,
  openhat: 0.5,  // open hats sustain for 150–500 ms
};

// Bandpass ranges used for per-voice energy-envelope analysis. These are wider
// than the feature-classification sub-bands on purpose: they isolate the
// perceptually relevant body of each voice so the RMS decay tracks what the
// listener hears.
const DECAY_BAND_HZ: Record<DrumVoiceType, [number, number]> = {
  kick:    [20,   250],
  snare:   [150,  6000],
  hihat:   [4000, 16000],
  openhat: [4000, 16000],  // identical band to closed hihat — distinguished only by decay
};
const DECAY_DROP_FRACTION   = 0.15;  // stop when band RMS drops to 15% of peak
const DECAY_SUSTAIN_FRAMES  = 3;     // must be below threshold for 3 frames
const DECAY_FRAME_SAMPLES   = 256;   // RMS frame size (~5.8 ms at 44.1 kHz)

// SuperFlux onset detection lag: the spectral flux peaks 10–40 ms after the
// actual transient start. findTrueOnset scans back up to ONSET_LOOKBACK_S
// before the SuperFlux position to find where the signal first crosses the
// per-voice threshold — that is the true onset used for both MIDI placement
// and sample extraction.
//
// The transient detector reports sampleIndex at the analysis-window CENTER,
// not its start — the spectral event that produced the flux peak sits
// windowSize/2 samples (~11.6 ms at 44.1 kHz, windowSize=1024) BEFORE the
// reported sample index. The lookback budget therefore has to cover the
// usual 10–40 ms SuperFlux lag PLUS this ~11.6 ms window-center offset.
const ONSET_LOOKBACK_S = 0.050;   // scan back up to 50 ms before detection

// Compensation for the frame-center-vs-frame-start shift in the reported
// sampleIndex (see ONSET_LOOKBACK_S comment). Feature windows are anchored
// at sampleIndex and extend forward; without this shift-back they would
// start ~11.6 ms past the attack, inside the decay, and misclassify
// snares/hihats as non-percussive material.
const ONSET_DETECTOR_HALF_WINDOW = 512;  // windowSize/2 at default windowSize=1024
const ONSET_SCAN_ABS   = 5e-4;    // absolute noise floor guard
// Short fade-in applied to the copy so the hard-start edge doesn't click.
const ONSET_FADE_IN_SAMPLES = 4;  // ~0.09 ms at 44.1 kHz — just enough to kill a DC click

// Per-voice onset threshold (fraction of local peak). Hihats often have a
// gradual 10–15 ms pre-attack ramp in breaks; a higher threshold skips it so
// the sample starts at a perceptually sharp onset.
const ONSET_SCAN_REL: Record<string, number> = {
  kick:    0.05,   // 5 % — skip pre-kick bleed/noise while retaining the sub attack
  snare:   0.03,   // 3 % — snares are sharp; a tiny guard against pre-noise
  hihat:   0.15,   // 15 % — skip the common slow-attack ramp in break recordings
  openhat: 0.15,   // same attack character as closed hat — same threshold
};

// Grace region before the next detected onset — keeps the tail from leaking
// into the next hit even if the energy envelope hasn't dropped yet.
const NEXT_ONSET_GRACE_SECONDS = 0.008;

const FADE_OUT_SECONDS = 0.02;       // 20ms fade-out at slice end
const CLEAN_GAP_SECONDS = 0.1;       // minimum gap from previous same-voice hit for "clean" sample
// Minimum gap from any PRIOR loud cross-voice hit before a sample can be
// considered "clean". Kicks that occur 170ms after a snare (e.g. fills in
// Awestruck) inherit the snare's body in their sample — exclude those hits.
const CROSS_VOICE_CLEAN_SECONDS = 0.20;
const MAX_SAMPLES_PER_TIER = 3;

// ── Pass 2.95: spectral masked-hihat rescue (constants) ────────────────────
// A hihat that fires simultaneously with a kick or snare is easily missed by
// the spectral classifier (the louder hit dominates the feature window).
// However, the 4–16 kHz RMS around a hybrid kick+hat or snare+hat hit is
// markedly higher than at a "clean" kick/snare where no hihat is sitting on
// top. Measuring that elevation lets us infer the masked hihat directly from
// audio — more reliably than pattern extrapolation, which additionally
// requires a highly regular pattern.
const HF_RESCUE_RATIO    = 2.5;  // HF band must be ≥ this multiple of the "clean" baseline
const HF_RESCUE_MAX_VEL  = 100;  // cap on rescued-hit velocity (avoid noise → unrealistically loud hat)
// Note: a file-scope COINCIDENCE_WINDOW_S (0.025 s) is defined below for
// cross-voice coincidence checks used in Pass 2.5/2.6. We reuse that same
// constant here — see Pass 2.95's `coincidenceSamples` binding.

// ── Pass 2.97: contextual reclassification (constants) ─────────────────────
// Per-hit spectral classification is context-free: each hit is classified from
// a ~23 ms window with no knowledge of other hits in the loop. That produces
// systematic errors when one voice's spectrum partly overlaps another's
// (e.g. dark vintage hihats that spectrally resemble BWB-style snares).
// Pass 2.97 runs after all other classification passes and inspects loop-level
// context — velocity distribution, voice density, and timing grid alignment —
// to flag "suspicious" hits and reclassify them to the most likely alternative
// voice.

/**
 * Minimum relative velocity gap to flag the low cluster as bimodally suspicious.
 * Voice-specific because the character of legitimate velocity distributions
 * differs per voice:
 *  - Kicks are rarely contaminated by spurious classifications from other
 *    voices, so a wide gap is required before suspicion is warranted.
 *  - Snares routinely pick up dark-hihat false positives whose velocities
 *    interleave with real snares; a much smaller gap is enough to flag the low
 *    cluster as suspicious.
 *  - Hihats / openhats legitimately accent within a single loop (soft ghost
 *    notes, loud accents), so we stay conservative here.
 */
const CONTEXT_BIMODAL_GAP_THRESHOLD: Record<DrumVoiceType, number> = {
  kick:    0.35,
  snare:   0.12,
  hihat:   0.40,
  openhat: 0.40,
};

/** Combined suspicion threshold above which a hit is reclassified. */
const CONTEXT_RECLASSIFY_THRESHOLD  = 0.50;

/** Signal weights for combined suspicion score. */
const CONTEXT_WEIGHT_BIMODAL  = 1.0;
const CONTEXT_WEIGHT_DENSITY  = 0.6;
const CONTEXT_WEIGHT_TIMING   = 0.2;

/**
 * Max expected hits per beat per voice before the density signal fires.
 * Snare / kick are tightened below realistic musical maxima: even ghost-heavy
 * grooves rarely average more than ~1 snare-per-beat, and complex kick patterns
 * rarely exceed ~1.5/beat. Hihats legitimately run dense subdivisions.
 */
const CONTEXT_MAX_DENSITY: Record<DrumVoiceType, number> = {
  kick:    1.5,
  snare:   1.0,
  hihat:   8.0,
  openhat: 1.0,
};

/** Musical subdivisions of a beat considered "clean grid" positions. */
const CONTEXT_SUBDIVISIONS: readonly number[] = [1 / 4, 1 / 8, 1 / 16, 1 / 3, 1 / 6];

/** Tolerance (in beats) for snapping a hit to a grid subdivision. */
const CONTEXT_GRID_TOLERANCE_BEATS    = 0.05;

/** Tolerance (in beats) for snapping a snare to a typical backbeat position. */
const CONTEXT_BACKBEAT_TOLERANCE_BEATS = 0.12;

// Per-tier target peak level (dBFS) when multiple tiers exist. Softer tiers
// get a lower target so the MIDI velocity and the sample amplitude agree.
const TIER_PEAK_DBFS: Record<number, number[]> = {
  1: [-3],
  2: [-9, -3],
  3: [-12, -6, -3],
};

// ── Per-band SuperFlux supplementary detection ───────────────────────────────
// Broad bands used to find onsets of a particular voice that the full-signal
// SuperFlux + feature classifier pipeline missed (typical case: a kick fires
// on top of a loud hi-hat and the full-signal onset gets classified as hi-hat
// because the hi-hat energy dominates the feature window).
const MULTIBAND_RANGES: Array<{ voice: DrumVoiceType; loHz: number; hiHz: number }> = [
  { voice: "kick",  loHz: 20,   hiHz: 180   },
  { voice: "snare", loHz: 180,  hiHz: 4000  },
  { voice: "hihat", loHz: 5000, hiHz: 20000 },
];
// Two onsets within this window are treated as the same event (prefer the one
// that came out of the full-signal pass).
const COINCIDENCE_WINDOW_S = 0.025;

function tierCount(hitCount: number): number {
  if (hitCount < 4) return 1;
  if (hitCount < 9) return 2;
  return 3;
}

const TIER_RANGES: Record<number, Array<[number, number]>> = {
  1: [[1, 127]],
  2: [[1, 63], [64, 127]],
  3: [[1, 42], [43, 84], [85, 127]],
};

function applyFadeOut(samples: Float32Array, sampleRate: number): void {
  const fadeSamples = Math.min(Math.round(FADE_OUT_SECONDS * sampleRate), samples.length);
  for (let i = 0; i < fadeSamples; i++) {
    samples[samples.length - fadeSamples + i] *= 1 - i / fadeSamples;
  }
}

/**
 * Find the sample index at which the voice-relevant band energy has decayed
 * to a small fraction of the attack peak. Used to trim drum sample output to
 * just the hit itself, without the next hit or ambient bleed.
 *
 * The algorithm:
 *   1. Hard-cap the search at whichever comes first: the absolute max duration
 *      for this voice, the next detected onset (minus a small grace region),
 *      or the end of the source.
 *   2. Bandpass-filter the slice so only the voice's perceptual body is
 *      considered.
 *   3. Walk frame-by-frame, measuring RMS in `DECAY_FRAME_SAMPLES` windows.
 *   4. Track the peak RMS across the attack region (first 50 ms).
 *   5. Once we're past the attack, return as soon as the RMS has stayed under
 *      `DECAY_DROP_FRACTION * peak` for `DECAY_SUSTAIN_FRAMES` in a row.
 */
function findDecayEnd(
  allSamples:        Float32Array,
  sampleRate:        number,
  startSample:       number,
  voice:             DrumVoiceType,
  nextOnsetSample:   number,
  maxDurationSamples: number,
): number {
  const graceSamples = Math.round(NEXT_ONSET_GRACE_SECONDS * sampleRate);
  const endCap = Math.min(
    startSample + maxDurationSamples,
    nextOnsetSample - graceSamples,
    allSamples.length,
  );
  // Underflow guard: if the next onset sits so close that endCap falls at
  // or before startSample, a naive `max(startSample+1, endCap)` would
  // produce a 1-sample degenerate slice. Fall back to at least one RMS
  // frame so downstream extraction has something meaningful to analyze.
  if (endCap <= startSample) {
    return Math.min(startSample + DECAY_FRAME_SAMPLES, allSamples.length);
  }
  if (endCap <= startSample + DECAY_FRAME_SAMPLES) {
    return Math.max(startSample + 1, endCap);
  }

  const [loHz, hiHz] = DECAY_BAND_HZ[voice];
  const slice = allSamples.slice(startSample, endCap);
  const bandFiltered = applyBandpassFilter(slice, sampleRate, loHz, hiHz);

  const numFrames = Math.floor(bandFiltered.length / DECAY_FRAME_SAMPLES);
  if (numFrames < 2) return endCap;

  const attackFrames = Math.min(
    numFrames,
    Math.ceil(0.05 * sampleRate / DECAY_FRAME_SAMPLES),
  );

  // Pass 1 — peak RMS in the attack region.
  let peakRms = 0;
  for (let f = 0; f < attackFrames; f++) {
    const frameStart = f * DECAY_FRAME_SAMPLES;
    let sum = 0;
    for (let i = frameStart; i < frameStart + DECAY_FRAME_SAMPLES; i++) {
      const v = bandFiltered[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / DECAY_FRAME_SAMPLES);
    if (rms > peakRms) peakRms = rms;
  }

  if (peakRms < 1e-6) return endCap;

  // Pass 2 — walk forward until RMS sustains below the threshold.
  const threshold = peakRms * DECAY_DROP_FRACTION;
  let belowCount = 0;
  for (let f = attackFrames; f < numFrames; f++) {
    const frameStart = f * DECAY_FRAME_SAMPLES;
    let sum = 0;
    for (let i = frameStart; i < frameStart + DECAY_FRAME_SAMPLES; i++) {
      const v = bandFiltered[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / DECAY_FRAME_SAMPLES);
    if (rms <= threshold) {
      belowCount++;
      if (belowCount >= DECAY_SUSTAIN_FRAMES) {
        const firstBelowFrame = f - DECAY_SUSTAIN_FRAMES + 1;
        return startSample + (firstBelowFrame + 1) * DECAY_FRAME_SAMPLES;
      }
    } else {
      belowCount = 0;
    }
  }
  return endCap;
}

/**
 * Measure the peak amplitude of a voice-band-filtered window starting at the
 * onset. Used as an amplitude-based velocity source (more accurate than the
 * raw SuperFlux onset strength, which is a frequency-domain delta).
 */
function measureOnsetAmplitude(
  samples:     Float32Array,
  sampleRate:  number,
  sampleIndex: number,
  voice:       DrumVoiceType,
): number {
  const [loHz, hiHz] = DECAY_BAND_HZ[voice];
  const windowSamples = Math.round(0.020 * sampleRate); // 20 ms probe
  const end   = Math.min(sampleIndex + windowSamples, samples.length);
  if (end <= sampleIndex) return 0;
  const slice = samples.slice(sampleIndex, end);
  const filtered = applyBandpassFilter(slice, sampleRate, loHz, hiHz);
  let peak = 0;
  for (const s of filtered) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Measure the peak amplitude of the full-band signal in a short window at
 * the onset. Counterpart to measureOnsetAmplitude — used to gate
 * supplementary-pass detections against their share of total energy.
 */
function measureBroadbandAmplitude(
  samples:     Float32Array,
  sampleRate:  number,
  sampleIndex: number,
): number {
  const windowSamples = Math.round(0.020 * sampleRate);
  const end = Math.min(sampleIndex + windowSamples, samples.length);
  let peak = 0;
  for (let i = sampleIndex; i < end; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/** Collect all hits across every voice in a Map<voice, DrumHit[]>. */
function allKeptHitsOf(hitsByVoice: Map<DrumVoiceType, DrumHit[]>): DrumHit[] {
  const out: DrumHit[] = [];
  for (const arr of hitsByVoice.values()) out.push(...arr);
  return out;
}

/** Scale samples in-place so their peak magnitude matches the target dBFS. */
function normalizeToPeakDbfs(samples: Float32Array, targetDbfs: number): void {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  if (peak < 1e-8) return;
  const targetLinear = Math.pow(10, targetDbfs / 20);
  const gain = targetLinear / peak;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}

// ── Feature extraction ───────────────────────────────────────────────────────

interface SpectralWindow {
  totalEnergy:   number;
  centroidHz:    number;
  rolloff85Hz:   number;
  flatness:      number;
  subBand:       [number, number, number, number, number];
  subBandRatio:  [number, number, number, number, number];
}

/**
 * Run an FFT on `samples[start..start+N]` and return spectral metrics.
 * Returns null if the slice is too short to FFT.
 */
function analyzeSpectrum(
  samples: Float32Array, sampleRate: number, start: number, N: number,
): SpectralWindow | null {
  if (N < 64) return null;

  let fftSize = 1;
  while (fftSize < N) fftSize <<= 1;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    re[i] = samples[start + i] * w;
  }
  fft(re, im);

  const numBins = fftSize / 2;
  const mag = new Float32Array(numBins);
  let totalEnergy = 0;
  for (let k = 0; k < numBins; k++) {
    const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    mag[k] = m;
    totalEnergy += m;
  }

  const binHz = sampleRate / fftSize;

  let centroidNum = 0;
  for (let k = 0; k < numBins; k++) centroidNum += k * binHz * mag[k];
  const centroidHz = totalEnergy > 0 ? centroidNum / totalEnergy : 0;

  const rolloffTarget = totalEnergy * 0.85;
  let cum = 0;
  let rolloffBin = numBins - 1;
  for (let k = 0; k < numBins; k++) {
    cum += mag[k];
    if (cum >= rolloffTarget) { rolloffBin = k; break; }
  }
  const rolloff85Hz = rolloffBin * binHz;

  let logSum = 0, arithSum = 0, count = 0;
  const eps = 1e-12;
  for (let k = 1; k < numBins; k++) {
    logSum  += Math.log(mag[k] + eps);
    arithSum += mag[k];
    count++;
  }
  const geoMean   = count > 0 ? Math.exp(logSum / count) : 0;
  const arithMean = count > 0 ? arithSum / count : 0;
  const flatness  = arithMean > 0 ? geoMean / arithMean : 0;

  const subBand: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (let band = 0; band < 5; band++) {
    const loK = Math.max(0, Math.floor(SUB_BAND_EDGES_HZ[band]     / binHz));
    const hiK = Math.min(numBins - 1, Math.ceil(SUB_BAND_EDGES_HZ[band + 1] / binHz));
    let e = 0;
    for (let k = loK; k <= hiK; k++) e += mag[k];
    subBand[band] = e;
  }
  const sbTotal = subBand.reduce((a, b) => a + b, 0) || 1;
  const subBandRatio: [number, number, number, number, number] = [
    subBand[0] / sbTotal, subBand[1] / sbTotal, subBand[2] / sbTotal,
    subBand[3] / sbTotal, subBand[4] / sbTotal,
  ];

  return { totalEnergy, centroidHz, rolloff85Hz, flatness, subBand, subBandRatio };
}

/**
 * Compute per-onset spectral features over an analysis window starting at
 * `sampleIndex`. Returns null if the window doesn't fit in the audio.
 *
 * Two analysis windows are taken:
 *   • EARLY (size = `windowSize`, starts at sampleIndex) — captures the attack
 *     transient and immediate post-attack content. Used for centroid, flatness,
 *     zcr, and the primary subBandRatio.
 *   • LATE  (size = LATE_WINDOW_SIZE, starts ~23ms after sampleIndex) —
 *     captures the post-attack decay. Used to detect kick-rumble that
 *     outlasts a co-occurring hi-hat tick (broadband-bleed solver).
 */
export function computeDrumFeatures(
  samples:    Float32Array,
  sampleRate: number,
  sampleIndex: number,
  windowSize: number = FEATURE_WINDOW_SIZE,
): DrumFeatures | null {
  const start = Math.max(0, sampleIndex);
  const end   = Math.min(samples.length, start + windowSize);
  const N = end - start;
  if (N < 64) return null;

  // Zero-crossing rate (time-domain, on the un-windowed early slice)
  let crossings = 0;
  for (let i = 1; i < N; i++) {
    if ((samples[start + i] >= 0) !== (samples[start + i - 1] >= 0)) crossings++;
  }
  const zcr = crossings / N;

  const early = analyzeSpectrum(samples, sampleRate, start, N);
  if (!early) return null;

  // Neighbor-window probes: pre = ~23ms before the onset, late = ~23ms after.
  const preStart  = Math.max(0, start - NEIGHBOR_WINDOW_OFFSET);
  const preN      = Math.min(NEIGHBOR_WINDOW_SIZE, start - preStart);
  const pre       = analyzeSpectrum(samples, sampleRate, preStart, preN);
  const preSubBandRatio: [number, number, number, number, number] = pre
    ? pre.subBandRatio
    : [0, 0, 0, 0, 0];

  const lateStart = Math.min(samples.length, start + NEIGHBOR_WINDOW_OFFSET);
  const lateN     = Math.min(NEIGHBOR_WINDOW_SIZE, samples.length - lateStart);
  const late      = analyzeSpectrum(samples, sampleRate, lateStart, lateN);
  const lateSubBandRatio: [number, number, number, number, number] = late
    ? late.subBandRatio
    : [0, 0, 0, 0, 0];

  // Attack slope: RMS over the first ~3 ms vs the first ~12 ms. A sharp
  // percussive onset concentrates its energy very early, pushing this ratio
  // above 1. A gradual ramp (sustained bleed or reverb) yields a ratio near 1
  // or below. log(ratio + 1) keeps the feature bounded and ~zero for flat
  // slices so we don't compound noise.
  const PROBE_A = Math.round(0.0029 * sampleRate);  // ~2.9 ms
  const PROBE_B = Math.round(0.0116 * sampleRate);  // ~11.6 ms
  let sumA = 0, sumB = 0;
  const nA = Math.min(PROBE_A, N);
  const nB = Math.min(PROBE_B, N);
  for (let i = 0; i < nA; i++) {
    const v = samples[start + i];
    sumA += v * v;
  }
  for (let i = 0; i < nB; i++) {
    const v = samples[start + i];
    sumB += v * v;
  }
  const rmsA = Math.sqrt(sumA / Math.max(1, nA));
  const rmsB = Math.sqrt(sumB / Math.max(1, nB));
  const attackSlope = rmsA > 1e-8 && rmsB > 1e-8 ? Math.log(rmsA / rmsB + 1) : 0;

  // HF temporal-decay probe. Bandpass-filter the minimum slice we need
  // (onset → onset + HF_DECAY_LATE_END_MS), then measure RMS in the early
  // (0..EARLY_MS) and late (LATE_START_MS..LATE_END_MS) sub-windows. Slicing
  // before filtering keeps this cheap even for long input buffers.
  let hfDecayRatio = NaN;
  const earlyEndS   = HF_DECAY_EARLY_MS      / 1000;
  const lateStartS  = HF_DECAY_LATE_START_MS / 1000;
  const lateEndS    = HF_DECAY_LATE_END_MS   / 1000;
  const earlyEndSamp  = Math.round(earlyEndS  * sampleRate);
  const lateStartSamp = Math.round(lateStartS * sampleRate);
  const lateEndSamp   = Math.round(lateEndS   * sampleRate);
  const hfEnd = Math.min(samples.length, start + lateEndSamp);
  // Need at least a partial late window to compute the ratio.
  if (hfEnd - start > lateStartSamp) {
    const hfSlice = samples.slice(start, hfEnd);
    const hfFiltered = applyBandpassFilter(
      hfSlice, sampleRate, HF_DECAY_LO_HZ, HF_DECAY_HI_HZ,
    );
    const earlyHi = Math.min(earlyEndSamp, hfFiltered.length);
    let earlySum = 0;
    for (let i = 0; i < earlyHi; i++) {
      const v = hfFiltered[i];
      earlySum += v * v;
    }
    const earlyHfRms = Math.sqrt(earlySum / Math.max(1, earlyHi));

    const lateLo = Math.min(lateStartSamp, hfFiltered.length);
    const lateHi = Math.min(lateEndSamp,   hfFiltered.length);
    let lateSum = 0;
    for (let i = lateLo; i < lateHi; i++) {
      const v = hfFiltered[i];
      lateSum += v * v;
    }
    const lateCount  = Math.max(1, lateHi - lateLo);
    const lateHfRms  = Math.sqrt(lateSum / lateCount);
    hfDecayRatio = lateHfRms > HF_DECAY_SILENCE_FLOOR
      ? earlyHfRms / lateHfRms
      : NaN;
  }

  return {
    centroidHz:   early.centroidHz,
    rolloff85Hz:  early.rolloff85Hz,
    flatness:     early.flatness,
    zcr,
    subBandRatio: early.subBandRatio,
    preSubBandRatio,
    lateSubBandRatio,
    attackSlope,
    hfDecayRatio,
  };
}

/** Classification result — voice plus a sample-offset correction. The
 * correction is negative when we think the actual attack happened earlier than
 * the SuperFlux frame center (pre-window kick rule). Callers may apply it to
 * t.sampleIndex / t.timeSeconds for more accurate placement. */
export interface DrumClassification {
  voice:        DrumVoiceType;
  sampleOffset: number;
}

/**
 * Decision-cascade classifier.  Returns null when the onset doesn't match any
 * of the three drum voices (it'll be discarded unless explicitly enabled).
 *
 * Cascade order matters:
 *   1. KICK rule A (clean): low centroid + dominant sub-bass in early window.
 *   2. KICK rule B (under hat / clipped attack): EITHER neighbor window (pre
 *      OR late) is sub-bass dominated. This catches:
 *        - kicks under hi-hats: the late window outlasts the hat decay
 *        - kicks with clipped attacks: the pre window catches the undistorted
 *          fundamental before the SuperFlux peak frame.
 *   3. HI-HAT: high centroid, high sb[4]. zcr is intentionally NOT required —
 *      mixed-loop hi-hats often share their analysis window with the tail of
 *      a kick or snare, dragging zcr below the isolated-sample range.
 *   4. SNARE: mid centroid, sb[3] dominant, zcr below the hi-hat range.
 */
export function classifyDrumVoice(f: DrumFeatures): DrumVoiceType | null {
  return classifyDrumVoiceEx(f)?.voice ?? null;
}

export function classifyDrumVoiceEx(f: DrumFeatures): DrumClassification | null {
  // 1. Clean kick — early window's spectrum is sub-bass dominated
  if (f.centroidHz < KICK_MAX_CENTROID_HZ && f.subBandRatio[0] > KICK_MIN_SUBBAND0_RATIO) {
    return { voice: "kick", sampleOffset: 0 };
  }

  // 2. Kick beneath a simultaneous hi-hat — the early window is blended
  //    (hat raises centroid above the Rule 1 threshold), but the LATE window
  //    (23 ms after onset) catches the kick's sub-bass rumble after the short
  //    hat transient has decayed.
  //
  //    Guard: skip this rule if the early window clearly shows a pure non-kick
  //    (high centroid + high zcr + negligible sub-bass). Without this guard the
  //    pre-window of a hihat that follows a kick within ~300 ms would inherit
  //    the kick's decaying sub-bass tail and be misclassified as a kick.
  // sb[0] threshold is low (0.06) to allow simultaneous kick+hihat mixes through:
  // in those cases the kick's sub-bass is diluted but still present (~0.10–0.15).
  // Pure hihats following a kick (decaying tail in pre-window) have sb[0] ≈ 0.00–0.02.
  const earlyIsDefinitelyNotKick =
    f.centroidHz > 3000 &&
    f.zcr        > 0.10 &&
    f.subBandRatio[0] < 0.06;

  const sb = f.lateSubBandRatio;
  const lateKick =
    sb[0] >= KICK_NEIGHBOR_MIN_SUBBAND0 ||
    (sb[0] + sb[1] >= 0.50 && sb[0] >= 0.25 && sb[0] + sb[1] > sb[4] * 1.5);

  if (lateKick && !earlyIsDefinitelyNotKick) {
    return { voice: "kick", sampleOffset: 0 };
  }

  // 3. Snare — body band dominant, mid-range centroid, low zcr. Extra
  //    discriminators rolled in after empirical work on BWB + vintage breaks:
  //
  //      • sb[2] (500–2k "body") ≥ 0.08:
  //        hihats — even bright modern ones and vintage ones with centroid
  //        down at 5–7 kHz — have negligible energy in the 500–2k band
  //        (sb[2] ≈ 0.02–0.05). Snares always carry at least ~0.16 body (empirically: vintage break hihats top out at 0.156).
  //        This is the single most reliable separator when centroid, sb[3]
  //        and sb[4] overlap between the two voices.
  //
  //      • sb[2] + sb[3] ≥ sb[4]:
  //        pure hats put all their mass in sb[4]; a snare's body + snap
  //        combined always match or exceed the top band. This holds even
  //        for bright "sizzly" BWB snares where sb[4] alone tops sb[3].
  //
  //    Evaluated BEFORE the hi-hat rule so that snare+hat overlaps land on
  //    snare when the snare's body is clearly present.
  // Vintage-break hihat guard: a hit with high centroid, low body (sb[2]),
  // and snap-dominant (sb[3] > sb[4]) is a hihat position with room-acoustic
  // bleed — not a snare. Real high-centroid snares are either bodied
  // (sb[2] ≥ SNARE_VINTAGE_HAT_SB2_MAX) or sizzle-dominant (sb[4] ≥ sb[3]).
  const isVintageHatFP =
    f.centroidHz      >= SNARE_VINTAGE_HAT_CENTROID &&
    f.subBandRatio[2] <  SNARE_VINTAGE_HAT_SB2_MAX  &&
    f.subBandRatio[3] >  f.subBandRatio[4];

  // Dark-hihat via HF sustain: centroid in snare range but HF energy persists
  // far longer than a snare's ~20-30ms crack. A real snare always decays
  // quickly; a hihat's shimmer sustains well past 40ms even when closed. NaN
  // (silent late window) is treated as indeterminate — don't block snares.
  // Extra sb[3] > sb[4] guard: mirrors the existing vintage-hat asymmetry
  // pattern and avoids collapsing legit sizzle-dominant corpus snares
  // (sb[4] > sb[3]) onto this rule, which would regress corpus detection.
  // Dark vintage hihats we want to catch are snap-dominant (sb[3] > sb[4])
  // just like the existing vintage-hat FP rule above.
  const isHfSustainedHat =
    !isNaN(f.hfDecayRatio)                       &&
    f.hfDecayRatio  < HF_SUSTAIN_SNARE_MIN_DECAY &&  // HF doesn't decay fast
    f.centroidHz   >= HF_SUSTAIN_MIN_CENTROID    &&  // too bright to be a snare body
    f.subBandRatio[2] < HF_SUSTAIN_MAX_SB2        &&  // limited 500-2k body
    f.subBandRatio[3] >  f.subBandRatio[4];           // snap-dominant (empirical guard)

  // Bright-decay hat: centroid well above real snare body range, HF decays
  // fast (like a hat tick), and limited mid-body energy. The isVintageHatFP
  // guard above catches most of these but misses when sb[2] lands at exactly
  // 0.18 (the boundary). This rule closes that gap while remaining safe for
  // corpus snares that have the same centroid/decay but more body (sb[2] ≥ 0.21).
  const isBrightDecayHat =
    !isNaN(f.hfDecayRatio)                            &&
    f.centroidHz      > BRIGHT_DECAY_HAT_CENTROID_HZ  &&  // above real snare body range
    f.hfDecayRatio    > BRIGHT_DECAY_HAT_HFDECAY_MIN  &&  // fast HF decay, hat-like
    f.subBandRatio[2] < BRIGHT_DECAY_HAT_SB2_MAX      &&  // limited body energy
    f.subBandRatio[3] > f.subBandRatio[4];                // HF energy falls off (sb3>sb4 protects snares)

  // Low-centroid vintage hat: ghost hihat hits in vintage breaks land in
  // 4400–4850 Hz with high upper-mid and moderate air energy. Corpus snares
  // in this centroid range have sb4 < 0.27, so this gate is regression-safe.
  const isLowCentroidVintageHat =
    f.centroidHz      >= LOW_CENTROID_HAT_MIN_HZ  &&
    f.centroidHz      <= LOW_CENTROID_HAT_MAX_HZ  &&
    f.subBandRatio[2] <  LOW_CENTROID_HAT_SB2_MAX &&
    f.subBandRatio[3] >  f.subBandRatio[4]        &&
    f.subBandRatio[4] >= LOW_CENTROID_HAT_SB4_MIN;

  // Snap-heavy hat: centroid in the low-mid range (< 4.4 kHz) with extreme sb3
  // and limited body. Vintage-break hi-hat ticks that ring at 3.5–4.4 kHz fall
  // below every centroid-based vintage-hat guard but are betrayed by sb3/sb2
  // imbalance + elevated zcr that no real snare in this centroid range shows.
  // Centroid ceiling keeps BWB/Cymatics snares (4500–7000 Hz) unaffected.
  const isSnapHeavyHat =
    f.centroidHz      < SNAP_HEAVY_HAT_CENTROID_MAX &&
    f.subBandRatio[3] > SNAP_HEAVY_HAT_SB3_MIN      &&
    f.subBandRatio[2] < SNAP_HEAVY_HAT_SB2_MAX      &&
    f.zcr             > SNAP_HEAVY_HAT_ZCR_MIN;

  if (
    !isVintageHatFP &&
    !isHfSustainedHat &&
    !isBrightDecayHat &&
    !isLowCentroidVintageHat &&
    !isSnapHeavyHat &&
    f.centroidHz >= SNARE_MIN_CENTROID_HZ &&
    f.centroidHz <= SNARE_MAX_CENTROID_HZ &&
    f.subBandRatio[3] >= SNARE_MIN_SUBBAND3_RATIO &&
    f.subBandRatio[2] >= SNARE_MIN_SUBBAND2_RATIO &&
    (f.subBandRatio[2] + f.subBandRatio[3]) >= f.subBandRatio[4] &&
    f.zcr <= SNARE_MAX_ZCR
  ) {
    return { voice: "snare", sampleOffset: 0 };
  }

  // 4. Hi-hat — two gates:
  //    (a) bright & top-band dominated (the classic modern hat), OR
  //    (b) vintage-break hihat FP (high centroid, low body, snap-dominant), OR
  //    (c) vintage hat whose centroid dropped into snare range but body absent.
  if (
    f.centroidHz > HIHAT_MIN_CENTROID_HZ &&
    f.subBandRatio[4] > HIHAT_MIN_SUBBAND4_RATIO
  ) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (isVintageHatFP) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (isHfSustainedHat) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (isBrightDecayHat) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (isLowCentroidVintageHat) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (isSnapHeavyHat) {
    return { voice: "hihat", sampleOffset: 0 };
  }
  if (
    f.centroidHz >= 4000 &&
    f.subBandRatio[2] < SNARE_MIN_SUBBAND2_RATIO &&
    f.subBandRatio[4] >= f.subBandRatio[3] &&
    f.zcr >= 0.15
  ) {
    return { voice: "hihat", sampleOffset: 0 };
  }

  return null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Detect drum voices in an audio file, extract representative samples per velocity tier,
 * and return a DrumAnalysis ready for Drum Rack construction.
 *
 * Architecture: a single SuperFlux onset pass on the full signal finds every
 * candidate hit; each onset is then classified to exactly one voice via
 * spectral features. This avoids the broadband-bleed problem of running
 * separate per-band detectors.
 */
export function detectDrumVoices(
  filePath: string,
  bpm: number,
  sensitivity: number,    // 0–1: higher = detect more (quieter) hits
  outputDir: string,
  enabledVoices: DrumVoiceType[] = ["kick", "snare", "hihat"],
): DrumAnalysis {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const wav = parseAudio(filePath);
  // Sensitivity 0–1 maps to threshold 0.4–0.05. Drum hits should mostly clear
  // a low normalized-flux floor; we cap the upper threshold at 0.4 so even
  // sensitivity=0 keeps the soft kicks. (Old mapping was 0.05–0.95 which made
  // sens=0.5 reject any onset whose normalized flux fell below 0.5 — typical
  // for soft kicks living under loud snares/hats in a normalized loop.)
  const sensClamped = Math.max(0, Math.min(1, sensitivity));
  const threshold = 0.30 - sensClamped * 0.28;  // sens=0 → 0.30, sens=0.5 → 0.16, sens=1 → 0.02

  // ── Pass 1: detect ALL onsets on the full signal ────────────────────────────
  // Prepend a windowSize of silence so that hits landing at t=0 are detected
  // at their true position. Without this, SuperFlux's flux curve has no prev
  // frame to compare the opening hit against and misses it (or flags it many
  // frames late, when spectral change finally registers).
  const PREPAD_SAMPLES = 4096;
  const paddedSamples = new Float32Array(wav.samples.length + PREPAD_SAMPLES);
  paddedSamples.set(wav.samples, PREPAD_SAMPLES);
  const paddedWav = { ...wav, samples: paddedSamples, numSamples: paddedSamples.length };

  const rawTransients = detectTransientsSuperFlux(paddedWav, {
    bpm,
    threshold,
    windowSize: 1024,
    hopSize: 256,
    minGapSeconds: 0.04,
  });

  // Shift onsets back by the pad, clamping at 0. Onsets whose center sits
  // entirely inside the pad (sampleIndex < -PREPAD_SAMPLES) are dropped — those
  // are flux artifacts from the silence→audio boundary, not real hits.
  const transients = rawTransients
    .map(t => ({
      ...t,
      sampleIndex: t.sampleIndex - PREPAD_SAMPLES,
      timeSeconds: (t.sampleIndex - PREPAD_SAMPLES) / wav.sampleRate,
      timeBeat:    ((t.sampleIndex - PREPAD_SAMPLES) / wav.sampleRate / 60) * bpm,
    }))
    .filter(t => t.sampleIndex >= -PREPAD_SAMPLES)
    .map(t => t.sampleIndex < 0
      ? { ...t, sampleIndex: 0, timeSeconds: 0, timeBeat: 0 }
      : t);

  // ── Pass 2: classify each onset by spectral features ────────────────────────
  const enabled = new Set<DrumVoiceType>(enabledVoices);
  // Open and closed hi-hats share an identical spectral signature at onset —
  // they're distinguished only by a post-classification decay measurement (see
  // Pass 2.9 below). To let the classifier fire on openhat-only requests, we
  // internally enable "hihat" whenever "openhat" is requested. After the decay
  // pass, any leftover closed-hat hits will be discarded if the caller did not
  // enable "hihat".
  const classifierEnabled = new Set<DrumVoiceType>(enabled);
  if (classifierEnabled.has("openhat")) classifierEnabled.add("hihat");
  const hitsByVoice = new Map<DrumVoiceType, DrumHit[]>();
  for (const v of classifierEnabled) hitsByVoice.set(v, []);

  // Compute strength normalization across all classified hits so that velocity
  // remains in 1–127 even when classifier discards some onsets.
  let maxStrength = 1e-10;
  for (const t of transients) if (t.strength > maxStrength) maxStrength = t.strength;

  for (const t of transients) {
    // Shift back to the frame start so the feature window spans the attack.
    // `detectTransientsSuperFlux` reports the window CENTER; analyzing from
    // there forward would entirely miss the attack transient.
    const featureIdx = Math.max(0, t.sampleIndex - ONSET_DETECTOR_HALF_WINDOW);
    const features = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
    if (!features) continue;

    const result = classifyDrumVoiceEx(features);
    if (!result || !classifierEnabled.has(result.voice)) continue;
    const { voice, sampleOffset } = result;

    // For kicks detected via the pre-window rule, walk backwards in 256-sample
    // steps until the sub-bass signature disappears, then use that position as
    // the kick's true attack time. SuperFlux is notoriously late on kicks with
    // heavy clipping (square-wave-like tops hide the actual transient); the
    // pre-window classifier fires, and a backwards walk finds the attack.
    let walkedOffset = sampleOffset;
    if (voice === "kick" && sampleOffset < 0) {
      const STEP = 256;
      const MAX_WALK = Math.round(0.185 * wav.sampleRate);  // cap at ~185ms
      let probeIdx = t.sampleIndex + walkedOffset;
      while (probeIdx - STEP >= 0 && t.sampleIndex - (probeIdx - STEP) <= MAX_WALK) {
        const probeF = computeDrumFeatures(
          wav.samples, wav.sampleRate, probeIdx - STEP, NEIGHBOR_WINDOW_SIZE,
        );
        if (!probeF) break;
        // Stop when the sub-bass signature weakens OR the window goes silent.
        if (probeF.subBandRatio[0] < KICK_NEIGHBOR_MIN_SUBBAND0 * 0.8) break;
        probeIdx -= STEP;
      }
      walkedOffset = probeIdx - t.sampleIndex;
    }

    const adjSample  = Math.max(0, t.sampleIndex + walkedOffset);
    const adjSeconds = adjSample / wav.sampleRate;
    const adjBeat    = (adjSeconds / 60) * bpm;

    const norm = t.strength / maxStrength;
    hitsByVoice.get(voice)!.push({
      timeSeconds: adjSeconds,
      timeBeat:    adjBeat,
      sampleIndex: adjSample,
      strength:    norm,
      velocity:    Math.max(1, Math.min(127, Math.round(norm * 127))),
      voice,
    });

    // Hi-hat co-detection: when a kick or snare onset also contains
    // significant high-frequency 6k–20k content, an overlapping hi-hat is
    // present at the same moment.  Emit a hihat hit too so the drum rack
    // captures the full pattern (otherwise hat patterns that line up with
    // every kick/snare downbeat would miss half their hits).
    //
    // Discriminator (early window): sb[4] ≥ 0.40 AND sb[4] ≥ sb[3] AND
    // centroid ≥ 5500 Hz.  Tuning notes:
    //   • isolated snare → sb[3] ≈ 0.40, sb[4] ≈ 0.30 — sb[4]≥sb[3] fails,
    //     no false hi-hat emitted (snare's own splash isn't a hat).
    //   • snare+hat       → sb[4] ≈ 0.45, sb[3] ≈ 0.35 — sb[4]≥sb[3] passes.
    //   • kick alone      → sb[4] ≈ 0.00 — fails the 0.40 floor.
    //   • kick+hat        → sb[4] ≈ 0.55 — passes (centroid up at ~9 kHz).
    // Hi-hat co-detection. Voice-specific rules so we can be more
    // permissive for kicks (no spectral content above 6 kHz unless a hat
    // really is there) without inviting false positives from snares (the
    // snare's own splash easily reaches 0.20 in the top band on its own).
    let coDetectHat = false;
    if (voice === "kick") {
      // Kick + hat: kick has near-zero zcr and tiny sb[4] alone (~0.05).
      // Anything above sb[4] ≥ 0.18 with sb[4] >= sb[3] indicates the hat
      // is sitting on top.
      coDetectHat =
        features.subBandRatio[4] >= 0.18 &&
        features.subBandRatio[4] >= features.subBandRatio[3];
    } else if (voice === "snare") {
      // Snare + hat: a clean snare's sb[4] ≈ 0.20–0.30. A hat sitting on
      // top of it pushes sb[4] past 0.30 and the centroid past 5500.
      coDetectHat =
        (features.subBandRatio[4] >= 0.40 &&
         features.subBandRatio[4] >= features.subBandRatio[3] &&
         features.centroidHz      >= 5500)
        ||
        (features.subBandRatio[4] >= 0.30 &&
         features.subBandRatio[4] >= features.subBandRatio[3] &&
         features.centroidHz      >= 4500);
    }
    if (coDetectHat && classifierEnabled.has("hihat")) {
      hitsByVoice.get("hihat")!.push({
        timeSeconds: t.timeSeconds,
        timeBeat:    t.timeBeat,
        sampleIndex: t.sampleIndex,
        strength:    norm,
        velocity:    Math.max(1, Math.min(127, Math.round(norm * 127))),
        voice:       "hihat",
      });
    }
  }

  // Per-voice dedup: after classification, two onsets of the same voice within
  // MIN_SAME_VOICE_GAP_SECONDS are folded into one — keeping the stronger of
  // the two.  Necessary because a single kick attack often generates two
  // SuperFlux peaks (the clipped-square transient and the low-frequency
  // rumble), both of which pass the kick classifier.
  const MIN_SAME_VOICE_GAP_SECONDS: Record<DrumVoiceType, number> = {
    // Kick dedup is the wide one: a single clipped kick often produces TWO
    // SuperFlux peaks ~140–170ms apart (flux from transition into kick, flux
    // from kick → decay). 180ms = safe; still allows 16ths at 200 BPM.
    kick:  0.18,
    // Snare gap kept narrow so flams (grace 10–30 ms before main) survive
    // as two distinct hits. The SuperFlux minGapSeconds=0.04 above is the
    // real lower bound on detectable spacing.
    snare:   0.04,
    hihat:   0.05,   // SuperFlux minGap already handles most of this
    // Open hats get a wider gap because their sustained decay can produce
    // secondary SuperFlux peaks. They never fire faster than a quarter note
    // in practice; 0.10 s accommodates up to 600 BPM 16ths (overkill).
    openhat: 0.10,
  };
  for (const [voice, hits] of hitsByVoice) {
    if (hits.length < 2) continue;
    hits.sort((a, b) => a.sampleIndex - b.sampleIndex);
    const minGap = MIN_SAME_VOICE_GAP_SECONDS[voice];
    const kept: DrumHit[] = [];
    for (const h of hits) {
      const prev = kept[kept.length - 1];
      if (prev && (h.sampleIndex - prev.sampleIndex) / wav.sampleRate < minGap) {
        // Fold into prev. Keep the earlier (already in `kept`) for the time
        // position, but promote to the stronger velocity.
        if (h.strength > prev.strength) {
          kept[kept.length - 1] = { ...prev, strength: h.strength, velocity: h.velocity };
        }
      } else {
        kept.push(h);
      }
    }
    hitsByVoice.set(voice, kept);
  }

  // ── Pass 2.5: per-band supplementary SuperFlux ─────────────────────────────
  // The full-signal SuperFlux + feature classifier can miss hits that share
  // time with a louder voice (classic case: a kick on the downbeat with a
  // hi-hat always on — the full-signal flux is dominated by the hi-hat, and
  // the feature window classifies the onset as a hat). A per-band SuperFlux
  // on a band-filtered copy of the signal recovers those buried hits.
  //
  // Strategy: run SuperFlux on each band, and for every band onset that
  // doesn't already have ANY hit of ANY voice within COINCIDENCE_WINDOW_S,
  // consider adding it as a hit of this band's voice. Stringent sanity
  // checks protect against false positives: a missed hit must (a) have clear
  // energy in its own band and (b) have its own band's energy be a
  // meaningful fraction of the full-signal energy at that time (so a snare
  // artefact of a kick's band-limited tail doesn't register).
  //
  // We only run this supplementary pass for the KICK band: that's the case
  // where the classifier is most vulnerable (kicks under hi-hats). The
  // snare and hi-hat bands overlap too much with other voices — running
  // supplementary detection there creates more false positives than it
  // solves missed detections.
  const SUPPLEMENTARY_VOICES = new Set<DrumVoiceType>(["kick"]);
  for (const { voice: bandVoice, loHz, hiHz } of MULTIBAND_RANGES) {
    if (!enabled.has(bandVoice)) continue;
    if (!SUPPLEMENTARY_VOICES.has(bandVoice)) continue;

    const bandFilteredRaw = applyBandpassFilter(wav.samples, wav.sampleRate, loHz, hiHz);
    const bandPadded = new Float32Array(bandFilteredRaw.length + PREPAD_SAMPLES);
    bandPadded.set(bandFilteredRaw, PREPAD_SAMPLES);
    const bandPaddedWav = {
      ...wav,
      samples:    bandPadded,
      numSamples: bandPadded.length,
    };

    const bandRaw = detectTransientsSuperFlux(bandPaddedWav, {
      bpm,
      threshold: Math.max(0.05, threshold * 0.9),
      windowSize: 1024,
      hopSize: 256,
      minGapSeconds: 0.04,
    });

    // Match the main pass: onsets landing inside the pad get clamped to
    // t=0 instead of being dropped. Loops whose opening hit fires exactly
    // at t=0 only ever produce a flux peak a few hundred samples into the
    // pad — if we filtered those out, every "beat-zero kick" would vanish.
    const bandTransients = bandRaw
      .map(t => ({
        ...t,
        sampleIndex: t.sampleIndex - PREPAD_SAMPLES,
        timeSeconds: (t.sampleIndex - PREPAD_SAMPLES) / wav.sampleRate,
        timeBeat:    ((t.sampleIndex - PREPAD_SAMPLES) / wav.sampleRate / 60) * bpm,
      }))
      .filter(t => t.sampleIndex >= -PREPAD_SAMPLES)
      .map(t => t.sampleIndex < 0
        ? { ...t, sampleIndex: 0, timeSeconds: 0, timeBeat: 0 }
        : t);

    const voiceHits = hitsByVoice.get(bandVoice) ?? [];

    for (const bt of bandTransients) {
      // Skip if this band's voice already has a hit near here (we already
      // found it via the full-signal pass). Recompute each iteration so that
      // hits added in THIS band pass don't suppress close-but-distinct hits
      // (e.g. a snare flam grace note 15 ms earlier should not block the main).
      const existingHits = allKeptHitsOf(hitsByVoice);
      const nearbyHits   = existingHits.filter(
        h => Math.abs(h.timeSeconds - bt.timeSeconds) <= COINCIDENCE_WINDOW_S,
      );
      if (nearbyHits.some(h => h.voice === bandVoice)) continue;

      // For the KICK supplementary pass: don't add a kick if the full-signal
      // classifier already chose SNARE here — that classifier requires sb[2]
      // ≥ 0.08 + sb[3] dominance + (sb[2]+sb[3]) ≥ sb[4], none of which a
      // pure kick satisfies, so trust it. For the SNARE supplementary pass:
      // don't add a snare if a kick is already here (kicks have low-band
      // energy that can leak into the snare band — trust the kick decision).
      if (bandVoice === "kick" && nearbyHits.some(h => h.voice === "snare")) continue;
      if (bandVoice === "snare" && nearbyHits.some(h => h.voice === "kick")) continue;

      // Sanity 1: the band must have meaningful energy at this onset.
      const bandAmp = measureOnsetAmplitude(wav.samples, wav.sampleRate, bt.sampleIndex, bandVoice);
      if (bandAmp < 0.02) continue;

      // Sanity 2: this band must be a substantial fraction of the broadband
      // energy at this moment. If the band is merely catching the tail of
      // an overlapping voice, its ratio to full-signal peak will be small.
      const broadbandAmp = measureBroadbandAmplitude(wav.samples, wav.sampleRate, bt.sampleIndex);
      if (broadbandAmp > 1e-6 && bandAmp / broadbandAmp < 0.15) continue;

      // Sanity 3 (voice-specific): require the voice's band to dominate the
      // most-likely-confusable band at this moment. The widePeak helper
      // looks over 60 ms centred near the onset so the check catches the
      // band's true peak even if it lags the SuperFlux onset frame.
      const widePeak = (lo: number, hi: number): number => {
        const W   = Math.round(0.060 * wav.sampleRate);
        const s   = Math.max(0, bt.sampleIndex - Math.round(0.005 * wav.sampleRate));
        const end = Math.min(s + W, wav.samples.length);
        const sl  = wav.samples.slice(s, end);
        const fl  = applyBandpassFilter(sl, wav.sampleRate, lo, hi);
        let p = 0; for (const v of fl) if (Math.abs(v) > p) p = Math.abs(v); return p;
      };
      if (bandVoice === "kick") {
        // Reject snare bodies leaking into the kick band: a real kick has
        // sub-bass energy ≥ 30% of its full snare-band content.
        const kickBandPeak  = widePeak(20, 250);
        const snareBandPeak = widePeak(150, 6000);
        if (snareBandPeak > 1e-6 && kickBandPeak / snareBandPeak < 0.30) continue;
        // And require sub-bass mass in the spectral feature windows.
        // A snare with body bleed has sb[0] ≈ 0.02–0.05 in every window;
        // a real kick is at ≥ 0.10 in at least one of early / late / pre.
        const fk = computeDrumFeatures(wav.samples, wav.sampleRate, bt.sampleIndex);
        if (fk) {
          const lowMass = Math.max(
            fk.subBandRatio[0],
            fk.lateSubBandRatio[0],
            fk.preSubBandRatio[0],
          );
          if (lowMass < 0.10) continue;
          // Guard against kick-tail artifacts: a hit whose EARLY-window sub-bass
          // is negligible (< 0.06) is inheriting its lowMass from the pre/late
          // windows of a decaying nearby kick, not from its own attack frame.
          // Real missed kicks always have sub-bass in their own early window.
          if (fk.subBandRatio[0] < 0.06) continue;
        }
      } else if (bandVoice === "snare") {
        // Reject hi-hat ticks leaking into the snare band's upper edge.
        // A real snare has 180–4k content ≥ 50% of its 4k–16k content.
        const snareBodyPeak = widePeak(180, 4000);
        const hatBandPeak   = widePeak(4000, 16000);
        if (hatBandPeak > 1e-6 && snareBodyPeak / hatBandPeak < 0.50) continue;
        // And reject pure kick rumble: snare body must outweigh the kick band.
        const kickBandPeak2 = widePeak(20, 180);
        if (kickBandPeak2 > 1e-6 && snareBodyPeak / kickBandPeak2 < 0.6) continue;
      }

      const newHit: DrumHit = {
        timeSeconds: bt.timeSeconds,
        timeBeat:    bt.timeBeat,
        sampleIndex: Math.max(0, bt.sampleIndex),
        strength:    0, // amplitudes are re-normalised in Pass 2.75 below
        velocity:    1,
        voice:       bandVoice,
      };
      voiceHits.push(newHit);

      // Hi-hat co-detection for supplementary kick / snare hits. If there's
      // significant 6k–20k content at this moment (typical for a hi-hat
      // sharing the downbeat) and no hat hit is already registered nearby,
      // emit one. This mirrors the full-signal co-detection path; without
      // it, kicks-under-hats (or snares-under-hats) re-discovered by the
      // per-band pass would never get their companion hi-hats.
      const feats = computeDrumFeatures(wav.samples, wav.sampleRate, bt.sampleIndex);
      if (feats && classifierEnabled.has("hihat") && bandVoice !== "hihat") {
        const hatHits = hitsByVoice.get("hihat") ?? [];
        const hatNear = hatHits.some(
          h => Math.abs(h.timeSeconds - bt.timeSeconds) <= COINCIDENCE_WINDOW_S,
        );
        if (!hatNear &&
            feats.subBandRatio[4] >= 0.35 &&
            feats.subBandRatio[4] >= feats.subBandRatio[3] &&
            feats.centroidHz      >= 5000) {
          const newHatHit: DrumHit = {
            timeSeconds: bt.timeSeconds,
            timeBeat:    bt.timeBeat,
            sampleIndex: Math.max(0, bt.sampleIndex),
            strength:    0,
            velocity:    1,
            voice:       "hihat",
          };
          hatHits.push(newHatHit);
          existingHits.push(newHatHit);
          hitsByVoice.set("hihat", hatHits);
        }
      }
    }

    // Re-sort and re-dedup this voice now that we may have injected new hits.
    voiceHits.sort((a, b) => a.sampleIndex - b.sampleIndex);
    const minGap = MIN_SAME_VOICE_GAP_SECONDS[bandVoice];
    const deduped: DrumHit[] = [];
    for (const h of voiceHits) {
      const prev = deduped[deduped.length - 1];
      if (prev && (h.sampleIndex - prev.sampleIndex) / wav.sampleRate < minGap) {
        if (h.strength > prev.strength) {
          deduped[deduped.length - 1] = { ...prev, strength: h.strength, velocity: h.velocity };
        }
      } else {
        deduped.push(h);
      }
    }
    hitsByVoice.set(bandVoice, deduped);
  }

  // ── Pass 2.6: snare flam detection ──────────────────────────────────────────
  // A flam is two snare hits 10–35 ms apart (grace + main). At the standard
  // SuperFlux window/hop size both hits collapse into one onset; the FFT
  // window is wider than the gap. To recover the second hit we compute a
  // short-window energy envelope on the snare body band immediately after
  // every detected snare and look for a second peak > 60 % of the first peak
  // within 35 ms. If found, emit a second snare hit there.
  if (enabled.has("snare")) {
    const snareHits = hitsByVoice.get("snare") ?? [];
    if (snareHits.length > 0) {
      const snareBand = applyBandpassFilter(wav.samples, wav.sampleRate, 180, 4000);
      const FRAME = Math.round(0.0015 * wav.sampleRate);  // ~1.5 ms RMS frame
      // The detected snare can be 5–15 ms ahead of the actual attack
      // (SuperFlux frame center lags). Scan a wider initial window for
      // the grace peak, then look for the main peak after a dip.
      const ATTACK_WINDOW_MS = 25;
      const TAIL_WINDOW_MS   = 50;
      const attackOff = Math.round(ATTACK_WINDOW_MS * wav.sampleRate / 1000);
      const tailOff   = Math.round(TAIL_WINDOW_MS   * wav.sampleRate / 1000);
      // The main note must dwarf the grace: in real flams, main is 1.3–3×
      // the grace peak. A normal snare's decay sometimes briefly re-peaks
      // (sympathetic body resonance) but rarely above the original peak.
      const MAIN_PEAK_RATIO = 1.30;
      const DIP_RATIO       = 0.55;
      const newHits: DrumHit[] = [];

      const frameRms = (frameIdxStart: number): number => {
        let s = 0;
        for (let i = 0; i < FRAME; i++) {
          const v = snareBand[frameIdxStart + i] || 0;
          s += v * v;
        }
        return Math.sqrt(s / FRAME);
      };

      for (let hIdx = 0; hIdx < snareHits.length; hIdx++) {
        const h = snareHits[hIdx];
        // h.sampleIndex is at the detector's frame CENTER — shift back to frame
        // start so the grace-peak attack window actually covers the first (grace)
        // hit rather than landing inside the main note's attack. Never back up
        // past the previous snare hit, or we'd search through its decay tail.
        const prevSnareEnd = hIdx > 0 ? snareHits[hIdx - 1].sampleIndex + 1 : 0;
        const probeStart = Math.max(prevSnareEnd, h.sampleIndex - ONSET_DETECTOR_HALF_WINDOW);
        const attackEnd  = Math.min(probeStart + attackOff,            snareBand.length);
        const probeEnd   = Math.min(probeStart + attackOff + tailOff,  snareBand.length);
        if (probeEnd - probeStart < FRAME * 4) continue;

        // 1) Find the grace peak in the attack window (0–25 ms).
        let firstPeak = 0;
        let firstFrame = 0;
        const attackFrames = Math.floor((attackEnd - probeStart) / FRAME);
        for (let f = 0; f < attackFrames; f++) {
          const r = frameRms(probeStart + f * FRAME);
          if (r > firstPeak) { firstPeak = r; firstFrame = f; }
        }
        if (firstPeak < 1e-4) continue;

        // 2) Walk forward from the grace peak: require a dip below
        //    DIP_RATIO × firstPeak followed by a new local max ≥
        //    PEAK_RATIO × firstPeak. This is the main note.
        let dipped = false;
        let bestPeak = 0;
        let bestFrame = -1;
        const totalFrames = Math.floor((probeEnd - probeStart) / FRAME);
        for (let f = firstFrame + 1; f < totalFrames; f++) {
          const r = frameRms(probeStart + f * FRAME);
          if (r < firstPeak * DIP_RATIO) dipped = true;
          if (dipped && r > bestPeak) { bestPeak = r; bestFrame = f; }
        }
        if (bestFrame < 0 || bestPeak < firstPeak * MAIN_PEAK_RATIO) continue;

        const flamSampleIdx = probeStart + bestFrame * FRAME;
        // Skip if too close to an existing snare (avoid duplicating the
        // same hit when probe windows overlap).
        if (snareHits.some(o => Math.abs(o.sampleIndex - flamSampleIdx) <= FRAME * 2)) continue;

        // Reject if the candidate looks like a hi-hat rather than a snare grace
        // note — snap-heavy/body-light positions are hi-hat ticks near the
        // snare attack, not real flams.
        const flamFeatures = computeDrumFeatures(wav.samples, wav.sampleRate,
          Math.max(0, flamSampleIdx - ONSET_DETECTOR_HALF_WINDOW));
        if (flamFeatures) {
          const flamClass = classifyDrumVoiceEx(flamFeatures);
          if (flamClass && flamClass.voice !== "snare") continue;
        }

        const flamSeconds = flamSampleIdx / wav.sampleRate;
        const flamBeat   = (flamSeconds / 60) * bpm;
        newHits.push({
          timeSeconds: flamSeconds,
          timeBeat:    flamBeat,
          sampleIndex: flamSampleIdx,
          strength:    h.strength,                   // re-normalised in Pass 2.75
          velocity:    h.velocity,
          voice:       "snare",
        });
      }

      if (newHits.length > 0) {
        snareHits.push(...newHits);
        snareHits.sort((a, b) => a.sampleIndex - b.sampleIndex);
        hitsByVoice.set("snare", snareHits);
      }
    }
  }

  // ── Pass 2.6: doublet-kick rescue ───────────────────────────────────────────
  // SuperFlux misses a second kick 80–350ms after a first because the sub-bass
  // band is still elevated from hit 1 — the onset has low positive flux despite
  // a real amplitude rise. We scan the kick-band RMS envelope for a dip-then-
  // rise signature after each detected kick.
  if (enabled.has("kick")) {
    const kickBand = applyBandpassFilter(wav.samples, wav.sampleRate, 20, 250);
    const FRAME_KB = Math.round(0.0058 * wav.sampleRate);  // ~5.8 ms RMS frame
    const frameRmsKick = (si: number): number => {
      let s = 0;
      const end = Math.min(si + FRAME_KB, kickBand.length);
      for (let i = si; i < end; i++) s += kickBand[i] * kickBand[i];
      return Math.sqrt(s / FRAME_KB);
    };

    // Minimum gap = 1 sixteenth note at the current tempo. Resonance tails of a
    // BWB-style kick sample produce secondary peaks at sub-sixteenth intervals
    // (~130ms at 100 BPM) — excluding anything shorter than one sixteenth
    // cleanly separates tails from real back-to-back kick hits.
    const DOUBLET_MIN_GAP_S = 60 / (bpm * 4);
    const DOUBLET_MAX_GAP_S = 0.35;
    const DIP_RISE_RATIO    = 1.15;  // secondary peak must be ≥15% above its preceding dip
    const MIN_PEAK_RATIO    = 0.40;  // secondary peak at least 40% of first kick's peak
    const SUPPRESS_WINDOW_S = 0.04;  // skip if a hit already exists within 40ms

    const kickHits = [...(hitsByVoice.get("kick") ?? [])];
    const newKickHits: DrumHit[] = [];

    // Build the shared hit list ONCE; push accepted new hits into it as we go
    // so the per-iteration dedup check stays O(1) in list construction.
    const allHits = allKeptHitsOf(hitsByVoice);

    for (const h of kickHits) {
      const searchStart = h.sampleIndex + Math.round(DOUBLET_MIN_GAP_S * wav.sampleRate);
      const searchEnd   = Math.min(
        h.sampleIndex + Math.round(DOUBLET_MAX_GAP_S * wav.sampleRate),
        kickBand.length - FRAME_KB,
      );
      if (searchStart >= searchEnd) continue;

      // First-peak RMS: measured over the first 40ms of this kick.
      const initEnd = Math.min(h.sampleIndex + Math.round(0.040 * wav.sampleRate), kickBand.length);
      let firstPeak = 0;
      for (let si = h.sampleIndex; si < initEnd; si += FRAME_KB)
        firstPeak = Math.max(firstPeak, frameRmsKick(si));
      if (firstPeak < 1e-5) continue;

      // Walk forward: track dip level, then look for a rise above the dip.
      let dipLevel  = firstPeak;
      let bestPeak  = 0;
      let bestSi    = -1;
      for (let si = searchStart; si < searchEnd; si += FRAME_KB) {
        const r = frameRmsKick(si);
        if (r < dipLevel) dipLevel = r;
        if (r > dipLevel * DIP_RISE_RATIO && r > firstPeak * MIN_PEAK_RATIO) {
          if (r > bestPeak) { bestPeak = r; bestSi = si; }
        }
      }
      if (bestSi < 0) continue;

      // Peak-to-dip ratio: a real second kick causes a meaningful dip in the
      // kick band before the secondary rise (the band decays between hits).
      // BWB sample resonance oscillations have shallow dip-to-peak swings
      // (the "dip" is just a minor oscillation on the decay tail).
      // Require the secondary peak to be ≥ 3× the minimum seen in the search
      // window (the dip). Real doublets: ~3.5–10×; resonance: ~1.3–2×.
      const peakToDip = dipLevel > 1e-8 ? bestPeak / dipLevel : 0;
      if (peakToDip < 5.0) continue;

      // Skip if any voice already has a hit nearby (allHits is mutated below
      // as we accept new doublet hits, so this single check covers both the
      // pre-existing detections and the just-added doublets from this loop).
      const suppressSamples = Math.round(SUPPRESS_WINDOW_S * wav.sampleRate);
      if (allHits.some(e => Math.abs(e.sampleIndex - bestSi) < suppressSamples)) continue;

      const t = bestSi / wav.sampleRate;
      const newKickHit: DrumHit = {
        timeSeconds: t,
        timeBeat:    (t / 60) * bpm,
        sampleIndex: bestSi,
        strength:    bestPeak / firstPeak,
        velocity:    Math.max(1, Math.min(127, Math.round((bestPeak / firstPeak) * 127))),
        voice:       "kick",
      };
      newKickHits.push(newKickHit);
      allHits.push(newKickHit);
    }

    if (newKickHits.length > 0) {
      const merged = [...kickHits, ...newKickHits].sort((a, b) => a.sampleIndex - b.sampleIndex);
      hitsByVoice.set("kick", merged);
    }
  }

  // ── Pass 2.75: amplitude-based velocity ─────────────────────────────────────
  // Replace the SuperFlux-strength-derived velocity with an amplitude-based
  // measurement taken from a short band-limited window at the onset. This is
  // what a human hears as "loud" vs "soft" and scales linearly with the
  // signal; SuperFlux strength is a frequency-domain delta and can under- or
  // over-report real loudness depending on the spectral context.
  for (const [voice, hits] of hitsByVoice) {
    if (hits.length === 0) continue;
    const amps = new Float32Array(hits.length);
    let maxAmp = 1e-10;
    for (let i = 0; i < hits.length; i++) {
      amps[i] = measureOnsetAmplitude(wav.samples, wav.sampleRate, hits[i].sampleIndex, voice);
      if (amps[i] > maxAmp) maxAmp = amps[i];
    }
    for (let i = 0; i < hits.length; i++) {
      const normAmp = amps[i] / maxAmp;
      hits[i] = {
        ...hits[i],
        strength: normAmp,
        velocity: Math.max(1, Math.min(127, Math.round(normAmp * 127))),
      };
    }
    hitsByVoice.set(voice, hits);
  }

  // ── Pass 2.8: correct hit timing to true onset ────────────────────────────
  // SuperFlux reports the onset at the spectral-flux peak, which is typically
  // 10–40 ms after the actual transient start. Scan back up to 50 ms before
  // each detection to find where the signal first crosses the per-voice
  // threshold. This aligns MIDI note placement (and sample start) with the
  // perceptual onset rather than the detection lag.
  //
  // After correction: re-sort and re-dedup per voice. Backward correction can
  // pull a hit past the boundary of the previous dedup window, violating the
  // gap invariant established in Pass 2.
  for (const [voice, hits] of hitsByVoice) {
    // Hits are sorted by sampleIndex at this point. Apply onset correction with
    // lookback bounded by the previous same-voice hit so we can't pull a hit
    // back past (or into) a preceding hit from the same voice.
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const prevHitEndSample = i > 0 ? hits[i - 1].sampleIndex + 1 : 0;
      const originalSampleIndex = h.sampleIndex;

      // Step 1 — backward scan: correct for SuperFlux detection lag.
      // findTrueOnset measures localPeak over a short 10 ms window, which can
      // underestimate the true peak for slow-attack voices. When the threshold
      // is too low the scan overshoots into pre-attack noise, placing the MIDI
      // note earlier than the audible onset.
      const backwardIdx = findTrueOnset(
        wav.samples, wav.sampleRate, originalSampleIndex, h.voice, prevHitEndSample,
      );

      // Step 2 — forward scan: find the actual threshold crossing using a
      // localPeak measured over the full attack window (backwardIdx …
      // h.sampleIndex + ONSET_LOOKBACK_S). The wider window captures the true
      // peak, giving a correctly scaled threshold and an onset that matches
      // what the listener hears.
      const forwardBound = Math.min(
        originalSampleIndex + Math.round(ONSET_LOOKBACK_S * wav.sampleRate),
        wav.samples.length,
      );
      const forwardResult = findOnsetStart(wav.samples, backwardIdx, forwardBound, h.voice);

      // If the forward scan couldn't advance (localPeak below noise floor,
      // so findOnsetStart returned startIdx unchanged), the overshot backward
      // position is worse than the original SuperFlux point — findDecayEnd
      // would measure attack RMS from pre-attack silence and return the full
      // max-duration window. Fall back to the original SuperFlux detection.
      const finalIdx = (forwardResult === backwardIdx && backwardIdx < originalSampleIndex)
        ? originalSampleIndex
        : forwardResult;

      if (finalIdx !== originalSampleIndex) {
        const finalSeconds = finalIdx / wav.sampleRate;
        hits[i] = {
          ...h,
          sampleIndex: finalIdx,
          timeSeconds: finalSeconds,
          timeBeat:    (finalSeconds / 60) * bpm,
        };
      }
    }

    // Re-sort (backward correction can invert order when two hits are close)
    hits.sort((a, b) => a.sampleIndex - b.sampleIndex);

    // Re-dedup: backward correction can violate the gap invariant. After
    // findTrueOnset moves hits backward by up to ONSET_LOOKBACK_S, two hits
    // that were ≥ minGap apart pre-correction can be as close as
    // minGap - 2*ONSET_LOOKBACK_S post-correction. Using the raw minGap here
    // would collapse legitimate back-to-back hits (e.g. 16ths at 200 BPM,
    // or snare flams added by Pass 2.6 that are 10–30 ms apart).
    //
    // We only need to fold hits that Pass 2.8 correction itself pulled
    // artificially close — i.e. hits that were above Pass 2's dedup floor
    // (MIN_SAME_VOICE_GAP_SECONDS[voice]) before correction but fell below
    // it afterward. Subtracting 2*ONSET_LOOKBACK_S models that worst case.
    // Bound the result below by 0 so we never collapse Pass-2.6-inserted
    // flams / doublets whose true spacing is inside the SuperFlux minimum.
    //
    // Note: at very fast tempos (≥200 BPM), 16th-note doublet-rescue hits
    // (75 ms apart) can land within minGap28 and be collapsed. This is an
    // accepted limitation — narrowing minGap28 further risks letting
    // SuperFlux double-peaks from a single kick attack survive dedup.
    const minGap = MIN_SAME_VOICE_GAP_SECONDS[voice];
    const minGap28 = Math.max(minGap - 2 * ONSET_LOOKBACK_S, 0);
    const deduped28: DrumHit[] = [];
    for (const h of hits) {
      const prev = deduped28[deduped28.length - 1];
      if (prev && (h.sampleIndex - prev.sampleIndex) / wav.sampleRate < minGap28) {
        if (h.strength > prev.strength) {
          deduped28[deduped28.length - 1] = { ...prev, strength: h.strength, velocity: h.velocity };
        }
      } else {
        deduped28.push(h);
      }
    }
    hitsByVoice.set(voice, deduped28);
  }

  // ── Pass 2.9: open-hihat reclassification ──────────────────────────────────
  // Open and closed hi-hats share identical onset spectral signatures — both
  // are high-frequency, broad-spectrum transients. The reliable discriminator
  // is the post-onset decay in the 4–16 kHz band: closed hats decay to
  // noise-floor in well under 100 ms; open hats sustain for 150 ms+.
  //
  // Empirical measurements on BWB SZN 26 + Cymatics IMMORTAL one-shots (50
  // files, see /tmp/measure-decay.ts):
  //   • Closed hats:  RMS-15% decay  17 ms (min) — 87 ms (max)
  //   • Open hats:    RMS-15% decay 168 ms (min) — 586 ms (max)
  // A 100 ms threshold cleanly separates both populations (0 misclassifications).
  //
  // Measurement: walk an RMS-smoothed envelope of the 4–16 kHz band from each
  // detected hihat onset. Peak RMS is taken over the first 25 ms (the attack
  // region) and then we find the first frame where RMS drops below 15% of that
  // peak AND stays below for 2 consecutive frames (~11 ms) — matching the
  // style of findDecayEnd elsewhere in this file.
  const OPENHAT_DECAY_THRESHOLD_S  = 0.100; // decay > 100 ms → openhat
  const OPENHAT_PEAK_WINDOW_S      = 0.025; // peak RMS measured over first 25 ms
  const OPENHAT_MEASURE_WINDOW_S   = 0.300; // bound the decay search at 300 ms
  const OPENHAT_DECAY_DROP         = 0.15;  // 15% of peak RMS
  const OPENHAT_SUSTAIN_FRAMES     = 2;     // frames below threshold in a row

  if (enabled.has("openhat")) {
    const hatBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);
    const hatHits = hitsByVoice.get("hihat") ?? [];
    const keepClosed: DrumHit[] = [];
    const openHits:   DrumHit[] = [];

    const FRAME  = DECAY_FRAME_SAMPLES; // 256 samples ≈ 5.8 ms at 44.1 kHz
    const peakFrameCount    = Math.max(1, Math.floor(
      OPENHAT_PEAK_WINDOW_S * wav.sampleRate / FRAME,
    ));
    const measureFrameCount = Math.max(1, Math.floor(
      OPENHAT_MEASURE_WINDOW_S * wav.sampleRate / FRAME,
    ));

    const frameRms = (start: number): number => {
      let s = 0;
      const end = Math.min(start + FRAME, hatBand.length);
      for (let i = start; i < end; i++) s += hatBand[i] * hatBand[i];
      return Math.sqrt(s / FRAME);
    };

    // Local helper: measure HF decay length starting at `startSample`.
    // Returns the time in seconds at which RMS drops below 15% of the
    // peak for 2 consecutive frames, or OPENHAT_MEASURE_WINDOW_S if
    // it never does.
    const measureHfDecayS = (startSample: number): number => {
      let peakRms = 0;
      for (let f = 0; f < peakFrameCount; f++) {
        const s = startSample + f * FRAME;
        if (s + FRAME > hatBand.length) break;
        const r = frameRms(s);
        if (r > peakRms) peakRms = r;
      }
      if (peakRms < 1e-6) return 0;
      const thr = peakRms * OPENHAT_DECAY_DROP;
      let below = 0;
      let decayFrame = measureFrameCount;
      for (let f = peakFrameCount; f < measureFrameCount; f++) {
        const s = startSample + f * FRAME;
        if (s + FRAME > hatBand.length) break;
        const r = frameRms(s);
        if (r < thr) {
          below++;
          if (below >= OPENHAT_SUSTAIN_FRAMES) { decayFrame = f - OPENHAT_SUSTAIN_FRAMES + 1; break; }
        } else below = 0;
      }
      return (decayFrame * FRAME) / wav.sampleRate;
    };

    for (const h of hatHits) {
      // Primary probe: start at the hit's sampleIndex (the transient onset).
      // Secondary probe: start ONSET_DETECTOR_HALF_WINDOW samples later.
      // When a hat is co-detected with a kick, h.sampleIndex points to the
      // kick's transient center. The kick's brief HF click inflates the peak
      // and causes the hat's longer sustain to look like it falls below the
      // threshold early. The secondary probe starts after the click has
      // subsided, giving a more accurate read on the hat's actual sustain.
      const decayS = Math.max(
        measureHfDecayS(h.sampleIndex),
        measureHfDecayS(h.sampleIndex + ONSET_DETECTOR_HALF_WINDOW),
      );
      if (decayS > OPENHAT_DECAY_THRESHOLD_S) {
        openHits.push({ ...h, voice: "openhat" });
      } else {
        keepClosed.push(h);
      }
    }

    // Caller requested openhat detection: always register the (possibly empty)
    // openhat bucket. If the caller did NOT also request closed hihat, discard
    // the closed hits — we were only running hihat detection internally so the
    // openhat reclassifier had something to work on.
    hitsByVoice.set("openhat", openHits);
    if (enabled.has("hihat")) {
      hitsByVoice.set("hihat", keepClosed);
    } else {
      hitsByVoice.delete("hihat");
    }
  }

  // ── Pass 2.95: spectral masked-hihat rescue ──────────────────────────────
  // A hihat that fires simultaneously with a kick or snare is often missed by
  // the spectral classifier (and the co-detection rules in Pass 2 are
  // intentionally conservative to avoid false positives from snare "splash").
  // However, the 4–16 kHz RMS at a hybrid kick+hat or snare+hat onset is
  // measurably elevated compared to a "clean" kick/snare, where no hihat is
  // present. We:
  //   1. Measure the "clean" HF baseline from kicks/snares that already have
  //      no co-occurring hihat.
  //   2. Establish an HF reference from already-detected hihats to calibrate
  //      the rescued-hit velocity.
  //   3. For each kick/snare without a co-detected hihat, measure HF RMS and
  //      — if it's well above baseline — synthesise a hihat hit at that
  //      moment, classifying open vs closed by post-onset decay (same rule
  //      as Pass 2.9).
  //
  // This is a more robust recovery path than pattern extrapolation: it works
  // on irregular grooves and relies on audio evidence directly.
  if (enabled.has("hihat") || enabled.has("openhat")) {
    const hfBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);
    const kickHits  = hitsByVoice.get("kick")    ?? [];
    const snareHits = hitsByVoice.get("snare")   ?? [];
    const hatHits   = hitsByVoice.get("hihat")   ?? [];
    const openHits  = hitsByVoice.get("openhat") ?? [];
    const existingHats: DrumHit[] = [...hatHits, ...openHits]
      .sort((a, b) => a.sampleIndex - b.sampleIndex);

    const coincidenceSamples = Math.round(COINCIDENCE_WINDOW_S * wav.sampleRate);

    // Fast "is there already a hihat within ±COINCIDENCE_WINDOW_S?" check.
    const hasCooccurringHat = (sampleIdx: number): boolean => {
      // Linear scan is fine for typical <100 hihats per loop; avoids the
      // complexity of a binary-search helper for a sub-millisecond hot path.
      for (const h of existingHats) {
        if (Math.abs(h.sampleIndex - sampleIdx) <= coincidenceSamples) return true;
      }
      return false;
    };

    // Split kick+snare into "clean" (no hihat on top — useful for baseline)
    // and "rescue candidates" (no hihat on top AND need evaluation — same set
    // here, but the distinction keeps the algorithm readable).
    const kickSnareHits = [...kickHits, ...snareHits]
      .sort((a, b) => a.sampleIndex - b.sampleIndex);
    const cleanRefs = kickSnareHits.filter(h => !hasCooccurringHat(h.sampleIndex));

    // Need ≥ 2 clean references to establish a stable baseline and ≥ 1
    // detected hihat to calibrate the rescued-hit velocity scale. Bail
    // cheaply if either is missing.
    if (cleanRefs.length >= 2 && existingHats.length >= 1) {
      const RMS_WINDOW = 512;

      const baselineSamples = cleanRefs.map(h => windowRms(hfBand, h.sampleIndex, RMS_WINDOW));
      const hatSamples      = existingHats.map(h => windowRms(hfBand, h.sampleIndex, RMS_WINDOW));
      const hfBaseline      = median(baselineSamples);
      const hfHatReference  = median(hatSamples);

      // Decay-classification reuses the open-hat logic from Pass 2.9 (same
      // frame size, same 100 ms threshold, same sustain/drop ratios). Copied
      // here rather than refactored to keep Pass 2.9's tight local scope.
      const FRAME = DECAY_FRAME_SAMPLES;
      const PEAK_WINDOW_S    = 0.025;
      const MEASURE_WINDOW_S = 0.300;
      const DECAY_DROP       = 0.15;
      const SUSTAIN_FRAMES   = 2;
      const DECAY_THRESHOLD_S = 0.100;
      const peakFrameCount    = Math.max(1, Math.floor(PEAK_WINDOW_S    * wav.sampleRate / FRAME));
      const measureFrameCount = Math.max(1, Math.floor(MEASURE_WINDOW_S * wav.sampleRate / FRAME));

      const frameRms = (start: number): number => {
        let s = 0;
        const endIdx = Math.min(start + FRAME, hfBand.length);
        for (let i = start; i < endIdx; i++) s += hfBand[i] * hfBand[i];
        return Math.sqrt(s / FRAME);
      };

      const measureDecayS = (startSample: number): number => {
        let peakRms = 0;
        for (let f = 0; f < peakFrameCount; f++) {
          const start = startSample + f * FRAME;
          if (start + FRAME > hfBand.length) break;
          const r = frameRms(start);
          if (r > peakRms) peakRms = r;
        }
        if (peakRms < 1e-6) return 0;
        const threshold = peakRms * DECAY_DROP;
        let below = 0;
        let decayFrame = measureFrameCount;
        for (let f = peakFrameCount; f < measureFrameCount; f++) {
          const start = startSample + f * FRAME;
          if (start + FRAME > hfBand.length) break;
          const r = frameRms(start);
          if (r < threshold) {
            below++;
            if (below >= SUSTAIN_FRAMES) { decayFrame = f - SUSTAIN_FRAMES + 1; break; }
          } else below = 0;
        }
        return (decayFrame * FRAME) / wav.sampleRate;
      };

      // Dual-probe: measure decay from sampleIdx AND from sampleIdx+ONSET_DETECTOR_HALF_WINDOW.
      // When a hat co-occurs with a kick, the sampleIdx points to the kick's transient
      // center. The kick's brief HF click inflates the peak, making the hat's longer
      // sustain look short. The secondary probe starts after the click has settled,
      // giving an accurate read on the hat's true decay.
      const classifyDecay = (sampleIdx: number): "hihat" | "openhat" => {
        const decayS = Math.max(
          measureDecayS(sampleIdx),
          measureDecayS(sampleIdx + ONSET_DETECTOR_HALF_WINDOW),
        );
        return decayS > DECAY_THRESHOLD_S ? "openhat" : "hihat";
      };

      // Rescue loop: each kick/snare without a co-occurring hihat is a
      // candidate. If the HF energy at its position is ≥ HF_RESCUE_RATIO ×
      // baseline, we infer a masked hihat there.
      const rescued: { voice: "hihat" | "openhat"; hit: DrumHit }[] = [];
      for (const h of kickSnareHits) {
        if (hasCooccurringHat(h.sampleIndex)) continue;
        const hfEnergy = windowRms(hfBand, h.sampleIndex, RMS_WINDOW);
        if (hfEnergy <= hfBaseline * HF_RESCUE_RATIO) continue;

        const inferredVoice = classifyDecay(h.sampleIndex);
        // Respect the caller's enabled-voice set: if the classified voice
        // isn't requested, drop the rescue entirely (don't silently
        // reclassify, which would mask the openhat/hihat distinction).
        if (!enabled.has(inferredVoice)) continue;

        // Velocity calibration: HF energy relative to the detected-hat
        // reference, scaled to 127, then capped so a noisy spike can't
        // manufacture a 127-velocity hat.
        const velRaw = hfHatReference > 0
          ? Math.round(127 * hfEnergy / hfHatReference)
          : 60;
        const velocity = Math.max(1, Math.min(HF_RESCUE_MAX_VEL, velRaw));

        rescued.push({
          voice: inferredVoice,
          hit: {
            timeSeconds: h.timeSeconds,
            timeBeat:    h.timeBeat,
            sampleIndex: h.sampleIndex,
            strength:    velocity / 127,
            velocity,
            voice:       inferredVoice,
            synthetic:   true,
          },
        });
      }

      if (rescued.length > 0) {
        for (const r of rescued) {
          const bucket = hitsByVoice.get(r.voice) ?? [];
          bucket.push(r.hit);
          hitsByVoice.set(r.voice, bucket);
        }
        // Re-sort hihat/openhat buckets now that rescued hits are merged in.
        for (const v of ["hihat", "openhat"] as const) {
          const bucket = hitsByVoice.get(v);
          if (bucket) bucket.sort((a, b) => a.sampleIndex - b.sampleIndex);
        }
      }
    }
  }

  // ── Pass 2.97: contextual reclassification ────────────────────────────────
  // Loop-level context-aware cleanup of per-hit classification errors. Runs
  // AFTER all detection/rescue/reclassification passes and BEFORE sample
  // extraction so reclassified hits are extracted from the correct voice's
  // bucket. See `contextualReclassify` for signal details.
  {
    const durationBeatsCtx = wav.numSamples / wav.sampleRate * bpm / 60;
    const barsCtx          = Math.max(1, Math.round(durationBeatsCtx / 4));
    contextualReclassify(hitsByVoice, { totalBeats: barsCtx * 4, bpm }, enabled);
  }

  // ── Pass 3: build tiers and extract samples ─────────────────────────────────
  const voices: DrumVoice[] = [];
  let totalBeats = 0;

  // Build a flat list of all kept hits for sample-extraction boundary detection.
  const allKeptHits: DrumHit[] = [];
  for (const v of enabledVoices) allKeptHits.push(...(hitsByVoice.get(v) ?? []));
  allKeptHits.sort((a, b) => a.sampleIndex - b.sampleIndex);

  for (const voiceType of enabledVoices) {
    const hits = (hitsByVoice.get(voiceType) ?? []).slice().sort((a, b) => a.sampleIndex - b.sampleIndex);
    if (hits.length === 0) continue;

    totalBeats = Math.max(totalBeats, hits[hits.length - 1].timeBeat + 1);

    // Identify "clean" hits: previous same-voice hit is > CLEAN_GAP_SECONDS away
    // AND no loud cross-voice hit within CROSS_VOICE_CLEAN_SECONDS before this
    // hit (e.g. a kick 170ms after a snare inherits snare body in its sample).
    const crossVoiceContaminators: DrumVoiceType[] =
      voiceType === "kick"    ? ["snare"] :
      voiceType === "snare"   ? ["kick"]  :
      voiceType === "openhat" ? ["kick", "snare"] :
      // Hihats co-detected with a snare or kick share the same onset — the
      // extracted sample starts with the louder voice, not the hat. Use a
      // ±window check (not strictly-before) so same-sampleIndex pairs are caught.
      voiceType === "hihat"   ? ["snare", "kick"] :
      [];
    const cleanHits = hits.filter((h, i) => {
      if (i > 0 && h.timeSeconds - hits[i - 1].timeSeconds < CLEAN_GAP_SECONDS) return false;
      if (crossVoiceContaminators.length > 0) {
        for (const cv of crossVoiceContaminators) {
          const cvHits = allKeptHits.filter(x => x.voice === cv);
          if (voiceType === "hihat") {
            // Use a tight bidirectional window: co-detected hihats fire at the
            // same sampleIndex as the triggering snare/kick — the strictly-before
            // filter misses them. 30ms catches simultaneous co-detections without
            // rejecting hihats that legitimately follow a snare by a 16th note.
            const HIHAT_CODET_WINDOW = 0.030;
            const nearest = cvHits.reduce<DrumHit | null>((best, x) => {
              const d = Math.abs(x.timeSeconds - h.timeSeconds);
              return best === null || d < Math.abs(best.timeSeconds - h.timeSeconds) ? x : best;
            }, null);
            if (nearest && Math.abs(nearest.timeSeconds - h.timeSeconds) < HIHAT_CODET_WINDOW) return false;
          } else {
            const justBefore = cvHits.filter(x => x.sampleIndex < h.sampleIndex);
            if (justBefore.length > 0) {
              const nearest = justBefore[justBefore.length - 1];
              if (h.timeSeconds - nearest.timeSeconds < CROSS_VOICE_CLEAN_SECONDS) return false;
            }
          }
        }
      }
      return true;
    });

    const nTiers = tierCount(hits.length);
    const ranges = TIER_RANGES[nTiers];

    const sortedByStrength = [...cleanHits].sort((a, b) => b.strength - a.strength);
    const chunkSize = Math.ceil(sortedByStrength.length / nTiers);

    const tiers: VelocityTier[] = ranges.map(([velMin, velMax], tierIdx) => {
      const tierHits = sortedByStrength.slice(
        (nTiers - 1 - tierIdx) * chunkSize,
        (nTiers - tierIdx) * chunkSize,
      );

      const midStrength = ((velMin + velMax) / 2) / 127;
      tierHits.sort((a, b) => Math.abs(a.strength - midStrength) - Math.abs(b.strength - midStrength));

      const selected = tierHits.slice(0, MAX_SAMPLES_PER_TIER);
      const samples: DrumSample[] = selected.map((hit, sampleIdx) => {
        const samplePath = join(outputDir, `${voiceType}_t${tierIdx}_s${sampleIdx}.wav`);
        extractHitSample(
          wav.samples, wav.sampleRate, hit, allKeptHits, samplePath,
          tierIdx, nTiers,
        );
        return { filePath: samplePath, strength: hit.strength };
      });

      return { velMin, velMax, samples };
    }).filter(tier => tier.samples.length > 0);

    voices.push({ voice: voiceType, midiNote: MIDI_NOTE[voiceType], tiers, hits });
  }

  // Derive loop length from the audio file duration (most accurate) and round
  // to the nearest whole bar (4 beats). Using hit timing would add up to one
  // beat of padding and produces non-integer bar counts.
  const durationBeats = wav.numSamples / wav.sampleRate * bpm / 60;
  const bars          = Math.max(1, Math.round(durationBeats / 4));
  return { voices, bpm, totalBeats: bars * 4 };
}

/**
 * Scan backward from a SuperFlux detection position to find where the signal
 * first crossed the per-voice threshold. Returns a corrected sample index that
 * is earlier than (or equal to) `sampleIndex`. This corrects for SuperFlux
 * detection lag so that MIDI note timing and sample start are both anchored to
 * the true transient onset.
 *
 * `minScanStart` bounds the backward scan at the previous same-voice hit's
 * sample position + 1, preventing the corrected index from landing at or
 * before the prior hit. It does not prevent the scan window from including
 * that hit's decay tail in the localPeak measurement.
 */
function findTrueOnset(
  allSamples:   Float32Array,
  sampleRate:   number,
  sampleIndex:  number,
  voice:        string,
  minScanStart: number = 0,
): number {
  const lookback  = Math.round(ONSET_LOOKBACK_S * sampleRate);
  const scanStart = Math.max(minScanStart, sampleIndex - lookback);

  // Peak measured over the attack window: from the frame start (sampleIndex
  // minus the B6 half-window offset) to 10 ms after the frame start. The
  // incoming sampleIndex is the SuperFlux frame CENTER — for sharp-attack
  // voices (hihats, snares) the attack has already decayed by that point,
  // so measuring from there would underestimate the peak and let the
  // backward scan overshoot. Anchoring at the frame start keeps the
  // measurement on the attack itself.
  const attackStart = Math.max(scanStart, sampleIndex - ONSET_DETECTOR_HALF_WINDOW);
  const peakEnd = Math.min(allSamples.length, attackStart + Math.round(0.010 * sampleRate));
  let localPeak = 0;
  for (let i = attackStart; i < peakEnd; i++) {
    const v = Math.abs(allSamples[i]);
    if (v > localPeak) localPeak = v;
  }
  if (localPeak < ONSET_SCAN_ABS) return sampleIndex;

  const rel       = ONSET_SCAN_REL[voice] ?? 0.01;
  const threshold = localPeak * rel;

  // Scan backward from detection to find where the signal first crossed
  // the threshold. The onset is just after the last sample below threshold.
  for (let i = sampleIndex; i >= scanStart; i--) {
    if (Math.abs(allSamples[i]) < threshold) {
      return Math.min(i + 1, sampleIndex);
    }
  }
  // Signal was above threshold throughout the scan window. If the scan was
  // bounded by the previous same-voice hit (minScanStart clamped scanStart
  // above the raw lookback boundary), the above-threshold signal is almost
  // certainly the prior hit's decay tail — snapping to scanStart there would
  // collapse the current hit onto the prior hit (e.g. flam grace/main pairs).
  // In that case trust the original SuperFlux position.
  if (scanStart === minScanStart && minScanStart > sampleIndex - lookback) {
    return sampleIndex;
  }
  return scanStart;
}

function findOnsetStart(
  allSamples: Float32Array,
  startIdx:   number,
  endIdx:     number,
  voice:      string,
): number {
  // Scan the full extraction window — no distance cap. findTrueOnset may push
  // startIdx backward by up to ONSET_LOOKBACK_S (50 ms) before the actual
  // transient; capping the forward scan shorter than that leaves silence at the
  // top of the extracted WAV. endIdx is already bounded by the next same-voice
  // onset and the per-voice max duration, so scanning to endIdx is safe.
  let localPeak = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const v = Math.abs(allSamples[i]);
    if (v > localPeak) localPeak = v;
  }
  if (localPeak < ONSET_SCAN_ABS) return startIdx;  // too quiet — don't trim

  const rel = ONSET_SCAN_REL[voice] ?? 0.01;
  const threshold = localPeak * rel;
  for (let i = startIdx; i < endIdx; i++) {
    if (Math.abs(allSamples[i]) > threshold) return i;
  }
  return startIdx;
}

function extractHitSample(
  allSamples:  Float32Array,
  sampleRate:  number,
  hit:         DrumHit,
  allHits:     DrumHit[],
  outPath:     string,
  tierIdx:     number,
  nTiers:      number,
): void {
  const maxDurationSamples = Math.round(MAX_HIT_SECONDS[hit.voice] * sampleRate);

  // Cap at the next onset of the SAME voice (not any voice), so dense hi-hat
  // patterns don't shorten kick/snare samples.
  const nextSameVoiceHit = allHits.find(
    h => h.voice === hit.voice && h.sampleIndex > hit.sampleIndex,
  );
  let nextOnsetSample = nextSameVoiceHit ? nextSameVoiceHit.sampleIndex : allSamples.length;

  // Cross-voice bleed cap: also cap at the next onset of loud competing voices
  // to prevent audible transients from being included in the extracted sample.
  // For openhat: cap at next hihat/kick/snare (a hihat tick or snare after an
  // openhat is clearly a new note, not part of the openhat's ring).
  // For kick: cap at next snare (prevents snare body bleeding into kick tail).
  // Hihats are already short enough that same-voice capping suffices.
  const BLEED_CAP_VOICES: Partial<Record<DrumVoiceType, DrumVoiceType[]>> = {
    openhat: ["kick", "snare", "hihat"],
    kick:    ["snare"],
  };
  const bleedVoices = BLEED_CAP_VOICES[hit.voice] ?? [];
  for (const bv of bleedVoices) {
    const nextBleed = allHits.find(h => h.voice === bv && h.sampleIndex > hit.sampleIndex);
    if (nextBleed && nextBleed.sampleIndex < nextOnsetSample) {
      nextOnsetSample = nextBleed.sampleIndex;
    }
  }

  // hit.sampleIndex is the forward-corrected onset from the Pass 2.8 onset
  // correction phase (findTrueOnset backward + findOnsetStart forward). Both
  // MIDI timing and decay detection use this as the true transient start.
  const endIdx = findDecayEnd(
    allSamples, sampleRate, hit.sampleIndex,
    hit.voice, nextOnsetSample, maxDurationSamples,
  );
  const startIdx = hit.sampleIndex;

  const slice = allSamples.slice(startIdx, endIdx);
  const copy  = new Float32Array(slice);

  // Short fade-in (~0.7 ms) from zero to prevent a click at the hard start.
  const fadeLen = Math.min(copy.length, ONSET_FADE_IN_SAMPLES);
  for (let i = 0; i < fadeLen; i++) copy[i] *= i / fadeLen;

  // Tier-based peak normalization. A track with a single tier is normalized
  // to –3 dBFS; multi-tier voices spread targets so softer tiers really sound
  // softer at the output stage.
  const targets = TIER_PEAK_DBFS[nTiers] ?? TIER_PEAK_DBFS[1];
  const targetDbfs = targets[Math.min(tierIdx, targets.length - 1)];
  normalizeToPeakDbfs(copy, targetDbfs);

  applyFadeOut(copy, sampleRate);
  writeWav(outPath, copy, sampleRate);
}
