import { initialize, AudioClip, AudioTrack, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import { parseWav, detectTransients, buildErrorDataUrl } from "@arclight/core";
import { buildQuantizeWebview } from "./webview-html.js";
import type { TransientFrame } from "@arclight/core";

export function activate(context: ActivationContext): void {
  const ext = initialize(context, "1.0.0");
  console.log("[BeatDetective] Starting...");

  ext.commands.registerCommand("beat-detective.quantize", async (args: unknown) => {
    try {
      // Registered on AudioClip + AudioTrack — resolve whichever the handle is.
      // For a track, pick the first session clip slot containing an audio clip.
      let clip: AudioClip<"1.0.0"> | null = null;
      try {
        clip = ext.getObjectFromHandle(args as Handle, AudioClip);
      } catch {
        try {
          const track = ext.getObjectFromHandle(args as Handle, AudioTrack);
          for (const slot of track.clipSlots) {
            const raw = slot.clip;
            if (!raw) continue;
            let asAudio: AudioClip<"1.0.0">;
            try {
              asAudio = ext.getObjectFromHandle(raw.handle, AudioClip);
            } catch { continue; }
            if (asAudio.filePath) { clip = asAudio; break; }
          }
          if (!clip) {
            await ext.ui.showModalDialog(buildErrorDataUrl("Beat Detective", "No audio clips in this track."), 400, 200);
            return;
          }
        } catch (e) {
          console.error("[BeatDetective] handle is neither an AudioClip nor an AudioTrack:", e);
          return;
        }
      }

      // renderPreFxAudio needs the typed owning AudioTrack. Walk the object
      // hierarchy from the clip (AudioClip → ClipSlot → Track) to find it.
      let track: AudioTrack<"1.0.0"> | null = null;
      for (let node = clip.parent; node; node = node.parent) {
        if (node instanceof AudioTrack) { track = node; break; }
      }
      if (!track) {
        console.error("[BeatDetective] Could not find owning audio track for clip");
        return;
      }

      const song = ext.application.song;
      const bpm = song.tempo;
      const startTime = clip.startTime;
      const endTime = clip.endTime;

      let transients: TransientFrame[] = [];
      const waveformData: number[] = [];

      await ext.ui.withinProgressDialog(
        "Beat Detective: Analyzing...",
        { progress: 0 },
        async (update, _signal) => {
          await update("Rendering audio...", 10);

          const wavPath = await ext.resources.renderPreFxAudio(track!, startTime, endTime);

          await update("Parsing audio...", 40);
          const wav = parseWav(wavPath);

          await update("Detecting transients...", 60);
          transients = detectTransients(wav, { bpm, threshold: 0.25 });

          // Downsample for waveform display (~1000 points)
          await update("Building waveform...", 85);
          const chunkSize = Math.floor(wav.samples.length / 1000);
          for (let i = 0; i < 1000; i++) {
            let max = 0;
            for (let j = 0; j < chunkSize; j++) {
              const s = Math.abs(wav.samples[i * chunkSize + j] ?? 0);
              if (s > max) max = s;
            }
            waveformData.push(max);
          }

          await update("Done", 100);
        }
      );

      if (transients.length === 0) {
        console.log("[BeatDetective] No transients detected");
        return;
      }

      // ANALYZE / PREVIEW ONLY (Extensions SDK 1.0.0): AudioClip.warpMarkers is
      // read-only and the host exposes no warp-marker write API in 1.0.0 (0.0.5's
      // clip.setWarpMarkers is gone). The dialog detects transients and renders the
      // waveform/grid preview, but its Apply button is disabled — there is no path to
      // write markers back to the clip. So we show the preview, let the user inspect,
      // and the dialog only ever returns a close/cancel action. If a future SDK adds a
      // setter, re-enable Apply in webview-html.ts and apply
      // transientFramesToWarpMarkers(...) within a transaction here.
      const clipDuration = endTime - startTime;
      const dataUrl = buildQuantizeWebview(waveformData, transients, clipDuration, bpm);
      await ext.ui.showModalDialog(dataUrl, 900, 520);

    } catch (err) {
      console.error("[BeatDetective] Error:", err);
    }
  });

  ext.ui.registerContextMenuAction("AudioClip",  "Smart Quantize (Beat Detective)", "beat-detective.quantize");
  ext.ui.registerContextMenuAction("AudioTrack", "Smart Quantize (Beat Detective)", "beat-detective.quantize");
  console.log("[BeatDetective] Ready — right-click any audio clip to analyze transients (preview only on SDK 1.0.0)");

  process.on("exit", () => { console.log("[BeatDetective] Unloaded"); });
}
