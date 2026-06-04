// Music theory tables shared between parser (for `'` chord shorthand) and
// patterns.ts (for the `scale` method and `chord` constructor).

import { noteNameToMidi } from "./notes.js";

// Semitone offsets from the root, for each scale degree.
export const SCALES: Record<string, number[]> = {
  major:           [0, 2, 4, 5, 7, 9, 11],
  minor:           [0, 2, 3, 5, 7, 8, 10],   // natural minor
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  phrygian:        [0, 1, 3, 5, 7, 8, 10],
  lydian:          [0, 2, 4, 6, 7, 9, 11],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  aeolian:         [0, 2, 3, 5, 7, 8, 10],   // alias for natural minor
  locrian:         [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
  melodicMinor:    [0, 2, 3, 5, 7, 9, 11],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues:           [0, 3, 5, 6, 7, 10],
  chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

// Semitone intervals from the root for each chord type.
export const CHORDS: Record<string, number[]> = {
  // Triads
  maj:   [0, 4, 7],
  min:   [0, 3, 7],
  m:     [0, 3, 7],          // alias for min
  dim:   [0, 3, 6],
  aug:   [0, 4, 8],
  sus2:  [0, 2, 7],
  sus4:  [0, 5, 7],
  "5":   [0, 7],             // power chord
  // 7ths
  maj7:  [0, 4, 7, 11],
  min7:  [0, 3, 7, 10],
  m7:    [0, 3, 7, 10],
  "7":   [0, 4, 7, 10],      // dominant 7
  dom7:  [0, 4, 7, 10],
  dim7:  [0, 3, 6, 9],
  m7b5:  [0, 3, 6, 10],      // half-diminished
  aug7:  [0, 4, 8, 10],
  mMaj7: [0, 3, 7, 11],
  // 9ths
  maj9:  [0, 4, 7, 11, 14],
  min9:  [0, 3, 7, 10, 14],
  m9:    [0, 3, 7, 10, 14],
  "9":   [0, 4, 7, 10, 14],
  // 6ths
  "6":   [0, 4, 7, 9],
  min6:  [0, 3, 7, 9],
  m6:    [0, 3, 7, 9],
  // Misc
  add9:  [0, 4, 7, 14],
};

// Parse a chord token like "c'maj", "f#3'min7", "bb'dim". Returns the root MIDI
// note number (60 default if no octave) and the interval list, or null if the
// token isn't recognizable as a chord.
export function parseChordToken(tok: string): { root: number; intervals: number[]; chordName: string } | null {
  // Allow note (c, c#, db, etc.) + optional octave + apostrophe + chord name.
  const m = tok.match(/^([a-g][#b]?)(-?\d+)?'(.+)$/i);
  if (!m) return null;
  const noteName = m[1].toLowerCase();
  const octave = m[2] ?? "4";
  const chordName = m[3];
  const root = noteNameToMidi(noteName + octave);
  if (root === null) return null;
  const intervals = CHORDS[chordName];
  if (!intervals) return null;
  return { root, intervals, chordName };
}

// Parse a chord NAME for the `chord(name)` constructor. Accepts both
// "Cmaj7" and "C'maj7" forms — the apostrophe is optional. Defaults to
// "maj" when the suffix is empty (so "C" → C major).
//
// The non-apostrophe form is ambiguous between "octave + chord" (C4maj7) and
// "chord starting with digit" (C7, Bb9). We resolve by preferring the chord
// interpretation: try the suffix as a chord name first, then fall back to
// splitting off a leading octave.
export function parseChordName(name: string): { root: number; intervals: number[] } | null {
  // Apostrophe form is unambiguous.
  const aposM = name.match(/^([a-g][#b]?)(-?\d+)?'(.*)$/i);
  if (aposM) return tryBuildChord(aposM[1], aposM[2] ?? "4", aposM[3] || "maj");
  // No apostrophe: extract note prefix, then try chord-then-octave interpretations.
  const m = name.match(/^([a-g][#b]?)(.*)$/i);
  if (!m) return null;
  const noteName = m[1];
  const rest = m[2] || "maj";
  // First try: whole suffix is a chord name (covers "C7", "Bb9", "Cmaj7").
  const direct = tryBuildChord(noteName, "4", rest);
  if (direct) return direct;
  // Fallback: split leading digits as octave (covers "F#3m7", "C4maj7").
  const split = rest.match(/^(-?\d+)(.*)$/);
  if (!split) return null;
  return tryBuildChord(noteName, split[1], split[2] || "maj");
}

function tryBuildChord(noteName: string, octave: string, chordName: string): { root: number; intervals: number[] } | null {
  const root = noteNameToMidi(noteName.toLowerCase() + octave);
  if (root === null) return null;
  const intervals = CHORDS[chordName];
  if (!intervals) return null;
  return { root, intervals };
}
