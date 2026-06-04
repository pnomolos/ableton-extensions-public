/**
 * Check HF energy at various post-onset delays for the kick+openhat position
 * vs the clean-kick baseline. Used to determine optimal rescue offset.
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices } from "../drum-detector.js";
import { parseAudio, applyBandpassFilter } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;

const wav = parseAudio(FILE);
const hfBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);

const windowRms = (centerIdx: number, windowSize: number): number => {
  const half  = windowSize >> 1;
  const start = Math.max(0, centerIdx - half);
  const end   = Math.min(hfBand.length, centerIdx + half);
  let s = 0;
  for (let i = start; i < end; i++) s += hfBand[i] * hfBand[i];
  return end > start ? Math.sqrt(s / (end - start)) : 0;
};

const med = (arr: number[]): number => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const analysis = detectDrumVoices(FILE, BPM, 0.5, join(tmpdir(), "post-onset-diag"),
  ["kick", "snare", "hihat", "openhat"]);

const kickHits  = analysis.voices.find(v => v.voice === "kick")?.hits    ?? [];
const snareHits = analysis.voices.find(v => v.voice === "snare")?.hits   ?? [];
const hatHits   = analysis.voices.find(v => v.voice === "hihat")?.hits   ?? [];
const existingHats = hatHits.sort((a, b) => a.sampleIndex - b.sampleIndex);

const coincSamples = Math.round(0.025 * wav.sampleRate);
const hasHat = (si: number): boolean =>
  existingHats.some(h => Math.abs(h.sampleIndex - si) <= coincSamples);

const kickSnare = [...kickHits, ...snareHits].sort((a, b) => a.sampleIndex - b.sampleIndex);
const cleanRefs = kickSnare.filter(h => !hasHat(h.sampleIndex));

// The known kick+openhat position (0.9346s = beat 7/16 from kick downbeat)
const OPENHAT_S  = 0.9346;
const openHatSi  = Math.round(OPENHAT_S * wav.sampleRate);

const DELAYS_MS  = [0, 25, 50, 75, 100, 125, 150, 175, 200];
const RMS_WIN    = 512;

console.log("=== HF at various delays: clean-kick baseline vs kick+openhat ===");
console.log("delayMs\tbaseline\tcand_hf\tratio");
for (const delayMs of DELAYS_MS) {
  const delaySamples = Math.round(delayMs / 1000 * wav.sampleRate);
  const bSamples     = cleanRefs.map(h => windowRms(h.sampleIndex + delaySamples, RMS_WIN));
  const bl           = med(bSamples);
  const cand         = windowRms(openHatSi + delaySamples, RMS_WIN);
  const ratio        = bl > 0 ? cand / bl : Infinity;
  const flag         = ratio > 2.5 ? "*** RESCUE" : ratio > 1.5 ? " maybe" : "";
  console.log(`${delayMs}\t${bl.toFixed(6)}\t${cand.toFixed(6)}\t${ratio.toFixed(2)}x${flag}`);
}

console.log(`\nClean ref count: ${cleanRefs.length}`);
console.log(`Existing hats: ${existingHats.length}`);
console.log(`kick+hat at sampleIndex: ${openHatSi} (${OPENHAT_S.toFixed(4)} s)`);
