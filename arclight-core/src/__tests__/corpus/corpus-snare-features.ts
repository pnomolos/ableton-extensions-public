/**
 * Check centroid + hfDecayRatio of corpus snare hits using the DETECTION-TIME
 * feature window (featureIdx = sampleIndex - ONSET_HALF_WINDOW, same as the
 * actual classifier). Run: cd arclight-core && npx tsx src/__tests__/corpus/corpus-snare-features.ts
 */
import { join } from "path";
import { readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { parseAudio } from "../../transient-detector.js";
import { computeDrumFeatures, detectDrumVoices } from "../../drum-detector.js";

const CORPUS = join(__dirname, "loops");
const ONSET_HALF_WINDOW = 512;  // same as ONSET_DETECTOR_HALF_WINDOW in detector
const files  = readdirSync(CORPUS).filter(f => f.endsWith(".wav"));

for (const wavFile of files) {
  const loopName = wavFile.replace(/\.wav$/, "");
  const wavPath  = join(CORPUS, wavFile);
  const meta     = JSON.parse(readFileSync(join(CORPUS, `${loopName}.json`), "utf8"));
  const out      = join(tmpdir(), `cf-${loopName}`);

  const analysis = detectDrumVoices(wavPath, meta.bpm, 0.5, out, ["kick","snare","hihat","openhat"]);
  const wav      = parseAudio(wavPath);

  for (const voice of analysis.voices) {
    if (voice.voice !== "snare") continue;
    for (const h of voice.hits) {
      if (h.synthetic || h.sampleIndex === 0) continue;
      const featureIdx = Math.max(0, h.sampleIndex - ONSET_HALF_WINDOW);
      const feat  = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
      if (!feat) continue;
      const hfd = isNaN(feat.hfDecayRatio) ? "  NaN" : feat.hfDecayRatio.toFixed(2);
      console.log(
        `[${loopName}/snare]` +
        ` beat=${h.timeBeat.toFixed(2).padStart(6)}` +
        ` vel=${String(h.velocity).padStart(3)}` +
        ` centroid=${String(Math.round(feat.centroidHz)).padStart(5)}Hz` +
        ` hfDecay=${hfd}` +
        ` sb2=${feat.subBandRatio[2].toFixed(2)}` +
        ` sb3=${feat.subBandRatio[3].toFixed(2)}` +
        ` sb4=${feat.subBandRatio[4].toFixed(2)}`
      );
    }
  }
}
