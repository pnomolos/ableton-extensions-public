/**
 * Diagnose Awestruck using the SAME feature window as the actual detector
 * (featureIdx = transientIdx - ONSET_DETECTOR_HALF_WINDOW) so we see
 * exactly what isBrightDecayHat sees during classification.
 *
 * Usage: cd arclight-core && npx tsx src/__tests__/corpus/diagnose-awestruck-v2.ts
 */

import { tmpdir } from "os";
import { join } from "path";
import { parseAudio } from "../../transient-detector.js";
import {
  detectDrumVoices,
  computeDrumFeatures,
  classifyDrumVoice,
} from "../../drum-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Awestruck 95 BPM.wav";
const BPM  = 95;
const OUT  = join(tmpdir(), "diagnose-awestruck-v2");

const ONSET_HALF_WINDOW = 512;  // same as detector

const analysis = detectDrumVoices(FILE, BPM, 0.5, OUT, ["kick", "snare", "hihat", "openhat"]);
const wav = parseAudio(FILE);

console.log(`\nVoice counts: ${analysis.voices.map(v => `${v.voice}(${v.hits.length})`).join(", ")}\n`);
console.log("── Snare hits with detection-time features ──\n");

const snareVoice = analysis.voices.find(v => v.voice === "snare");
if (!snareVoice) { console.log("no snare voice"); process.exit(0); }

for (const h of snareVoice.hits) {
  if (h.synthetic) continue;
  // Use detection-time window (shifted back by ONSET_DETECTOR_HALF_WINDOW)
  const featureIdx = Math.max(0, h.sampleIndex - ONSET_HALF_WINDOW);
  const feat = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
  if (!feat) continue;

  const verdict = classifyDrumVoice(feat);
  const bdh = !isNaN(feat.hfDecayRatio) &&
              feat.centroidHz > 4700 &&
              feat.hfDecayRatio > 3.0 &&
              feat.subBandRatio[2] < 0.20;
  const isVFP = feat.centroidHz >= 4800 &&
                feat.subBandRatio[2] < 0.18 &&
                feat.subBandRatio[3] > feat.subBandRatio[4];

  console.log(
    `beat=${h.timeBeat.toFixed(2).padStart(6)}` +
    ` vel=${String(h.velocity).padStart(3)}` +
    ` centroid=${String(Math.round(feat.centroidHz)).padStart(5)}Hz` +
    ` hfDecay=${isNaN(feat.hfDecayRatio) ? "  NaN" : feat.hfDecayRatio.toFixed(2).padStart(5)}` +
    ` sb2=${feat.subBandRatio[2].toFixed(2)}` +
    ` sb3=${feat.subBandRatio[3].toFixed(2)}` +
    ` sb4=${feat.subBandRatio[4].toFixed(2)}` +
    ` verdict=${(verdict ?? "null").padEnd(6)}` +
    (bdh ? " [BDH!]" : "") +
    (isVFP ? " [VFP!]" : ""),
  );
}
