/**
 * Diagnostic: run drum detector on Aloe Vera 98 BPM.wav
 * Shows features for all snare-classified hits and all transients near open-hat territory.
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices, computeDrumFeatures, classifyDrumVoiceEx } from "../drum-detector.js";
import { parseAudio, detectTransientsSuperFlux } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const BPM  = 98;
const SENSITIVITY = 0.5;
const HALF = 512;

const wav = parseAudio(FILE);
const transients = detectTransientsSuperFlux(wav, { bpm: BPM, threshold: 1 - SENSITIVITY, windowSize: 512, hopSize: 256 });

console.log("=== All transients (raw classifier) ===");
console.log("time\tbeat\tcentroid\tsb2\tsb3\tsb4\tzcr\thfDecay\tvoice");
for (const t of transients) {
  const fi = Math.max(0, t.sampleIndex - HALF);
  const f = computeDrumFeatures(wav.samples, wav.sampleRate, fi);
  if (!f) continue;
  const r = classifyDrumVoiceEx(f);
  const beat = (t.sampleIndex / wav.sampleRate / 60) * BPM;
  console.log([
    (t.sampleIndex / wav.sampleRate).toFixed(3),
    beat.toFixed(3),
    Math.round(f.centroidHz),
    f.subBandRatio[2].toFixed(3),
    f.subBandRatio[3].toFixed(3),
    f.subBandRatio[4].toFixed(3),
    f.zcr.toFixed(3),
    isNaN(f.hfDecayRatio) ? "NaN" : f.hfDecayRatio.toFixed(3),
    r?.voice ?? "null",
  ].join("\t"));
}

console.log("\n=== Full detection summary ===");
const outDir = join(tmpdir(), "aloe-vera-diag");
const analysis = detectDrumVoices(FILE, BPM, SENSITIVITY, outDir, ["kick", "snare", "hihat", "openhat"]);
for (const v of analysis.voices) {
  console.log(`\n${v.voice}: ${v.hits.length} hits, ${v.tiers.length} tier(s)`);
  if (v.voice === "snare") {
    console.log("beat\tvel\tcentroid\tsb2\tsb3\tsb4\tzcr\thfDecay\trawVoice");
    for (const h of v.hits) {
      const beat = (h.timeSeconds / 60) * BPM;
      const si = Math.round(h.timeSeconds * wav.sampleRate);
      const fi = Math.max(0, si - HALF);
      const f = computeDrumFeatures(wav.samples, wav.sampleRate, fi);
      const rv = f ? (classifyDrumVoiceEx(f)?.voice ?? "null") : "?";
      console.log([
        beat.toFixed(3), h.velocity,
        f ? Math.round(f.centroidHz) : "?",
        f ? f.subBandRatio[2].toFixed(3) : "?",
        f ? f.subBandRatio[3].toFixed(3) : "?",
        f ? f.subBandRatio[4].toFixed(3) : "?",
        f ? f.zcr.toFixed(3) : "?",
        f ? (isNaN(f.hfDecayRatio) ? "NaN" : f.hfDecayRatio.toFixed(3)) : "?",
        rv,
      ].join("\t"));
    }
  } else {
    for (const h of v.hits) {
      console.log(`  beat=${((h.timeSeconds/60)*BPM).toFixed(3)}  vel=${h.velocity}`);
    }
  }
}

// Simulate the clean-hit filter for hihat
const allHits2 = analysis.voices.flatMap(v => v.hits);
const hihatHits2 = analysis.voices.find(v => v.voice === "hihat")?.hits ?? [];
const snareHits2 = analysis.voices.find(v => v.voice === "snare")?.hits ?? [];
const kickHits2  = analysis.voices.find(v => v.voice === "kick")?.hits ?? [];
const CLEAN_GAP = 0.1;
const CODET_WIN = 0.030;

console.log("\n=== Hihat clean/contaminated classification ===");
for (let i = 0; i < hihatHits2.length; i++) {
  const h = hihatHits2[i];
  const beat = (h.timeSeconds / 60) * BPM;
  let reason = "clean";
  if (i > 0 && h.timeSeconds - hihatHits2[i-1].timeSeconds < CLEAN_GAP) {
    reason = "dirty:same-voice-gap";
  } else {
    for (const cv of [...snareHits2, ...kickHits2]) {
      if (Math.abs(cv.timeSeconds - h.timeSeconds) < CODET_WIN) {
        reason = `dirty:codet-with-${cv.voice}@${((cv.timeSeconds/60)*BPM).toFixed(2)}`;
        break;
      }
    }
  }
  console.log(`  beat=${beat.toFixed(3)}  vel=${h.velocity}  ${reason}`);
}
