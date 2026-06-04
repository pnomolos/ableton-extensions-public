import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  computeGrooveFromMidi,
  computeGrooveProfile,
  applyGrooveToNotes,
  applyVelocityGroove,
  computeGrooveFromAudio,
} from "../warp-utils.js";
import type { MidiNote, TransientFrame, GrooveProfile } from "../types.js";

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

// ── WAV builder (minimal inline copy — avoids cross-file test coupling) ───────

function buildWav(samples: Float32Array, sampleRate = 44100): Buffer {
  const dataSize = samples.length * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");   buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");   buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);       buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);        buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);        buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

// ── note helpers ──────────────────────────────────────────────────────────────

function note(startTime: number, velocity = 100, pitch = 60, duration = 0.25): MidiNote {
  return { pitch, startTime, duration, velocity };
}

// ── computeGrooveProfile ──────────────────────────────────────────────────────

describe("computeGrooveProfile", () => {
  it("returns zero offsets when transients are perfectly on the grid", () => {
    const res = 0.25;
    const transients: TransientFrame[] = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({
      sampleIndex: i * 11025,
      timeSeconds: i * res * 0.5,     // 120 BPM, 0.5s per beat
      timeBeat:    i * res,
      strength:    1,
    }));
    const profile = computeGrooveProfile(transients, 120, res, "Test");
    for (const off of profile.offsets) expect(Math.abs(off)).toBeLessThan(0.001);
  });

  it("stores the provided bpm and resolution", () => {
    const transients: TransientFrame[] = [
      { sampleIndex: 0, timeSeconds: 0, timeBeat: 0, strength: 1 },
    ];
    const profile = computeGrooveProfile(transients, 135, 0.5, "Groove");
    expect(profile.tempo).toBe(135);
    expect(profile.resolution).toBe(0.5);
  });

  it("generates ids in the expected groove_<timestamp> format", () => {
    const t: TransientFrame[] = [{ sampleIndex: 0, timeSeconds: 0, timeBeat: 0, strength: 1 }];
    const a = computeGrooveProfile(t, 120, 0.25, "A");
    expect(a.id).toMatch(/^groove_\d+$/);
  });

  it("captures velocityOffsets from transient strength", () => {
    const res = 0.25;
    // Alternating strong (1.0) and weak (0.2) hits — strong slots should get positive offsets,
    // weak slots negative offsets
    const transients: TransientFrame[] = [0, 1, 2, 3].map(i => ({
      sampleIndex: i * 11025,
      timeSeconds: i * res * 0.5,
      timeBeat:    i * res,
      strength:    i % 2 === 0 ? 1.0 : 0.2,
    }));
    const profile = computeGrooveProfile(transients, 120, res, "VelTest");
    expect(profile.velocityOffsets).toBeDefined();
    expect(profile.velocityOffsets!.length).toBe(profile.offsets.length);
    // Slot 0 (strength=1.0) should have a higher velocity offset than slot 1 (strength=0.2)
    expect(profile.velocityOffsets![0]).toBeGreaterThan(profile.velocityOffsets![1]);
  });

  it("velocity offsets are in [-1, 1]", () => {
    const transients: TransientFrame[] = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({
      sampleIndex: i * 5512,
      timeSeconds: i * 0.125,
      timeBeat:    i * 0.25,
      strength:    Math.random(),
    }));
    const profile = computeGrooveProfile(transients, 120, 0.25, "Range");
    for (const v of profile.velocityOffsets!) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ── computeGrooveFromMidi ─────────────────────────────────────────────────────

describe("computeGrooveFromMidi", () => {
  it("returns near-zero offsets for perfectly quantised notes", () => {
    const notes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(i =>
      note(i * 0.25),
    );
    const profile = computeGrooveFromMidi(notes, 120, 0.25, 4, "Perfect");
    for (const off of profile.offsets) expect(Math.abs(off)).toBeLessThan(0.001);
  });

  it("detects positive swing when odd 16ths are consistently late", () => {
    // Even slots on the grid, odd slots 0.05 beats late
    const notes = [
      note(0.00), note(0.30),   // slots 0, 1 — slot 1 is 0.05 late
      note(0.50), note(0.80),   // slots 2, 3 — slot 3 is 0.05 late
      note(1.00), note(1.30),
      note(1.50), note(1.80),
    ];
    const profile = computeGrooveFromMidi(notes, 120, 0.25, 2, "Swing");
    expect(profile.swingAmount).toBeGreaterThan(0.5);
  });

  it("folds multi-bar clips: notes beyond one bar map back to the same slots", () => {
    // Note at slot 0 in bar 1 and bar 2, both 0.02 beats late
    const notes = [note(0.02), note(4.02)];
    const profile = computeGrooveFromMidi(notes, 120, 0.25, 4, "Fold");
    // Slot 0 offset should average the two deviations → ≈ 0.02
    expect(Math.abs(profile.offsets[0] - 0.02)).toBeLessThan(0.005);
  });

  it("auto-detects resolution when null is passed", () => {
    const notes = [0, 1, 2, 3].map(i => note(i * 0.5)); // 1/8 spacing
    const profile = computeGrooveFromMidi(notes, 120, null, 4, "Auto");
    expect(profile.resolution).toBeCloseTo(0.5, 9);
  });

  it("handles empty note array without throwing", () => {
    expect(() => computeGrooveFromMidi([], 120, 0.25, 4, "Empty")).not.toThrow();
  });

  it("captures velocity offsets", () => {
    // Alternate loud/quiet notes so velocityOffsets should be non-zero
    const notes = [
      note(0.00, 100), note(0.25, 50),
      note(0.50, 100), note(0.75, 50),
    ];
    const profile = computeGrooveFromMidi(notes, 120, 0.25, 1, "Vel");
    expect(profile.velocityOffsets).toBeDefined();
    expect(profile.velocityOffsets!.some(v => Math.abs(v) > 0.1)).toBe(true);
  });
});

// ── applyGrooveToNotes ────────────────────────────────────────────────────────

function makeProfile(offsets: number[], resolution = 0.25): GrooveProfile {
  return {
    id: "test",
    name: "test",
    createdAt: new Date().toISOString(),
    tempo: 120,
    resolution,
    offsets,
    swingAmount: 0.5,
    version: 1,
  };
}

describe("applyGrooveToNotes", () => {
  it("does not move notes when strength is 0", () => {
    const notes = [note(0.1), note(0.6), note(1.1)];
    const groove = makeProfile([0.05, -0.03, 0.02, 0]);
    const result = applyGrooveToNotes(notes, groove, 0);
    notes.forEach((n, i) => expect(result[i]).toBeCloseTo(n.startTime));
  });

  it("applies full offset at strength 1", () => {
    // Note at exactly grid position 0 — groove has +0.05 offset at slot 0
    const notes = [note(0.0)];
    const groove = makeProfile([0.05, 0, 0, 0]);
    const result = applyGrooveToNotes(notes, groove, 1);
    // grooved = gridTime(0) + offset(0.05) = 0.05; note at 0.0 → 0 + (0.05-0)*1 = 0.05
    expect(result[0]).toBeCloseTo(0.05);
  });

  it("blends at intermediate strength", () => {
    const notes = [note(0.0)];
    const groove = makeProfile([0.1, 0, 0, 0]);
    const full   = applyGrooveToNotes(notes, groove, 1)[0];
    const half   = applyGrooveToNotes(notes, groove, 0.5)[0];
    const zero   = applyGrooveToNotes(notes, groove, 0)[0];
    expect(half).toBeCloseTo((full + zero) / 2);
  });

  it("wraps the groove pattern for notes beyond one bar", () => {
    // Groove has 4 slots at 1/4 note resolution → 1-bar pattern
    // Note at beat 4.0 → slot 4 % 4 = 0 → same offset as beat 0
    const notes = [note(0.0), note(4.0)];
    const groove = makeProfile([0.05, 0, 0, 0], 1.0); // 1 quarter-note resolution
    const result = applyGrooveToNotes(notes, groove, 1);
    expect(result[0]).toBeCloseTo(result[1] - 4.0);
  });

  it("enforces minimum gap to prevent note overlap", () => {
    // Two notes at the same grid position (after grooving would collide)
    const notes = [note(0.0), note(0.0)];
    const groove = makeProfile([0, 0, 0, 0]);
    const result = applyGrooveToNotes(notes, groove, 1);
    expect(Math.abs(result[0] - result[1])).toBeGreaterThanOrEqual(0.01);
  });

  it("returns one value per input note", () => {
    const notes = [note(0), note(0.25), note(0.5), note(0.75)];
    const groove = makeProfile([0.01, -0.01, 0.02, 0]);
    const result = applyGrooveToNotes(notes, groove, 1);
    expect(result).toHaveLength(4);
  });
});

// ── applyVelocityGroove ───────────────────────────────────────────────────────

describe("applyVelocityGroove", () => {
  it("does not change velocities when strength is 0", () => {
    const notes = [note(0, 80), note(0.25, 100)];
    const groove = { ...makeProfile([0, 0, 0, 0]), velocityOffsets: [0.5, -0.5, 0.5, -0.5] };
    const result = applyVelocityGroove(notes, groove, 0);
    expect(result[0]).toBeCloseTo(80);
    expect(result[1]).toBeCloseTo(100);
  });

  it("applies velocity offsets at full strength", () => {
    const notes = [note(0, 100), note(0.25, 100)];
    // velOffset[0]=+0.5, velOffset[1]=-0.5 → slot 0 gets louder, slot 1 quieter
    const groove = { ...makeProfile([0, 0, 0, 0]), velocityOffsets: [0.5, -0.5, 0.5, -0.5] };
    const result = applyVelocityGroove(notes, groove, 1);
    expect(result[0]).toBeGreaterThan(100); // boosted
    expect(result[1]).toBeLessThan(100);    // reduced
  });

  it("returns unchanged velocities when groove has no velocityOffsets", () => {
    const notes = [note(0, 80), note(0.25, 90)];
    const groove = makeProfile([0, 0, 0, 0]); // no velocityOffsets
    const result = applyVelocityGroove(notes, groove, 1);
    expect(result[0]).toBeCloseTo(80);
    expect(result[1]).toBeCloseTo(90);
  });

  it("returns one value per input note", () => {
    const notes = [note(0), note(0.25), note(0.5)];
    const groove = { ...makeProfile([0, 0, 0, 0]), velocityOffsets: [0, 0, 0, 0] };
    const result = applyVelocityGroove(notes, groove, 1);
    expect(result).toHaveLength(3);
  });
});

// ── computeGrooveFromAudio (integration) ─────────────────────────────────────

describe("computeGrooveFromAudio", () => {
  const SR = 44100;
  const BPM = 120;

  // Build a pulse train: impulses spaced exactly one resolution apart
  function pulseTrain(resolution: number, numPulses: number): Float32Array {
    const samplesPerSlot = Math.round((60 / BPM) * resolution * SR);
    const total = samplesPerSlot * (numPulses + 1);
    const out = new Float32Array(total);
    for (let i = 0; i < numPulses; i++) out[i * samplesPerSlot] = 1.0;
    return out;
  }

  it("returns a GrooveProfile with the requested resolution", () => {
    const path = writeTmp("pulse.wav", buildWav(pulseTrain(0.5, 8)));
    const profile = computeGrooveFromAudio(path, {
      band: "full", bpm: BPM, resolution: 0.5, sensitivity: 0.7, name: "Test",
    });
    expect(profile.resolution).toBeCloseTo(0.5);
    expect(profile.name).toBe("Test");
  });

  it("stores the provided bpm in the profile", () => {
    const path = writeTmp("bpm.wav", buildWav(pulseTrain(0.25, 16)));
    const profile = computeGrooveFromAudio(path, {
      band: "full", bpm: 140, resolution: 0.25, sensitivity: 0.7, name: "BPM test",
    });
    expect(profile.tempo).toBe(140);
  });

  it("extracts near-zero offsets from a perfectly-timed pulse train", () => {
    const path = writeTmp("ontick.wav", buildWav(pulseTrain(0.5, 8)));
    const profile = computeGrooveFromAudio(path, {
      band: "full", bpm: BPM, resolution: 0.5, sensitivity: 0.7, name: "OnTick",
    });
    const detectedOffsets = profile.offsets.filter((_, i) => i < 8);
    const maxOff = Math.max(...detectedOffsets.map(Math.abs));
    // Pulses are on the grid — offsets should be small (within temporal resolution of detector)
    expect(maxOff).toBeLessThan(0.1); // within 100ms at 120 BPM
  });

  it("runs without error for each frequency band", () => {
    const path = writeTmp("bands.wav", buildWav(pulseTrain(0.5, 8)));
    for (const band of ["full", "kick", "snare", "hihat"] as const) {
      expect(() => computeGrooveFromAudio(path, {
        band, bpm: BPM, resolution: 0.5, sensitivity: 0.7, name: band,
      })).not.toThrow();
    }
  });

  it("low sensitivity detects fewer transients than high sensitivity", () => {
    // Mix of loud and quiet hits — strict mode misses quiet ones
    const samples = pulseTrain(0.25, 16);
    // Every other pulse is quiet
    const SR_per_slot = Math.round((60 / BPM) * 0.25 * SR);
    for (let i = 1; i < 16; i += 2) samples[i * SR_per_slot] = 0.15;
    const path = writeTmp("mixed.wav", buildWav(samples));

    const strict = computeGrooveFromAudio(path, {
      band: "full", bpm: BPM, resolution: 0.25, sensitivity: 0.2, name: "strict",
    });
    const loose = computeGrooveFromAudio(path, {
      band: "full", bpm: BPM, resolution: 0.25, sensitivity: 0.9, name: "loose",
    });
    expect(loose.offsets.length).toBeGreaterThanOrEqual(strict.offsets.length);
  });
});
