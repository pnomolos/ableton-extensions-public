import { parseAudio, detectTransientsSuperFlux } from "../../transient-detector.js";
import { computeDrumFeatures, classifyDrumVoice } from "../../drum-detector.js";

const file = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const bpm = 98;

const wav = parseAudio(file);
console.log(`Loaded: ${wav.numSamples} samples @ ${wav.sampleRate}Hz (${(wav.numSamples/wav.sampleRate).toFixed(2)}s)`);

const transients = detectTransientsSuperFlux(wav, { bpm, threshold: 0.16, windowSize: 512, hopSize: 256 });
console.log(`Detected ${transients.length} transients\n`);

for (const t of transients.slice(0, 20)) {
  const feat = computeDrumFeatures(wav.samples, wav.sampleRate, t.sampleIndex);
  if (!feat) continue;
  const cls = classifyDrumVoice(feat);
  console.log(
    `t=${t.timeSeconds.toFixed(3)}s beat=${t.timeBeat.toFixed(2)} str=${t.strength.toFixed(3)}` +
    ` centroid=${feat.centroidHz.toFixed(0)}Hz rolloff=${feat.rolloff85Hz.toFixed(0)}Hz` +
    ` flat=${feat.flatness.toFixed(3)} zcr=${feat.zcr.toFixed(3)}` +
    ` sb=[${feat.subBandRatio.map(r=>r.toFixed(2)).join(",")}]` +
    ` → ${cls ?? "null"}`
  );
}
