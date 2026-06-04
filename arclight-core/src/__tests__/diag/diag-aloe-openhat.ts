/**
 * Diagnose open-hat detection on Aloe Vera — show HF decay time for every hihat hit.
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices } from "../drum-detector.js";
import { parseAudio, applyBandpassFilter } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;

const wav = parseAudio(FILE);
// Run detection with just hihat (no openhat) to get the raw hat hits before reclassification
const outDir = join(tmpdir(), "aloe-openhat-diag");
const analysis = detectDrumVoices(FILE, BPM, 0.5, outDir, ["kick", "snare", "hihat", "openhat"]);

const allHihat = [
  ...(analysis.voices.find(v => v.voice === "hihat")?.hits ?? []),
  ...(analysis.voices.find(v => v.voice === "openhat")?.hits ?? []),
].sort((a, b) => a.sampleIndex - b.sampleIndex);

const hatBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);
const FRAME = 256;
const PEAK_FRAMES    = Math.floor(0.025 * wav.sampleRate / FRAME);
const MEASURE_FRAMES = Math.floor(0.300 * wav.sampleRate / FRAME);
const DROP = 0.15;
const SUSTAIN = 2;

const frameRms = (start: number): number => {
  let s = 0;
  const end = Math.min(start + FRAME, hatBand.length);
  for (let i = start; i < end; i++) s += hatBand[i] * hatBand[i];
  return Math.sqrt(s / FRAME);
};

console.log("beat\tvel\tdecayMs\t>100ms?\tvoice");
for (const h of allHihat) {
  let peakRms = 0;
  for (let f = 0; f < PEAK_FRAMES; f++) {
    const start = h.sampleIndex + f * FRAME;
    if (start + FRAME > hatBand.length) break;
    const r = frameRms(start);
    if (r > peakRms) peakRms = r;
  }

  let decayFrame = MEASURE_FRAMES;
  let below = 0;
  const threshold = peakRms * DROP;
  for (let f = PEAK_FRAMES; f < MEASURE_FRAMES; f++) {
    const start = h.sampleIndex + f * FRAME;
    if (start + FRAME > hatBand.length) break;
    const r = frameRms(start);
    if (r < threshold) {
      below++;
      if (below >= SUSTAIN) { decayFrame = f - SUSTAIN + 1; break; }
    } else {
      below = 0;
    }
  }

  const decayMs = (decayFrame * FRAME / wav.sampleRate * 1000).toFixed(1);
  const beat = ((h.timeSeconds / 60) * BPM).toFixed(3);
  const over = parseFloat(decayMs) > 100 ? "YES" : "no";
  console.log(`${beat}\t${h.velocity}\t${decayMs}\t${over}\t${h.voice}`);
}
