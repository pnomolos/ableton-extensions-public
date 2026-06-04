/**
 * Diagnostic: run detectDrumVoices on Awestruck 95 BPM.wav and dump
 * per-hit feature values so we can understand misclassifications.
 *
 * Usage:
 *   cd arclight-core && npx tsx src/__tests__/corpus/diagnose-awestruck.ts
 */

import { tmpdir } from "os";
import { join } from "path";
import { parseAudio } from "../../transient-detector.js";
import {
  detectDrumVoices,
  computeDrumFeatures,
  classifyDrumVoice,
} from "../../drum-detector.js";
import type { DrumVoiceType } from "../../drum-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Awestruck 95 BPM.wav";
const BPM  = 95;
const OUT  = join(tmpdir(), "diagnose-awestruck");

console.log(`\nAnalysing: ${FILE}\n`);

// ── Run full detection ───────────────────────────────────────────────────────

const analysis = detectDrumVoices(FILE, BPM, 0.5, OUT, ["kick", "snare", "hihat", "openhat"]);

console.log(`Detected voices: ${analysis.voices.map(v => `${v.voice}(${v.hits.length})`).join(", ")}`);
console.log(`Total beats: ${analysis.totalBeats}, BPM: ${analysis.bpm}\n`);

for (const voice of analysis.voices) {
  console.log(`\n── ${voice.voice.toUpperCase()} (${voice.hits.length} hits, ${voice.tiers.length} tiers) ──`);
  for (const h of voice.hits) {
    const tag = h.synthetic ? "[synth]" : "";
    console.log(`  beat=${h.timeBeat.toFixed(3).padStart(7)}  vel=${String(h.velocity).padStart(3)}  str=${h.strength.toFixed(3)}${tag}`);
  }
}

// ── Per-hit feature dump on raw audio ───────────────────────────────────────
// Re-parse the audio to compute features for a sample of transients.

console.log("\n\n── PER-HIT FEATURE DUMP (snare & borderline hits) ──\n");

const wav = parseAudio(FILE);

// Gather all detected hits from all voices, sorted by sampleIndex
const allHits = analysis.voices
  .flatMap(v => v.hits.map(h => ({ ...h, detectedAs: v.voice })))
  .filter(h => !h.synthetic)
  .sort((a, b) => a.sampleIndex - b.sampleIndex);

const WINDOW = Math.round(0.1 * wav.sampleRate); // 100ms feature window

for (const hit of allHits) {
  if (hit.sampleIndex === 0) continue;
  const start = hit.sampleIndex;
  const end   = Math.min(start + WINDOW, wav.samples.length);
  const slice = wav.samples.slice(start, end);
  const feat  = computeDrumFeatures(slice, wav.sampleRate, 0);
  if (!feat) continue;

  const verdict = classifyDrumVoice(feat);
  const flag = verdict !== hit.detectedAs ? " ← MISMATCH" : "";

  const sb = feat.subBandRatio.map(r => r.toFixed(2)).join(", ");
  console.log(
    `[${hit.detectedAs.padEnd(7)}→${(verdict ?? "null").padEnd(7)}]` +
    ` beat=${hit.timeBeat.toFixed(2).padStart(6)}` +
    ` vel=${String(hit.velocity).padStart(3)}` +
    ` centroid=${String(Math.round(feat.centroidHz)).padStart(5)}Hz` +
    ` flatness=${feat.flatness.toFixed(3)}` +
    ` zcr=${feat.zcr.toFixed(3)}` +
    ` sb=[${sb}]` +
    ` hfDecay=${isNaN(feat.hfDecayRatio) ? "  NaN" : feat.hfDecayRatio.toFixed(2)}` +
    flag,
  );
}
