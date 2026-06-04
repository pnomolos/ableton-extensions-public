/**
 * Targeted diagnostic for the open hi-hat co-occurring with a kick at bar 1,
 * beat 7/16 in Aloe Vera 98 BPM (~1.07 s).
 *
 * Checks:
 *  1. What voices are detected near 1.07 s
 *  2. HF RMS at that position vs the clean-kick baseline
 *  3. HF decay time at that position (openhat classifier)
 *  4. Pass 2.95 rescue ratio
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices } from "../drum-detector.js";
import { parseAudio, applyBandpassFilter } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;

// Beat 7/16 = 1.75 quarter-beats from bar 1.
// Time = 1.75 / 98 * 60 = 1.0714 s
const TARGET_S   = (7 / 4) / BPM * 60;  // 1.0714 s
const SEARCH_WIN = 0.080;                 // ±80 ms search window

console.log(`Target time: ${TARGET_S.toFixed(4)} s  (bar 1 beat 7/16 @ ${BPM} bpm)\n`);

const wav = parseAudio(FILE);
const hfBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);

// ── HF-decay probe (same params as Pass 2.9 / Pass 2.95) ──────────────────
const FRAME            = 256;
const PEAK_WINDOW_S    = 0.025;
const MEASURE_WINDOW_S = 0.300;
const DECAY_DROP       = 0.15;
const SUSTAIN_FRAMES   = 2;
const DECAY_THRESHOLD_S = 0.100;
const peakFrameCount    = Math.max(1, Math.floor(PEAK_WINDOW_S    * wav.sampleRate / FRAME));
const measureFrameCount = Math.max(1, Math.floor(MEASURE_WINDOW_S * wav.sampleRate / FRAME));

const frameRms = (start: number): number => {
  let s = 0;
  const endIdx = Math.min(start + FRAME, hfBand.length);
  for (let i = start; i < endIdx; i++) s += hfBand[i] * hfBand[i];
  return Math.sqrt(s / FRAME);
};

const measureDecay = (sampleIdx: number): { decayS: number; voice: "hihat" | "openhat" } => {
  let peakRms = 0;
  for (let f = 0; f < peakFrameCount; f++) {
    const r = frameRms(sampleIdx + f * FRAME);
    if (r > peakRms) peakRms = r;
  }
  if (peakRms < 1e-6) return { decayS: 0, voice: "hihat" };
  const threshold = peakRms * DECAY_DROP;
  let below = 0;
  let decayFrame = measureFrameCount;
  for (let f = peakFrameCount; f < measureFrameCount; f++) {
    const r = frameRms(sampleIdx + f * FRAME);
    if (r < threshold) {
      below++;
      if (below >= SUSTAIN_FRAMES) { decayFrame = f - SUSTAIN_FRAMES + 1; break; }
    } else below = 0;
  }
  const decayS = (decayFrame * FRAME) / wav.sampleRate;
  return { decayS, voice: decayS > DECAY_THRESHOLD_S ? "openhat" : "hihat" };
};

const windowRms = (centerIdx: number, windowSize: number): number => {
  const half  = windowSize >> 1;
  const start = Math.max(0, centerIdx - half);
  const end   = Math.min(hfBand.length, centerIdx + half);
  let s = 0;
  for (let i = start; i < end; i++) s += hfBand[i] * hfBand[i];
  return end > start ? Math.sqrt(s / (end - start)) : 0;
};

// ── Run full detection ─────────────────────────────────────────────────────
const outDir   = join(tmpdir(), "aloe-kick-openhat-diag");
const analysis = detectDrumVoices(FILE, BPM, 0.5, outDir, ["kick", "snare", "hihat", "openhat"]);

const allHits = analysis.voices.flatMap(v => v.hits)
  .sort((a, b) => a.sampleIndex - b.sampleIndex);

console.log("=== Hits near target (±80 ms) ===");
console.log("voice\tbeat\ttimeS\tsampleIdx");
for (const h of allHits) {
  if (Math.abs(h.timeSeconds - TARGET_S) < SEARCH_WIN) {
    const beat = (h.timeSeconds / 60) * BPM;
    console.log(`${h.voice}\t${beat.toFixed(4)}\t${h.timeSeconds.toFixed(4)}\t${h.sampleIndex}`);
  }
}

// ── Check HF at target position ────────────────────────────────────────────
const targetSample = Math.round(TARGET_S * wav.sampleRate);
const RMS_WINDOW   = 512;
const hfAtTarget   = windowRms(targetSample, RMS_WINDOW);
const decayResult  = measureDecay(targetSample);

console.log(`\n=== HF at target sample ${targetSample} ===`);
console.log(`hfRms(512): ${hfAtTarget.toFixed(6)}`);
console.log(`decayS: ${decayResult.decayS.toFixed(3)} s  →  ${decayResult.voice}`);

// ── Rebuild baseline the way Pass 2.95 does ───────────────────────────────
const kickHits  = analysis.voices.find(v => v.voice === "kick")?.hits    ?? [];
const snareHits = analysis.voices.find(v => v.voice === "snare")?.hits   ?? [];
const hatHits   = analysis.voices.find(v => v.voice === "hihat")?.hits   ?? [];
const openHits  = analysis.voices.find(v => v.voice === "openhat")?.hits ?? [];
const existingHats = [...hatHits, ...openHits].sort((a, b) => a.sampleIndex - b.sampleIndex);

const COINCIDENCE_WINDOW_S = 0.025;
const coincidenceSamples   = Math.round(COINCIDENCE_WINDOW_S * wav.sampleRate);

const hasCooccurringHat = (sampleIdx: number): boolean =>
  existingHats.some(h => Math.abs(h.sampleIndex - sampleIdx) <= coincidenceSamples);

const kickSnareHits = [...kickHits, ...snareHits].sort((a, b) => a.sampleIndex - b.sampleIndex);
const cleanRefs     = kickSnareHits.filter(h => !hasCooccurringHat(h.sampleIndex));

console.log(`\n=== Pass 2.95 baseline simulation ===`);
console.log(`Total kick+snare: ${kickSnareHits.length}`);
console.log(`Clean refs (no hat): ${cleanRefs.length}`);
console.log(`Existing hats: ${existingHats.length}`);

if (cleanRefs.length >= 2 && existingHats.length >= 1) {
  const baselineSamples = cleanRefs.map(h => windowRms(h.sampleIndex, RMS_WINDOW));
  const hatSamples      = existingHats.map(h => windowRms(h.sampleIndex, RMS_WINDOW));

  const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
  const medianFn = (arr: number[]) => {
    const s = sorted(arr);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  };

  const hfBaseline     = medianFn(baselineSamples);
  const hfHatReference = medianFn(hatSamples);

  console.log(`hfBaseline (median): ${hfBaseline.toFixed(6)}`);
  console.log(`hfHatRef   (median): ${hfHatReference.toFixed(6)}`);
  console.log(`HF_RESCUE_RATIO: 2.5 → threshold = ${(hfBaseline * 2.5).toFixed(6)}`);
  console.log(`HF at target: ${hfAtTarget.toFixed(6)}  ratio vs baseline: ${(hfAtTarget / hfBaseline).toFixed(2)}x`);
  console.log(`Would rescue? ${hfAtTarget > hfBaseline * 2.5 ? "YES" : "NO"}`);

  // Check each kick/snare near target
  console.log(`\n=== Kick+snare candidates near target ===`);
  console.log("voice\tbeatS\thfRms\tratio\thasHat?\twould rescue?");
  for (const h of kickSnareHits) {
    if (Math.abs(h.timeSeconds - TARGET_S) < SEARCH_WIN) {
      const hf    = windowRms(h.sampleIndex, RMS_WINDOW);
      const ratio = hf / hfBaseline;
      const hasHat = hasCooccurringHat(h.sampleIndex);
      const beat = (h.timeSeconds / 60) * BPM;
      const d = measureDecay(h.sampleIndex);
      console.log(`${h.voice}\t${beat.toFixed(4)}\t${hf.toFixed(6)}\t${ratio.toFixed(2)}x\t${hasHat}\t${!hasHat && ratio > 2.5 ? "YES→" + d.voice : "no"}`);
    }
  }
} else {
  console.log("Not enough data for baseline simulation");
}

// ── Also show all detections so we can see the full pattern ──────────────
console.log(`\n=== Full detection summary ===`);
for (const v of analysis.voices) {
  const beats = v.hits.map(h => ((h.timeSeconds / 60) * BPM).toFixed(3)).join(", ");
  console.log(`${v.voice}: ${v.hits.length} hits  [${beats}]`);
}
