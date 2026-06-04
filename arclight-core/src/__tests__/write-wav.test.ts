import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { writeWav } from "../write-wav.js";
import { parseAudio } from "../transient-detector.js";

const TMP = join(tmpdir(), "arclight-write-wav-test");

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("writeWav", () => {
  it("round-trips a simple sine wave", () => {
    const sampleRate = 44100;
    const freq = 440;
    const durationSec = 0.1;
    const n = Math.round(sampleRate * durationSec);
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      original[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
    }

    const path = join(TMP, "sine.wav");
    writeWav(path, original, sampleRate);

    const parsed = parseAudio(path);
    expect(parsed.sampleRate).toBe(sampleRate);
    expect(parsed.numSamples).toBe(n);

    // Values should be very close (float32 round-trip)
    for (let i = 0; i < n; i++) {
      expect(parsed.samples[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("round-trips silence (all zeros)", () => {
    const sampleRate = 48000;
    const samples = new Float32Array(1000);
    const path = join(TMP, "silence.wav");
    writeWav(path, samples, sampleRate);

    const parsed = parseAudio(path);
    expect(parsed.sampleRate).toBe(sampleRate);
    expect(parsed.numSamples).toBe(1000);
    expect(Array.from(parsed.samples).every(v => v === 0)).toBe(true);
  });

  it("writes correct WAV header magic bytes", () => {
    const path = join(TMP, "header.wav");
    writeWav(path, new Float32Array(100), 44100);

    const parsed = parseAudio(path);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.numSamples).toBe(100);
  });

  it("handles a single sample", () => {
    const path = join(TMP, "single.wav");
    const samples = new Float32Array([0.5]);
    writeWav(path, samples, 44100);

    const parsed = parseAudio(path);
    expect(parsed.numSamples).toBe(1);
    expect(parsed.samples[0]).toBeCloseTo(0.5, 5);
  });
});
