/**
 * Debug Pass 2.9: check what openhat hits detectDrumVoices actually emits.
 */
import { tmpdir } from "os";
import { join } from "path";
import { detectDrumVoices } from "../drum-detector.js";

const FILE = "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav";
const analysis = detectDrumVoices(FILE, 98, 0.5, join(tmpdir(), "pass29-debug"),
  ["kick", "snare", "hihat", "openhat"]);

for (const v of analysis.voices) {
  console.log(`\n${v.voice}: ${v.hits.length} hits`);
  for (const h of v.hits) {
    const beat = (h.timeSeconds / 60) * 98;
    console.log(`  beat=${beat.toFixed(3)}  timeS=${h.timeSeconds.toFixed(4)}  si=${h.sampleIndex}  vel=${h.velocity}  synth=${h.synthetic ?? false}`);
  }
}
