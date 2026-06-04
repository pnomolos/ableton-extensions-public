import type { MidiNote, TransientFrame, WarpMarkerData, GrooveProfile, FrequencyBand, AudioGrooveOptions } from "./types.js";
import { parseAudio, applyBandpassFilter, detectTransients } from "./transient-detector.js";

/**
 * Convert detected transients to warp markers that quantize audio to a grid.
 */
export function transientFramesToWarpMarkers(
  transients: TransientFrame[],
  audioStartSeconds: number,
  gridSubdivision: number,
  humanizeAmount = 0,
  clipStartBeat = 0,
): WarpMarkerData[] {
  return transients.map(t => {
    const beatInClip = t.timeBeat;
    const nearestGrid = Math.round(beatInClip / gridSubdivision) * gridSubdivision;
    const offset = beatInClip - nearestGrid;
    const quantizedBeat = nearestGrid + offset * humanizeAmount;
    return {
      beatTime: clipStartBeat + quantizedBeat,
      sampleTime: audioStartSeconds + t.timeSeconds,
    };
  });
}

/**
 * Detect the best-fit grid resolution for a set of MIDI notes.
 * Scores each candidate by mean (deviation / resolution)^2 — normalised so
 * finer grids don't automatically win just by having smaller absolute errors.
 */
export function detectOptimalResolution(notes: MidiNote[]): number {
  if (notes.length === 0) return 0.25;

  const CANDIDATES = [1.0, 0.5, 0.25, 0.125, 1 / 3, 1 / 6];

  let bestRes = 0.25;
  let bestScore = Infinity;

  for (const res of CANDIDATES) {
    let total = 0;
    for (const note of notes) {
      const nearest = Math.round(note.startTime / res) * res;
      const dev = note.startTime - nearest;
      total += (dev / res) ** 2;
    }
    const score = total / notes.length;
    if (score < bestScore) {
      bestScore = score;
      bestRes = res;
    }
  }
  return bestRes;
}

// Interpolate null slots from nearest non-null neighbours (circular), shared by both profile functions.
function interpolateSlots(raw: (number | null)[]): number[] {
  const n = raw.length;
  if (n === 0) return [];
  const filledIdx = raw.map((v, i) => v !== null ? i : -1).filter(i => i >= 0);
  if (filledIdx.length === 0) return raw.map(() => 0);
  return raw.map((v, i) => {
    if (v !== null) return v;
    let prevIdx = -1, nextIdx = -1;
    for (let k = 1; k <= n; k++) {
      if (prevIdx < 0 && raw[(i - k + n) % n] !== null) prevIdx = (i - k + n) % n;
      if (nextIdx < 0 && raw[(i + k) % n] !== null)     nextIdx = (i + k) % n;
      if (prevIdx >= 0 && nextIdx >= 0) break;
    }
    if (prevIdx < 0 && nextIdx < 0) return 0;
    if (prevIdx < 0) return raw[nextIdx] as number;
    if (nextIdx < 0) return raw[prevIdx] as number;
    const distPrev = (i - prevIdx + n) % n;
    const distNext = (nextIdx - i + n) % n;
    const total = distPrev + distNext;
    return ((raw[prevIdx] as number) * distNext + (raw[nextIdx] as number) * distPrev) / total;
  });
}

/**
 * Compute a groove profile from detected transients (audio-derived).
 * Captures both timing offsets and per-slot velocity character derived from
 * each transient's onset strength (spectral flux peak), which correlates with
 * hit loudness — loud kicks/snares have high strength, ghost notes have low.
 */
export function computeGrooveProfile(
  transients: TransientFrame[],
  bpm: number,
  resolution = 0.25,
  name = "Extracted Groove",
): GrooveProfile {
  const numPositions = Math.ceil(
    (transients[transients.length - 1]?.timeBeat ?? 0) / resolution
  ) + 1;

  const offsets         = new Array(numPositions).fill(0) as number[];
  const strengthAccum   = new Array(numPositions).fill(0) as number[];
  const strengthCount   = new Array(numPositions).fill(0) as number[];

  for (const t of transients) {
    const gridPos = Math.round(t.timeBeat / resolution);
    if (gridPos < numPositions) {
      offsets[gridPos] = t.timeBeat - gridPos * resolution;
      strengthAccum[gridPos] += t.strength;
      strengthCount[gridPos]++;
    }
  }

  const evenOffsets = offsets.filter((_, i) => i % 2 === 0);
  const oddOffsets  = offsets.filter((_, i) => i % 2 === 1);
  const avgEven = evenOffsets.reduce((a, b) => a + b, 0) / (evenOffsets.length || 1);
  const avgOdd  = oddOffsets.reduce((a, b) => a + b, 0) / (oddOffsets.length || 1);
  const swingAmount = Math.min(Math.max((avgOdd - avgEven) / (resolution * 0.5) + 0.5, 0), 1);

  const meanStrength = transients.reduce((s, t) => s + t.strength, 0) / (transients.length || 1);
  const rawVelOffsets = strengthAccum.map((sum, i): number | null => {
    if (strengthCount[i] === 0) return null;
    const avg = sum / strengthCount[i];
    return Math.max(-1, Math.min(1, (avg - meanStrength) / (meanStrength || 1)));
  });
  const velocityOffsets = interpolateSlots(rawVelOffsets);

  return {
    id: `groove_${Date.now()}`,
    name,
    createdAt: new Date().toISOString(),
    tempo: bpm,
    resolution,
    offsets,
    velocityOffsets,
    swingAmount,
    version: 1,
  };
}

/**
 * Extract a groove profile from MIDI note timings.
 *
 * Measures each note's deviation from the nearest grid point, averaged per
 * slot within one bar (16 slots for 1/16 in 4/4, repeating over multi-bar clips).
 * Also captures per-slot velocity character.
 *
 * @param resolution  Pass null to auto-detect from the notes.
 */
export function computeGrooveFromMidi(
  notes: MidiNote[],
  bpm = 0,
  resolution: number | null = 0.25,
  barLength = 4,
  name = "Extracted Groove",
): GrooveProfile {
  const res = resolution ?? detectOptimalResolution(notes);
  const numSlots = Math.max(1, Math.round(barLength / res));

  const offsetAccum  = new Array(numSlots).fill(0) as number[];
  const offsetCount  = new Array(numSlots).fill(0) as number[];
  const velAccum     = new Array(numSlots).fill(0) as number[];
  const velCount     = new Array(numSlots).fill(0) as number[];

  const meanVelocity = notes.reduce((s, n) => s + n.velocity, 0) / (notes.length || 1);

  for (const note of notes) {
    const nearestGrid = Math.round(note.startTime / res) * res;
    const deviation   = note.startTime - nearestGrid;
    const gridPos     = Math.round(nearestGrid / res);
    const slot        = gridPos % numSlots;

    offsetAccum[slot] += deviation;
    offsetCount[slot]++;

    velAccum[slot] += note.velocity - meanVelocity;
    velCount[slot]++;
  }

  const rawOffsets = offsetAccum.map((sum, i) =>
    offsetCount[i] > 0 ? sum / offsetCount[i] : null
  ) as (number | null)[];

  const rawVelOffsets = velAccum.map((sum, i) => {
    if (velCount[i] === 0) return null;
    const raw = sum / velCount[i] / (meanVelocity || 64);
    return Math.max(-1, Math.min(1, raw));
  }) as (number | null)[];

  const offsets        = interpolateSlots(rawOffsets);
  const velocityOffsets = interpolateSlots(rawVelOffsets);

  // Swing: compare even vs odd slot offsets
  const evenOff = offsets.filter((_, i) => i % 2 === 0);
  const oddOff  = offsets.filter((_, i) => i % 2 === 1);
  const avgEven = evenOff.reduce((a, b) => a + b, 0) / (evenOff.length || 1);
  const avgOdd  = oddOff.reduce((a, b) => a + b, 0) / (oddOff.length || 1);
  const swingAmount = Math.min(Math.max((avgOdd - avgEven) / (res * 0.5) + 0.5, 0), 1);

  return {
    id: `groove_${Date.now()}`,
    name,
    createdAt: new Date().toISOString(),
    tempo: bpm,
    resolution: res,
    offsets,
    velocityOffsets,
    swingAmount,
    version: 1,
  };
}

/**
 * Apply groove timing to MIDI notes.
 * Blends between original position (strength=0) and fully-grooved (strength=1).
 * The groove pattern repeats every bar (modulo on groove.offsets.length).
 *
 * When two notes would land within MIN_GAP beats of each other after grooving,
 * the later one is nudged forward to maintain separation (preserving note order).
 */
export function applyGrooveToNotes(
  notes: Array<{ startTime: number; [key: string]: unknown }>,
  groove: GrooveProfile,
  strength = 1.0,
): number[] {
  const MIN_GAP = 0.01; // ~5ms at 120 BPM — imperceptible but prevents overlap

  const rawPositions = notes.map(note => {
    const gridPos     = Math.round(note.startTime / groove.resolution);
    const idx         = gridPos % groove.offsets.length;
    const gridTime    = gridPos * groove.resolution;
    const groovedTime = gridTime + groove.offsets[idx];
    return note.startTime + (groovedTime - note.startTime) * strength;
  });

  // Sort by grooved position, sweep forward to enforce minimum gap, restore original order
  const indexed = rawPositions.map((pos, i) => ({ pos, i }));
  indexed.sort((a, b) => a.pos - b.pos);

  let cursor = -Infinity;
  for (const item of indexed) {
    if (item.pos < cursor) item.pos = cursor;
    cursor = item.pos + MIN_GAP;
  }

  const result = new Array<number>(notes.length);
  for (const item of indexed) result[item.i] = item.pos;
  return result;
}

const BAND_HZ: Record<FrequencyBand, [number, number]> = {
  kick:  [20,    200],
  snare: [200,   2000],
  hihat: [2000,  20000],
  full:  [20,    20000],
};

/**
 * Extract a groove profile from an audio file.
 * Applies bandpass filtering to isolate the chosen frequency band, then runs
 * spectral flux onset detection and folds transients into a groove profile.
 */
export function computeGrooveFromAudio(
  filePath: string,
  opts: AudioGrooveOptions,
): GrooveProfile {
  const { band, bpm, resolution, sensitivity, name } = opts;

  const wav = parseAudio(filePath);

  const [lowHz, highHz] = BAND_HZ[band];
  const samples = band === "full"
    ? wav.samples
    : applyBandpassFilter(wav.samples, wav.sampleRate, lowHz, highHz);

  // sensitivity 0–1 → threshold 0.95–0.05 (inverted: more sensitive = lower threshold)
  const threshold = 1 - Math.max(0.05, Math.min(0.95, sensitivity));
  const transients = detectTransients(
    { ...wav, samples },
    { bpm, threshold, windowSize: 512, hopSize: 256 },
  );

  return computeGrooveProfile(transients, bpm, resolution, name);
}

/**
 * Apply groove velocity character to MIDI notes.
 * Returns new velocity values (caller must clamp to 1–127 and round).
 * strength=0 → no change; strength=1 → full velocity offsets applied.
 */
export function applyVelocityGroove(
  notes: Array<{ startTime: number; velocity: number; [key: string]: unknown }>,
  groove: GrooveProfile,
  strength = 1.0,
): number[] {
  const velOffsets = groove.velocityOffsets;
  if (!velOffsets || velOffsets.length === 0) return notes.map(n => n.velocity);

  const meanVelocity = notes.reduce((s, n) => s + n.velocity, 0) / (notes.length || 1);

  return notes.map(note => {
    const gridPos = Math.round(note.startTime / groove.resolution);
    const idx = gridPos % velOffsets.length;
    return note.velocity + velOffsets[idx] * meanVelocity * strength;
  });
}
