import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseWav,
  parseAiff,
  parseAudio,
  applyBandpassFilter,
  detectTransients,
  estimateTempo,
} from "../transient-detector.js";

// ── temp file helpers ─────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

function writeTmp(name: string, buf: Buffer): string {
  const p = join(tmpdir(), `arclight-${process.pid}-${name}`);
  writeFileSync(p, buf);
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles) { try { unlinkSync(p); } catch {} }
});

// ── audio buffer builders ─────────────────────────────────────────────────────

function sineWave(freq: number, sampleRate: number, durationSecs: number): Float32Array {
  const n = Math.floor(durationSecs * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function buildWav(samples: Float32Array, sampleRate = 44100, channels = 1, bitsPerSample = 16): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  // samples is already interleaved across channels, so dataSize = sample count × bytes per sample
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);   // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    if (bitsPerSample === 16) {
      buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    } else if (bitsPerSample === 24) {
      const v = Math.round(clamped * 8388607);
      buf.writeUInt8(v & 0xFF, 44 + i * 3);
      buf.writeUInt8((v >> 8) & 0xFF, 44 + i * 3 + 1);
      buf.writeInt8(v >> 16, 44 + i * 3 + 2);
    }
  }
  return buf;
}

// IEEE 754 80-bit extended for 44100 Hz: exponent 16398 (0x400E), mantissa 0xAC44_0000...
const SR_44100_80BIT = Buffer.from([0x40, 0x0E, 0xAC, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

function buildAiff(samples: Float32Array, sampleRate = 44100, bitsPerSample = 16): Buffer {
  if (sampleRate !== 44100) throw new Error("buildAiff helper only supports 44100 Hz");
  const channels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * channels * bytesPerSample;

  // FORM(8) + AIFF(4) + COMM(8+18=26) + SSND(8+8+data=16+data)
  const buf = Buffer.alloc(54 + dataSize);

  buf.write("FORM", 0, "ascii");
  buf.writeUInt32BE(46 + dataSize, 4); // size of everything after FORM+size
  buf.write("AIFF", 8, "ascii");

  // COMM chunk at offset 12
  buf.write("COMM", 12, "ascii");
  buf.writeUInt32BE(18, 16);
  buf.writeInt16BE(channels, 20);
  buf.writeUInt32BE(samples.length, 22);
  buf.writeInt16BE(bitsPerSample, 26);
  SR_44100_80BIT.copy(buf, 28);

  // SSND chunk at offset 38
  buf.write("SSND", 38, "ascii");
  buf.writeUInt32BE(8 + dataSize, 42);
  buf.writeUInt32BE(0, 46); // offset field
  buf.writeUInt32BE(0, 50); // blockSize field
  // sample data at offset 54 (big-endian)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    if (bitsPerSample === 16) {
      buf.writeInt16BE(Math.round(clamped * 32767), 54 + i * 2);
    }
  }
  return buf;
}

// ── parseWav ─────────────────────────────────────────────────────────────────

describe("parseWav", () => {
  it("reads sample rate and channel count from header", () => {
    const samples = sineWave(440, 44100, 0.1);
    const path = writeTmp("test-16bit.wav", buildWav(samples, 44100));
    const wav = parseWav(path);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.numChannels).toBe(1);
    expect(wav.numSamples).toBe(samples.length);
  });

  it("mixes stereo to mono (average of channels)", () => {
    // Build a stereo WAV: L=0.5, R=-0.5 per sample → mono should be ~0
    const nSamples = 1000;
    const stereoSamples = new Float32Array(nSamples * 2); // L,R,L,R,...
    for (let i = 0; i < nSamples; i++) {
      stereoSamples[i * 2]     =  0.5;
      stereoSamples[i * 2 + 1] = -0.5;
    }
    const path = writeTmp("stereo.wav", buildWav(stereoSamples, 44100, 2));
    const wav = parseWav(path);
    expect(wav.numChannels).toBe(2);
    expect(wav.numSamples).toBe(nSamples);
    for (const s of wav.samples) expect(Math.abs(s)).toBeLessThan(0.01);
  });

  it("preserves amplitude within 16-bit quantisation error", () => {
    const samples = sineWave(440, 44100, 0.1);
    const path = writeTmp("amp.wav", buildWav(samples, 44100));
    const wav = parseWav(path);
    const diff = Math.max(...Array.from(wav.samples).map((s, i) => Math.abs(s - samples[i])));
    expect(diff).toBeLessThan(1 / 32767 + 0.0001); // within 1 LSB
  });

  it("parses 24-bit WAV without error", () => {
    const samples = sineWave(440, 44100, 0.05);
    const path = writeTmp("24bit.wav", buildWav(samples, 44100, 1, 24));
    const wav = parseWav(path);
    expect(wav.numSamples).toBe(samples.length);
    expect(rms(wav.samples)).toBeGreaterThan(0.5); // signal is present
  });

  it("handles non-standard sample rate", () => {
    const samples = sineWave(440, 48000, 0.05);
    const path = writeTmp("48k.wav", buildWav(samples, 48000));
    const wav = parseWav(path);
    expect(wav.sampleRate).toBe(48000);
  });
});

// ── parseAiff ─────────────────────────────────────────────────────────────────

describe("parseAiff", () => {
  it("reads sample rate and channel count", () => {
    const samples = sineWave(440, 44100, 0.1);
    const path = writeTmp("test.aiff", buildAiff(samples));
    const wav = parseAiff(path);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.numChannels).toBe(1);
    expect(wav.numSamples).toBe(samples.length);
  });

  it("decodes big-endian samples correctly", () => {
    const samples = sineWave(440, 44100, 0.1);
    const path = writeTmp("decode.aiff", buildAiff(samples));
    const wav = parseAiff(path);
    // Signal should have similar RMS to the original (within 16-bit quantisation)
    expect(rms(wav.samples)).toBeGreaterThan(0.6);
    expect(rms(wav.samples)).toBeLessThan(0.8);
  });

  it("throws for non-AIFF data", () => {
    const path = writeTmp("bad.aiff", Buffer.from("RIFF????WAVE"));
    expect(() => parseAiff(path)).toThrow();
  });
});

// ── parseAudio ────────────────────────────────────────────────────────────────

describe("parseAudio", () => {
  it("dispatches .wav extension to parseWav", () => {
    const samples = sineWave(440, 44100, 0.05);
    const path = writeTmp("dispatch.wav", buildWav(samples));
    const wav = parseAudio(path);
    expect(wav.sampleRate).toBe(44100);
  });

  it("dispatches .aiff extension to parseAiff", () => {
    const samples = sineWave(440, 44100, 0.05);
    const path = writeTmp("dispatch.aiff", buildAiff(samples));
    const wav = parseAudio(path);
    expect(wav.sampleRate).toBe(44100);
  });

  it("dispatches .aif extension to parseAiff", () => {
    const samples = sineWave(440, 44100, 0.05);
    const path = writeTmp("dispatch.aif", buildAiff(samples));
    const wav = parseAudio(path);
    expect(wav.sampleRate).toBe(44100);
  });
});

// ── applyBandpassFilter ───────────────────────────────────────────────────────

describe("applyBandpassFilter", () => {
  const SR = 44100;
  const DUR = 0.5; // seconds — enough for filter to settle

  it("passes a low-frequency sine through the kick band (20–200 Hz)", () => {
    const sin100 = sineWave(100, SR, DUR);
    const filtered = applyBandpassFilter(sin100, SR, 20, 200);
    // 100 Hz is inside the kick passband — signal should largely survive
    expect(rms(filtered) / rms(sin100)).toBeGreaterThan(0.7);
  });

  it("strongly attenuates low-frequency sine in the hi-hat band (2–20 kHz)", () => {
    const sin100 = sineWave(100, SR, DUR);
    const filtered = applyBandpassFilter(sin100, SR, 2000, 20000);
    // 100 Hz is deep in the hi-hat stopband — should be heavily attenuated
    expect(rms(filtered) / rms(sin100)).toBeLessThan(0.15);
  });

  it("passes a high-frequency sine through the hi-hat band", () => {
    const sin8k = sineWave(8000, SR, DUR);
    const filtered = applyBandpassFilter(sin8k, SR, 2000, 20000);
    // 8 kHz is inside the hi-hat passband
    expect(rms(filtered) / rms(sin8k)).toBeGreaterThan(0.7);
  });

  it("strongly attenuates high-frequency sine in the kick band", () => {
    const sin8k = sineWave(8000, SR, DUR);
    const filtered = applyBandpassFilter(sin8k, SR, 20, 200);
    // 8 kHz is deep in the kick stopband
    expect(rms(filtered) / rms(sin8k)).toBeLessThan(0.15);
  });

  it("passes a midrange sine through the snare band (200 Hz–2 kHz)", () => {
    const sin500 = sineWave(500, SR, DUR);
    const filtered = applyBandpassFilter(sin500, SR, 200, 2000);
    expect(rms(filtered) / rms(sin500)).toBeGreaterThan(0.6);
  });

  it("returns samples unchanged for full-range (no-op)", () => {
    const sin440 = sineWave(440, SR, 0.1);
    // nyquist = SR/2 — the early-return condition requires highHz >= nyquist
    const filtered = applyBandpassFilter(sin440, SR, 20, SR / 2);
    expect(filtered).toBe(sin440);
  });
});

// ── detectTransients ──────────────────────────────────────────────────────────

describe("detectTransients", () => {
  const SR = 44100;

  it("returns empty array for silent audio", () => {
    const samples = new Float32Array(SR); // 1 second of silence
    const transients = detectTransients({ sampleRate: SR, numChannels: 1, samples, numSamples: SR });
    expect(transients).toHaveLength(0);
  });

  it("detects a single impulse in silence", () => {
    const samples = new Float32Array(SR);
    samples[SR / 2] = 1.0; // spike at 0.5 seconds
    const transients = detectTransients(
      { sampleRate: SR, numChannels: 1, samples, numSamples: SR },
      { threshold: 0.1 },
    );
    expect(transients.length).toBeGreaterThanOrEqual(1);
  });

  it("places detected transient near the impulse position", () => {
    const samples = new Float32Array(SR);
    const spikeAt = Math.floor(SR * 0.5);
    samples[spikeAt] = 1.0;
    const transients = detectTransients(
      { sampleRate: SR, numChannels: 1, samples, numSamples: SR },
      { threshold: 0.1 },
    );
    const closest = transients.reduce((best, t) =>
      Math.abs(t.timeSeconds - 0.5) < Math.abs(best.timeSeconds - 0.5) ? t : best,
    );
    expect(closest.timeSeconds).toBeCloseTo(0.5, 1); // within 50ms
  });

  it("computes timeBeat from bpm", () => {
    const samples = new Float32Array(SR);
    samples[SR] = 1.0; // spike at exactly 1 second = 2 beats at 120 BPM
    const longSamples = new Float32Array(SR * 2);
    longSamples.set(samples);
    longSamples[SR] = 1.0;
    const transients = detectTransients(
      { sampleRate: SR, numChannels: 1, samples: longSamples, numSamples: SR * 2 },
      { bpm: 120, threshold: 0.1 },
    );
    const at1sec = transients.find(t => Math.abs(t.timeSeconds - 1.0) < 0.05);
    expect(at1sec).toBeDefined();
    if (at1sec) expect(at1sec.timeBeat).toBeCloseTo(2.0, 0);
  });

  it("respects minGapSeconds to suppress double-triggers", () => {
    // Two spikes 10ms apart — should merge into one with minGapSeconds=0.05
    const samples = new Float32Array(SR);
    samples[1000] = 1.0;
    samples[1441] = 0.9; // ~33ms later at 44100 Hz
    const transients = detectTransients(
      { sampleRate: SR, numChannels: 1, samples, numSamples: SR },
      { threshold: 0.1, minGapSeconds: 0.05 },
    );
    // Should detect at most 1 transient (the second is within the gap)
    expect(transients.length).toBeLessThanOrEqual(1);
  });

  it("strength values are in [0, 1]", () => {
    const samples = new Float32Array(SR);
    for (let i = 0; i < SR; i += 4410) samples[i] = Math.random();
    const transients = detectTransients(
      { sampleRate: SR, numChannels: 1, samples, numSamples: SR },
      { threshold: 0.1 },
    );
    for (const t of transients) {
      expect(t.strength).toBeGreaterThanOrEqual(0);
      expect(t.strength).toBeLessThanOrEqual(1);
    }
  });
});

// ── estimateTempo ─────────────────────────────────────────────────────────────

describe("estimateTempo", () => {
  const SR = 44100;

  // Build a regular pulse train at a given BPM and write as temp WAV
  function pulseTrain(bpm: number, bars = 4): string {
    const beatsPerBar = 4;
    const beatPeriod = SR * 60 / bpm;
    const totalBeats = bars * beatsPerBar;
    const totalSamples = Math.ceil(beatPeriod * totalBeats) + SR; // +1s tail
    const samples = new Float32Array(totalSamples);
    for (let beat = 0; beat < totalBeats; beat++) {
      const pos = Math.round(beat * beatPeriod);
      if (pos < totalSamples) samples[pos] = 1.0;
    }
    return writeTmp(`pulse-${bpm}bpm.wav`, buildWav(samples));
  }

  it("detects 120 BPM from a regular pulse train", () => {
    const { bpm, confidence } = estimateTempo(pulseTrain(120));
    expect(bpm).toBeCloseTo(120, 0); // within ±0.5 BPM
    expect(confidence).toBeGreaterThan(0.1);
  });

  it("detects 172 BPM from a regular pulse train", () => {
    const { bpm, confidence } = estimateTempo(pulseTrain(172));
    // Allow ±5 BPM — autocorrelation resolution at 100fps is ~2 BPM at this range
    expect(Math.abs(bpm - 172)).toBeLessThan(6);
    expect(confidence).toBeGreaterThan(0.1);
  });

  it("detects 90 BPM from a regular pulse train", () => {
    const { bpm, confidence } = estimateTempo(pulseTrain(90));
    expect(Math.abs(bpm - 90)).toBeLessThan(4);
    expect(confidence).toBeGreaterThan(0.1);
  });

  it("returns bpm=120 and confidence=0 for silence", () => {
    const silence = new Float32Array(SR * 4);
    const path = writeTmp("silence-tempo.wav", buildWav(silence));
    const { bpm, confidence } = estimateTempo(path);
    expect(bpm).toBe(120);
    expect(confidence).toBe(0);
  });

  it("returns confidence in [0, 1]", () => {
    const { confidence } = estimateTempo(pulseTrain(120));
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});
