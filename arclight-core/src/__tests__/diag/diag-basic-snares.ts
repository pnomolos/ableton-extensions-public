import { join } from "path";
import { computeDrumFeatures, classifyDrumVoiceEx } from "../drum-detector.js";
import { parseAudio, detectTransientsSuperFlux } from "../transient-detector.js";

const FILE = join(__dirname, "corpus/loops/basic-groove.wav");
const BPM = 100;
const HALF = 512;

const wav = parseAudio(FILE);
const transients = detectTransientsSuperFlux(wav, { bpm: BPM, threshold: 0.5, windowSize: 512, hopSize: 256 });

console.log("All transients with features:");
console.log("time\tbeat\tcentroid\tsb2\tsb3\tsb4\tzcr\thfDecay\tisSnapHeavy\tvoice");
for (const t of transients) {
  const fi = Math.max(0, t.sampleIndex - HALF);
  const f = computeDrumFeatures(wav.samples, wav.sampleRate, fi);
  if (!f) continue;
  const r = classifyDrumVoiceEx(f);
  const beat = (t.sampleIndex / wav.sampleRate / 60) * BPM;
  const isSnap = f.subBandRatio[3] > 0.36 && f.subBandRatio[2] < 0.17 && f.zcr > 0.10;
  console.log([
    (t.sampleIndex / wav.sampleRate).toFixed(3),
    beat.toFixed(2),
    Math.round(f.centroidHz),
    f.subBandRatio[2].toFixed(3),
    f.subBandRatio[3].toFixed(3),
    f.subBandRatio[4].toFixed(3),
    f.zcr.toFixed(3),
    isNaN(f.hfDecayRatio) ? "NaN" : f.hfDecayRatio.toFixed(3),
    isSnap ? "YES" : "no",
    r?.voice ?? "null",
  ].join("\t"));
}
