/**
 * Show sampleIndex, timeSeconds, and HF decay for every hihat/openhat hit.
 * Compares decay measured from hit sampleIndex vs from (sampleIndex+512).
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices } from "../drum-detector.js";
import { parseAudio, applyBandpassFilter } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;

const wav    = parseAudio(FILE);
const hfBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);

const FRAME         = 256;
const PEAK_F        = Math.max(1, Math.floor(0.025 * wav.sampleRate / FRAME));
const MEAS_F        = Math.max(1, Math.floor(0.300 * wav.sampleRate / FRAME));
const DROP          = 0.15;
const SUSTAIN       = 2;
const THRESH_S      = 0.100;

const frameRms = (s: number): number => {
  let sum = 0;
  const end = Math.min(s + FRAME, hfBand.length);
  for (let i = s; i < end; i++) sum += hfBand[i] * hfBand[i];
  return Math.sqrt(sum / FRAME);
};

const measureDecayMs = (si: number): number => {
  let peak = 0;
  for (let f = 0; f < PEAK_F; f++) { const r = frameRms(si + f * FRAME); if (r > peak) peak = r; }
  if (peak < 1e-6) return 0;
  const thr = peak * DROP; let below = 0;
  for (let f = PEAK_F; f < MEAS_F; f++) {
    const r = frameRms(si + f * FRAME);
    if (r < thr) { below++; if (below >= SUSTAIN) return ((f - SUSTAIN + 1) * FRAME / wav.sampleRate * 1000); }
    else below = 0;
  }
  return (MEAS_F * FRAME / wav.sampleRate * 1000);
};

const analysis = detectDrumVoices(FILE, BPM, 0.5, join(tmpdir(), "aloe-hat-si"),
  ["kick", "snare", "hihat", "openhat"]);

const allHats = [
  ...(analysis.voices.find(v => v.voice === "hihat")?.hits ?? []),
  ...(analysis.voices.find(v => v.voice === "openhat")?.hits ?? []),
].sort((a, b) => a.sampleIndex - b.sampleIndex);

console.log("voice\tbeat\ttimeS\tsampleIdx\tdecay@si(ms)\tdecay@si+512(ms)\t>100ms?");
for (const h of allHats) {
  const beat   = (h.timeSeconds / 60) * BPM;
  const dm0    = measureDecayMs(h.sampleIndex);
  const dm512  = measureDecayMs(h.sampleIndex + 512);
  const isOpen = dm0 > THRESH_S * 1000 || dm512 > THRESH_S * 1000 ? "YES" : "no";
  console.log(`${h.voice}\t${beat.toFixed(3)}\t${h.timeSeconds.toFixed(4)}\t${h.sampleIndex}\t${dm0.toFixed(0)}\t${dm512.toFixed(0)}\t${isOpen}`);
}

// Show kick positions for reference
console.log("\nKick positions:");
for (const h of analysis.voices.find(v=>v.voice==="kick")?.hits??[]) {
  const beat = (h.timeSeconds/60)*BPM;
  console.log(`  kick beat=${beat.toFixed(3)} timeS=${h.timeSeconds.toFixed(4)} si=${h.sampleIndex}`);
}
