const SEMITONES: Record<string, number> = {
  c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, fb: 4,
  "e#": 5, f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8,
  a: 9, "a#": 10, bb: 10, b: 11, cb: 11,
};

// "c4" → 60, "c#4" → 61, "bb3" → 58. MIDI 0 = C-1.
// "0" → 60, "7" → 67, "-12" → 48. Numeric tokens are semitone offsets from C4 (Tidal `n` semantics).
export function noteNameToMidi(name: string): number | null {
  const lower = name.toLowerCase();
  if (/^-?\d+$/.test(lower)) {
    const midi = 60 + parseInt(lower, 10);
    if (midi < 0 || midi > 127) return null;
    return midi;
  }
  const m = lower.match(/^([a-g][#b]?)(-?\d+)$/);
  if (!m) return null;
  const semis = SEMITONES[m[1]];
  if (semis === undefined) return null;
  const octave = parseInt(m[2], 10);
  const midi = (octave + 1) * 12 + semis;
  if (midi < 0 || midi > 127) return null;
  return midi;
}
