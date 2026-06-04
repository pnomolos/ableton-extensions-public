/**
 * Diagnostic: run drum detector on Awestruck 95 BPM.wav and dump
 * feature values for every hit classified as "snare", to identify
 * false positives that are actually hi-hats.
 *
 * Usage: npx tsx src/__tests__/diag-awestruck.ts
 */

import { tmpdir } from "os";
import { join } from "path";
import {
  detectDrumVoices,
  computeDrumFeatures,
  classifyDrumVoiceEx,
} from "../drum-detector.js";
import { parseAudio } from "../transient-detector.js";
import { detectTransientsSuperFlux } from "../transient-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Awestruck 95 BPM.wav";
const BPM  = 95;
const SENSITIVITY = 0.5;

const ONSET_DETECTOR_HALF_WINDOW = 512;

const wav = parseAudio(FILE);
const transients = detectTransientsSuperFlux(wav, { bpm: BPM, threshold: 1 - SENSITIVITY, windowSize: 512, hopSize: 256 });

console.log(`Total onsets detected: ${transients.length}\n`);
console.log("=== Hits classified as SNARE ===");
console.log(
  ["time(s)", "beat", "centroid", "sb0", "sb1", "sb2", "sb3", "sb4", "zcr", "flatness", "hfDecay", "strength", "→voice"]
    .join("\t")
);

for (const t of transients) {
  const featureIdx = Math.max(0, t.sampleIndex - ONSET_DETECTOR_HALF_WINDOW);
  const f = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
  if (!f) continue;

  const result = classifyDrumVoiceEx(f);
  if (!result) continue;

  if (result.voice === "snare") {
    const timeSec = t.sampleIndex / wav.sampleRate;
    const beat    = (timeSec / 60) * BPM;
    console.log([
      timeSec.toFixed(3),
      beat.toFixed(3),
      Math.round(f.centroidHz),
      f.subBandRatio[0].toFixed(3),
      f.subBandRatio[1].toFixed(3),
      f.subBandRatio[2].toFixed(3),
      f.subBandRatio[3].toFixed(3),
      f.subBandRatio[4].toFixed(3),
      f.zcr.toFixed(3),
      f.flatness.toFixed(3),
      isNaN(f.hfDecayRatio) ? "NaN" : f.hfDecayRatio.toFixed(3),
      t.strength.toFixed(3),
      result.voice,
    ].join("\t"));
  }
}

console.log("\n=== All snare hits in full analysis (with features) ===");
const outDir = join(tmpdir(), "awestruck-diag");
const analysis = detectDrumVoices(FILE, BPM, SENSITIVITY, outDir, ["kick", "snare", "hihat", "openhat"]);
for (const v of analysis.voices) {
  console.log(`\n${v.voice}: ${v.hits.length} hits, ${v.tiers.length} tier(s)`);
  if (v.voice !== "snare") {
    for (const h of v.hits) {
      const beat = (h.timeSeconds / 60) * BPM;
      console.log(`  beat=${beat.toFixed(3)}  vel=${h.velocity}`);
    }
    continue;
  }
  // For snare hits, compute features so we can see what the later passes added
  console.log(
    ["beat", "vel", "centroid", "sb0", "sb1", "sb2", "sb3", "sb4", "zcr", "hfDecay", "rawVoice"]
      .join("\t")
  );
  for (const h of v.hits) {
    const beat = (h.timeSeconds / 60) * BPM;
    const sampleIdx = Math.round(h.timeSeconds * wav.sampleRate);
    const featureIdx = Math.max(0, sampleIdx - ONSET_DETECTOR_HALF_WINDOW);
    const f = computeDrumFeatures(wav.samples, wav.sampleRate, featureIdx);
    const rawVoice = f ? (classifyDrumVoiceEx(f)?.voice ?? "null") : "no-features";
    console.log([
      beat.toFixed(3),
      h.velocity,
      f ? Math.round(f.centroidHz) : "?",
      f ? f.subBandRatio[0].toFixed(3) : "?",
      f ? f.subBandRatio[1].toFixed(3) : "?",
      f ? f.subBandRatio[2].toFixed(3) : "?",
      f ? f.subBandRatio[3].toFixed(3) : "?",
      f ? f.subBandRatio[4].toFixed(3) : "?",
      f ? f.zcr.toFixed(3) : "?",
      f ? (isNaN(f.hfDecayRatio) ? "NaN" : f.hfDecayRatio.toFixed(3)) : "?",
      rawVoice,
    ].join("\t"));
  }
}
