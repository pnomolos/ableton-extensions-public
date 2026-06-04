/**
 * Diagnostic: empirically measure spectral features of real BWB drum samples
 * and report the classifier's verdict per file.
 *
 * Usage:
 *   cd arclight-core && npx tsx src/__tests__/corpus/diagnose-features.ts
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { parseAudio } from "../../transient-detector.js";
import {
  computeDrumFeatures,
  classifyDrumVoice,
  type DrumFeatures,
  type DrumVoiceType,
} from "../../drum-detector.js";

interface SampleClass {
  label: string;                       // "kick" | "snare" | "hihat"
  dir:   string;
  baseName: (n: number) => string;
}

const HOME = homedir();

const CLASSES: SampleClass[] = [
  {
    label: "kick",
    dir:   join(HOME, "Music/Local Samples/BWB SZN 26/BWB SZN 26 KICKS"),
    baseName: (n) => `BWB SZN 26 KICK (${n}).wav`,
  },
  {
    label: "snare",
    dir:   join(HOME, "Music/Local Samples/BWB SZN 26/BWB SZN 26 SNARES"),
    baseName: (n) => `BWB SZN 26 SNARE (${n}).wav`,
  },
  {
    label: "hihat",
    dir:   join(HOME, "Music/Local Samples/BWB SZN 26/BWB SZN 26 HATS/BWB SZN 26 HI HAT"),
    baseName: (n) => `BWB SZN 26 HI HAT (${n}).wav`,
  },
];

const N_SAMPLES = 8;

function fmtNum(x: number, d = 2): string {
  return x.toFixed(d);
}

function summarizeStats(values: number[]): { min: number; max: number; mean: number } {
  const min  = Math.min(...values);
  const max  = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, mean };
}

interface PerSample {
  label: string;
  index: number;
  features: DrumFeatures;
  classified: DrumVoiceType | null;
}

const allResults: PerSample[] = [];

for (const cls of CLASSES) {
  console.log(`\n=== ${cls.label.toUpperCase()} samples ===`);
  for (let n = 1; n <= N_SAMPLES; n++) {
    const path = join(cls.dir, cls.baseName(n));
    if (!existsSync(path)) {
      console.log(`  [${cls.label}] (${n}): MISSING ${path}`);
      continue;
    }
    let wav;
    try {
      wav = parseAudio(path);
    } catch (err) {
      console.log(`  [${cls.label}] (${n}): parse error: ${(err as Error).message}`);
      continue;
    }
    const features = computeDrumFeatures(wav.samples, wav.sampleRate, 0);
    if (!features) {
      console.log(`  [${cls.label}] (${n}): too short for analysis`);
      continue;
    }
    const verdict = classifyDrumVoice(features);
    const sb  = features.subBandRatio.map((r) => fmtNum(r)).join(", ");
    const lsb = features.lateSubBandRatio.map((r) => fmtNum(r)).join(", ");
    const psb = features.preSubBandRatio.map((r) => fmtNum(r)).join(", ");
    console.log(
      `[${cls.label}] ${cls.label.toUpperCase()}(${n}): ` +
        `centroid=${fmtNum(features.centroidHz, 0)}Hz ` +
        `rolloff85=${fmtNum(features.rolloff85Hz, 0)}Hz ` +
        `flatness=${fmtNum(features.flatness)} ` +
        `zcr=${fmtNum(features.zcr)} ` +
        `sb=[${sb}] ` +
        `preSb=[${psb}] ` +
        `lateSb=[${lsb}] ` +
        `→ classified as: ${verdict ?? "null"}`,
    );
    allResults.push({ label: cls.label, index: n, features, classified: verdict });
  }
}

// ── Summary stats per feature per class ──────────────────────────────────────
console.log(`\n=== SUMMARY STATS (min / mean / max per class) ===`);
const featureKeys: Array<keyof DrumFeatures> = [
  "centroidHz", "rolloff85Hz", "flatness", "zcr",
];
for (const cls of CLASSES) {
  const subset = allResults.filter((r) => r.label === cls.label);
  if (subset.length === 0) continue;
  console.log(`\n[${cls.label}] (n=${subset.length})`);
  for (const k of featureKeys) {
    const vals = subset.map((r) => r.features[k] as number);
    const s = summarizeStats(vals);
    const decimals = (k === "centroidHz" || k === "rolloff85Hz") ? 0 : 3;
    console.log(
      `  ${k.padEnd(14)} min=${fmtNum(s.min, decimals).padStart(8)} ` +
        `mean=${fmtNum(s.mean, decimals).padStart(8)} ` +
        `max=${fmtNum(s.max, decimals).padStart(8)}`,
    );
  }
  for (let band = 0; band < 5; band++) {
    const vals = subset.map((r) => r.features.subBandRatio[band]);
    const s = summarizeStats(vals);
    console.log(
      `  subBand[${band}]    min=${fmtNum(s.min).padStart(8)} ` +
        `mean=${fmtNum(s.mean).padStart(8)} ` +
        `max=${fmtNum(s.max).padStart(8)}`,
    );
  }
  // Classification breakdown
  const counts = subset.reduce<Record<string, number>>((acc, r) => {
    const k = r.classified ?? "null";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  classified:  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`,
  );
}
