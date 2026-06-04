/**
 * Check if the flam detection guard is removing real snares in corpus loops.
 */
import { join } from "path";
import { computeDrumFeatures, classifyDrumVoiceEx, detectDrumVoices } from "../drum-detector.js";
import { tmpdir } from "os";

const CORPUS = join(__dirname, "corpus/loops");

for (const [name, bpm] of [
  ["basic-groove", 120],
  ["cymatics-fast-hihats", 120],
  ["cymatics-velocity-dynamic", 120],
] as [string, number][]) {
  const outDir = join(tmpdir(), `diag-${name}`);
  const analysis = detectDrumVoices(
    join(CORPUS, `${name}.wav`),
    bpm, 0.5, outDir,
    ["kick", "snare", "hihat", "openhat"]
  );
  const snare = analysis.voices.find(v => v.voice === "snare");
  console.log(`${name}: ${snare?.hits.length ?? 0} snare hits`);
  for (const h of snare?.hits ?? []) {
    const beat = (h.timeSeconds / 60) * bpm;
    console.log(`  beat=${beat.toFixed(3)} vel=${h.velocity}`);
  }
}
