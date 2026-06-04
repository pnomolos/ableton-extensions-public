/**
 * Corpus generator — run once to build real-sample WAV+JSON pairs.
 * Usage: npx tsx src/__tests__/corpus/generate-corpus.ts
 *
 * Output goes to src/__tests__/corpus/loops/ (committed to git).
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildTestLoop } from "./build-loop.js";
import type { LoopEvent } from "./build-loop.js";

// Support both ESM (import.meta.url) and CJS (__dirname)
const _dir: string = typeof __dirname !== "undefined"
  ? __dirname
  // @ts-ignore — available in ESM context only
  : dirname(fileURLToPath(import.meta.url));

const LOOPS_DIR = join(_dir, "loops");
mkdirSync(LOOPS_DIR, { recursive: true });

// ── sample paths ──────────────────────────────────────────────────────────────

const COSMIC = (subfolder: string, name: string) =>
  join(
    "/Volumes/Samples/Sample Packs/Cosmic Soul",
    "Cosmic Vintage Drums, Vol. 1 [OPEN SOUL]",
    "One Shots",
    subfolder,
    name,
  );

const BWB = (folder: string, name: string) =>
  join(
    process.env.HOME ?? "/Users/you",
    "Music/Local Samples/BWB SZN 26",
    folder,
    name,
  );

const CYM_BASE = "/Volumes/Samples/Cymatics Sample Library/Cymatics - Immortal - Production Suite/Cymatics - IMMORTAL/Drums/Drum One Shots";
const CYM = (subfolder: string, name: string) => join(CYM_BASE, subfolder, name);

const RS = (folder: string, name: string) =>
  join(
    process.env.HOME ?? "/Users/you",
    "Music/Samples/Sample Lab/Raw Supply - Drum Pack/Drum One Shots",
    folder,
    name,
  );

const BWB_KICKS_DIR    = "BWB SZN 26 KICKS";
const BWB_SNARES_DIR   = "BWB SZN 26 SNARES";
const BWB_HATS_DIR     = "BWB SZN 26 HATS/BWB SZN 26 HI HAT";
const BWB_OPENHAT_DIR  = "BWB SZN 26 HATS/BWB SZN 26 OPEN HAT";

const SAMPLES = {
  // BWB kicks
  bwbKick1:  BWB(BWB_KICKS_DIR,  "BWB SZN 26 KICK (1).wav"),
  bwbKick3:  BWB(BWB_KICKS_DIR,  "BWB SZN 26 KICK (3).wav"),
  bwbKick5:  BWB(BWB_KICKS_DIR,  "BWB SZN 26 KICK (5).wav"),
  bwbKick10: BWB(BWB_KICKS_DIR,  "BWB SZN 26 KICK (10).wav"),
  // BWB snares
  bwbSnare1:  BWB(BWB_SNARES_DIR, "BWB SZN 26 SNARE (1).wav"),
  bwbSnare3:  BWB(BWB_SNARES_DIR, "BWB SZN 26 SNARE (3).wav"),
  bwbSnare5:  BWB(BWB_SNARES_DIR, "BWB SZN 26 SNARE (5).wav"),
  bwbSnare10: BWB(BWB_SNARES_DIR, "BWB SZN 26 SNARE (10).wav"),
  // BWB closed hihats
  bwbHat1:  BWB(BWB_HATS_DIR, "BWB SZN 26 HI HAT (1).wav"),
  bwbHat5:  BWB(BWB_HATS_DIR, "BWB SZN 26 HI HAT (5).wav"),
  bwbHat8:  BWB(BWB_HATS_DIR, "BWB SZN 26 HI HAT (8).wav"),
  // BWB open hihats (long decay, 150–400 ms — cleanly separated from closed)
  bwbOpenHat1: BWB(BWB_OPENHAT_DIR, "BWB SZN 26 OPEN HAT (1).wav"),
  bwbOpenHat5: BWB(BWB_OPENHAT_DIR, "BWB SZN 26 OPEN HAT (5).wav"),
  // Raw Supply
  rsKick:   RS("Kicks",   "Bounce Kick.wav"),
  rsSnare:  RS("Snares",  "Aquired Snare.wav"),
  rsHat:    RS("Hi Hat",  "Aura Hat.wav"),
};

// ── loop helper ───────────────────────────────────────────────────────────────

interface LoopSpec {
  name:        string;
  bpm:         number;
  durationBeats: number;
  description: string;
  events:      LoopEvent[];
}

function expandEvents(spec: LoopSpec): Array<{ voice: string; beat: number }> {
  return spec.events.map(e => ({ voice: e.voice, beat: e.beat }));
}

function sampleMap(spec: LoopSpec): Record<string, string> {
  // Build a map: voice → samplePath (last wins if multiple samples per voice)
  const map: Record<string, string> = {};
  for (const e of spec.events) {
    map[e.voice] = e.samplePath;
  }
  return map;
}

function generate(spec: LoopSpec): void {
  const wavPath  = join(LOOPS_DIR, `${spec.name}.wav`);
  const jsonPath = join(LOOPS_DIR, `${spec.name}.json`);

  console.log(`Generating ${spec.name}…`);
  buildTestLoop(spec.events, spec.bpm, spec.durationBeats, wavPath);

  const meta = {
    bpm:           spec.bpm,
    durationBeats: spec.durationBeats,
    description:   spec.description,
    events:        expandEvents(spec),
    samples:       sampleMap(spec),
  };
  writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`  → wrote ${wavPath}`);
  console.log(`  → wrote ${jsonPath}`);
}

// ── Loop 1: basic-groove ──────────────────────────────────────────────────────
// 4 bars, 100 BPM.  Kick on beat 1+3 of each bar, snare on 2+4, 8th-note hihats.
// 4/4 → beats 0–15 total (4 bars × 4 beats).
{
  const bpm = 100;
  const bars = 4;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 16

  const events: LoopEvent[] = [];

  // Kick: beat 0 and 2 of each bar = beats 0,2,4,6,8,10,12,14
  for (let bar = 0; bar < bars; bar++) {
    events.push({ voice: "kick",  beat: bar * beatsPerBar + 0, samplePath: SAMPLES.bwbKick1 });
    events.push({ voice: "kick",  beat: bar * beatsPerBar + 2, samplePath: SAMPLES.bwbKick1 });
  }
  // Snare: beat 1 and 3 of each bar = beats 1,3,5,7,9,11,13,15
  for (let bar = 0; bar < bars; bar++) {
    events.push({ voice: "snare", beat: bar * beatsPerBar + 1, samplePath: SAMPLES.bwbSnare1 });
    events.push({ voice: "snare", beat: bar * beatsPerBar + 3, samplePath: SAMPLES.bwbSnare1 });
  }
  // Hihat: every 0.5 beats (8th notes)
  for (let i = 0; i < total * 2; i++) {
    events.push({ voice: "hihat", beat: i * 0.5, samplePath: SAMPLES.bwbHat1, velocityScale: 0.7 });
  }

  generate({
    name: "basic-groove",
    bpm,
    durationBeats: total,
    description: "Standard 4/4 groove, kick on 1+3, snare on 2+4, 8th-note hihats (BWB samples)",
    events,
  });
}

// ── Loop 2: punchy-groove ─────────────────────────────────────────────────────
// 4 bars, 120 BPM. Kick with pickup 16ths on "and of 4", snare only on beat 2,
// sparse hihats (only first two 8th notes of each bar).
{
  const bpm = 120;
  const bars = 4;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 16

  const events: LoopEvent[] = [];

  // Kick: beats 0, 2, 3.5 per bar (2 = beat 3, 3.5 = pickup "and of 4")
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "kick", beat: base + 0,   samplePath: SAMPLES.bwbKick5 });
    events.push({ voice: "kick", beat: base + 2,   samplePath: SAMPLES.bwbKick5 });
    events.push({ voice: "kick", beat: base + 3.5, samplePath: SAMPLES.bwbKick5, velocityScale: 0.75 });
  }
  // Snare: only beat 2 of each bar (snare on 2 only, no snare on 4)
  for (let bar = 0; bar < bars; bar++) {
    events.push({ voice: "snare", beat: bar * beatsPerBar + 1, samplePath: SAMPLES.bwbSnare5 });
  }
  // Hihat: first two 8th notes of each bar (beats 0, 0.5 per bar)
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "hihat", beat: base + 0,   samplePath: SAMPLES.bwbHat5, velocityScale: 0.65 });
    events.push({ voice: "hihat", beat: base + 0.5, samplePath: SAMPLES.bwbHat5, velocityScale: 0.65 });
  }

  generate({
    name: "punchy-groove",
    bpm,
    durationBeats: total,
    description: "Punchy 120 BPM groove, kick with pickup 16ths, snare on 2 only, sparse hihats (BWB samples)",
    events,
  });
}

// ── Loop 3: sparse-groove ─────────────────────────────────────────────────────
// 2 bars, 90 BPM. No hihat. Kick on beat 1 only, snare on beat 3 only.
{
  const bpm = 90;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "kick",  beat: base + 0, samplePath: SAMPLES.bwbKick10 });
    events.push({ voice: "snare", beat: base + 2, samplePath: SAMPLES.bwbSnare10 });
  }

  generate({
    name: "sparse-groove",
    bpm,
    durationBeats: total,
    description: "Sparse 2-bar groove, 90 BPM, kick on 1 only, snare on 3 only, no hihat (BWB samples)",
    events,
  });
}

// ── Loop 4: hihat-heavy ───────────────────────────────────────────────────────
// 4 bars, 95 BPM. Standard kick+snare, 16th-note hihats.
{
  const bpm = 95;
  const bars = 4;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 16

  const events: LoopEvent[] = [];

  // Kick: beats 0 and 2 per bar
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "kick",  beat: base + 0, samplePath: SAMPLES.bwbKick3 });
    events.push({ voice: "kick",  beat: base + 2, samplePath: SAMPLES.bwbKick3 });
  }
  // Snare: beats 1 and 3 per bar
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "snare", beat: base + 1, samplePath: SAMPLES.bwbSnare3 });
    events.push({ voice: "snare", beat: base + 3, samplePath: SAMPLES.bwbSnare3 });
  }
  // Hihat: 16th notes = every 0.25 beats (64 total over 16 beats)
  for (let i = 0; i < total * 4; i++) {
    const vel = (i % 4 === 0) ? 0.85 : (i % 2 === 0) ? 0.6 : 0.4; // accent on beat, medium on 8th, soft on 16th
    events.push({ voice: "hihat", beat: i * 0.25, samplePath: SAMPLES.bwbHat8, velocityScale: vel });
  }

  generate({
    name: "hihat-heavy",
    bpm,
    durationBeats: total,
    description: "Hi-hat heavy 4-bar loop, 95 BPM, 16th-note hihats, standard kick+snare (BWB samples)",
    events,
  });
}

// ── Loop 5: mixed-samples ────────────────────────────────────────────────────
// 4 bars, 110 BPM. Raw Supply kick, BWB snare, BWB hihat.
// Kick: beats 0, 1.75, per bar (kick with 16th-note anticipation on beat 2),
//       plus standard beat 2 kick.
{
  const bpm = 110;
  const bars = 4;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 16

  const events: LoopEvent[] = [];

  // Kick: 0, 1.75 per bar (beat 1 and anticipated beat 2 — "and of 2" minus 16th)
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "kick", beat: base + 0,    samplePath: SAMPLES.rsKick });
    events.push({ voice: "kick", beat: base + 1.75, samplePath: SAMPLES.rsKick, velocityScale: 0.8 });
  }
  // Snare: beats 1 and 3 per bar (beats 2 and 4 of each bar)
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "snare", beat: base + 1, samplePath: SAMPLES.bwbSnare1 });
    events.push({ voice: "snare", beat: base + 3, samplePath: SAMPLES.bwbSnare1 });
  }
  // Hihat: 8th notes (every 0.5 beats)
  for (let i = 0; i < total * 2; i++) {
    events.push({ voice: "hihat", beat: i * 0.5, samplePath: SAMPLES.bwbHat1, velocityScale: 0.65 });
  }

  generate({
    name: "mixed-samples",
    bpm,
    durationBeats: total,
    description: "Mixed-pack groove, 110 BPM, Raw Supply kick, BWB snare+hihat, kick with 16th anticipation",
    events,
  });
}

// ── Loop 6: ghost-groove ─────────────────────────────────────────────────────
// 2 bars, 93 BPM. Ghost snares (velocityScale 0.25) between main hits.
// Kick on 0 and 2 per bar, main snare on 1 and 3 per bar, ghost snares on
// every half-beat not already occupied by a main hit, 16th-note hihats.
{
  const bpm = 93;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beat 0 and 2 of each bar
    events.push({ voice: "kick",  beat: base + 0, samplePath: COSMIC("Kicks", "Ample Kick.wav") });
    events.push({ voice: "kick",  beat: base + 2, samplePath: COSMIC("Kicks", "Ample Kick.wav") });
    // Main snare: beat 1 and 3 of each bar
    events.push({ voice: "snare", beat: base + 1, samplePath: COSMIC("Snares", "That Snare.wav") });
    events.push({ voice: "snare", beat: base + 3, samplePath: COSMIC("Snares", "That Snare.wav") });
    // Ghost snares: 8th-note positions not occupied by kick or main snare
    // (0.5, 1.5, 2.5, 3.5 per bar)
    events.push({ voice: "snare", beat: base + 0.5, samplePath: COSMIC("Snares", "That Snare.wav"), velocityScale: 0.25 });
    events.push({ voice: "snare", beat: base + 1.5, samplePath: COSMIC("Snares", "That Snare.wav"), velocityScale: 0.25 });
    events.push({ voice: "snare", beat: base + 2.5, samplePath: COSMIC("Snares", "That Snare.wav"), velocityScale: 0.25 });
    events.push({ voice: "snare", beat: base + 3.5, samplePath: COSMIC("Snares", "That Snare.wav"), velocityScale: 0.25 });
  }

  // Hihats: 16th notes (every 0.25 beats)
  for (let i = 0; i < total * 4; i++) {
    const vel = (i % 4 === 0) ? 0.8 : (i % 2 === 0) ? 0.55 : 0.4;
    events.push({ voice: "hihat", beat: i * 0.25, samplePath: COSMIC("Hats/Meinl Hats", "Meinl Bow Low.wav"), velocityScale: vel });
  }

  generate({
    name: "ghost-groove",
    bpm,
    durationBeats: total,
    description: "Ghost-note groove, 93 BPM, 2 bars. Main snares on 2+4, ghost snares (25% velocity) on 8th-note offbeats, 16th-note hihats (Cosmic Soul samples)",
    events,
  });
}

// ── Loop 7: triplet-groove ────────────────────────────────────────────────────
// 2 bars, 88 BPM. Triplet 8th-note hihats (3 per beat = 0.333 beat spacing).
{
  const bpm = 88;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beat 0 per bar
    events.push({ voice: "kick",  beat: base + 0, samplePath: COSMIC("Kicks", "Branch Kick.wav") });
    // Snare: beat 2 per bar
    events.push({ voice: "snare", beat: base + 2, samplePath: COSMIC("Snares", "Rich Snare.wav") });
  }

  // Hihats: triplet 8th notes = 3 per beat over 8 beats = 24 hits total
  // Beat positions: 0, 1/3, 2/3, 1, 4/3, 5/3, 2, ...
  const tripletHits = Array.from({ length: total * 3 }, (_, i) => i / 3);
  for (const beat of tripletHits) {
    events.push({ voice: "hihat", beat, samplePath: COSMIC("Hats/Meinl Hats", "Meinl Bow Mid.wav"), velocityScale: 0.6 });
  }

  generate({
    name: "triplet-groove",
    bpm,
    durationBeats: total,
    description: "Triplet-feel groove, 88 BPM, 2 bars. Triplet 8th-note hihats (3 per beat), kick on 1, snare on 3 (Cosmic Soul samples)",
    events,
  });
}

// ── Loop 8: flam-groove ───────────────────────────────────────────────────────
// 2 bars, 100 BPM. Flam snares (grace note 15ms before main hit).
// At 100 BPM: 1 beat = 600ms, 15ms ≈ 0.025 beats.
{
  const bpm = 100;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8
  const flamOffset = 0.025; // 15ms at 100 BPM in beats

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beats 0 and 2 per bar
    events.push({ voice: "kick", beat: base + 0, samplePath: COSMIC("Kicks", "Grilled Kick.wav") });
    events.push({ voice: "kick", beat: base + 2, samplePath: COSMIC("Kicks", "Grilled Kick.wav") });
    // Flam snare on beats 1 and 3 — grace note then main hit
    for (const snBeat of [1, 3]) {
      const main = base + snBeat;
      // Grace note (soft, just before main)
      events.push({ voice: "snare", beat: main - flamOffset, samplePath: COSMIC("Snares", "Crunch Snare.wav"), velocityScale: 0.4 });
      // Main hit (full velocity)
      events.push({ voice: "snare", beat: main, samplePath: COSMIC("Snares", "Crunch Snare.wav") });
    }
  }

  // Hihats: 8th notes (every 0.5 beats)
  for (let i = 0; i < total * 2; i++) {
    events.push({ voice: "hihat", beat: i * 0.5, samplePath: COSMIC("Hats/Meinl Hats", "Meinl Edge Mid.wav"), velocityScale: 0.7 });
  }

  generate({
    name: "flam-groove",
    bpm,
    durationBeats: total,
    description: "Flam-snare groove, 100 BPM, 2 bars. Flam snares on 2+4 (grace note 15ms before main), 8th-note hihats (Cosmic Soul samples)",
    events,
  });
}

// ── Loop 9: cymatics-trap-groove ─────────────────────────────────────────────
// 2 bars, 140 BPM. Sparse kick (beat 1 only), snare on beat 3, accented 16th hihats.
{
  const bpm = 140;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beat 0 only per bar (sparse trap kick)
    events.push({ voice: "kick",  beat: base + 0, samplePath: CYM("Kick", "Cymatics - Kick (Aurora).wav") });
    // Snare: beat 2 per bar (snare on 3 of each bar)
    events.push({ voice: "snare", beat: base + 2, samplePath: CYM("Snares", "Cymatics - Snare (Alpha).wav") });
  }

  // Hihat: 16th notes with velocity accents
  // 0.9 on beat (i%4===0), 0.5 on 8th offbeat (i%2===0, i%4!==0), 0.3 on 16th offbeats
  for (let i = 0; i < total * 4; i++) {
    const vel = (i % 4 === 0) ? 0.9 : (i % 2 === 0) ? 0.5 : 0.3;
    events.push({ voice: "hihat", beat: i * 0.25, samplePath: CYM("Hihats - Closed", "Cymatics - Hihat (Aerials).wav"), velocityScale: vel });
  }

  generate({
    name: "cymatics-trap-groove",
    bpm,
    durationBeats: total,
    description: "Trap groove, 140 BPM, 2 bars. Sparse kick, snare on 3, accented 16th hihats (Cymatics IMMORTAL)",
    events,
  });
}

// ── Loop 10: cymatics-hip-hop ─────────────────────────────────────────────────
// 4 bars, 90 BPM. Syncopated kick, snare on beat 3 only, no hihat.
{
  const bpm = 90;
  const bars = 4;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 16

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: bars 1+3 (bar%2===0): beats 0, 2.5; bars 2+4 (bar%2===1): beats 0, 1.5, 3
    if (bar % 2 === 0) {
      events.push({ voice: "kick", beat: base + 0,   samplePath: CYM("Kick", "Cymatics - Kick (BigBoi).wav") });
      events.push({ voice: "kick", beat: base + 2.5, samplePath: CYM("Kick", "Cymatics - Kick (BigBoi).wav"), velocityScale: 0.85 });
    } else {
      events.push({ voice: "kick", beat: base + 0,   samplePath: CYM("Kick", "Cymatics - Kick (BigBoi).wav") });
      events.push({ voice: "kick", beat: base + 1.5, samplePath: CYM("Kick", "Cymatics - Kick (BigBoi).wav"), velocityScale: 0.8 });
      events.push({ voice: "kick", beat: base + 3,   samplePath: CYM("Kick", "Cymatics - Kick (BigBoi).wav"), velocityScale: 0.9 });
    }
    // Snare: beat 2 per bar (snare on 3 only)
    events.push({ voice: "snare", beat: base + 2, samplePath: CYM("Snares", "Cymatics - Snare (Bully).wav") });
  }

  generate({
    name: "cymatics-hip-hop",
    bpm,
    durationBeats: total,
    description: "Hip-hop groove, 90 BPM, 4 bars. Syncopated kick pattern, snare on 3 only, no hihat (Cymatics IMMORTAL)",
    events,
  });
}

// ── Loop 11: cymatics-kick-hat-bleed ─────────────────────────────────────────
// 2 bars, 100 BPM. Hihat fires on same positions as kick — tests kick-under-hat classifier.
{
  const bpm = 100;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beats 0 and 2 per bar
    events.push({ voice: "kick",  beat: base + 0, samplePath: CYM("Kick", "Cymatics - Kick (Bombastic).wav") });
    events.push({ voice: "kick",  beat: base + 2, samplePath: CYM("Kick", "Cymatics - Kick (Bombastic).wav") });
    // Hihat: SAME positions as kick (0 and 2 per bar)
    events.push({ voice: "hihat", beat: base + 0, samplePath: CYM("Hihats - Closed", "Cymatics - Hihat (Champion).wav"), velocityScale: 0.7 });
    events.push({ voice: "hihat", beat: base + 2, samplePath: CYM("Hihats - Closed", "Cymatics - Hihat (Champion).wav"), velocityScale: 0.7 });
    // Snare: beats 1 and 3 per bar
    events.push({ voice: "snare", beat: base + 1, samplePath: CYM("Snares", "Cymatics - Snare (Chonk).wav") });
    events.push({ voice: "snare", beat: base + 3, samplePath: CYM("Snares", "Cymatics - Snare (Chonk).wav") });
  }

  generate({
    name: "cymatics-kick-hat-bleed",
    bpm,
    durationBeats: total,
    description: "Kick+hihat bleed test, 100 BPM, 2 bars. Hat fires on every kick downbeat — tests kick-under-hat classifier (Cymatics IMMORTAL)",
    events,
  });
}

// ── Loop 12: cymatics-velocity-dynamic ───────────────────────────────────────
// 2 bars, 100 BPM. Ghost kicks and ghost snares at low velocity, alternating hihat accents.
{
  const bpm = 100;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beat 0 at full velocity, beat 2 at 0.4 (ghost kick)
    events.push({ voice: "kick", beat: base + 0, samplePath: CYM("Kick", "Cymatics - Kick (Cedar).wav") });
    events.push({ voice: "kick", beat: base + 2, samplePath: CYM("Kick", "Cymatics - Kick (Cedar).wav"), velocityScale: 0.4 });
    // Snare: beat 1 at full velocity, beat 3 at 0.35 (ghost snare)
    events.push({ voice: "snare", beat: base + 1, samplePath: CYM("Snares", "Cymatics - Snare (Corruption).wav") });
    events.push({ voice: "snare", beat: base + 3, samplePath: CYM("Snares", "Cymatics - Snare (Corruption).wav"), velocityScale: 0.35 });
  }

  // Hihat: 8th notes, alternating 0.8 / 0.3 velocity (strong/weak)
  for (let i = 0; i < total * 2; i++) {
    const vel = (i % 2 === 0) ? 0.8 : 0.3;
    events.push({ voice: "hihat", beat: i * 0.5, samplePath: CYM("Hihats - Closed", "Cymatics - Hihat (Ash).wav"), velocityScale: vel });
  }

  generate({
    name: "cymatics-velocity-dynamic",
    bpm,
    durationBeats: total,
    description: "Velocity dynamics test, 100 BPM, 2 bars. Ghost kicks and ghost snares at 35–40% velocity, alternating hihat accents (Cymatics IMMORTAL)",
    events,
  });
}

// ── Loop 13: cymatics-fast-hihats ────────────────────────────────────────────
// 2 bars, 110 BPM. Standard kick+snare, dense 32nd-note hihats with velocity accents.
{
  const bpm = 110;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick: beats 0 and 2 per bar
    events.push({ voice: "kick",  beat: base + 0, samplePath: CYM("Kick", "Cymatics - Kick (Crushed).wav") });
    events.push({ voice: "kick",  beat: base + 2, samplePath: CYM("Kick", "Cymatics - Kick (Crushed).wav") });
    // Snare: beats 1 and 3 per bar
    events.push({ voice: "snare", beat: base + 1, samplePath: CYM("Snares", "Cymatics - Snare (Bricks).wav") });
    events.push({ voice: "snare", beat: base + 3, samplePath: CYM("Snares", "Cymatics - Snare (Bricks).wav") });
  }

  // Hihat: 32nd notes (0.125 beat spacing), pattern of 4 per 16th: strong, soft, medium, soft
  // i%4: 0=beat(0.8), 1=32nd offbeat(0.25), 2=16th(0.5), 3=32nd offbeat(0.25)
  for (let i = 0; i < total * 8; i++) {
    const mod = i % 4;
    const vel = (mod === 0) ? 0.8 : (mod === 2) ? 0.5 : 0.25;
    events.push({ voice: "hihat", beat: i * 0.125, samplePath: CYM("Hihats - Closed", "Cymatics - Hihat (Bamba).wav"), velocityScale: vel });
  }

  generate({
    name: "cymatics-fast-hihats",
    bpm,
    durationBeats: total,
    description: "Fast 32nd-note hihat groove, 110 BPM, 2 bars. Standard kick+snare, dense 32nd-note hihats with velocity accents (Cymatics IMMORTAL)",
    events,
  });
}

// ── Loop 14: openhat-groove ──────────────────────────────────────────────────
// 2 bars, 100 BPM. Classic rock/funk pattern: kick on 1, snare on 2+4, 8th-note
// closed hats with an open hat on beat 3 of each bar. Tests decay-based hat
// classification — closed hats on same pattern as opens, same onset spectral
// signature; only decay distinguishes them.
{
  const bpm = 100;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    // Kick on 1
    events.push({ voice: "kick",  beat: base + 0, samplePath: SAMPLES.bwbKick1 });
    // Snare on 2 and 4
    events.push({ voice: "snare", beat: base + 1, samplePath: SAMPLES.bwbSnare1 });
    events.push({ voice: "snare", beat: base + 3, samplePath: SAMPLES.bwbSnare1 });
  }

  // Closed hats on every 8th note EXCEPT beat 2 of each bar (where the open hat fires)
  // 8th-note grid: 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5 per bar
  // beat 2 = beat 2 in-bar index, so skip index 4 (beat 2) in each bar.
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    const positions = [0, 0.5, 1, 1.5, 2.5, 3, 3.5]; // skip 2 — that's open hat
    for (const p of positions) {
      events.push({ voice: "hihat", beat: base + p, samplePath: SAMPLES.bwbHat1, velocityScale: 0.65 });
    }
    // Open hat on beat 3 (mid-bar) per bar — classic rock/funk "splash" position
    events.push({ voice: "openhat", beat: base + 2, samplePath: SAMPLES.bwbOpenHat1, velocityScale: 0.8 });
  }

  generate({
    name: "openhat-groove",
    bpm,
    durationBeats: total,
    description: "Openhat rock/funk groove, 100 BPM, 2 bars. Kick on 1, snare 2+4, closed 8th hats with open hat on beat 3 (BWB samples)",
    events,
  });
}

// ── Loop 15: openhat-alternating ─────────────────────────────────────────────
// 2 bars, 120 BPM. Alternating closed/open hihats on every quarter note. Kick
// on 1 of each bar, snare on 3. This exercises the openhat decay classifier in
// a dense pattern where closed and open hats sit right next to each other.
{
  const bpm = 120;
  const bars = 2;
  const beatsPerBar = 4;
  const total = bars * beatsPerBar; // 8

  const events: LoopEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const base = bar * beatsPerBar;
    events.push({ voice: "kick",  beat: base + 0, samplePath: SAMPLES.bwbKick5 });
    events.push({ voice: "snare", beat: base + 2, samplePath: SAMPLES.bwbSnare5 });
    // Alternating hat pattern: closed, open, closed, open (per beat)
    events.push({ voice: "hihat",   beat: base + 0, samplePath: SAMPLES.bwbHat5,       velocityScale: 0.7 });
    events.push({ voice: "openhat", beat: base + 1, samplePath: SAMPLES.bwbOpenHat5,   velocityScale: 0.75 });
    events.push({ voice: "hihat",   beat: base + 2, samplePath: SAMPLES.bwbHat5,       velocityScale: 0.7 });
    events.push({ voice: "openhat", beat: base + 3, samplePath: SAMPLES.bwbOpenHat5,   velocityScale: 0.75 });
  }

  generate({
    name: "openhat-alternating",
    bpm,
    durationBeats: total,
    description: "Alternating closed/open hat groove, 120 BPM, 2 bars. Kick on 1, snare on 3, hats alternate closed/open every quarter (BWB samples)",
    events,
  });
}

console.log("\nDone. All loops generated in:", LOOPS_DIR);
