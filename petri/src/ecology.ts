import type { MidiNote } from "@arclight/core";
import { mutateClip, getScaleIntervals } from "./genetics.js";

export interface OscillationSettings {
  intervalMode: "bars" | "seconds";
  division: number;      // bars: 0.5, 1, 2, 4, 8 (used when intervalMode === "bars")
  intervalSec: number;   // seconds (used when intervalMode === "seconds")
  intensity: number;
  transportSync: boolean;
  scaleLock: boolean;
}

export interface PlaybackInfo {
  // NOTE: transport play-state (isPlaying) was removed in SDK 1.0.0 and has no
  // replacement, so oscillation can no longer gate on whether Live is playing.
  tempo: number;
  rootNote: number;
  scaleName: string;
}

interface ActiveOscillation extends OscillationSettings {
  timeoutId: ReturnType<typeof setTimeout>;
}

const oscillations = new Map<string, ActiveOscillation>();

function computeIntervalMs(settings: OscillationSettings, tempo: number): number {
  if (settings.intervalMode === "bars") {
    return Math.max(250, (60000 / tempo) * settings.division * 4);
  }
  return Math.max(250, settings.intervalSec * 1000);
}

export function startOscillation(
  handleKey: string,
  getAndSetNotes: () => { get: () => MidiNote[]; set: (n: MidiNote[]) => void },
  settings: OscillationSettings,
  getPlaybackInfo: () => PlaybackInfo
): void {
  stopOscillation(handleKey);

  const tick = () => {
    const existing = oscillations.get(handleKey);
    if (!existing) return;

    try {
      const info = getPlaybackInfo();
      // transportSync previously suppressed mutation while Live was stopped, but
      // SDK 1.0.0 removed song.isPlaying — oscillation now always runs.
      const { get, set } = getAndSetNotes();
      const notes = get() as unknown as MidiNote[];
      if (notes.length > 0) {
        const scaleInfo = settings.scaleLock
          ? { rootNote: info.rootNote, intervals: getScaleIntervals(info.scaleName) }
          : undefined;
        const mutated = mutateClip(
          notes,
          settings.intensity * 0.4,
          { pitch: true, timing: true, duration: false, velocity: true },
          Date.now(),
          scaleInfo
        );
        set(mutated);
      }

      const nextMs = computeIntervalMs(settings, getPlaybackInfo().tempo);
      existing.timeoutId = setTimeout(tick, nextMs);
    } catch {
      stopOscillation(handleKey);
    }
  };

  const { tempo } = getPlaybackInfo();
  const timeoutId = setTimeout(tick, computeIntervalMs(settings, tempo));
  oscillations.set(handleKey, { timeoutId, ...settings });
}

export function stopOscillation(handleKey: string): void {
  const existing = oscillations.get(handleKey);
  if (existing) {
    clearTimeout(existing.timeoutId);
    oscillations.delete(handleKey);
  }
}

export function getOscillation(handleKey: string): OscillationSettings | undefined {
  const o = oscillations.get(handleKey);
  if (!o) return undefined;
  return {
    intervalMode: o.intervalMode,
    division: o.division,
    intervalSec: o.intervalSec,
    intensity: o.intensity,
    transportSync: o.transportSync,
    scaleLock: o.scaleLock,
  };
}

export function stopAllOscillations(): void {
  for (const key of [...oscillations.keys()]) stopOscillation(key);
}
