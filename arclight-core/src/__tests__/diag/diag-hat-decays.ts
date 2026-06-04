import { detectDrumVoices } from "../drum-detector.js";
import { parseAudio, applyBandpassFilter } from "../transient-detector.js";
import { tmpdir } from "os";
import { join } from "path";

function measure(file: string, bpm: number, label: string) {
  const wav = parseAudio(file);
  const hatBand = applyBandpassFilter(wav.samples, wav.sampleRate, 4000, 16000);
  const FRAME = 256;
  const PEAK_F = Math.floor(0.025 * wav.sampleRate / FRAME);
  const MEAS_F = Math.floor(0.500 * wav.sampleRate / FRAME); // extend to 500ms
  const frameRms = (s: number) => {
    let sum = 0; const e = Math.min(s + FRAME, hatBand.length);
    for (let i = s; i < e; i++) sum += hatBand[i] * hatBand[i];
    return Math.sqrt(sum / FRAME);
  };
  const analysis = detectDrumVoices(file, bpm, 0.5, join(tmpdir(), label), ["kick","snare","hihat","openhat"]);
  const hits = [
    ...(analysis.voices.find(v => v.voice === "hihat")?.hits ?? []),
    ...(analysis.voices.find(v => v.voice === "openhat")?.hits ?? []),
  ].sort((a, b) => a.sampleIndex - b.sampleIndex);
  console.log(`\n=== ${label} ===`);
  console.log("beat\tvel\tdecay(ms)\tvoice");
  for (const h of hits) {
    let peak = 0;
    for (let f = 0; f < PEAK_F; f++) {
      const r = frameRms(h.sampleIndex + f * FRAME);
      if (r > peak) peak = r;
    }
    let decayF = MEAS_F, below = 0;
    const thr = peak * 0.15;
    for (let f = PEAK_F; f < MEAS_F; f++) {
      const r = frameRms(h.sampleIndex + f * FRAME);
      if (r < thr) { below++; if (below >= 2) { decayF = f - 1; break; } } else below = 0;
    }
    const ms = (decayF * FRAME / wav.sampleRate * 1000).toFixed(0);
    const beat = ((h.timeSeconds / 60) * bpm).toFixed(2);
    console.log(`${beat}\t${h.velocity}\t${ms}\t${h.voice}`);
  }
}

measure(
  "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Awestruck 95 BPM.wav",
  95, "Awestruck"
);
measure(
  "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav",
  98, "Aloe Vera"
);

// Try lower sensitivity on Aloe Vera
measure(
  "/Volumes/Samples/Sample Packs/Cosmic Soul/Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]/Drum Breaks/Aloe Vera 98 BPM.wav",
  98, "Aloe Vera (sens=0.8)"
);
