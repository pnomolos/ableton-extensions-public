import { join } from "path";
import { computeDrumFeatures, classifyDrumVoiceEx } from "../drum-detector.js";
import { parseAudio, detectTransientsSuperFlux } from "../transient-detector.js";

const CORPUS = join(__dirname, "corpus/loops");
const HALF = 512;

for (const [name, bpm] of [
  ["basic-groove", 120],
  ["cymatics-fast-hihats", 120],
  ["cymatics-velocity-dynamic", 120],
  ["mixed-samples", 120],
] as [string, number][]) {
  const file = join(CORPUS, `${name}.wav`);
  const wav = parseAudio(file);
  const transients = detectTransientsSuperFlux(wav, { bpm, threshold: 0.5, windowSize: 512, hopSize: 256 });
  console.log(`\n=== ${name} — hits blocked by isSnapHeavyHat ===`);
  console.log("time\tcentroid\tsb2\tsb3\tzcr\tcurrentVoice");
  for (const t of transients) {
    const fi = Math.max(0, t.sampleIndex - HALF);
    const f = computeDrumFeatures(wav.samples, wav.sampleRate, fi);
    if (!f) continue;
    const isBlocked = f.subBandRatio[3] > 0.36 && f.subBandRatio[2] < 0.17 && f.zcr > 0.10;
    if (isBlocked) {
      const r = classifyDrumVoiceEx(f);
      console.log([
        (t.sampleIndex / wav.sampleRate).toFixed(3),
        Math.round(f.centroidHz),
        f.subBandRatio[2].toFixed(3),
        f.subBandRatio[3].toFixed(3),
        f.zcr.toFixed(3),
        r?.voice ?? "null",
      ].join("\t"));
    }
  }
}
