import { initialize, MidiClip, type ActivationContext, type Handle, type NoteDescription } from "@ableton-extensions/sdk";

const SUBDIVISION = 0.25;  // sixteenth note in beats
const ROWS = 16;            // two octaves of scale pitches
const MAX_COLS = 32;        // cap at 2 bars of sixteenth notes
const BASE_OCTAVE = 4;      // pitches start at C4 (MIDI 60)

const SCALE_INTERVALS: Record<string, number[]> = {
  "Major":            [0, 2, 4, 5, 7, 9, 11],
  "Minor":            [0, 2, 3, 5, 7, 8, 10],
  "Dorian":           [0, 2, 3, 5, 7, 9, 10],
  "Phrygian":         [0, 1, 3, 5, 7, 8, 10],
  "Lydian":           [0, 2, 4, 6, 7, 9, 11],
  "Mixolydian":       [0, 2, 4, 5, 7, 9, 10],
  "Locrian":          [0, 1, 3, 5, 6, 8, 10],
  "Pentatonic Minor": [0, 3, 5, 7, 10],
  "Pentatonic Major": [0, 2, 4, 7, 9],
  "Blues":            [0, 3, 5, 6, 7, 10],
  "Harmonic Minor":   [0, 2, 3, 5, 7, 8, 11],
  "Melodic Minor":    [0, 2, 3, 5, 7, 9, 11],
};

// MIDI pitch = (octave + 1) * 12 + noteClass, e.g. C4 = (4+1)*12 + 0 = 60.
// Builds ROWS pitches ascending from BASE_OCTAVE, wrapping to higher octaves.
function buildPitchMap(rootNote: number, intervals: number[]): number[] {
  const pitches: number[] = [];
  let octaveOffset = 0;
  for (let idx = 0; pitches.length < ROWS; idx++) {
    if (idx > 0 && idx % intervals.length === 0) octaveOffset++;
    const pitch = (BASE_OCTAVE + 1 + octaveOffset) * 12 + rootNote + intervals[idx % intervals.length];
    pitches.push(Math.min(127, pitch));
  }
  return pitches;
}

function notesToGrid(notes: NoteDescription[], pitchMap: number[], cols: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: ROWS }, () => new Array(cols).fill(false));
  for (const note of notes) {
    // SDK returns BigInt at runtime for integer fields despite number typing
    const col = Math.round(Number(note.startTime) / SUBDIVISION) % cols;
    const row = pitchMap.indexOf(Number(note.pitch));
    if (row >= 0) grid[row][col] = true;
  }
  return grid;
}

// Standard Conway rules. Time axis (columns) wraps — the clip loops.
// Pitch axis (rows) uses a hard boundary — pitches don't wrap.
function conwayStep(grid: boolean[][]): boolean[][] {
  const rows = grid.length;
  const cols = grid[0].length;
  return grid.map((row, r) =>
    row.map((alive, c) => {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = (c + dc + cols) % cols;
          if (nr >= 0 && nr < rows && grid[nr][nc]) n++;
        }
      }
      return alive ? n === 2 || n === 3 : n === 3;
    })
  );
}

function gridToNotes(grid: boolean[][], pitchMap: number[]): NoteDescription[] {
  const notes: NoteDescription[] = [];
  grid.forEach((row, r) => {
    row.forEach((alive, c) => {
      if (alive) {
        notes.push({
          pitch: pitchMap[r],
          startTime: c * SUBDIVISION,
          duration: SUBDIVISION * 0.9,
          velocity: 100,
        });
      }
    });
  });
  return notes;
}

function randomGrid(cols: number, density = 0.3): boolean[][] {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: cols }, () => Math.random() < density)
  );
}

// Sends a JSON result back to ext.ui.showModalDialog() and closes the modal.
const SEND_FN = `
function send(data) {
  const msg = { method: 'close_and_send', params: [JSON.stringify(data)] };
  if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(msg);
  else if (window.chrome?.webview) window.chrome.webview.postMessage(msg);
}`;

function buildAutoTickModal(isActive: boolean, intervalMs: number): string {
  const PRESETS = [250, 500, 1000, 2000, 4000, 8000];
  const isCustom = !PRESETS.includes(intervalMs);
  const customVal = isActive && isCustom ? intervalMs : 1000;

  const options = PRESETS.map(ms => {
    const label = ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
    const sel = !isCustom && ms === intervalMs ? " selected" : "";
    return `<option value="${ms}"${sel}>${label}</option>`;
  }).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;font-size:13px;background:#1a1a1a;color:#e0e0e0;display:flex;flex-direction:column;height:100vh}
.hdr{background:#252525;border-bottom:1px solid #333;padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#777}
.body{flex:1;padding:20px 16px;display:flex;flex-direction:column;gap:14px}
.status{padding:9px 12px;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:8px}
.active{background:#1a3318;border:1px solid #2d5a28;color:#72c46a}
.idle{background:#222;border:1px solid #333;color:#666}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex-shrink:0}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#888}
select,input[type=number]{background:#2a2a2a;border:1px solid #444;color:#d0d0d0;padding:7px 10px;border-radius:4px;font-size:13px;width:100%;appearance:none;-webkit-appearance:none}
select:focus,input:focus{outline:none;border-color:#555}
.custom-row{display:none}
.custom-row.visible{display:flex;flex-direction:column;gap:6px}
.ftr{padding:10px 16px;border-top:1px solid #252525;display:flex;gap:8px;justify-content:flex-end}
button{border:1px solid #444;color:#ccc;background:#2a2a2a;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:12px}
button:hover{background:#333}
.stop-btn{background:#3a1a1a;border-color:#6a2a2a;color:#e08080}
.stop-btn:hover{background:#4a2020}
.start-btn{background:#1a3a1a;border-color:#2a6a2a;color:#80e080}
.start-btn:hover{background:#1e4a1e}
</style></head>
<body>
<div class="hdr">Conway Clips — Auto-Tick</div>
<div class="body">
  <div class="status ${isActive ? "active" : "idle"}">
    <span class="dot"></span>
    ${isActive ? `Ticking every ${intervalMs < 1000 ? intervalMs + " ms" : intervalMs / 1000 + " s"}` : "Idle"}
  </div>
  <div class="field">
    <label>Tick Interval</label>
    <select id="preset" onchange="onPreset(this.value)">
      ${options}
      <option value="custom"${isCustom ? " selected" : ""}>Custom…</option>
    </select>
  </div>
  <div class="custom-row field${isCustom ? " visible" : ""}" id="customRow">
    <label>Interval (ms)</label>
    <input type="number" id="customMs" value="${customVal}" min="100" max="60000" step="100">
  </div>
</div>
<div class="ftr">
  ${isActive ? `<button class="stop-btn" onclick="send({action:'stop'})">Stop</button>` : ""}
  <button onclick="send({action:'cancel'})">Cancel</button>
  <button class="start-btn" onclick="doStart()">Start</button>
</div>
<script>
${SEND_FN}
function onPreset(v) {
  document.getElementById('customRow').classList.toggle('visible', v === 'custom');
}
function doStart() {
  const sel = document.getElementById('preset').value;
  const ms = sel === 'custom'
    ? parseInt(document.getElementById('customMs').value, 10)
    : parseInt(sel, 10);
  if (!ms || ms < 100) return;
  send({ action: 'start', intervalMs: ms });
}
</script>
</body></html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function activate(context: ActivationContext): void {
  const ext = initialize(context, "1.0.0");
  console.log("[ConwayClips] Starting...");

  // Auto-tick state
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let tickClip: MidiClip<"1.0.0"> | null = null;
  let tickIntervalMs = 2000;

  function getScaleInfo() {
    const song = ext.application.song;
    const rootNote = Number(song.rootNote);   // SDK returns BigInt at runtime
    const scaleName = song.scaleName;
    const intervals = SCALE_INTERVALS[scaleName] ?? SCALE_INTERVALS["Major"]!;
    return { rootNote, scaleName, intervals };
  }

  function clipCols(clip: MidiClip<"1.0.0">, notes: NoteDescription[]): number {
    let end = Number(clip.loopEnd);
    if (end <= 0 && notes.length > 0)
      end = Math.ceil(Math.max(...notes.map(n => Number(n.startTime) + Number(n.duration))) / 4) * 4;
    if (end <= 0) end = 4;
    return Math.min(Math.round(end / SUBDIVISION), MAX_COLS);
  }

  function stepClip(clip: MidiClip<"1.0.0">) {
    const notes = clip.notes;
    const cols = clipCols(clip, notes);
    if (cols === 0) return;
    const { rootNote, intervals } = getScaleInfo();
    const pitchMap = buildPitchMap(rootNote, intervals);
    const grid = notesToGrid(notes, pitchMap, cols);
    ext.withinTransaction(() => {
      clip.notes = gridToNotes(conwayStep(grid), pitchMap);
    });
  }

  function startTick(clip: MidiClip<"1.0.0">, intervalMs: number) {
    stopTick();
    tickClip = clip;
    tickIntervalMs = intervalMs;
    tickTimer = setInterval(() => {
      if (!tickClip) return;
      try {
        stepClip(tickClip);
      } catch (err) {
        console.error("[ConwayClips] Auto-tick error — stopping:", err);
        stopTick();
      }
    }, intervalMs);
    console.log(`[ConwayClips] Auto-tick started — every ${intervalMs}ms`);
  }

  function stopTick() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
      tickClip = null;
      console.log("[ConwayClips] Auto-tick stopped");
    }
  }

  // ── STEP ─────────────────────────────────────────────────────────────────────

  ext.commands.registerCommand("conway-clips.step", async (args: unknown) => {
    try {
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
      const notes = clip.notes;
      const cols = clipCols(clip, notes);
      if (cols === 0) return;
      const { rootNote, scaleName, intervals } = getScaleInfo();
      const pitchMap = buildPitchMap(rootNote, intervals);
      const grid = notesToGrid(notes, pitchMap, cols);
      console.log(`[ConwayClips] Step — ${scaleName} root=${rootNote} cols=${cols}`);
      ext.withinTransaction(() => {
        clip.notes = gridToNotes(conwayStep(grid), pitchMap);
      });
    } catch (err) {
      console.error("[ConwayClips] Step error:", err);
    }
  });

  // ── EVOLVE 4 ─────────────────────────────────────────────────────────────────

  ext.commands.registerCommand("conway-clips.evolve", async (args: unknown) => {
    try {
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
      const notes = clip.notes;
      const cols = clipCols(clip, notes);
      const { rootNote, scaleName, intervals } = getScaleInfo();
      const pitchMap = buildPitchMap(rootNote, intervals);
      let grid = notesToGrid(notes, pitchMap, cols);
      for (let i = 0; i < 4; i++) grid = conwayStep(grid);
      console.log(`[ConwayClips] Evolve 4 — ${scaleName} root=${rootNote} cols=${cols}`);
      ext.withinTransaction(() => {
        clip.notes = gridToNotes(grid, pitchMap);
      });
    } catch (err) {
      console.error("[ConwayClips] Evolve error:", err);
    }
  });

  // ── RANDOMIZE ────────────────────────────────────────────────────────────────

  ext.commands.registerCommand("conway-clips.randomize", async (args: unknown) => {
    try {
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
      const cols = clipCols(clip, clip.notes);
      const { rootNote, scaleName, intervals } = getScaleInfo();
      const pitchMap = buildPitchMap(rootNote, intervals);
      console.log(`[ConwayClips] Randomize — ${scaleName} root=${rootNote} cols=${cols}`);
      ext.withinTransaction(() => {
        clip.notes = gridToNotes(randomGrid(cols), pitchMap);
      });
    } catch (err) {
      console.error("[ConwayClips] Randomize error:", err);
    }
  });

  // ── AUTO-TICK ────────────────────────────────────────────────────────────────

  ext.commands.registerCommand("conway-clips.autoTick", async (args: unknown) => {
    try {
      // Resolve while the command-arg handle is still valid (before any await)
      const clip = ext.getObjectFromHandle(args as Handle, MidiClip);

      const isActive = tickTimer !== null;
      const url = buildAutoTickModal(isActive, tickIntervalMs);
      const resultJson = await ext.ui.showModalDialog(url, 380, 260);
      if (!resultJson) return;

      const result = JSON.parse(resultJson) as { action: string; intervalMs?: number };

      if (result.action === "start" && result.intervalMs) {
        startTick(clip, result.intervalMs);
      } else if (result.action === "stop") {
        stopTick();
      }
    } catch (err) {
      console.error("[ConwayClips] Auto-tick config error:", err);
    }
  });

  // ── CONTEXT MENU ─────────────────────────────────────────────────────────────

  ext.ui.registerContextMenuAction("MidiClip", "Step Generation",      "conway-clips.step");
  ext.ui.registerContextMenuAction("MidiClip", "Evolve 4 Generations", "conway-clips.evolve");
  ext.ui.registerContextMenuAction("MidiClip", "Randomize (Conway)",   "conway-clips.randomize");
  ext.ui.registerContextMenuAction("MidiClip", "Auto-Tick\u2026",      "conway-clips.autoTick");

  console.log("[ConwayClips] Ready — right-click any MIDI clip");
  process.on("exit", () => {
    stopTick();
    console.log("[ConwayClips] Unloaded");
  });
}
