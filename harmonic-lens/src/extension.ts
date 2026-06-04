import { initialize, MidiClip, MidiTrack, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import { detectKey, buildChordTimeline, suggestNextChords, buildErrorDataUrl } from "@arclight/core";
import { buildAnalysisWebview } from "./webview-html.js";
import type { ChordInfo, KeyInfo, MidiNote } from "@arclight/core";

export function activate(activation: ActivationContext): void {
  const ext = initialize(activation, "1.0.0");
  console.log("[HarmonicLens] Starting...");

  ext.commands.registerCommand("harmonic-lens.analyze", async (args: unknown) => {
    try {
      // Registered on MidiClip + MidiTrack — resolve whichever the handle is,
      // and for a track pick the first session clip slot containing a clip with notes.
      let resolved: MidiClip<"1.0.0"> | null = null;
      try {
        resolved = ext.getObjectFromHandle(args as Handle, MidiClip);
      } catch {
        try {
          const track = ext.getObjectFromHandle(args as Handle, MidiTrack);
          for (const slot of track.clipSlots) {
            const raw = slot.clip;
            if (!raw) continue;
            let asMidi: MidiClip<"1.0.0">;
            try {
              asMidi = ext.getObjectFromHandle(raw.handle, MidiClip);
            } catch { continue; }
            if (asMidi.notes.length > 0) { resolved = asMidi; break; }
          }
        } catch (e) {
          console.error("[HarmonicLens] Could not resolve handle as MidiClip or MidiTrack:", e);
          return;
        }
      }

      if (!resolved) {
        await ext.ui.showModalDialog(buildErrorDataUrl("Harmonic Lens", "No MIDI clips with notes in this track."), 400, 200);
        return;
      }
      // From here on `clip` is non-null — narrow once so TS doesn't have to
      // re-prove it through the nested try/catch above.
      const clip = resolved;

      if (clip.notes.length === 0) {
        console.log("[HarmonicLens] No notes in clip");
        return;
      }

      const rawNotes = clip.notes;
      const notes = rawNotes as unknown as MidiNote[];
      const key: KeyInfo = detectKey(notes);
      const chords: ChordInfo[] = buildChordTimeline(notes);
      const suggestions: ChordInfo[] = suggestNextChords(key, chords[chords.length - 1] ?? null);
      const maxBeat = Math.max(...rawNotes.map(n => n.startTime + n.duration));

      const dataUrl = buildAnalysisWebview(key, chords, suggestions, maxBeat, rawNotes);
      const resultJson = await ext.ui.showModalDialog(dataUrl, 860, 520);
      if (!resultJson) return;

      const result = JSON.parse(resultJson) as {
        type: string;
        notes?: Array<{ pitch: number; startTime: number; duration: number; velocity?: number }>;
      };
      if (result.type === "done" && result.notes && result.notes.length > rawNotes.length) {
        ext.withinTransaction(() => {
          clip.notes = result.notes!;
        });
        console.log(`[HarmonicLens] Wrote ${result.notes.length} notes to clip`);
      }
    } catch (err) {
      console.error("[HarmonicLens] Error:", err);
    }
  });

  ext.ui.registerContextMenuAction("MidiClip",  "Analyze with Harmonic Lens", "harmonic-lens.analyze");
  ext.ui.registerContextMenuAction("MidiTrack", "Analyze with Harmonic Lens", "harmonic-lens.analyze");

  console.log("[HarmonicLens] Ready — right-click any MIDI clip to analyze");

  process.on("exit", () => { console.log("[HarmonicLens] Unloaded"); });
}
