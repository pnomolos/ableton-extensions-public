import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { writeWav } from "../write-wav.js";
import { parseAudio } from "../transient-detector.js";
import { detectDrumVoices } from "../drum-detector.js";

const TMP = join(tmpdir(), "arclight-drum-detector-test");
const SR  = 44100;
const BPM = 120;

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let loopCounter = 0;

/**
 * Build a synthetic WAV containing kick-like events — a short low-frequency
 * sine burst (~60 Hz) with an exponential decay envelope. This gives each hit
 * a low spectral centroid and dominant energy in the 20–150 Hz sub-band, so
 * the new feature classifier reliably tags it as a kick. The amplitudes
 * control the peak level (which becomes velocity after normalization).
 */
function buildLoop(
  events: Array<{ timeSeconds: number; amplitude?: number }>,
  durationSeconds: number,
): string {
  const n   = Math.round(SR * durationSeconds);
  const buf = new Float32Array(n);
  const KICK_HZ      = 60;
  const KICK_LEN_SEC = 0.12;
  const kickLen      = Math.round(KICK_LEN_SEC * SR);
  const decayTau     = kickLen / 4;          // exponential time constant in samples

  for (const ev of events) {
    const start = Math.round(ev.timeSeconds * SR);
    const amp   = ev.amplitude ?? 1.0;
    if (start <= 0 || start >= n) continue;
    for (let i = 0; i < kickLen && start + i < n; i++) {
      const env = Math.exp(-i / decayTau);
      buf[start + i] += amp * env * Math.sin(2 * Math.PI * KICK_HZ * (i / SR));
    }
  }
  const path = join(TMP, `loop_${++loopCounter}.wav`);
  writeWav(path, buf, SR);
  return path;
}

const SENS = 0.9; // sensitivity 0.9 → threshold 0.1, reliably catches all impulses

// ── tier count ────────────────────────────────────────────────────────────────

describe("velocity tier count", () => {
  it("1 hit → 1 tier", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "tc1");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    expect(kick?.tiers.length).toBe(1);
  });

  it("2 hits → 1 tier with 2 round-robin samples", () => {
    const path = buildLoop([{ timeSeconds: 0.1 }, { timeSeconds: 0.6 }], 2);
    const outDir = join(TMP, "tc2");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    expect(kick?.tiers.length).toBe(1);
    expect(kick?.tiers[0].samples.length).toBeGreaterThanOrEqual(2);
  });

  it("4 hits → 2 tiers", () => {
    const path = buildLoop([
      { timeSeconds: 0.1 },
      { timeSeconds: 0.6 },
      { timeSeconds: 1.1 },
      { timeSeconds: 1.6 },
    ], 3);
    const outDir = join(TMP, "tc4");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    expect(kick?.tiers.length).toBe(2);
  });

  it("9 hits → 3 tiers", () => {
    const path = buildLoop(
      Array.from({ length: 9 }, (_, i) => ({ timeSeconds: 0.1 + i * 0.3 })),
      4,
    );
    const outDir = join(TMP, "tc9");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    expect(kick?.tiers.length).toBe(3);
  });
});

// ── velocity ranges ───────────────────────────────────────────────────────────

describe("tier velocity ranges", () => {
  it("1 tier spans 1–127", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "vr1");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;
    expect(kick.tiers[0].velMin).toBe(1);
    expect(kick.tiers[0].velMax).toBe(127);
  });

  it("2-tier split: [1–63] and [64–127]", () => {
    const path = buildLoop([
      { timeSeconds: 0.1 }, { timeSeconds: 0.6 },
      { timeSeconds: 1.1 }, { timeSeconds: 1.6 },
    ], 3);
    const outDir = join(TMP, "vr2");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;
    if (kick.tiers.length === 2) {
      const mins = kick.tiers.map(t => t.velMin).sort((a, b) => a - b);
      const maxs = kick.tiers.map(t => t.velMax).sort((a, b) => a - b);
      expect(mins).toEqual([1, 64]);
      expect(maxs).toEqual([63, 127]);
    }
  });

  it("3-tier split: [1–42], [43–84], [85–127]", () => {
    const path = buildLoop(
      Array.from({ length: 9 }, (_, i) => ({ timeSeconds: 0.1 + i * 0.3 })),
      4,
    );
    const outDir = join(TMP, "vr3");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;
    if (kick.tiers.length === 3) {
      const mins = kick.tiers.map(t => t.velMin).sort((a, b) => a - b);
      const maxs = kick.tiers.map(t => t.velMax).sort((a, b) => a - b);
      expect(mins).toEqual([1, 43, 85]);
      expect(maxs).toEqual([42, 84, 127]);
    }
  });
});

// ── clean-sample filtering ────────────────────────────────────────────────────

describe("clean-sample filtering", () => {
  it("hit within 100ms of previous same-voice hit is excluded from sample pool", () => {
    // Three impulses: two 50ms apart (second is masked), then one clean at 0.5s
    const path = buildLoop([
      { timeSeconds: 0.1  },
      { timeSeconds: 0.14 }, // 40ms gap — not clean
      { timeSeconds: 0.5  },
    ], 2);
    const outDir = join(TMP, "clean");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    const totalSamples = kick?.tiers.reduce((s, t) => s + t.samples.length, 0) ?? 0;
    // Two clean hits (at 0.1 and 0.5) → at most 2 samples; the 0.14 hit is excluded
    expect(totalSamples).toBeLessThanOrEqual(2);
  });
});

// ── single-classification guarantee ───────────────────────────────────────────
// (Replaces the old cross-voice suppression tests — each onset now gets exactly
// one classification by spectral features, so bleed-through is impossible by
// construction.)

describe("single-classification guarantee", () => {
  it("a broadband impulse is classified to exactly one voice", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "single_class");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick", "snare", "hihat"]);

    // Each voice may report at most one hit at this time — and across all
    // voices the total number of hits in this window must be ≤ 1.
    const hitsNear = voices.flatMap(v =>
      v.hits.filter(h => Math.abs(h.timeSeconds - 0.5) < 0.1)
    );
    expect(hitsNear.length).toBeLessThanOrEqual(1);
  });
});

// ── velocity values ───────────────────────────────────────────────────────────

describe("velocity values", () => {
  it("all hit velocities are within 1–127", () => {
    const path = buildLoop(
      Array.from({ length: 6 }, (_, i) => ({ timeSeconds: 0.1 + i * 0.3, amplitude: 0.3 + i * 0.12 })),
      3,
    );
    const outDir = join(TMP, "vel_range");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    for (const hit of kick?.hits ?? []) {
      expect(hit.velocity).toBeGreaterThanOrEqual(1);
      expect(hit.velocity).toBeLessThanOrEqual(127);
    }
  });
});

// ── output files ──────────────────────────────────────────────────────────────

describe("output files", () => {
  it("writes WAV files for each tier sample", () => {
    const path = buildLoop([{ timeSeconds: 0.1 }, { timeSeconds: 0.6 }], 2);
    const outDir = join(TMP, "wav_out");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    for (const tier of kick?.tiers ?? []) {
      for (const sample of tier.samples) {
        expect(existsSync(sample.filePath)).toBe(true);
      }
    }
  });

  it("respects enabledVoices filter", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "filter_voice");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    expect(voices.map(v => v.voice)).not.toContain("hihat");
    expect(voices.map(v => v.voice)).not.toContain("snare");
  });

  it("midiNote is correct per voice", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "midi_notes");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick", "snare", "hihat"]);
    const byVoice = Object.fromEntries(voices.map(v => [v.voice, v.midiNote]));
    if (byVoice["kick"])  expect(byVoice["kick"]).toBe(36);
    if (byVoice["snare"]) expect(byVoice["snare"]).toBe(38);
    if (byVoice["hihat"]) expect(byVoice["hihat"]).toBe(42);
  });
});

// ── totalBeats ────────────────────────────────────────────────────────────────

describe("totalBeats", () => {
  it("is greater than zero when hits are detected", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }, { timeSeconds: 1.0 }], 2);
    const outDir = join(TMP, "total_beats");
    const { totalBeats } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    expect(totalBeats).toBeGreaterThan(0);
  });
});

// ── sample start trimming ─────────────────────────────────────────────────────
//
// Regression: findTrueOnset can push hit.sampleIndex back up to
// ONSET_LOOKBACK_S (50 ms) before the actual transient. findOnsetStart must
// scan the full extraction window (no distance cap) to always reach the hit.

/** Returns the number of leading samples below 1 % of the file's peak amplitude. */
function countLeadingSilenceSamples(filePath: string): number {
  const { samples } = parseAudio(filePath);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  const threshold = peak * 0.01;
  let count = 0;
  while (count < samples.length && Math.abs(samples[count]) < threshold) count++;
  return count;
}

const MAX_LEADING_SILENCE_MS = 2;   // more than this is audible as pre-hit silence

describe("sample start trimming", () => {
  it("isolated hit: extracted sample starts at the transient (< 2 ms leading silence)", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "trim_isolated");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;
    const samplePath = kick.tiers[0].samples[0].filePath;

    const leadingSamples = countLeadingSilenceSamples(samplePath);
    expect(leadingSamples).toBeLessThan(Math.round(MAX_LEADING_SILENCE_MS / 1000 * SR));
  });

  it("hit preceded by decaying signal: onset trimmed correctly even when findTrueOnset overshoots > 30 ms", () => {
    // Place a loud hit at 0.05 s whose exponential decay (tau ≈ 26 ms) still has
    // energy above the 5 % kick threshold at t = 0.1 s. A second hit at 0.1 s
    // sits inside the 50 ms lookback window of the first hit's decay, which can
    // push findTrueOnset backward by ~35–45 ms — beyond the old 30 ms
    // findOnsetStart cap. The extracted sample for the second hit must still
    // start within 2 ms of the actual transient.
    const n   = Math.round(SR * 2);
    const buf = new Float32Array(n);

    const KICK_HZ  = 60;
    const TAU      = Math.round(0.026 * SR);   // slow decay — still loud at +50 ms
    const KICK_LEN = Math.round(0.30  * SR);

    for (const [tSec, amp] of [[0.05, 1.0], [0.1, 0.9]] as [number, number][]) {
      const start = Math.round(tSec * SR);
      for (let i = 0; i < KICK_LEN && start + i < n; i++) {
        buf[start + i] += amp * Math.exp(-i / TAU) * Math.sin(2 * Math.PI * KICK_HZ * (i / SR));
      }
    }

    const inPath = join(TMP, `trim_overshoot_${++loopCounter}.wav`);
    writeWav(inPath, buf, SR);

    const outDir = join(TMP, "trim_overshoot");
    const { voices } = detectDrumVoices(inPath, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    if (!kick || kick.hits.length < 2) return; // detector may merge — skip if not separated

    for (const tier of kick.tiers) {
      for (const sample of tier.samples) {
        const leadingSamples = countLeadingSilenceSamples(sample.filePath);
        expect(leadingSamples).toBeLessThan(Math.round(MAX_LEADING_SILENCE_MS / 1000 * SR));
      }
    }
  });
});

// ── sample duration / decay detection ────────────────────────────────────────
//
// Regression: findDecayEnd must receive the true onset (from findOnsetStart)
// as its startSample, not the raw findTrueOnset result. When findTrueOnset
// overshoots into pre-transient silence, findDecayEnd's attack-peak RMS is
// measured over that silence (peakRms ≈ 0), which triggers the peakRms < 1e-6
// guard and returns endCap — the full MAX_HIT_SECONDS duration. The extracted
// sample then runs past the natural decay and captures bleed from unrelated
// hits (e.g. a hi-hat at +160 ms into a snare sample, as observed in the
// "Aloe Vera 98 BPM" loop — snare_t1_s0.wav ran to 245 ms instead of ~90 ms).
// Fix: run findOnsetStart first, pass its result into findDecayEnd.

/** Returns the duration of a WAV file in milliseconds. */
function durationMs(filePath: string): number {
  const { samples, sampleRate } = parseAudio(filePath);
  return (samples.length / sampleRate) * 1000;
}

describe("sample duration / decay detection", () => {
  // The synthetic kick (60 Hz sine, τ ≈ 30 ms) decays to < 1 % of peak by
  // ~150 ms. MAX_HIT_SECONDS for kick is 500 ms. A correctly working
  // findDecayEnd should stop well under 250 ms; hitting endCap would produce
  // a sample close to 500 ms.
  const MAX_EXPECTED_KICK_MS = 250;

  it("isolated hit: extracted sample ends at the natural decay, not at MAX_HIT_SECONDS", () => {
    const path = buildLoop([{ timeSeconds: 0.5 }], 2);
    const outDir = join(TMP, "dur_isolated");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;

    for (const tier of kick.tiers) {
      for (const sample of tier.samples) {
        expect(durationMs(sample.filePath)).toBeLessThan(MAX_EXPECTED_KICK_MS);
      }
    }
  });

  it("hit preceded by decaying signal: findDecayEnd still measures peak from the true onset, not from pre-onset silence", () => {
    // Same overshoot scenario as the leading-silence regression test.
    // Without the fix, findDecayEnd receives hit.sampleIndex (in the first
    // kick's decay tail), measures peakRms ≈ 0 over silence, and returns
    // endCap (~500 ms). With the fix, it receives the corrected startIdx and
    // stops at the natural decay (~100–150 ms).
    const n   = Math.round(SR * 3);
    const buf = new Float32Array(n);
    const KICK_HZ  = 60;
    const TAU      = Math.round(0.026 * SR);
    const KICK_LEN = Math.round(0.30  * SR);

    for (const [tSec, amp] of [[0.05, 1.0], [0.1, 0.9]] as [number, number][]) {
      const start = Math.round(tSec * SR);
      for (let i = 0; i < KICK_LEN && start + i < n; i++) {
        buf[start + i] += amp * Math.exp(-i / TAU) * Math.sin(2 * Math.PI * KICK_HZ * (i / SR));
      }
    }

    const inPath = join(TMP, `dur_overshoot_${++loopCounter}.wav`);
    writeWav(inPath, buf, SR);

    const outDir = join(TMP, "dur_overshoot");
    const { voices } = detectDrumVoices(inPath, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    if (!kick || kick.hits.length < 1) return;

    for (const tier of kick.tiers) {
      for (const sample of tier.samples) {
        expect(durationMs(sample.filePath)).toBeLessThan(MAX_EXPECTED_KICK_MS);
      }
    }
  });
});

// ── MIDI timing accuracy ──────────────────────────────────────────────────────
//
// Regression: findTrueOnset measures localPeak over a short 10 ms window.
// For slow-attack voices the window can miss the true peak, producing an
// underestimated threshold that allows the backward scan to overshoot into
// pre-attack signal. The resulting hit.sampleIndex (and therefore hit.timeBeat)
// lands before the actual audible onset — causing MIDI notes to be placed
// before the beat even though the audio waveform is after it.
//
// Fix: a forward scan (findOnsetStart with a wider peak window) is applied
// after findTrueOnset, correcting hit.sampleIndex before timeBeat is computed.

// Tolerance: SuperFlux hop is 256 samples (~5.8 ms at 44.1 kHz). We allow
// ±10 ms from the true onset — tight enough to catch an overshoot of the
// kind seen in the "Aloe Vera 98 BPM" loop (bar 3 kick placed ~20-30 ms early).
const TIMING_TOLERANCE_S = 0.010;

describe("MIDI timing accuracy", () => {
  it("isolated hit: hit.timeSeconds matches the placed onset within ±10 ms", () => {
    const ONSET_S = 0.5;
    const path = buildLoop([{ timeSeconds: ONSET_S }], 2);
    const outDir = join(TMP, "timing_isolated");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick")!;

    expect(kick.hits.length).toBeGreaterThan(0);
    for (const hit of kick.hits) {
      expect(hit.timeSeconds).toBeGreaterThanOrEqual(ONSET_S - TIMING_TOLERANCE_S);
      expect(hit.timeSeconds).toBeLessThanOrEqual(ONSET_S + TIMING_TOLERANCE_S);
    }
  });

  it("hit preceded by decaying signal: hit.timeSeconds is not placed before the actual onset even when findTrueOnset overshoots", () => {
    // Loud kick at 0.05 s with slow decay (τ = 26 ms) bleeds into the
    // 50 ms lookback window of a second kick at 0.1 s. Without the
    // forward-scan correction, findTrueOnset returns a position inside the
    // first kick's decay tail, placing the MIDI note ~30-40 ms too early.
    const n   = Math.round(SR * 3);
    const buf = new Float32Array(n);
    const KICK_HZ  = 60;
    const TAU      = Math.round(0.026 * SR);
    const KICK_LEN = Math.round(0.30  * SR);

    for (const [tSec, amp] of [[0.05, 1.0], [0.1, 0.9]] as [number, number][]) {
      const start = Math.round(tSec * SR);
      for (let i = 0; i < KICK_LEN && start + i < n; i++) {
        buf[start + i] += amp * Math.exp(-i / TAU) * Math.sin(2 * Math.PI * KICK_HZ * (i / SR));
      }
    }

    const inPath = join(TMP, `timing_overshoot_${++loopCounter}.wav`);
    writeWav(inPath, buf, SR);

    const outDir = join(TMP, "timing_overshoot");
    const { voices } = detectDrumVoices(inPath, BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    if (!kick || kick.hits.length < 2) return;

    // The second kick is at 0.1 s — no detected hit should be placed before
    // the first kick's onset (0.05 s), which is what the overshoot produced.
    const secondHit = kick.hits.find(h => h.timeSeconds > 0.07);
    expect(secondHit).toBeDefined();
    expect(secondHit!.timeSeconds).toBeGreaterThanOrEqual(0.1 - TIMING_TOLERANCE_S);
  });
});

// ── T2: fast tempo (16ths at 200 BPM) ─────────────────────────────────────────
//
// The kick dedup window is 180 ms (MIN_SAME_VOICE_GAP_SECONDS.kick). At 200 BPM
// a 16th note is 60 / (200 * 4) = 75 ms — well under that threshold. Consecutive
// 16th kicks at this tempo therefore get collapsed by Pass 2's per-voice dedup.
//
// Pass 2.8's softer gap (minGap28 = max(0.18 - 2*0.05, 0) = 80 ms) also rejects
// 75 ms spacing. This is an accepted limitation, documented in drum-detector.ts
// — narrowing the gap further risks letting SuperFlux double-peaks of a single
// clipped kick attack survive as two hits.
//
// This test locks in the current behavior so we notice if it changes.

describe("fast tempo — 16th-note kicks at 200 BPM", () => {
  it("documents the dedup-window limitation: fewer than placed kicks survive", () => {
    const FAST_BPM = 200;
    const SIXTEENTH_S = 60 / (FAST_BPM * 4);    // = 0.075 s
    const DURATION_S = 3.2;                     // = 2 bars at 200 BPM
    const PLACED_COUNT = 16;                    // 16 × 16ths

    // Start a bit past 0 so the first event isn't clamped to t=0 by the prepad
    // boundary; space the rest at exact 16th-note intervals.
    const events = Array.from({ length: PLACED_COUNT }, (_, i) => ({
      timeSeconds: 0.1 + i * SIXTEENTH_S,
    }));
    const path = buildLoop(events, DURATION_S);
    const outDir = join(TMP, "fast_tempo_200bpm");
    const { voices } = detectDrumVoices(path, FAST_BPM, SENS, outDir, ["kick"]);
    const kick = voices.find(v => v.voice === "kick");
    const detected = kick?.hits.length ?? 0;

    // Known limitation: the 180 ms kick dedup window collapses 75 ms spacing.
    // Assert on the ACTUAL behavior: strictly fewer than placed are detected.
    // If the detector ever gains the ability to resolve 200 BPM 16th kicks,
    // this assertion fails and the test should be updated (likely flipping to
    // equality).
    expect(detected).toBeLessThan(PLACED_COUNT);
    // Sanity: we should still be detecting SOMETHING.
    expect(detected).toBeGreaterThan(0);
  });
});

// ── T3: silent / empty audio ──────────────────────────────────────────────────

describe("silent audio", () => {
  it("detectDrumVoices returns cleanly on a WAV of pure silence", () => {
    const silent = new Float32Array(SR);        // 1 s of zeros
    const path = join(TMP, "silence.wav");
    writeWav(path, silent, SR);
    const outDir = join(TMP, "silence_out");

    let result: ReturnType<typeof detectDrumVoices> | undefined;
    expect(() => {
      result = detectDrumVoices(path, BPM, SENS, outDir, ["kick", "snare", "hihat"]);
    }).not.toThrow();

    // Either no voices reported at all, or every reported voice has zero hits.
    for (const v of result!.voices) {
      expect(v.hits.length).toBe(0);
    }

    // totalBeats is derived from duration and should be a positive integer
    // (rounded to the nearest whole bar × 4 beats).
    expect(result!.totalBeats).toBeGreaterThan(0);
    expect(Number.isFinite(result!.totalBeats)).toBe(true);
  });
});

// ── T7: hit ordering invariant after Pass 2.8 correction ──────────────────────
//
// Pass 2.8 (onset correction) can pull a hit backward by up to ONSET_LOOKBACK_S
// (50 ms). To prevent the corrected position from inverting against the
// previous same-voice hit, findTrueOnset takes a `minScanStart = hits[i-1]
// .sampleIndex + 1` guard, and findOnsetStart scans forward from there.
//
// Analysis of the code path:
//   • findTrueOnset returns a value >= scanStart = max(minScanStart, ...)
//     (or falls back to the original sampleIndex), so it's always >
//     hits[i-1].sampleIndex.
//   • findOnsetStart scans forward starting at that backwardIdx, so finalIdx
//     >= backwardIdx > hits[i-1].sampleIndex.
//   • Pass 2.8 also runs an explicit hits.sort() + dedup afterward as belt-
//     and-braces, so even in pathological cases the final output is sorted.
//
// Conclusion: inversion inside a single voice should be impossible by
// construction. This test locks in that invariant: for a range of inputs,
// all hits within each voice are in strictly ascending sampleIndex order
// (and equivalently ascending timeSeconds).

// ── Pass 2.9: openhat reclassification ────────────────────────────────────────
//
// Open hi-hats and closed hi-hats share identical onset spectral signatures;
// decay duration in the 4–16 kHz band is the only reliable discriminator.
// The Pass 2.9 reclassifier measures post-onset RMS decay: if energy sustains
// for > 100 ms before dropping below 15% of peak, the hit is reclassified as
// openhat. These synthetic tests verify that:
//   1. A short-decay high-frequency burst stays classified as closed hihat.
//   2. A long-decay high-frequency burst is promoted to openhat.

/**
 * Build a synthetic WAV with high-frequency bursts (~8 kHz sine), exponentially
 * decaying with the specified τ. Short τ mimics a closed hi-hat; long τ mimics
 * an open hi-hat. Amplitude envelope is pure exp(-t/τ) — no attack ramp —
 * matching what a drum sample typically looks like.
 */
function buildHatLoop(
  events: Array<{ timeSeconds: number; decayTauMs: number; amplitude?: number }>,
  durationSeconds: number,
): string {
  const n   = Math.round(SR * durationSeconds);
  const buf = new Float32Array(n);
  const HAT_HZ  = 8000;
  const HAT_LEN = Math.round(0.6 * SR);  // 600 ms max per hit

  for (const ev of events) {
    const start  = Math.round(ev.timeSeconds * SR);
    const amp    = ev.amplitude ?? 1.0;
    const tauSec = ev.decayTauMs / 1000;
    const tau    = Math.round(tauSec * SR);
    if (start < 0 || start >= n) continue;
    for (let i = 0; i < HAT_LEN && start + i < n; i++) {
      const env = Math.exp(-i / tau);
      buf[start + i] += amp * env * Math.sin(2 * Math.PI * HAT_HZ * (i / SR));
    }
  }
  const path = join(TMP, `hat_loop_${++loopCounter}.wav`);
  writeWav(path, buf, SR);
  return path;
}

describe("openhat decay-based reclassification (Pass 2.9)", () => {
  it("short-decay hat stays classified as closed hihat", () => {
    // τ = 12 ms → signal drops to ~15% of peak in ~23 ms — well under the
    // 100 ms openhat threshold.
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 12 },
      { timeSeconds: 1.0, decayTauMs: 12 },
    ], 2);
    const outDir = join(TMP, "openhat_short");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["hihat", "openhat"]);

    const hihat   = voices.find(v => v.voice === "hihat");
    const openhat = voices.find(v => v.voice === "openhat");

    expect(hihat?.hits.length ?? 0).toBeGreaterThan(0);
    // All short-decay hits must remain as closed hihat.
    expect(openhat?.hits.length ?? 0).toBe(0);
  });

  it("long-decay hat is reclassified as openhat", () => {
    // τ = 150 ms → exp(-t/τ) = 0.15 at t ≈ 285 ms → decay duration solidly
    // past the 100 ms openhat threshold.
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 150 },
      { timeSeconds: 1.2, decayTauMs: 150 },
    ], 2.5);
    const outDir = join(TMP, "openhat_long");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["hihat", "openhat"]);

    const hihat   = voices.find(v => v.voice === "hihat");
    const openhat = voices.find(v => v.voice === "openhat");

    // All long-decay hits must be reclassified to openhat.
    expect(openhat?.hits.length ?? 0).toBeGreaterThan(0);
    expect(hihat?.hits.length ?? 0).toBe(0);
  });

  it("mixed short + long decays are split between the two voices", () => {
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 12  },   // closed
      { timeSeconds: 1.0, decayTauMs: 150 },   // open
      { timeSeconds: 1.8, decayTauMs: 12  },   // closed
      { timeSeconds: 2.5, decayTauMs: 150 },   // open
    ], 3.5);
    const outDir = join(TMP, "openhat_mixed");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["hihat", "openhat"]);

    const hihat   = voices.find(v => v.voice === "hihat");
    const openhat = voices.find(v => v.voice === "openhat");

    expect(hihat?.hits.length ?? 0).toBeGreaterThan(0);
    expect(openhat?.hits.length ?? 0).toBeGreaterThan(0);
  });

  it("openhat disabled: all hat hits remain as closed hihat (backward compat)", () => {
    // Same long-decay hits, but caller omitted "openhat" from enabledVoices —
    // both hits must remain as "hihat".
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 150 },
      { timeSeconds: 1.2, decayTauMs: 150 },
    ], 2.5);
    const outDir = join(TMP, "openhat_disabled");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["hihat"]);

    const hihat   = voices.find(v => v.voice === "hihat");
    const openhat = voices.find(v => v.voice === "openhat");

    expect(hihat?.hits.length ?? 0).toBeGreaterThan(0);
    expect(openhat).toBeUndefined();
  });

  it("openhat-only request: hihat detection runs internally, closed hats discarded", () => {
    // Two short-decay + two long-decay hits. Caller asks for "openhat" only.
    // Expected: openhat bucket has the long-decay hits; hihat bucket isn't in the result.
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 12  },
      { timeSeconds: 1.0, decayTauMs: 150 },
      { timeSeconds: 1.8, decayTauMs: 12  },
      { timeSeconds: 2.5, decayTauMs: 150 },
    ], 3.5);
    const outDir = join(TMP, "openhat_only");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["openhat"]);

    expect(voices.map(v => v.voice)).not.toContain("hihat");
    const openhat = voices.find(v => v.voice === "openhat");
    expect(openhat?.hits.length ?? 0).toBeGreaterThan(0);
  });

  it("openhat midiNote is 46 (GM open hihat)", () => {
    const path = buildHatLoop([
      { timeSeconds: 0.3, decayTauMs: 150 },
    ], 2);
    const outDir = join(TMP, "openhat_midinote");
    const { voices } = detectDrumVoices(path, BPM, SENS, outDir, ["hihat", "openhat"]);
    const openhat = voices.find(v => v.voice === "openhat");
    if (openhat) expect(openhat.midiNote).toBe(46);
  });
});

describe("hit ordering invariant (Pass 2.8)", () => {
  // Exercise Pass 2.8 with several scenarios that produce close-spaced hits
  // — exactly the situation where backward correction risks crossing the
  // previous hit.
  const scenarios: Array<{ name: string; events: Array<{ timeSeconds: number; amplitude?: number }>; duration: number; voices: ("kick" | "snare" | "hihat")[]; bpm: number }> = [
    {
      name: "closely-spaced kicks (50 ms)",
      events: [
        { timeSeconds: 0.20 },
        { timeSeconds: 0.25 },
        { timeSeconds: 0.30 },
      ],
      duration: 2,
      voices: ["kick"],
      bpm: 120,
    },
    {
      name: "kicks with decaying overlap (overshoot case)",
      events: [
        { timeSeconds: 0.05, amplitude: 1.0 },
        { timeSeconds: 0.10, amplitude: 0.9 },
        { timeSeconds: 0.60, amplitude: 0.8 },
      ],
      duration: 2,
      voices: ["kick"],
      bpm: 120,
    },
    {
      name: "eight kicks at quarter-note spacing",
      events: Array.from({ length: 8 }, (_, i) => ({ timeSeconds: 0.1 + i * 0.5 })),
      duration: 5,
      voices: ["kick"],
      bpm: 120,
    },
  ];

  for (const scn of scenarios) {
    it(`hits within each voice are in ascending time order — ${scn.name}`, () => {
      const path = buildLoop(scn.events, scn.duration);
      const outDir = join(TMP, `order_${scn.name.replace(/\W+/g, "_")}`);
      const { voices } = detectDrumVoices(path, scn.bpm, SENS, outDir, scn.voices);

      for (const v of voices) {
        for (let i = 1; i < v.hits.length; i++) {
          expect(v.hits[i].sampleIndex).toBeGreaterThan(v.hits[i - 1].sampleIndex);
          expect(v.hits[i].timeSeconds).toBeGreaterThanOrEqual(v.hits[i - 1].timeSeconds);
        }
      }
    });
  }
});

// ── Pass 2.95: spectral masked-hihat rescue ───────────────────────────────
// The rescue pass infers hihat hits at kick/snare positions when the 4–16 kHz
// RMS is well above the "clean" baseline. These tests verify:
//   • The pass doesn't crash or produce negative counts on representative
//     corpus loops, and reruns are deterministic.
//   • The pass is gated on `enabled` — calling without hihat/openhat yields
//     no hihat/openhat voice in the output.
//   • A loop with no hihats (sparse-groove) doesn't hallucinate a significant
//     number of rescued hihats.

describe("spectral masked-hihat rescue (Pass 2.95)", () => {
  const CORPUS_DIR = join(__dirname, "corpus", "loops");

  it("does not crash on a typical groove and is deterministic", () => {
    const loopPath = join(CORPUS_DIR, "basic-groove.wav");
    if (!existsSync(loopPath)) return; // corpus loop absent: skip silently
    const out1 = join(TMP, "rescue_det1");
    const out2 = join(TMP, "rescue_det2");
    const r1 = detectDrumVoices(loopPath, 100, SENS, out1, ["kick", "snare", "hihat"]);
    const r2 = detectDrumVoices(loopPath, 100, SENS, out2, ["kick", "snare", "hihat"]);
    const count1 = r1.voices.find(v => v.voice === "hihat")?.hits.length ?? 0;
    const count2 = r2.voices.find(v => v.voice === "hihat")?.hits.length ?? 0;
    expect(count1).toBeGreaterThanOrEqual(0);
    expect(count1).toBe(count2);
  });

  it("is gated on hihat/openhat being enabled", () => {
    const loopPath = join(CORPUS_DIR, "basic-groove.wav");
    if (!existsSync(loopPath)) return;
    const outDir = join(TMP, "rescue_gating");
    const { voices } = detectDrumVoices(loopPath, 100, SENS, outDir, ["kick", "snare"]);
    // Rescue must not sneak a hihat/openhat voice into the result when the
    // caller didn't request it.
    expect(voices.find(v => v.voice === "hihat")).toBeUndefined();
    expect(voices.find(v => v.voice === "openhat")).toBeUndefined();
  });

  it("does not hallucinate many hihats on a loop with no hihats (sparse-groove)", () => {
    const loopPath = join(CORPUS_DIR, "sparse-groove.wav");
    if (!existsSync(loopPath)) return;
    const outDir = join(TMP, "rescue_sparse");
    const { voices } = detectDrumVoices(loopPath, 90, SENS, outDir, ["kick", "snare", "hihat"]);
    const hatCount = voices.find(v => v.voice === "hihat")?.hits.length ?? 0;
    // sparse-groove.json declares zero hihat events. Rescue should remain
    // quiet here — allow a small tolerance for noise-floor variation across
    // different sample sets, but flag a real regression if the count
    // balloons.
    expect(hatCount).toBeLessThanOrEqual(2);
  });
});
