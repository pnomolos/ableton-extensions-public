import { parseAudio } from "../../transient-detector.js";
import { writeWav } from "../../write-wav.js";
import type { DrumVoiceType } from "../../drum-detector.js";

export interface LoopEvent {
  voice: DrumVoiceType | "perc";
  beat: number;           // beat position (0-based, fractions OK for 8ths/16ths)
  samplePath: string;     // absolute path to the source WAV
  velocityScale?: number; // 0–1 amplitude scale (default 1.0)
}

const TARGET_SR = 44100;

/**
 * Build a mixed drum loop WAV from real one-shot samples.
 *
 * - Allocates a Float32Array for the full loop duration at 44100 Hz.
 * - For each event: loads the source WAV, computes start sample from beat position,
 *   mixes (adds) the sample data into the output buffer with optional velocity scaling.
 * - Clamps the output to ±1.0 (no soft clipping).
 * - Throws if any source sample is not at 44100 Hz.
 */
export function buildTestLoop(
  events: LoopEvent[],
  bpm: number,
  durationBeats: number,
  outputPath: string,
): void {
  const totalSamples = Math.round((durationBeats / bpm) * 60 * TARGET_SR);
  const output = new Float32Array(totalSamples);

  for (const event of events) {
    const wav = parseAudio(event.samplePath);

    if (wav.sampleRate !== TARGET_SR) {
      throw new Error(
        `Sample rate mismatch: ${event.samplePath} is ${wav.sampleRate} Hz, expected ${TARGET_SR} Hz`,
      );
    }

    const startSample = Math.round((event.beat / bpm) * 60 * TARGET_SR);
    const scale = event.velocityScale ?? 1.0;
    const available = Math.min(wav.samples.length, totalSamples - startSample);

    for (let i = 0; i < available; i++) {
      output[startSample + i] += wav.samples[i] * scale;
    }
  }

  // Clamp to ±1.0
  for (let i = 0; i < output.length; i++) {
    if (output[i] > 1.0) output[i] = 1.0;
    else if (output[i] < -1.0) output[i] = -1.0;
  }

  writeWav(outputPath, output, TARGET_SR);
}
