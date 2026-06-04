import type { ChordInfo, KeyInfo, MidiNote } from "@arclight/core";

const CHORD_COLORS: Record<string, string> = {
  maj:  "#2a6db5",
  min:  "#7b3fa0",
  dom7: "#c75c00",
  maj7: "#1a8a6e",
  min7: "#6b4a9e",
  dim:  "#8a3030",
  aug:  "#7a6800",
  sus4: "#2a7a7a",
  sus2: "#2a6060",
};

export function buildAnalysisWebview(
  key: KeyInfo,
  chords: ChordInfo[],
  suggestions: ChordInfo[],
  maxBeat: number,
  rawNotes: Array<{ pitch: number; startTime: number; duration: number; velocity?: number }>,
): string {
  const initData = JSON.stringify({ key, chords, suggestions, maxBeat, notes: rawNotes });
  const chordColorsJson = JSON.stringify(CHORD_COLORS);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; background: #1a1a1a; color: #e0e0e0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    .header { background: #252525; border-bottom: 1px solid #333; padding: 10px 16px; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: #999; flex-shrink: 0; }
    #key-bar { display:flex; align-items:center; gap:12px; padding:10px 16px; background:#222; border-bottom:1px solid #333; flex-shrink:0; }
    .key-label { font-size:14px; } .key-label strong { color:#e05a00; }
    .conf-label { font-size:11px; color:#666; }
    #chord-chart { display:flex; align-items:stretch; height:110px; background:#111; border-bottom:1px solid #333; overflow-x:auto; flex-shrink:0; }
    .chord-block { display:flex; flex-direction:column; justify-content:center; align-items:center; min-width:60px; border-right:1px solid #000; transition:filter .15s; }
    .chord-block:hover { filter:brightness(1.2); }
    .chord-name { font-size:16px; font-weight:700; color:rgba(255,255,255,.9); }
    .chord-beat { font-size:10px; color:rgba(255,255,255,.4); margin-top:4px; }
    #suggestions-bar { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#1a1a1a; border-bottom:1px solid #333; flex-shrink:0; }
    .sug-label { font-size:11px; color:#666; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
    #suggestion-buttons { display:flex; gap:8px; }
    .sug-btn { background:#1a1a1a; border:1px solid #555; color:#ccc; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600; transition:background .1s; }
    .sug-btn:hover { background:#2a2a2a; color:#fff; }
    #footer { padding:10px 16px; display:flex; justify-content:flex-end; flex-shrink:0; }
    button.done { background:#333; border:1px solid #444; color:#e0e0e0; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px; }
    button.done:hover { background:#444; }
  </style>
</head>
<body>
  <div class="header">Harmonic Lens</div>
  <div id="key-bar">
    <span class="key-label">Key: <strong id="key-name"></strong></span>
    <span class="conf-label" id="key-conf"></span>
  </div>
  <div id="chord-chart"></div>
  <div id="suggestions-bar">
    <span class="sug-label">Try next →</span>
    <div id="suggestion-buttons"></div>
  </div>
  <div id="footer">
    <button class="done" onclick="finish()">Done</button>
  </div>
  <script>
// ── postMessage bridge ────────────────────────────────────────────────────────
function postMessage(msg) {
  const message = { method: "close_and_send", params: [JSON.stringify(msg)] };
  if (window.webkit?.messageHandlers?.live) {
    window.webkit.messageHandlers.live.postMessage(message);
  } else if (window.chrome?.webview) {
    window.chrome.webview.postMessage(message);
  }
}

// ── inlined music theory ──────────────────────────────────────────────────────
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SCALE_PATTERNS = {
  major:[0,2,4,5,7,9,11], minor:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10],
  mixolydian:[0,2,4,5,7,9,10], phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11], locrian:[0,1,3,5,6,8,10]
};
const CHORD_TYPES = {
  maj:[0,4,7], min:[0,3,7], dim:[0,3,6], aug:[0,4,8], sus2:[0,2,7], sus4:[0,5,7],
  dom7:[0,4,7,10], maj7:[0,4,7,11], min7:[0,3,7,10], dim7:[0,3,6,9], hdim7:[0,3,6,10]
};
const CHORD_DISPLAY = {
  maj:"", min:"m", dom7:"7", maj7:"maj7", min7:"m7",
  dim:"dim", aug:"aug", sus4:"sus4", sus2:"sus2", dim7:"dim7", hdim7:"ø7"
};
const CHORD_COLORS = ${chordColorsJson};

function detectKey(notes) {
  const w = new Array(12).fill(0);
  for (const n of notes) w[n.pitch % 12] += ((n.velocity||80)/127) * n.duration;
  let best = { score:-Infinity, root:0, mode:"major" };
  for (const [mode, pat] of Object.entries(SCALE_PATTERNS)) {
    for (let root = 0; root < 12; root++) {
      let score = 0;
      for (const d of pat) score += w[(root+d)%12];
      for (let pc = 0; pc < 12; pc++) if (!pat.map(d=>(root+d)%12).includes(pc)) score -= w[pc]*0.5;
      if (score > best.score) best = { score, root, mode };
    }
  }
  const total = w.reduce((a,b)=>a+b,0);
  return { root:best.root, rootName:NOTE_NAMES[best.root], mode:best.mode,
    modeName:best.mode.charAt(0).toUpperCase()+best.mode.slice(1),
    scale:SCALE_PATTERNS[best.mode].map(d=>(best.root+d)%12),
    confidence: total>0 ? Math.min(best.score/total,1) : 0 };
}

function identifyChord(notes, beatStart, beatEnd) {
  const win = notes.filter(n => n.startTime < beatEnd && n.startTime+n.duration > beatStart);
  if (win.length < 2) return null;
  const pcs = new Set(win.map(n=>n.pitch%12));
  const arr = [...pcs].sort((a,b)=>a-b);
  let best = { score:-1, root:arr[0], type:"maj" };
  for (const [type, intervals] of Object.entries(CHORD_TYPES)) {
    for (const root of arr) {
      const cPCs = intervals.map(i=>(root+i)%12);
      const matches = cPCs.filter(pc=>pcs.has(pc)).length;
      const score = matches / Math.max(cPCs.length, pcs.size);
      if (score > best.score) best = { score, root, type };
    }
  }
  return { root:best.root, rootName:NOTE_NAMES[best.root], type:best.type,
    name: NOTE_NAMES[best.root]+(CHORD_DISPLAY[best.type]??best.type),
    notes: CHORD_TYPES[best.type].map(i=>(best.root+i)%12),
    beatStart, beatEnd, confidence:best.score };
}

function buildChordTimeline(notes, barLen=4) {
  if (!notes.length) return [];
  const maxBeat = Math.max(...notes.map(n=>n.startTime+n.duration));
  const out = [];
  for (let bar=0; bar < Math.ceil(maxBeat/barLen); bar++) {
    const c = identifyChord(notes, bar*barLen, (bar+1)*barLen);
    if (c) out.push(c);
  }
  return out;
}

function suggestNextChords(key, lastChord) {
  const scaleRoots = SCALE_PATTERNS[key.mode].map(d=>(key.root+d)%12);
  const major = key.mode==="major" ? [0,3,4] : [2,5,6];
  const diatonic = scaleRoots.map((root,i) => {
    const type = major.includes(i) ? "maj" : "min";
    return { root, rootName:NOTE_NAMES[root], type, name:NOTE_NAMES[root]+(CHORD_DISPLAY[type]??""),
      notes:CHORD_TYPES[type].map(iv=>(root+iv)%12), beatStart:0, beatEnd:4, confidence:1 };
  });
  if (!lastChord) return diatonic.slice(0,4);
  return diatonic.filter(c=>c.root!==lastChord.root)
    .sort((a,b) => b.notes.filter(n=>lastChord.notes.includes(n)).length
                 - a.notes.filter(n=>lastChord.notes.includes(n)).length)
    .slice(0,4);
}

function chordToNotes(chord, beatStart, duration=4, octave=4, velocity=80) {
  return chord.notes.map((pc,i) => {
    let pitch = pc + (octave + Math.floor(i/4))*12;
    while (pitch < 48) pitch += 12;
    while (pitch > 84) pitch -= 12;
    return { pitch, startTime:beatStart, duration, velocity };
  });
}

// ── state ─────────────────────────────────────────────────────────────────────
const init = ${initData};
let currentNotes = init.notes;

function render() {
  const notes = currentNotes;
  const key = detectKey(notes);
  const chords = buildChordTimeline(notes);
  const maxBeat = notes.length ? Math.max(...notes.map(n=>n.startTime+n.duration)) : 4;
  const lastChord = chords[chords.length-1] ?? null;
  const suggestions = suggestNextChords(key, lastChord);
  const totalBeats = Math.max(maxBeat, chords.reduce((m,c)=>Math.max(m,c.beatEnd),0));

  // Key bar
  document.getElementById('key-name').textContent = key.rootName + ' ' + key.modeName;
  document.getElementById('key-conf').textContent = Math.round(key.confidence*100) + '% match';

  // Chord chart
  const chart = document.getElementById('chord-chart');
  chart.innerHTML = '';
  chords.forEach(chord => {
    const block = document.createElement('div');
    block.className = 'chord-block';
    const pct = ((chord.beatEnd - chord.beatStart) / totalBeats * 100).toFixed(1);
    block.style.width = pct + '%';
    block.style.background = CHORD_COLORS[chord.type] || '#444';
    block.innerHTML = '<span class="chord-name">'+chord.name+'</span>'
      +'<span class="chord-beat">bar '+Math.floor(chord.beatStart/4+1)+'</span>';
    chart.appendChild(block);
  });

  // Suggestions
  const sugBar = document.getElementById('suggestion-buttons');
  sugBar.innerHTML = '';
  suggestions.forEach(chord => {
    const btn = document.createElement('button');
    btn.className = 'sug-btn';
    btn.style.borderColor = CHORD_COLORS[chord.type] || '#555';
    btn.textContent = chord.name;
    btn.onclick = () => {
      const newNotes = chordToNotes(chord, maxBeat, 4, 4, 80);
      currentNotes = [...currentNotes, ...newNotes];
      render();
    };
    sugBar.appendChild(btn);
  });
}

function finish() {
  postMessage({ type: 'done', notes: currentNotes });
}

render();
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
