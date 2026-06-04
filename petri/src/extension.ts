import { initialize, MidiClip, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import type { MidiNote } from "@arclight/core";
import { mutateClip } from "./genetics.js";
import {
  startOscillation, stopOscillation, getOscillation, stopAllOscillations
} from "./ecology.js";
import {
  buildLabWebview, buildMutateWebview, buildOscillateWebview, type ClipEntry
} from "./webview-html.js";

interface MutationSettings {
  rate: number;
  opts: { pitch: boolean; timing: boolean; duration: boolean; velocity: boolean };
  seed: number;
}

function toMidiNotes(raw: unknown[]): MidiNote[] {
  return (raw as any[]).map(n => ({
    pitch:     Number(n.pitch     ?? 60),
    startTime: Number(n.startTime ?? 0),
    duration:  Number(n.duration  ?? 0.25),
    velocity:  Number(n.velocity  ?? 100),
  }));
}

export function activate(activation: ActivationContext): void {
  const ext = initialize(activation, "1.0.0");
  console.log("[Petri] Starting...");

  const lastMutations = new Map<string, MutationSettings>();

  const handleId = (h: unknown): string => String((h as { id: bigint }).id ?? 0);

  // ── Petri Lab — full session clip browser + breeding ──────────────────────
  ext.commands.registerCommand("petri.openLab", async (args: unknown) => {
    try {
      const song = ext.application?.song;
      if (!song) { console.log("[Petri] No active song"); return; }

      const clipEntries: ClipEntry[] = [];
      const clipRefs: MidiClip<any>[] = [];
      let clickedId = -1;

      const clickedHandleStr = handleId(args);

      const tracks = song.tracks as any[];
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        const slots: any[] = track.clipSlots ?? [];
        for (let si = 0; si < slots.length; si++) {
          const raw = slots[si].clip;
          if (!(raw instanceof MidiClip)) continue;
          const midiClip = raw as MidiClip<any>;
          const notes = toMidiNotes(midiClip.notes);
          if (!Array.isArray(notes) || notes.length === 0) continue;

          const id = clipEntries.length;
          if (handleId((midiClip as any).handle) === clickedHandleStr) clickedId = id;

          const cappedNotes = notes.slice(0, 128);
          clipEntries.push({
            id,
            trackName: track.name ?? `Track ${ti + 1}`,
            clipName: (midiClip as any).name ?? `Clip ${si + 1}`,
            noteCount: notes.length,
            notes: cappedNotes,
          });
          clipRefs.push(midiClip);
        }
      }

      if (clipEntries.length === 0) {
        console.log("[Petri] No MIDI clips with notes found in session");
        return;
      }

      // Fallback: match clicked clip by handle from context
      if (clickedId < 0) {
        try {
          const clicked = ext.getObjectFromHandle(args as Handle, MidiClip);
          const cn = clicked.notes.length;
          clickedId = clipEntries.findIndex(e => e.noteCount === cn);
        } catch {}
      }

      const resultJson = await ext.ui.showModalDialog(buildLabWebview(clipEntries, clickedId), 800, 520);
      if (!resultJson || resultJson === "null") return;

      const result = JSON.parse(resultJson) as {
        action: string; targetId: number; notes: MidiNote[]
      };
      if (result.action === "breed" && result.notes?.length > 0 && result.targetId >= 0) {
        const clip = clipRefs[result.targetId];
        if (clip) {
          ext.withinTransaction(() => { clip.notes = result.notes; });
          console.log(`[Petri] Bred ${result.notes.length} notes into clip ${result.targetId}`);
        }
      }
    } catch (err) {
      console.error("[Petri] openLab error:", err);
    }
  });

  // ── Mutate ────────────────────────────────────────────────────────────────
  ext.commands.registerCommand("petri.mutate", async (args: unknown) => {
    try {
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
      const notes = toMidiNotes(clip.notes);

      const resultJson = await ext.ui.showModalDialog(buildMutateWebview(notes), 510, 450);
      if (!resultJson || resultJson === "null") return;

      const result = JSON.parse(resultJson) as {
        action: string; notes: MidiNote[];
        rate?: number;
        opts?: MutationSettings["opts"];
        nextSeed?: number;
      };
      if (result.action === "mutate" && result.notes?.length > 0) {
        ext.withinTransaction(() => { clip.notes = result.notes; });
        const clipKey = handleId(args);
        if (result.rate !== undefined && result.opts && result.nextSeed !== undefined) {
          lastMutations.set(clipKey, { rate: result.rate, opts: result.opts, seed: result.nextSeed });
        }
        console.log("[Petri] Mutated clip");
      }
    } catch (err) {
      console.error("[Petri] mutate error:", err);
    }
  });

  // ── Mutate Again — repeat last mutation, no dialog ────────────────────────
  ext.commands.registerCommand("petri.mutateAgain", async (args: unknown) => {
    try {
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
      const clipKey = handleId(args);
      const lastMutation = lastMutations.get(clipKey) ?? null;

      if (!lastMutation) {
        // No prior mutation — fall through to full dialog
        const notes = toMidiNotes(clip.notes);
        const resultJson = await ext.ui.showModalDialog(buildMutateWebview(notes), 510, 450);
        if (!resultJson || resultJson === "null") return;
        const result = JSON.parse(resultJson) as {
          action: string; notes: MidiNote[];
          rate?: number; opts?: MutationSettings["opts"]; nextSeed?: number;
        };
        if (result.action === "mutate" && result.notes?.length > 0) {
          ext.withinTransaction(() => { clip.notes = result.notes; });
          if (result.rate !== undefined && result.opts && result.nextSeed !== undefined) {
            lastMutations.set(clipKey, { rate: result.rate, opts: result.opts, seed: result.nextSeed });
          }
        }
        return;
      }

      const notes = toMidiNotes(clip.notes);
      const { rate, opts, seed } = lastMutation;
      const mutated = mutateClip(notes, rate, opts, seed);
      ext.withinTransaction(() => { clip.notes = mutated; });
      lastMutations.set(clipKey, { rate, opts, seed: seed + 1 });
      console.log(`[Petri] Mutate Again: rate=${rate.toFixed(2)} seed=${seed}`);
    } catch (err) {
      console.error("[Petri] mutateAgain error:", err);
    }
  });

  // ── Oscillate ─────────────────────────────────────────────────────────────
  ext.commands.registerCommand("petri.oscillate", async (args: unknown) => {
    try {
      const handle = args as Handle;
      const handleKey = handleId(handle);
      const clip = ext.getObjectFromHandle(handle, MidiClip);
      const notes = toMidiNotes(clip.notes);
      const current = getOscillation(handleKey);

      const resultJson = await ext.ui.showModalDialog(buildOscillateWebview(notes, current), 440, 330);
      if (!resultJson || resultJson === "null") return;

      const result = JSON.parse(resultJson) as {
        action: string;
        intervalMode?: "bars" | "seconds";
        division?: number;
        intervalSec?: number;
        intensity?: number;
        transportSync?: boolean;
        scaleLock?: boolean;
      };
      if (result.action === "stop") {
        stopOscillation(handleKey);
        console.log("[Petri] Oscillation stopped");
      } else if (result.action === "start" && result.intensity) {
        startOscillation(
          handleKey,
          () => ({
            get: () => toMidiNotes(clip.notes),
            set: (n: MidiNote[]) => { ext.withinTransaction(() => { clip.notes = n; }); },
          }),
          {
            intervalMode: result.intervalMode ?? "bars",
            division: result.division ?? 1,
            intervalSec: result.intervalSec ?? 4,
            intensity: result.intensity,
            transportSync: result.transportSync ?? true,
            scaleLock: result.scaleLock ?? false,
          },
          () => ({
            // song.isPlaying was removed in SDK 1.0.0 (transport play-state is
            // no longer exposed); oscillation now runs regardless of transport.
            tempo: ext.application?.song?.tempo ?? 120,
            rootNote: ext.application?.song?.rootNote ?? 0,
            scaleName: ext.application?.song?.scaleName ?? "Major",
          })
        );
        console.log(`[Petri] Oscillation started: ${result.intervalMode} mode, intensity ${result.intensity}, scale lock ${result.scaleLock}`);
      }
    } catch (err) {
      console.error("[Petri] oscillate error:", err);
    }
  });

  ext.ui.registerContextMenuAction("MidiClip", "Open Lab…", "petri.openLab");
  ext.ui.registerContextMenuAction("MidiClip", "Mutate…", "petri.mutate");
  ext.ui.registerContextMenuAction("MidiClip", "Mutate Again", "petri.mutateAgain");
  ext.ui.registerContextMenuAction("MidiClip", "Oscillate…", "petri.oscillate");

  console.log("[Petri] Ready — right-click any MIDI clip");

  process.on("exit", () => {
    stopAllOscillations();
    console.log("[Petri] Unloaded");
  });
}
