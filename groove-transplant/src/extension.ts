import { initialize, MidiClip, AudioClip, type ActivationContext, type Handle } from "@ableton-extensions/sdk";
import {
  computeGrooveFromMidi,
  computeGrooveFromAudio,
  estimateTempo,
  extractBpmFromText,
  detectOptimalResolution,
  applyGrooveToNotes,
  applyVelocityGroove,
  detectDrumVoices,
  fillPatternGaps,
} from "@arclight/core";
import type { MidiNote, FrequencyBand, AudioGrooveOptions, DrumVoiceType } from "@arclight/core";
import { readdirSync, statSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { userLibrarySamples } from "./paths.js";
import { GrooveStore } from "./groove-store.js";
import { buildExtractWebview, buildApplyWebview, buildAudioExtractSettingsWebview, buildDrumRackSettingsWebview, buildManageSamplesWebview, escHtml } from "./webview-html.js";
import { writeAgr, grooveOutputDir, drumSampleOutputDir } from "./agr-writer.js";
import { buildDrumRack } from "./drum-rack-builder.js";

export function activate(context: ActivationContext): void {
  const ext = initialize(context, "1.0.0");
  console.log("[GrooveTransplant] Starting...");

  const store = new GrooveStore(ext.environment.storageDirectory ?? "/tmp/groove-transplant");

  // ── COPY GROOVE ───────────────────────────────────────────────────────────────

  ext.commands.registerCommand("groove-transplant.copy", async (args: unknown) => {
    try {
      const clip     = ext.getObjectFromHandle(args as Handle, MidiClip);
      const rawNotes = clip.notes;

      if (rawNotes.length === 0) {
        console.log("[GrooveTransplant] No notes in clip — nothing to extract");
        return;
      }

      const notes = rawNotes as unknown as MidiNote[];

      // Auto-detect resolution and compute profile
      const detectedRes = detectOptimalResolution(notes);
      const profile     = computeGrooveFromMidi(notes, 0, detectedRes, 4, "Groove");

      const dataUrl = buildExtractWebview(profile, detectedRes);
      const resultJson = await ext.ui.showModalDialog(dataUrl, 700, 420);
      if (!resultJson) return;

      const result = JSON.parse(resultJson) as {
        action: string;
        name?: string;
        resolution?: number;
      };
      if (result.action !== "save") return;

      // If user changed the resolution dropdown, recompute with chosen resolution
      const chosenRes  = result.resolution ?? detectedRes;
      const finalProfile = Math.abs(chosenRes - detectedRes) > 1e-9
        ? computeGrooveFromMidi(notes, 0, chosenRes, 4, "Groove")
        : profile;

      if (result.name?.trim()) finalProfile.name = result.name.trim();
      store.save(finalProfile);

      try {
        const agrPath = writeAgr(finalProfile, grooveOutputDir());
        console.log(`[GrooveTransplant] Saved groove: "${finalProfile.name}" → ${agrPath}`);
      } catch (agrErr) {
        console.warn("[GrooveTransplant] .agr export failed (groove saved internally):", agrErr);
      }

    } catch (err) {
      console.error("[GrooveTransplant] Copy error:", err);
    }
  });

  // ── APPLY GROOVE ─────────────────────────────────────────────────────────────

  ext.commands.registerCommand("groove-transplant.apply", async (args: unknown) => {
    try {
      const clip     = ext.getObjectFromHandle(args as Handle, MidiClip);
      const rawNotes = clip.notes;

      if (rawNotes.length === 0) {
        console.log("[GrooveTransplant] Target clip has no notes");
        return;
      }

      const notes = rawNotes as unknown as MidiNote[];
      const targetNotes = notes.map(n => ({
        pitch: n.pitch,
        startTime: n.startTime,
        duration: n.duration,
        velocity: n.velocity,
      }));

      // Loop so deleting a groove re-opens the dialog with the updated list
      while (true) {
        const grooves = store.loadAll();
        if (grooves.length === 0) {
          console.log("[GrooveTransplant] No grooves saved yet — copy a groove first");
          return;
        }

        const dataUrl = buildApplyWebview(grooves, targetNotes);
        const resultJson = await ext.ui.showModalDialog(dataUrl, 740, 560);
        if (!resultJson) return;

        const result = JSON.parse(resultJson) as {
          action: string;
          grooveId?: string;
          timingStrength?: number;
          velocityStrength?: number;
        };

        if (result.action === "delete" && result.grooveId) {
          store.delete(result.grooveId);
          console.log(`[GrooveTransplant] Deleted groove: ${result.grooveId}`);
          continue; // re-open with updated list
        }

        if (result.action !== "apply" || !result.grooveId) return;

        const groove = grooves.find(g => g.id === result.grooveId);
        if (!groove) return;

        const timingStr   = (result.timingStrength  ?? 100) / 100;
        const velocityStr = (result.velocityStrength ?? 0)   / 100;

        const grooveNotes = notes as unknown as Array<{ startTime: number; velocity: number; [key: string]: unknown }>;
        const newStartTimes  = applyGrooveToNotes(grooveNotes, groove, timingStr);
        const newVelocities  = velocityStr > 0
          ? applyVelocityGroove(grooveNotes, groove, velocityStr)
          : notes.map(n => n.velocity);

        const updatedNotes = notes.map((n, i) => ({
          pitch:     n.pitch,
          startTime: Math.max(0, newStartTimes[i]),
          duration:  n.duration,
          velocity:  Math.max(1, Math.min(127, Math.round(newVelocities[i]))),
        }));

        ext.withinTransaction(() => {
          clip.notes = updatedNotes;
        });

        console.log(
          `[GrooveTransplant] Applied "${groove.name}" — ` +
          `timing ${Math.round(timingStr * 100)}% / velocity ${Math.round(velocityStr * 100)}%`
        );
        return;
      }

    } catch (err) {
      console.error("[GrooveTransplant] Apply error:", err);
    }
  });

  // ── EXTRACT GROOVE FROM AUDIO ────────────────────────────────────────────────

  ext.commands.registerCommand("groove-transplant.extractAudio", async (args: unknown) => {
    try {
      // Command is registered on both AudioClip and MidiClip menus — verify it's actually an audio clip
      let clip: AudioClip<"1.0.0">;
      try {
        clip = ext.getObjectFromHandle(args as Handle, AudioClip);
      } catch {
        console.log("[GrooveTransplant] extract-from-audio: invoked on a non-audio clip — ignoring");
        return;
      }
      const filePath = clip.filePath;

      const fileExt = filePath.split(".").pop()?.toLowerCase() ?? "";
      if (!["wav", "aif", "aiff"].includes(fileExt)) {
        console.log(`[GrooveTransplant] Unsupported format: .${fileExt} — only WAV and AIFF supported`);
        return;
      }

      // Try to extract BPM from the clip name or filename first — common in sample packs
      const clipName = clip.name || "Audio Groove";
      const fileBasename = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      const nameBpm = extractBpmFromText(clipName) ?? extractBpmFromText(fileBasename);

      let defaultBpm: number;
      if (nameBpm !== null) {
        console.log(`[GrooveTransplant] BPM from name: ${nameBpm}`);
        defaultBpm = nameBpm;
      } else {
        const { bpm: detectedBpm, confidence } = estimateTempo(filePath);
        defaultBpm = confidence >= 0.1 ? detectedBpm : 120;
        console.log(`[GrooveTransplant] Tempo estimate: ${detectedBpm} BPM (confidence ${(confidence * 100).toFixed(0)}%)`);
      }

      const settingsUrl = buildAudioExtractSettingsWebview(clipName, defaultBpm);
      const settingsJson = await ext.ui.showModalDialog(settingsUrl, 500, 380);
      if (!settingsJson) return;

      const settings = JSON.parse(settingsJson) as {
        action: string;
        band: string;
        bpm: number;
        resolution: number;
        sensitivity: number;
        name: string;
      };
      if (settings.action !== "extract") return;

      const opts: AudioGrooveOptions = {
        band:        settings.band as FrequencyBand,
        bpm:         settings.bpm,
        resolution:  settings.resolution,
        sensitivity: settings.sensitivity / 100,
        name:        settings.name || clipName,
      };

      const profile = computeGrooveFromAudio(filePath, opts);

      if (profile.offsets.length === 0) {
        console.log("[GrooveTransplant] No transients detected — try lowering sensitivity");
        return;
      }

      // Reuse the MIDI extract results webview for save/discard
      const resultUrl  = buildExtractWebview(profile, opts.resolution);
      const resultJson = await ext.ui.showModalDialog(resultUrl, 700, 420);
      if (!resultJson) return;

      const result = JSON.parse(resultJson) as {
        action: string;
        name?: string;
        resolution?: number;
      };
      if (result.action !== "save") return;

      const chosenRes    = result.resolution ?? opts.resolution;
      const finalProfile = Math.abs(chosenRes - opts.resolution) > 1e-9
        ? computeGrooveFromAudio(filePath, { ...opts, resolution: chosenRes })
        : profile;

      if (result.name?.trim()) finalProfile.name = result.name.trim();
      store.save(finalProfile);

      try {
        const agrPath = writeAgr(finalProfile, grooveOutputDir());
        console.log(`[GrooveTransplant] Saved audio groove: "${finalProfile.name}" → ${agrPath}`);
      } catch (agrErr) {
        console.warn("[GrooveTransplant] .agr export failed (groove saved internally):", agrErr);
      }

    } catch (err) {
      console.error("[GrooveTransplant] Audio extraction error:", err);
    }
  });

  // ── BUILD DRUM RACK FROM AUDIO ────────────────────────────────────────────────

  const showDebugDialog = async (msg: string) => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;font-size:13px;
background:#1a1a1a;color:#e0e0e0;display:flex;flex-direction:column;height:100vh}
.hdr{background:#252525;border-bottom:1px solid #333;padding:10px 16px;font-size:11px;font-weight:600;
text-transform:uppercase;color:#777}.body{flex:1;padding:16px;overflow:auto;white-space:pre-wrap;
font-family:monospace;font-size:12px;color:#ccc}.ftr{padding:10px 16px;border-top:1px solid #2a2a2a;
display:flex;justify-content:flex-end}button{background:#2e2e2e;border:1px solid #444;color:#d0d0d0;
padding:6px 16px;border-radius:4px;cursor:pointer;font-size:12px}</style></head>
<body><div class="hdr">Drum Rack Debug</div><div class="body">${escHtml(msg)}</div>
<div class="ftr"><button onclick="var m={method:'close_and_send',params:['ok']};
if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)
window.webkit.messageHandlers.live.postMessage(m);
else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);">OK</button></div>
</body></html>`;
    await ext.ui.showModalDialog(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, 520, 320
    );
  };

  ext.commands.registerCommand("groove-transplant.buildDrumRack", async (args: unknown) => {
    const steps: string[] = [];
    const step = (s: string) => { steps.push(s); console.log(`[GrooveTransplant] ${s}`); };

    try {
      let clip: AudioClip<"1.0.0">;
      try {
        clip = ext.getObjectFromHandle(args as Handle, AudioClip);
      } catch {
        await showDebugDialog("Not an audio clip — ignoring");
        return;
      }
      const filePath = clip.filePath;
      step(`File: ${filePath}`);

      const fileExt = filePath.split(".").pop()?.toLowerCase() ?? "";
      if (!["wav", "aif", "aiff"].includes(fileExt)) {
        await showDebugDialog(`Unsupported format: .${fileExt}`);
        return;
      }

      const clipName = clip.name || "Drum Loop";
      const fileBasename = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      const nameBpm = extractBpmFromText(clipName) ?? extractBpmFromText(fileBasename);

      let defaultBpm: number;
      if (nameBpm !== null) {
        defaultBpm = nameBpm;
        step(`BPM from name: ${nameBpm}`);
      } else {
        const { bpm: detectedBpm, confidence } = estimateTempo(filePath);
        defaultBpm = confidence >= 0.1 ? detectedBpm : 120;
        step(`BPM estimate: ${detectedBpm} (conf ${(confidence * 100).toFixed(0)}%)`);
      }

      const settingsUrl = buildDrumRackSettingsWebview(clipName, defaultBpm);
      const settingsJson = await ext.ui.showModalDialog(settingsUrl, 460, 390);
      if (!settingsJson) return;

      const settings = JSON.parse(settingsJson) as {
        action: string; bpm: number; sensitivity: number;
        voices: string[]; trackName: string; fillGaps: boolean;
      };
      if (settings.action !== "build") return;
      step(`Settings: bpm=${settings.bpm} sens=${settings.sensitivity} voices=${settings.voices.join(",")}`);

      const validVoices = (settings.voices as string[]).filter(
        (v): v is DrumVoiceType =>
          v === "kick" || v === "snare" || v === "hihat" || v === "openhat",
      );
      if (validVoices.length === 0) {
        await showDebugDialog("No valid voices selected");
        return;
      }

      const outputDir = drumSampleOutputDir(clipName);
      step(`Output dir: ${outputDir}`);

      const analysis = detectDrumVoices(
        filePath, settings.bpm, settings.sensitivity / 100,
        outputDir, validVoices,
      );
      step(`Detected: ${analysis.voices.map(v => `${v.voice}(${v.hits.length}hits)`).join(", ") || "none"}`);

      if (settings.fillGaps) {
        const filled = fillPatternGaps(analysis);
        step(`Pattern fill: inserted ${filled} synthetic hit(s)`);
      }

      if (analysis.voices.length === 0) {
        await showDebugDialog(`No voices detected.\n\nSteps:\n${steps.join("\n")}`);
        return;
      }

      step("Calling buildDrumRack…");
      await buildDrumRack(ext, analysis, settings.trackName || clipName);
      step("Done!");

    } catch (err) {
      const msg = `Error: ${err instanceof Error ? err.message : String(err)}\n\nSteps:\n${steps.join("\n")}`;
      console.error("[GrooveTransplant] Build drum rack error:", err);
      await showDebugDialog(msg);
    }
  });

  // ── MANAGE SAMPLES ───────────────────────────────────────────────────────────

  ext.commands.registerCommand("groove-transplant.manageSamples", async () => {
    try {
      const samplesRoot = join(userLibrarySamples(), "Groove Transplant");

      const enumerated = new Set<string>();
      const folders: Array<{ name: string; sizeMb: number; date: string; mtimeMs: number }> = [];

      if (existsSync(samplesRoot)) {
        const entries = readdirSync(samplesRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          enumerated.add(entry.name);
          const folderPath = join(samplesRoot, entry.name);
          let totalBytes = 0;
          let mtimeMs = 0;
          try {
            const files = readdirSync(folderPath);
            for (const f of files) {
              if (!f.toLowerCase().endsWith(".wav")) continue;
              const st = statSync(join(folderPath, f));
              totalBytes += st.size;
              if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
            }
            if (mtimeMs === 0) mtimeMs = statSync(folderPath).mtimeMs;
          } catch {
            try { mtimeMs = statSync(folderPath).mtimeMs; } catch { /* skip */ }
          }
          const sizeMb = totalBytes / (1024 * 1024);
          const date = mtimeMs === 0
            ? "\u2014"
            : new Date(mtimeMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          folders.push({ name: entry.name, sizeMb, date, mtimeMs });
        }
        // Sort newest first by numeric mtime
        folders.sort((a, b) => b.mtimeMs - a.mtimeMs);
      }

      const dataUrl = buildManageSamplesWebview(folders);
      const resultJson = await ext.ui.showModalDialog(dataUrl, 560, 420);
      if (!resultJson) return;

      const result = JSON.parse(resultJson) as { action: string; folders?: string[] };
      if (result.action !== "delete" || !result.folders?.length) return;

      let deleted = 0;
      for (const name of result.folders) {
        // Validate against the originally enumerated set — reject path traversal attempts.
        if (!enumerated.has(name)) {
          console.warn(`[GrooveTransplant] Ignoring unknown folder "${name}" — not in enumerated set`);
          continue;
        }
        const folderPath = join(samplesRoot, name);
        try {
          rmSync(folderPath, { recursive: true, force: true });
          deleted++;
          console.log(`[GrooveTransplant] Deleted sample set: ${name}`);
        } catch (err) {
          console.error(`[GrooveTransplant] Failed to delete "${name}":`, err);
        }
      }
      console.log(`[GrooveTransplant] Manage samples: deleted ${deleted} of ${result.folders.length} selected sets`);

    } catch (err) {
      console.error("[GrooveTransplant] Manage samples error:", err);
    }
  });

  // ── CONTEXT MENU ─────────────────────────────────────────────────────────────

  ext.ui.registerContextMenuAction("MidiClip",   "Copy Groove",                          "groove-transplant.copy");
  ext.ui.registerContextMenuAction("MidiClip",   "Apply Groove\u2026",                   "groove-transplant.apply");
  ext.ui.registerContextMenuAction("AudioClip",  "Extract Groove from Audio\u2026",      "groove-transplant.extractAudio");
  ext.ui.registerContextMenuAction("AudioClip",  "Build Drum Rack from Audio\u2026",     "groove-transplant.buildDrumRack");
  // manageSamples is global \u2014 handler ignores its argument. Surface it on AudioTrack so it's discoverable.
  ext.ui.registerContextMenuAction("AudioTrack", "Manage Drum Rack Samples\u2026",       "groove-transplant.manageSamples");

  console.log("[GrooveTransplant] Ready");
  process.on("exit", () => { console.log("[GrooveTransplant] Unloaded"); });
}
