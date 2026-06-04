/**
 * Show all SuperFlux transients in Aloe Vera with varying sensitivity,
 * focusing on the region 0.8–1.3 s (bar 1, beat 7/16 area ≈ 1.07 s).
 */
import { parseAudio, detectTransientsSuperFlux, applyBandpassFilter } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;

const wav    = parseAudio(FILE);
const hfBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);

const FRAME = 256;
const frameRms = (start: number): number => {
  let s = 0; const end = Math.min(start + FRAME, hfBand.length);
  for (let i = start; i < end; i++) s += hfBand[i] * hfBand[i];
  return Math.sqrt(s / FRAME);
};
const measureDecayMs = (si: number): number => {
  const PEAK_F = Math.max(1, Math.floor(0.025 * wav.sampleRate / FRAME));
  const MEAS_F = Math.max(1, Math.floor(0.300 * wav.sampleRate / FRAME));
  let peakRms = 0;
  for (let f = 0; f < PEAK_F; f++) { const r = frameRms(si + f * FRAME); if (r > peakRms) peakRms = r; }
  if (peakRms < 1e-6) return 0;
  const thr = peakRms * 0.15; let below = 0;
  for (let f = PEAK_F; f < MEAS_F; f++) {
    const r = frameRms(si + f * FRAME);
    if (r < thr) { below++; if (below >= 2) return ((f - 1) * FRAME / wav.sampleRate * 1000); }
    else below = 0;
  }
  return (MEAS_F * FRAME / wav.sampleRate * 1000);
};

for (const sens of [0.3, 0.5, 0.7, 0.85]) {
  const threshold = 1 - sens;
  const transients = detectTransientsSuperFlux(wav, { bpm: BPM, threshold, windowSize: 512, hopSize: 256 });
  const near = transients.filter(t => t.timeSeconds >= 0.8 && t.timeSeconds <= 1.3);
  console.log(`\n=== sensitivity=${sens} (threshold=${threshold.toFixed(2)}) — hits in 0.8–1.3s ===`);
  if (near.length === 0) { console.log("  (none)"); continue; }
  console.log("timeS\tbeat\tdecayMs\tsampleIdx");
  for (const t of near) {
    const beat = (t.timeSeconds / 60) * BPM;
    const dm   = measureDecayMs(t.sampleIndex);
    console.log(`${t.timeSeconds.toFixed(4)}\t${beat.toFixed(3)}\t${dm.toFixed(0)}\t${t.sampleIndex}`);
  }
}

// Also raw HF envelope in the region 0.9-1.2s to see what's there
console.log(`\n=== Raw HF-band RMS every 10ms from 0.9 s to 1.2 s ===`);
console.log("timeS\thfRms");
for (let ms = 900; ms <= 1200; ms += 10) {
  const si = Math.round(ms / 1000 * wav.sampleRate);
  const r  = frameRms(si);
  console.log(`${(ms/1000).toFixed(3)}\t${r.toFixed(6)}`);
}
