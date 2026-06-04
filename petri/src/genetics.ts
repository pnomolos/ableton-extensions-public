import type { MidiNote } from "@arclight/core";

// Intervals (semitones from root) for Ableton's built-in scale names
const SCALE_INTERVALS: Record<string, number[]> = {
  "Major":            [0,2,4,5,7,9,11],
  "Minor":            [0,2,3,5,7,8,10],
  "Dorian":           [0,2,3,5,7,9,10],
  "Phrygian":         [0,1,3,5,7,8,10],
  "Lydian":           [0,2,4,6,7,9,11],
  "Mixolydian":       [0,2,4,5,7,9,10],
  "Locrian":          [0,1,3,5,6,8,10],
  "Harmonic Minor":   [0,2,3,5,7,8,11],
  "Melodic Minor":    [0,2,3,5,7,9,11],
  "Pentatonic Major": [0,2,4,7,9],
  "Pentatonic Minor": [0,3,5,7,10],
  "Blues":            [0,3,5,6,7,10],
  "Whole Tone":       [0,2,4,6,8,10],
  "Diminished":       [0,2,3,5,6,8,9,11],
  "Chromatic":        [0,1,2,3,4,5,6,7,8,9,10,11],
};

export function getScaleIntervals(scaleName: string): number[] {
  return SCALE_INTERVALS[scaleName] ?? SCALE_INTERVALS["Major"];
}

export function snapToScale(pitch: number, rootNote: number, intervals: number[]): number {
  // Build all valid pitches 0-127
  const valid: number[] = [];
  for (let oct = -1; oct <= 10; oct++) {
    for (const interval of intervals) {
      const p = rootNote + interval + oct * 12;
      if (p >= 0 && p <= 127) valid.push(p);
    }
  }
  // Nearest
  return valid.reduce((best, p) => Math.abs(p - pitch) < Math.abs(best - pitch) ? p : best, valid[0]);
}

export function breedClips(
  notesA: MidiNote[],
  notesB: MidiNote[],
  mutationRate: number,
  seed: number
): MidiNote[] {
  const rng = seededRng(seed);
  const sortedA = [...notesA].sort((a, b) => a.startTime - b.startTime);
  const sortedB = [...notesB].sort((a, b) => a.startTime - b.startTime);

  if (sortedA.length === 0 || sortedB.length === 0) return [];

  return sortedB.map((beatNote, i) => {
    const pitchNote = sortedA[i % sortedA.length];
    const note: MidiNote = {
      pitch: pitchNote.pitch,
      startTime: beatNote.startTime,
      duration: beatNote.duration,
      velocity: Math.round((pitchNote.velocity + beatNote.velocity) / 2),
    };
    return applyBreedMutation(note, mutationRate, rng);
  });
}

export function mutateClip(
  notes: MidiNote[],
  rate: number,
  opts: { pitch: boolean; timing: boolean; duration: boolean; velocity: boolean },
  seed: number,
  scaleInfo?: { rootNote: number; intervals: number[] }
): MidiNote[] {
  const rng = seededRng(seed);
  return notes.map(note => {
    if (rng() >= rate) return note;
    return applyMutateStep({ ...note }, rng, opts, scaleInfo);
  });
}

// Fixed-amount mutation — matches webview JS exactly for Mutate Again consistency
function applyMutateStep(
  note: MidiNote,
  rng: () => number,
  opts: { pitch: boolean; timing: boolean; duration: boolean; velocity: boolean },
  scaleInfo?: { rootNote: number; intervals: number[] }
): MidiNote {
  const n = { ...note };
  if (opts.pitch && rng() < 0.8) {
    const nudged = clamp(n.pitch + Math.round((rng() - 0.5) * 10), 0, 127);
    n.pitch = scaleInfo ? snapToScale(nudged, scaleInfo.rootNote, scaleInfo.intervals) : nudged;
  }
  if (opts.timing   && rng() < 0.7) n.startTime = Math.max(0, n.startTime + (rng() - 0.5) * 0.18);
  if (opts.duration && rng() < 0.7) n.duration  = Math.max(0.0625, n.duration * (0.7 + rng() * 0.6));
  if (opts.velocity && rng() < 0.8) n.velocity  = clamp(n.velocity + Math.round((rng() - 0.5) * 44), 1, 127);
  return n;
}

// Intensity-scaled mutation — for breeding, slider controls how much
function applyBreedMutation(note: MidiNote, intensity: number, rng: () => number): MidiNote {
  const n = { ...note };
  if (rng() < intensity) n.pitch     = clamp(n.pitch + Math.round((rng() - 0.5) * 8 * intensity), 0, 127);
  if (rng() < intensity) n.startTime = Math.max(0, n.startTime + (rng() - 0.5) * 0.15 * intensity);
  if (rng() < intensity) n.duration  = Math.max(0.0625, n.duration * (0.75 + rng() * 0.5 * intensity));
  if (rng() < intensity) n.velocity  = clamp(n.velocity + Math.round((rng() - 0.5) * 40 * intensity), 1, 127);
  return n;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function seededRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    return (s >>> 0) / 0xffffffff;
  };
}
