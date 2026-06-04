import { RackDevice, DrumChain, Simpler, type ExtensionContext } from "@ableton-extensions/sdk";
import type { DrumAnalysis, DrumVoiceType, VelocityTier } from "@arclight/core";

// Each voice gets consecutive semitones for velocity-layered pads.
// Tier 0 → baseNote, tier 1 → baseNote+1, tier 2 → baseNote+2.
// kick:    C1  (36–38)
// snare:   E1  (40–42)
// hihat:   G#1 (44–46)  — closed
// openhat: A#1 (47–49)  — open (note 47 so its tier-0 pad doesn't collide with
//                        closed hi-hat's max tier at baseNote 44 + tier 2 = 46)
const VOICE_BASE_NOTE: Record<string, number> = {
  kick:    36,
  snare:   40,
  hihat:   44,
  openhat: 47,
};

// Note durations in beats. Short durations let the Simpler envelope handle
// the natural decay; long notes in Classic mode sustain the sample longer than
// necessary and muddy the low-end.
const VOICE_NOTE_DURATION: Record<string, number> = {
  kick:    0.5,   // 8th note — long enough for the sub-bass rumble to develop
  snare:   0.5,
  hihat:   0.25,  // 16th note — hihats are short by nature
  openhat: 0.5,   // open hats sustain longer than closed hats
};

// ── Pure helper functions (unit-testable, no Live dependency) ─────────────────

/**
 * Returns a flat list of chain descriptors for all chains to create for a
 * voice. Each non-empty tier gets exactly ONE chain (the first sample, which
 * drum-detector orders by proximity to the tier's midpoint strength — i.e. the
 * most representative hit for that dynamic level).
 *
 * tierIndex increments only for tiers that have at least one sample.
 *
 * --- Future SDK work (round-robin / multi-sample) ---
 * When the Extensions SDK exposes Simpler's multi-sample API, this function
 * should be updated to emit one chain per tier and load ALL tier.samples into
 * that chain's Simpler with Cycle (round-robin) playback mode. Until then,
 * using a single representative sample per tier is the correct approach:
 * velocity sensitivity (soft/medium/loud) is preserved via the consecutive-note
 * tier layout, and the limitation is limited variation within each dynamic layer.
 *
 * Alternatively, if the SDK ever exposes Device parameter setters, Ableton's
 * built-in "Random" MIDI effect could be inserted on the track before the Drum
 * Rack and configured with Choices=1 and Sign=+ to randomly select among
 * per-tier chains — but this requires knowing the exact parameter names and
 * ranges, and cannot be done today since Device has no parameter API.
 */
export function planChainsForVoice(
  _voice: DrumVoiceType,
  tiers: VelocityTier[],
  baseNote: number,
): Array<{ tierIndex: number; midiNote: number; filePath: string }> {
  const result: Array<{ tierIndex: number; midiNote: number; filePath: string }> = [];
  let tierIndex = 0;
  for (const tier of tiers) {
    if (tier.samples.length === 0) continue;
    result.push({ tierIndex, midiNote: baseNote + tierIndex, filePath: tier.samples[0].filePath });
    tierIndex++;
  }
  return result;
}

/**
 * Given a hit velocity and a voice's tier array, returns the tier index whose
 * [velMin, velMax] range contains the velocity.
 *
 * Clamping: velocity below all tiers → 0; velocity above all tiers → last index.
 * Ties/gaps: picks the tier whose midpoint is closest to the velocity.
 */
export function pickTierForVelocity(tiers: VelocityTier[], velocity: number): number {
  if (tiers.length === 0) return 0;
  if (tiers.length === 1) return 0;

  // First try exact range match
  for (let i = 0; i < tiers.length; i++) {
    if (velocity >= tiers[i].velMin && velocity <= tiers[i].velMax) return i;
  }

  // Velocity is outside all ranges (gap or clamp) — pick closest midpoint
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < tiers.length; i++) {
    const mid = (tiers[i].velMin + tiers[i].velMax) / 2;
    const dist = Math.abs(velocity - mid);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Builds the complete MIDI notes array from analysis + chain plans.
 * For each hit, the pitch is baseNote + tierIndex where tierIndex is chosen
 * via pickTierForVelocity applied to non-empty tiers only (matching what
 * planChainsForVoice uses when assigning midiNotes).
 * Voices not in voiceBasePitch are silently filtered out.
 */
// Tier-to-pitch mapping is recomputed from voiceData.tiers here rather than
// accepting a pre-built chainPlans map. The predicate (non-empty tiers) must
// match planChainsForVoice exactly — both use `tier.samples.length > 0`.
export function buildClipNotes(
  analysis: DrumAnalysis,
  voiceBasePitch: Record<string, number>,
  voiceDuration: Record<string, number>,
): Array<{ pitch: number; startTime: number; duration: number; velocity: number }> {
  const notes: Array<{ pitch: number; startTime: number; duration: number; velocity: number }> = [];
  for (const voiceData of analysis.voices) {
    const baseNote = voiceBasePitch[voiceData.voice];
    if (baseNote === undefined) continue;
    const duration = voiceDuration[voiceData.voice] ?? 0.5;

    // Only consider tiers that have samples — planChainsForVoice skips empty tiers
    // and assigns tierIndex sequentially among non-empty tiers.
    const nonEmptyTiers = voiceData.tiers.filter(t => t.samples.length > 0);

    for (const hit of voiceData.hits) {
      const tierIdx = nonEmptyTiers.length > 0
        ? pickTierForVelocity(nonEmptyTiers, hit.velocity)
        : 0;
      notes.push({ pitch: baseNote + tierIdx, startTime: hit.timeBeat, duration, velocity: hit.velocity });
    }
  }
  return notes;
}

export async function buildDrumRack(
  ext: ExtensionContext<"1.0.0">,
  analysis: DrumAnalysis,
  trackName: string,
): Promise<void> {
  const song = ext.application.song;

  // TODO(W5): No rollback on partial failure. The Extensions SDK 0.0.5 exposes no
  // track-deletion API (Song has no deleteTrack/removeMidiTrack method, and Track
  // has no delete method). If replaceSample or any Simpler-load step throws after
  // the MIDI track has been created, the partially-built track is left as an orphan
  // in Live. Callers should surface the error to the user so they can delete it
  // manually (right-click → Delete in the session/arrangement view).
  const track = await song.createMidiTrack();
  ext.withinTransaction(() => { track.name = trackName; });

  const device = await track.insertDevice("Drum Rack", 0);
  const rackDevice = ext.getObjectFromHandle(device.handle, RackDevice);

  // Plan all chains for each voice using velocity-tier layout.
  // Tier 0 → baseNote, tier 1 → baseNote+1, tier 2 → baseNote+2.
  // Multiple samples in the same tier share the same midiNote — Ableton
  // does round-robin automatically when multiple chains share a note.
  let chainInsertIdx = 0;

  for (const voiceData of analysis.voices) {
    const baseNote = VOICE_BASE_NOTE[voiceData.voice];
    if (baseNote === undefined) continue;

    const plan = planChainsForVoice(voiceData.voice, voiceData.tiers, baseNote);

    for (const entry of plan) {
      const newChain = await rackDevice.insertChain(chainInsertIdx++);
      const drumChain = ext.getObjectFromHandle(newChain.handle, DrumChain);
      ext.withinTransaction(() => { drumChain.receivingNote = entry.midiNote; });

      const simplerDevice = await drumChain.insertDevice("Simpler", 0);
      const simpler = ext.getObjectFromHandle(simplerDevice.handle, Simpler);
      await simpler.replaceSample(entry.filePath);
    }
  }

  const clipSlot = track.clipSlots[0];
  const clip = await clipSlot.createMidiClip(Math.max(analysis.totalBeats, 4));

  // Build MIDI notes: each hit selects the tier whose velMin–velMax matches
  // its velocity. The MIDI pitch for that tier is baseNote + tierIndex so
  // the Drum Rack routes it to the correct velocity-layered pad.
  const allNotes = buildClipNotes(analysis, VOICE_BASE_NOTE, VOICE_NOTE_DURATION);
  ext.withinTransaction(() => { clip.notes = allNotes; });

  const voiceSummary = analysis.voices.map(v => {
    const totalSamples = v.tiers.flatMap(t => t.samples).length;
    const tierCount = v.tiers.filter(t => t.samples.length > 0).length;
    return `${v.voice} (${totalSamples} sample${totalSamples !== 1 ? "s" : ""}, ${tierCount} tier${tierCount !== 1 ? "s" : ""})`;
  }).join(", ");
  console.log(
    `[GrooveTransplant] Drum rack "${trackName}" built — ${voiceSummary}, ${allNotes.length} note(s)`,
  );
}
