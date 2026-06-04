import type { MidiNote, ChordInfo, KeyInfo } from "./types.js";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const SCALE_PATTERNS: Record<string, number[]> = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
};

export const CHORD_TYPES: Record<string, number[]> = {
  maj:  [0, 4, 7],
  min:  [0, 3, 7],
  dim:  [0, 3, 6],
  aug:  [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9],
  hdim7:[0, 3, 6, 10],
};

/** Detect the most likely key/scale from a set of MIDI notes */
export function detectKey(notes: MidiNote[]): KeyInfo {
  const pitchClassWeights = new Array(12).fill(0);
  for (const note of notes) {
    // Weight by velocity and duration
    pitchClassWeights[note.pitch % 12] += (note.velocity / 127) * note.duration;
  }

  let bestScore = -Infinity;
  let bestRoot = 0;
  let bestMode: KeyInfo["mode"] = "major";

  for (const [mode, pattern] of Object.entries(SCALE_PATTERNS) as [KeyInfo["mode"], number[]][]) {
    for (let root = 0; root < 12; root++) {
      let score = 0;
      for (const degree of pattern) {
        score += pitchClassWeights[(root + degree) % 12];
      }
      // Penalize notes outside scale
      for (let pc = 0; pc < 12; pc++) {
        if (!pattern.map(d => (root + d) % 12).includes(pc)) {
          score -= pitchClassWeights[pc] * 0.5;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestMode = mode;
      }
    }
  }

  const totalWeight = pitchClassWeights.reduce((a, b) => a + b, 0);
  const scale = SCALE_PATTERNS[bestMode].map(d => (bestRoot + d) % 12);

  return {
    root: bestRoot,
    rootName: NOTE_NAMES[bestRoot],
    mode: bestMode,
    modeName: bestMode.charAt(0).toUpperCase() + bestMode.slice(1),
    scale,
    confidence: totalWeight > 0 ? Math.min(bestScore / totalWeight, 1) : 0,
  };
}

const CHORD_DISPLAY: Record<string, string> = {
  maj: "", min: "m", dom7: "7", maj7: "maj7", min7: "m7",
  dim: "dim", aug: "aug", sus4: "sus4", sus2: "sus2", dim7: "dim7", hdim7: "ø7",
};

/** Identify the chord at a given beat window from a set of notes */
export function identifyChord(notes: MidiNote[], beatStart: number, beatEnd: number): ChordInfo | null {
  const windowNotes = notes.filter(
    n => n.startTime < beatEnd && n.startTime + n.duration > beatStart
  );
  if (windowNotes.length < 2) return null;

  const pitchClasses = new Set(windowNotes.map(n => n.pitch % 12));
  const pcArray = Array.from(pitchClasses).sort((a, b) => a - b);

  let bestScore = -1;
  let bestRoot = pcArray[0];
  let bestType = "maj";

  for (const [type, intervals] of Object.entries(CHORD_TYPES)) {
    for (const root of pcArray) {
      const chordPCs = intervals.map(i => (root + i) % 12);
      const matches = chordPCs.filter(pc => pitchClasses.has(pc)).length;
      const score = matches / Math.max(chordPCs.length, pitchClasses.size);
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestType = type;
      }
    }
  }

  const chordNotes = CHORD_TYPES[bestType].map(i => (bestRoot + i) % 12);
  return {
    root: bestRoot,
    rootName: NOTE_NAMES[bestRoot],
    type: bestType,
    name: `${NOTE_NAMES[bestRoot]}${CHORD_DISPLAY[bestType] ?? bestType}`,
    notes: chordNotes,
    beatStart,
    beatEnd,
    confidence: bestScore,
  };
}

/** Build a chord timeline: one ChordInfo per bar (4 beats) */
export function buildChordTimeline(notes: MidiNote[], barLength = 4): ChordInfo[] {
  if (notes.length === 0) return [];
  const maxBeat = Math.max(...notes.map(n => n.startTime + n.duration));
  const numBars = Math.ceil(maxBeat / barLength);
  const timeline: ChordInfo[] = [];

  for (let bar = 0; bar < numBars; bar++) {
    const chord = identifyChord(notes, bar * barLength, (bar + 1) * barLength);
    if (chord) timeline.push(chord);
  }
  return timeline;
}

/** Get the pitch classes for a scale rooted at root */
export function getScaleNotes(root: number, mode: KeyInfo["mode"] = "major"): number[] {
  return SCALE_PATTERNS[mode].map(d => (root + d) % 12);
}

/** Convert a ChordInfo to MIDI notes at a given beat position */
export function chordToNotes(
  chord: ChordInfo,
  beatStart: number,
  duration = 4,
  octave = 4,
  velocity = 80
): MidiNote[] {
  return chord.notes.map((pc, i) => {
    // Spread voicing: keep notes in range 48–84
    let pitch = pc + (octave + Math.floor(i / 4)) * 12;
    while (pitch < 48) pitch += 12;
    while (pitch > 84) pitch -= 12;
    return { pitch, startTime: beatStart, duration, velocity };
  });
}

/** Suggest likely next chords given the current key and last chord */
export function suggestNextChords(key: KeyInfo, lastChord: ChordInfo | null): ChordInfo[] {
  // Diatonic chord progressions — return 4 suggestions
  const scaleRoots = SCALE_PATTERNS[key.mode].map(d => (key.root + d) % 12);
  const diatonicChords: ChordInfo[] = scaleRoots.map((root, i) => {
    // Determine triad quality for each scale degree
    const majorDegrees = key.mode === "major" ? [0, 3, 4] : [2, 5, 6];
    const type = majorDegrees.includes(i) ? "maj" : "min";
    const chordNotes = CHORD_TYPES[type].map(interval => (root + interval) % 12);
    return {
      root,
      rootName: NOTE_NAMES[root],
      type,
      name: `${NOTE_NAMES[root]}${CHORD_DISPLAY[type] ?? type}`,
      notes: chordNotes,
      beatStart: 0,
      beatEnd: 4,
      confidence: 1,
    };
  });

  if (!lastChord) return diatonicChords.slice(0, 4);

  // Sort by common tones with last chord
  return diatonicChords
    .filter(c => c.root !== lastChord.root)
    .sort((a, b) => {
      const aCommon = a.notes.filter(n => lastChord.notes.includes(n)).length;
      const bCommon = b.notes.filter(n => lastChord.notes.includes(n)).length;
      return bCommon - aCommon;
    })
    .slice(0, 4);
}
