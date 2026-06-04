import { detectDrumVoices, computeDrumFeatures, classifyDrumVoice } from "../../drum-detector.js";
import { parseAudio } from "../../transient-detector.js";
import { tmpdir } from "os";
import { join } from "path";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Awestruck 95 BPM.wav";
const out = join(tmpdir(), "awestruck-check");
const a = detectDrumVoices(FILE, 95, 0.5, out, ["kick","snare","hihat","openhat"]);
const wav = parseAudio(FILE);
const HALF = 512;

const snare = a.voices.find(v => v.voice === "snare");
if (snare) {
  console.log(`\n=== SNARE tier 0 hits (vel 1-42) — feature re-check ===`);
  for (const h of snare.hits.filter(h => !h.synthetic && h.velocity <= 42)) {
    const featureIdx = Math.max(0, h.sampleIndex - HALF);
    const feat = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
    if (!feat) { console.log(`  beat=${h.timeBeat.toFixed(2)}: no features`); continue; }
    const verdict = classifyDrumVoice(feat);
    console.log(
      `  beat=${h.timeBeat.toFixed(2).padStart(6)} vel=${h.velocity}` +
      ` sampleIdx=${h.sampleIndex} featureIdx=${featureIdx}` +
      ` centroid=${Math.round(feat.centroidHz)}Hz` +
      ` hfDecay=${isNaN(feat.hfDecayRatio) ? "NaN" : feat.hfDecayRatio.toFixed(2)}` +
      ` sb2=${feat.subBandRatio[2].toFixed(3)}` +
      ` sb3=${feat.subBandRatio[3].toFixed(3)}` +
      ` sb4=${feat.subBandRatio[4].toFixed(3)}` +
      ` verdict=${verdict}`,
    );
  }
}
