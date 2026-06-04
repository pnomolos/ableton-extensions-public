/** A single MIDI note as returned/accepted by the Extension SDK clip.notes API */
export interface MidiNote {
  pitch: number;          // 0–127
  startTime: number;      // position in beats
  duration: number;       // length in beats
  velocity: number;       // 0–127
  probability?: number;   // 0–1, default 1
  mute?: boolean;
  isSelected?: boolean;
}

/** Result of chord identification */
export interface ChordInfo {
  root: number;           // 0–11 (C=0)
  rootName: string;       // e.g. "C", "F#"
  type: string;           // e.g. "maj", "min", "dom7", "maj7", "min7", "dim", "aug", "sus4"
  name: string;           // full name, e.g. "Cmaj7"
  notes: number[];        // pitch classes in the chord (0–11)
  beatStart: number;      // first beat this chord appears
  beatEnd: number;        // last beat (exclusive)
  confidence: number;     // 0–1
}

/** Result of key/scale detection */
export interface KeyInfo {
  root: number;           // 0–11
  rootName: string;
  mode: "major" | "minor" | "dorian" | "mixolydian" | "phrygian" | "lydian" | "locrian";
  modeName: string;
  scale: number[];        // pitch classes in scale
  confidence: number;     // 0–1
}

/** A detected transient (onset) in audio */
export interface TransientFrame {
  sampleIndex: number;    // sample position in source audio
  timeSeconds: number;    // time in seconds
  timeBeat: number;       // time in beats (requires knowing tempo/sample rate)
  strength: number;       // 0–1, onset strength
}

/** A warp marker as used by the Extension SDK AudioClip.warpMarkers API */
export interface WarpMarkerData {
  beatTime: number;       // position in beats (the "where it should play")
  sampleTime: number;     // position in seconds in the original audio file
}

/** A saved groove profile extracted from an audio clip */
export interface GrooveProfile {
  id: string;
  name: string;
  createdAt: string;       // ISO date string
  tempo: number;           // BPM at time of extraction
  resolution: number;      // grid resolution in beats (e.g. 0.25 = 16th note)
  offsets: number[];       // timing offsets in beats, indexed by subdivision position
  velocityOffsets?: number[]; // velocity deviations per slot, normalized -1..1 relative to clip mean
  swingAmount: number;     // 0–1 detected swing amount
  version?: number;        // profile format version; absent = legacy pre-1.0
}

/** Frequency band selection for audio groove extraction */
export type FrequencyBand = 'kick' | 'snare' | 'hihat' | 'full';

/** Options for extracting a groove from an audio file */
export interface AudioGrooveOptions {
  band: FrequencyBand;
  bpm: number;
  resolution: number;
  /** 0–1: fraction of transients to detect (higher = more hits, lower = only loud hits) */
  sensitivity: number;
  name: string;
}

/** Message protocol between extension and webview */
export interface WebviewMessage<T = unknown> {
  type: string;
  payload: T;
}
