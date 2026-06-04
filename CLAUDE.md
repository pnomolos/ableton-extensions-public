# CLAUDE.md — Arclight Extensions

AI-facing documentation for the `ableton-extensions` monorepo. Human-facing docs
live in [README.md](README.md), [BUILDING.md](BUILDING.md), and
[DEVELOPMENT.md](DEVELOPMENT.md); per-extension READMEs sit in each package.

## Overview

Six Ableton Live extensions plus a shared, dependency-free `@arclight/core`
library. All extensions target the **Ableton Extensions SDK, API `1.0.0`**
(package `@ableton-extensions/sdk`).

| Package | Type | Description |
|---------|------|-------------|
| **arclight-core** | library | Music theory, transient/groove/drum analysis, WAV I/O. No SDK dependency. |
| **harmonic-lens** | extension | MIDI chord/key detection + next-chord suggestions on a clip. |
| **groove-transplant** | extension | Extract/apply groove feel from MIDI & audio; build Drum Racks from loops. |
| **beat-detective** | extension | Audio transient detection + waveform preview. **Analyze-only on SDK 1.0.0** (see below). |
| **lidal** | extension | TidalCycles-flavored live-coding DSL → MIDI via three virtual ports; browser editor. |
| **conway-clips** | extension | Cellular-automata transforms of MIDI clip content. |
| **petri** | extension | Generative / evolutionary MIDI experiments. |

## Monorepo structure

```
ableton-extensions/
├── arclight-core/        Shared @arclight/core library
│   └── src/              music-theory, warp-utils, drum-detector,
│                         transient-detector, pattern-fill, write-wav, text-utils, webview, types
├── harmonic-lens/        src/extension.ts + src/webview-html.ts
├── groove-transplant/    src/extension.ts, webview-html.ts, agr-writer.ts, drum-rack-builder.ts, groove-store.ts
├── beat-detective/       src/extension.ts + src/webview-html.ts
├── lidal/                src/extension.ts, parser.ts, patterns.ts, scheduler.ts, control.ts,
│                         transpile.ts, server.ts, sync.ts, music.ts, drums.ts, lfo.ts, editor/, …
├── conway-clips/         src/extension.ts
├── petri/                src/extension.ts + src/ecology.ts
├── extensions-sdk/       Local, git-ignored copy of the proprietary SDK (you provide it — see BUILDING.md)
├── scripts/              Shared build-extension.js / deploy-extension.js / pack-extension.js
└── tsconfig.base.json    Shared TS config (moduleResolution: "bundler")
```

## Build & deploy

```bash
pnpm install
pnpm run build:all                 # arclight-core first, then every extension
cd <ext> && pnpm run deploy        # build + copy bundle into the User Library Extensions folder
cd <ext> && pnpm run pack          # prod build + versioned zip in releases/
```

The Extensions SDK is **not** in this repo — obtain it from Ableton and place it
at `extensions-sdk/`. See [BUILDING.md](BUILDING.md).

### Reload during development

After editing source you **must `pnpm run deploy`** before reloading — the
Extension Host loads the *deployed* bundle from the User Library, not the repo's
`dist/`. Reload via the `dev-launch.sh` SIGHUP loop. The full workflow and its
two critical caveats (deploy-before-SIGHUP; only SIGHUP the `dev-launch.sh`
wrapper PID, never the bare node host) are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Extensions SDK 1.0.0 patterns

```typescript
import {
  initialize, MidiClip, AudioClip, MidiTrack,
  type ActivationContext, type Handle,
} from "@ableton-extensions/sdk";

export function activate(context: ActivationContext): void {
  const ext = initialize(context, "1.0.0");

  ext.commands.registerCommand("myext.command", async (args: unknown) => {
    // Context-menu commands receive the triggered object's Handle as the first arg.
    const clip = ext.getObjectFromHandle(args as Handle, MidiClip);

    // Mutations are individually undoable; wrap several in one undo step:
    ext.withinTransaction(() => { clip.notes = updatedNotes; });

    // Modal dialog — one call, resolves with the result string posted by the page:
    const resultJson = await ext.ui.showModalDialog(dataUrl, width, height);

    // Persistent storage:
    const dir = ext.environment.storageDirectory ?? "/tmp/fallback";
  });

  ext.ui.registerContextMenuAction("MidiClip", "Label", "myext.command");
}
```

Key points (these changed from the older 0.0.5 API):

- **Handle → object:** `ext.getObjectFromHandle(handle, Type)` (on the context directly — there is no `ext.objects` namespace).
- **Modals:** `await ext.ui.showModalDialog(url, w, h): Promise<string>`. For a long task, `ext.ui.withinProgressDialog(text, { progress }, async (update, signal) => {…})` (progress is a 0–100 percentage).
- **Context-menu scopes** are a union: `"MidiClip" | "AudioClip" | "MidiTrack" | "AudioTrack" | "ClipSlot" | "Scene" | "DrumRack" | "Simpler" | "Sample" | "ClipSlotSelection" | "AudioTrack.ArrangementSelection" | "MidiTrack.ArrangementSelection"`.
- **`NoteDescription`** is `{ pitch, startTime, duration, velocity?, muted?, probability?, velocityDeviation?, releaseVelocity?, selected? }`.
- **Device parameters** are native: `device.name`, `device.parameters`, and `DeviceParameter` with `name/min/max/isQuantized/valueItems` plus async `getValue()`/`setValue()`.
- **Not available in 1.0.0:** transport play-state (`song.isPlaying` was removed), a writable warp-marker API (`AudioClip.warpMarkers` is read-only — this is why beat-detective is analyze-only), an automation/envelope API, and a `deactivate`/dispose hook.

## Webview postMessage protocol

Modal pages return a result by posting `close_and_send`; raw JSON is dropped.

```js
function postMsg(msg) {
  const m = { method: "close_and_send", params: [JSON.stringify(msg)] };
  if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(m);
  else if (window.chrome?.webview) window.chrome.webview.postMessage(m);
}
```

`showModalDialog()` resolves with that single string. For delete-then-reopen
flows, loop on `showModalDialog()` in the command handler.

## Extension Host VM sandbox

Available: `process`, `Buffer`, `setTimeout`, `clearTimeout`, `fetch`.
Not available: `Request`, `Response`, `Headers`, `URL`, `TextEncoder`,
`TextDecoder`, `atob`, `btoa`, `setImmediate`.

Each extension's `esbuild.js` includes a polyfill banner and
`define: { global: "globalThis" }`. Native deps (lidal's `abletonlink`,
`easymidi`) are externalized by esbuild and shipped via the packer.

## Extensions

### harmonic-lens
Detects key/mode, identifies chords per bar, suggests next chords; music theory
is inlined into the webview. Command `harmonic-lens.analyze` →
"Analyze with Harmonic Lens" on **MidiClip** + **MidiTrack**. Appended chord
suggestions are written back via `clip.notes =` inside `withinTransaction`.

### groove-transplant
Extract/apply/export groove feel and build Drum Racks from audio. Context-menu
commands: Copy Groove (MidiClip), Apply Groove… (MidiClip), Extract Groove from
Audio… (AudioClip), Build Drum Rack from Audio… (AudioClip); plus a
non-context-menu `manageSamples`. Writes Live `.agr` groove files
(`agr-writer.ts`) and builds tracks/racks via the SDK.

### beat-detective
Detects transients (`detectTransients` / SuperFlux from `@arclight/core`) and
renders a waveform + grid preview. **Analyze/preview-only on SDK 1.0.0:**
`AudioClip.warpMarkers` is read-only with no setter, so the "Apply" action is
disabled with a note. Re-enable if a future SDK exposes a warp-marker writer.
Command `beat-detective.quantize` on AudioClip.

### lidal
Live-coding DSL streaming MIDI to three virtual ports (Lidal Notes / Lidal
Drums / Lidal Control); browser editor on `localhost:7654`. Patterns are
stateless `cycleN → Event[]` functions; the scheduler dispatches per cycle.
Sync sources: manual / LOM / MIDI-clock / Ableton Link. Commands:
`lidal.openEditor` (MidiClip/AudioClip/MidiTrack/AudioTrack/ClipSlot/Scene),
`lidal.autoMapDrums` (MidiClip/MidiTrack). See `lidal/README.md` for the DSL and
the per-port MIDI routing setup. CC orbits are not bakeable (no SDK automation API).

### conway-clips
Cellular-automata transforms over a pitch×time grid. Commands (all MidiClip):
Step Generation (`step`), Evolve 4 Generations (`evolve`),
Randomize (Conway) (`randomize`), Auto-Tick… (`autoTick`).

### petri
Generative/evolutionary MIDI "ecology". Commands (all MidiClip): Open Lab…
(`openLab`), Mutate… (`mutate`), Mutate Again (`mutateAgain`),
Oscillate… (`oscillate`). Note: oscillate no longer gates on transport
play-state (`song.isPlaying` was removed in 1.0.0) — it runs on its internal
interval.

## arclight-core

Pure TypeScript, no SDK dependency. Key modules: `music-theory` (`detectKey`,
`buildChordTimeline`, `suggestNextChords`), `warp-utils` (groove computation,
`transientFramesToWarpMarkers`, tempo estimation), `drum-detector` (multi-pass
voice classifier), `transient-detector` (SuperFlux onset detection, `parseWav`),
`pattern-fill`, `write-wav`, `text-utils`, `webview`. Consumed by extensions as
the workspace dependency `@arclight/core`. Some corpus/integration tests read
local audio files and **skip automatically** when those files are absent.
