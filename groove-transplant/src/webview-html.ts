import type { GrooveProfile, FrequencyBand } from "@arclight/core";

// ── TypeScript-level escaping helpers ────────────────────────────────────────
// These are used for compile-time interpolation into HTML template strings.
// They are SEPARATE from the client-side `escHtml`/`escJs` functions defined
// inside webview <script> blocks.

function tsEscHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tsEscJs(value: unknown): string {
  // JSON.stringify does not escape "</" sequences — a value containing
  // "</script>" would break out of a <script> block. Replace "</" with "<\/".
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

// ── shared postMessage (inlined in every webview) ────────────────────────────
const POST_MESSAGE_FN = `
function postMsg(msg) {
  var m = { method: "close_and_send", params: [JSON.stringify(msg)] };
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live)
    window.webkit.messageHandlers.live.postMessage(m);
  else if (window.chrome && window.chrome.webview)
    window.chrome.webview.postMessage(m);
}`.trim();

// ── shared dark-theme CSS ────────────────────────────────────────────────────
const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
  background: #1a1a1a; color: #e0e0e0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.header { background: #252525; border-bottom: 1px solid #333; padding: 10px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: #777; flex-shrink: 0; }
.footer { flex-shrink: 0; padding: 10px 16px; border-top: 1px solid #2a2a2a;
  display: flex; justify-content: flex-end; gap: 8px; background: #1a1a1a; }
button { background: #2e2e2e; border: 1px solid #444; color: #d0d0d0; padding: 6px 16px;
  border-radius: 4px; cursor: pointer; font-size: 12px; transition: background .1s; }
button:hover { background: #3a3a3a; color: #fff; }
button.primary { background: #c75a00; border-color: #c75a00; color: #fff; }
button.primary:hover { background: #e06800; border-color: #e06800; }
button:disabled { opacity: .4; cursor: default; }
`.trim();

// ── resolution options ────────────────────────────────────────────────────────
const RES_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1.0,       label: "1/4"   },
  { value: 0.5,       label: "1/8"   },
  { value: 0.25,      label: "1/16"  },
  { value: 0.125,     label: "1/32"  },
  { value: 1 / 3,     label: "1/8T"  },
  { value: 1 / 6,     label: "1/16T" },
];

function resLabel(r: number): string {
  const found = RES_OPTIONS.find(o => Math.abs(o.value - r) < 1e-9);
  return found ? found.label : `${r.toFixed(4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract / Copy Groove confirmation webview
// ─────────────────────────────────────────────────────────────────────────────

export function buildExtractWebview(profile: GrooveProfile, detectedResolution: number): string {
  const profileJson = tsEscJs(profile);

  // Bar chart of timing offsets
  const offsets  = profile.offsets.slice(0, 32);
  const n        = offsets.length;
  const W        = 620, H = 64;
  const barW     = (W / n) * 0.72;
  const gapW     = (W / n) * 0.28;
  const mid      = H / 2;
  const maxOff   = Math.max(...offsets.map(Math.abs), 0.001);
  const scale    = (mid - 6) / maxOff;
  const barsSvg  = offsets.map((off, i) => {
    const x  = (i / n) * W + gapW / 2;
    const h  = Math.max(Math.abs(off) * scale, 1);
    const y  = off >= 0 ? mid - h : mid;
    const c  = off > 0.002 ? "#c75a00" : off < -0.002 ? "#2a6db5" : "#555";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${c}" rx="1"/>`;
  }).join("");

  const swingPct = Math.round(Math.max(0, profile.swingAmount - 0.5) * 200);
  const maxOffMs = Math.round(Math.max(...offsets.map(Math.abs)) * 500);

  // Resolution dropdown — pre-select the auto-detected value
  const resOptions = RES_OPTIONS.map(opt => {
    const sel = Math.abs(opt.value - detectedResolution) < 1e-9 ? " selected" : "";
    return `<option value="${opt.value}"${sel}>${opt.label}</option>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
.body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
.stats { display: flex; gap: 28px; align-items: flex-end; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #666; }
.stat-val { font-size: 20px; font-weight: 700; color: #c75a00; line-height: 1; }
select.stat-sel { background: #222; border: 1px solid #444; color: #c75a00; padding: 3px 8px;
  border-radius: 4px; font-size: 16px; font-weight: 700; outline: none; cursor: pointer; }
select.stat-sel:focus { border-color: #c75a00; }
.viz { background: #111; border: 1px solid #252525; border-radius: 4px; padding: 8px 10px; }
.viz-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin-bottom: 4px; }
.name-row { display: flex; align-items: center; gap: 10px; }
.name-row label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
input[type=text] { flex: 1; background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 7px 10px; border-radius: 4px; font-size: 13px; outline: none; }
input[type=text]:focus { border-color: #c75a00; }
</style>
</head>
<body>
<div class="header">Groove Transplant — Copy Groove</div>
<div class="body">
  <div class="stats">
    <div class="stat">
      <div class="stat-lbl">Resolution</div>
      <select class="stat-sel" id="res-select">${resOptions}</select>
    </div>
    <div class="stat"><div class="stat-lbl">Swing</div><div class="stat-val">${swingPct}%</div></div>
    <div class="stat"><div class="stat-lbl">Max Offset</div><div class="stat-val">~${maxOffMs}ms</div></div>
    <div class="stat"><div class="stat-lbl">Slots</div><div class="stat-val">${profile.offsets.length}</div></div>
  </div>
  <div class="viz">
    <div class="viz-lbl">Timing deviations per slot (orange = late, blue = early)</div>
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#333" stroke-width="1"/>
      ${barsSvg}
    </svg>
  </div>
  <div class="name-row">
    <label>Name</label>
    <input type="text" id="name-input" value="${tsEscHtml(profile.name)}" placeholder="Groove name…" autofocus>
  </div>
</div>
<div class="footer">
  <button onclick="postMsg({action:'discard'})">Discard</button>
  <button class="primary" onclick="doSave()">Save Groove</button>
</div>
<script>
${POST_MESSAGE_FN}
var profile = ${profileJson};
function doSave() {
  var name = document.getElementById('name-input').value.trim() || profile.name;
  var resEl = document.getElementById('res-select');
  var resolution = resEl ? parseFloat(resEl.value) : profile.resolution;
  postMsg({ action: 'save', name: name, resolution: resolution });
}
document.getElementById('name-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSave();
  if (e.key === 'Escape') postMsg({ action: 'discard' });
});
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply Groove picker webview
// ─────────────────────────────────────────────────────────────────────────────

export function buildApplyWebview(
  grooves: GrooveProfile[],
  targetNotes: Array<{ pitch: number; startTime: number; duration: number; velocity: number }>,
): string {
  const groovesJson     = tsEscJs(grooves);
  const targetNotesJson = tsEscJs(targetNotes);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
.body { flex: 1; display: flex; overflow: hidden; }
.sidebar { width: 210px; border-right: 1px solid #2a2a2a; overflow-y: auto; flex-shrink: 0; background: #171717; }
.groove-item { padding: 9px 12px; cursor: pointer; border-bottom: 1px solid #222;
  user-select: none; display: flex; align-items: center; gap: 6px; }
.groove-item:hover { background: #222; }
.groove-item.selected { background: #222; border-left: 2px solid #c75a00; padding-left: 10px; }
.groove-info { flex: 1; min-width: 0; }
.groove-name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.groove-meta { font-size: 10px; color: #555; margin-top: 1px; }
.del-btn { background: none; border: none; color: #555; font-size: 15px; padding: 0 3px;
  line-height: 1; cursor: pointer; flex-shrink: 0; transition: color .1s; }
.del-btn:hover { color: #e05a00; background: none; border: none; }
.detail { flex: 1; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.detail-empty { color: #444; font-size: 12px; padding: 20px; }
.viz { background: #111; border: 1px solid #252525; border-radius: 4px; padding: 8px; flex-shrink: 0; }
.viz-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin-bottom: 4px; }
.stats-row { display: flex; gap: 18px; flex-shrink: 0; }
.stat { display: flex; flex-direction: column; gap: 1px; }
.stat-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #555; }
.stat-val { font-size: 15px; font-weight: 700; color: #c75a00; }
.ctrl-group { flex-shrink: 0; }
.ctrl-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #555;
  margin-bottom: 4px; display: flex; justify-content: space-between; }
input[type=range] { width: 100%; accent-color: #c75a00; }
.empty-state { padding: 16px; color: #555; font-size: 12px; line-height: 1.6; }
</style>
</head>
<body>
<div class="header">Groove Transplant — Apply Groove</div>
<div class="body">
  <div class="sidebar" id="sidebar"></div>
  <div class="detail" id="detail"><div class="detail-empty">Select a groove</div></div>
</div>
<div class="footer">
  <button onclick="postMsg({action:'cancel'})">Cancel</button>
  <button class="primary" id="apply-btn" disabled onclick="doApply()">Apply Groove</button>
</div>
<script>
${POST_MESSAGE_FN}
var grooves = ${groovesJson};
var targetNotes = ${targetNotesJson};
var selectedId = grooves.length > 0 ? grooves[0].id : null;

// ── sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  var el = document.getElementById('sidebar');
  if (!grooves.length) {
    el.innerHTML = '<div class="empty-state">No grooves saved.<br>Right-click a MIDI clip and choose <em>Copy Groove</em> first.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < grooves.length; i++) {
    var g = grooves[i];
    var sel = g.id === selectedId ? ' selected' : '';
    var swing = Math.round(Math.max(0, g.swingAmount - 0.5) * 200);
    var date = new Date(g.createdAt).toLocaleDateString();
    html += '<div class="groove-item' + sel + '" data-id="' + escHtml(g.id) + '">'
          +   '<div class="groove-info">'
          +     '<div class="groove-name">' + escHtml(g.name) + '</div>'
          +     '<div class="groove-meta">Swing ' + swing + '% &middot; ' + date + '</div>'
          +   '</div>'
          +   '<button class="del-btn" data-del="' + escHtml(g.id) + '" title="Delete">&#215;</button>'
          + '</div>';
  }
  el.innerHTML = html;
}

document.getElementById('sidebar').addEventListener('click', function(e) {
  var delId = e.target.getAttribute('data-del');
  if (delId) { e.stopPropagation(); postMsg({ action: 'delete', grooveId: delId }); return; }
  var item = e.target.closest('[data-id]');
  if (item) selectGroove(item.getAttribute('data-id'));
});

// ── detail pane ───────────────────────────────────────────────────────────────
function svgBars(offsets, w, h) {
  var n = offsets.length;
  var bw = (w / n) * 0.7, gap = (w / n) * 0.3;
  var mid = h / 2;
  var maxO = 0.001;
  for (var i = 0; i < offsets.length; i++) if (Math.abs(offsets[i]) > maxO) maxO = Math.abs(offsets[i]);
  var sc = (mid - 4) / maxO;
  var out = '';
  for (var i = 0; i < offsets.length; i++) {
    var o = offsets[i];
    var x = (i / n) * w + gap / 2;
    var hh = Math.max(Math.abs(o) * sc, 1);
    var y = o >= 0 ? mid - hh : mid;
    var c = o > 0.002 ? '#c75a00' : o < -0.002 ? '#2a6db5' : '#555';
    out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + c + '" rx="1"/>';
  }
  return out;
}

function renderDetail(g) {
  var slots = g.offsets.slice(0, 32);
  var W = 460, H = 56;
  var bars = svgBars(slots, W, H);
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ' + W + ' ' + H + '">'
    + '<line x1="0" y1="' + (H/2) + '" x2="' + W + '" y2="' + (H/2) + '" stroke="#333" stroke-width="1"/>'
    + bars + '</svg>';

  var maxOff = 0;
  for (var i = 0; i < g.offsets.length; i++) if (Math.abs(g.offsets[i]) > maxOff) maxOff = Math.abs(g.offsets[i]);
  var maxMs = Math.round(maxOff * 500);
  var resLbl = '${resLabel(0.25)}';
  for (var j = 0; j < resOptions.length; j++) {
    if (Math.abs(resOptions[j].value - g.resolution) < 1e-9) { resLbl = resOptions[j].label; break; }
  }

  document.getElementById('detail').innerHTML =
    '<div class="stats-row">'
    + '<div class="stat"><div class="stat-lbl">Swing</div><div class="stat-val">' + Math.round(Math.max(0, g.swingAmount - 0.5) * 200) + '%</div></div>'
    + '<div class="stat"><div class="stat-lbl">Resolution</div><div class="stat-val">' + resLbl + '</div></div>'
    + '<div class="stat"><div class="stat-lbl">Max Offset</div><div class="stat-val">~' + maxMs + 'ms</div></div>'
    + '<div class="stat"><div class="stat-lbl">Slots</div><div class="stat-val">' + g.offsets.length + '</div></div>'
    + '</div>'
    + '<div class="viz"><div class="viz-lbl">Timing deviations (orange=late, blue=early)</div>' + svg + '</div>'
    + '<div class="ctrl-group"><div class="ctrl-lbl"><span>Timing Strength</span><span id="timing-val">100%</span></div>'
    + '<input type="range" id="timing-strength" min="0" max="100" value="100" oninput="updateTiming(this.value)"></div>'
    + '<div class="ctrl-group"><div class="ctrl-lbl"><span>Velocity Strength</span><span id="vel-val">0%</span></div>'
    + '<input type="range" id="vel-strength" min="0" max="100" value="0" oninput="updateVel(this.value)"></div>'
    + '<div class="viz" id="preview-wrap"><div class="viz-lbl">Preview — note positions before / after</div>'
    + '<div id="preview-svg"></div></div>';

  renderPreview();
}

// ── slider callbacks (avoid inline quotes) ────────────────────────────────────
function updateTiming(v) {
  var el = document.getElementById('timing-val');
  if (el) el.textContent = v + '%';
  renderPreview();
}
function updateVel(v) {
  var el = document.getElementById('vel-val');
  if (el) el.textContent = v + '%';
  renderPreview();
}

// ── preview strip ─────────────────────────────────────────────────────────────
// Two-row layout: "before" ticks on top row, "after" ticks on bottom row,
// thin diagonal lines connecting each note's original → grooved position.
// Tick height is proportional to velocity: height = 4 + (velocity / 127) * 10
function renderPreview() {
  var wrap = document.getElementById('preview-svg');
  if (!wrap || !selectedId) return;
  var g = null;
  for (var i = 0; i < grooves.length; i++) if (grooves[i].id === selectedId) { g = grooves[i]; break; }
  if (!g || !targetNotes.length) { wrap.innerHTML = ''; return; }

  var strengthEl = document.getElementById('timing-strength');
  var strength = strengthEl ? parseInt(strengthEl.value) / 100 : 1;
  var velStrengthEl = document.getElementById('vel-strength');
  var velStrength = velStrengthEl ? parseInt(velStrengthEl.value) / 100 : 0;

  var maxBeat = 0;
  for (var i = 0; i < targetNotes.length; i++) {
    var end = targetNotes[i].startTime + targetNotes[i].duration;
    if (end > maxBeat) maxBeat = end;
  }
  if (maxBeat <= 0) { wrap.innerHTML = ''; return; }

  // Compute mean velocity for the applyVelocityGroove formula
  var meanVel = 0;
  for (var i = 0; i < targetNotes.length; i++) meanVel += (targetNotes[i].velocity || 64);
  meanVel /= targetNotes.length;

  var VW = 460, VH = 64;
  var pad = 6;
  var usable = VW - pad * 2;
  // Row centres: before=14, after=50; divider=32
  var Y_BEFORE = 14, Y_AFTER = 50, Y_DIV = 32;

  // Beat grid lines
  var grid = '';
  var numBeats = Math.ceil(maxBeat);
  for (var b = 0; b <= numBeats; b++) {
    var gx = (pad + (b / maxBeat) * usable).toFixed(1);
    grid += '<line x1="' + gx + '" y1="4" x2="' + gx + '" y2="' + (VH - 4) + '" stroke="#1e1e1e" stroke-width="1"/>';
  }

  // Compute raw grooved positions
  var rawTimes = [];
  for (var i = 0; i < targetNotes.length; i++) {
    var note = targetNotes[i];
    var gridPos = Math.round(note.startTime / g.resolution);
    var idx = gridPos % g.offsets.length;
    var gridTime = gridPos * g.resolution;
    var groovedTime = gridTime + g.offsets[idx];
    rawTimes.push(Math.max(0, note.startTime + (groovedTime - note.startTime) * strength));
  }

  // De-collision: same MIN_GAP logic as applyGrooveToNotes in warp-utils.ts
  var MIN_GAP = 0.01;
  var indexed = rawTimes.map(function(pos, i) { return { pos: pos, i: i }; });
  indexed.sort(function(a, b) { return a.pos - b.pos; });
  var cursor = -Infinity;
  for (var k = 0; k < indexed.length; k++) {
    if (indexed[k].pos < cursor) indexed[k].pos = cursor;
    cursor = indexed[k].pos + MIN_GAP;
  }
  var newTimes = new Array(targetNotes.length);
  var collided = new Array(targetNotes.length).fill(false);
  for (var k = 0; k < indexed.length; k++) {
    newTimes[indexed[k].i] = indexed[k].pos;
    if (Math.abs(indexed[k].pos - rawTimes[indexed[k].i]) > 0.001) collided[indexed[k].i] = true;
  }

  var marks = '';
  for (var i = 0; i < targetNotes.length; i++) {
    var note = targetNotes[i];
    var origVel = note.velocity || 64;
    var gridPos = Math.round(note.startTime / g.resolution);

    // Compute new velocity using applyVelocityGroove formula
    var newVel = origVel;
    if (velStrength > 0 && g.velocityOffsets && g.velocityOffsets.length > 0) {
      var velIdx = gridPos % g.velocityOffsets.length;
      newVel = origVel + g.velocityOffsets[velIdx] * meanVel * velStrength;
      newVel = Math.max(1, Math.min(127, Math.round(newVel)));
    }

    // Tick heights proportional to velocity
    var beforeH = 4 + (origVel / 127) * 10;
    var afterH  = 4 + (newVel  / 127) * 10;

    var newTime = newTimes[i];
    var ox = (pad + (note.startTime / maxBeat) * usable).toFixed(1);
    var nx = (pad + (newTime        / maxBeat) * usable).toFixed(1);
    var moved = Math.abs(newTime - note.startTime) > 0.002;

    // Connector line (only when note actually moves)
    if (moved) {
      marks += '<line x1="' + ox + '" y1="' + (Y_BEFORE + beforeH/2).toFixed(1) + '" x2="' + nx + '" y2="' + (Y_AFTER - afterH/2).toFixed(1) + '" stroke="#444" stroke-width="0.8"/>';
    }
    // Before tick (gray), velocity-proportional height
    marks += '<line x1="' + ox + '" y1="' + (Y_BEFORE - beforeH/2).toFixed(1) + '" x2="' + ox + '" y2="' + (Y_BEFORE + beforeH/2).toFixed(1) + '" stroke="#666" stroke-width="1.5"/>';
    // Ghost tick in AFTER row: original velocity height, faint — shows how much vel groove changed things
    if (velStrength > 0) {
      marks += '<line x1="' + nx + '" y1="' + (Y_AFTER - beforeH/2).toFixed(1) + '" x2="' + nx + '" y2="' + (Y_AFTER + beforeH/2).toFixed(1) + '" stroke="#555" stroke-width="1" opacity="0.35"/>';
    }
    // After tick: amber if collision-nudged, orange if moved, gray if unchanged
    var afterColor = collided[i] ? '#f5c842' : moved ? '#c75a00' : '#555';
    marks += '<line x1="' + nx + '" y1="' + (Y_AFTER - afterH/2).toFixed(1) + '" x2="' + nx + '" y2="' + (Y_AFTER + afterH/2).toFixed(1) + '" stroke="' + afterColor + '" stroke-width="1.5"/>';
  }

  // Row labels
  var labels =
    '<text x="' + pad + '" y="' + (Y_DIV - 3) + '" font-size="7" fill="#555" font-family="sans-serif">BEFORE</text>'
  + '<text x="' + pad + '" y="' + (VH - 3)    + '" font-size="7" fill="#c75a00" font-family="sans-serif">AFTER</text>';

  var divider = '<line x1="0" y1="' + Y_DIV + '" x2="' + VW + '" y2="' + Y_DIV + '" stroke="#2a2a2a" stroke-width="1"/>';

  wrap.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ' + VW + ' ' + VH + '">'
    + '<rect width="' + VW + '" height="' + VH + '" fill="#0d0d0d" rx="3"/>'
    + grid + divider + marks + labels
    + '</svg>';
}

// ── selection & apply ─────────────────────────────────────────────────────────
function selectGroove(id) {
  selectedId = id;
  renderSidebar();
  for (var i = 0; i < grooves.length; i++) {
    if (grooves[i].id === id) { renderDetail(grooves[i]); break; }
  }
  var btn = document.getElementById('apply-btn');
  if (btn) btn.disabled = false;
}

function doApply() {
  if (!selectedId) return;
  var tEl = document.getElementById('timing-strength');
  var vEl = document.getElementById('vel-strength');
  var timingStrength   = tEl ? parseInt(tEl.value) : 100;
  var velocityStrength = vEl ? parseInt(vEl.value) : 0;
  postMsg({ action: 'apply', grooveId: selectedId, timingStrength: timingStrength, velocityStrength: velocityStrength });
}

// ── resolution label map (client-side) ────────────────────────────────────────
var resOptions = [
  { value: 1.0,                label: '1/4'   },
  { value: 0.5,                label: '1/8'   },
  { value: 0.25,               label: '1/16'  },
  { value: 0.125,              label: '1/32'  },
  { value: 0.3333333333333333, label: '1/8T'  },
  { value: 0.1666666666666667, label: '1/16T' }
];

// ── HTML escaping helper (client-side) ────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── init ──────────────────────────────────────────────────────────────────────
renderSidebar();
if (grooves.length > 0) selectGroove(grooves[0].id);
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio extraction settings webview
// ─────────────────────────────────────────────────────────────────────────────

const BAND_META: Array<{ id: FrequencyBand; label: string; range: string }> = [
  { id: "full",  label: "Full Mix", range: "all bands"    },
  { id: "kick",  label: "Kick",     range: "20\u2013200 Hz"    },
  { id: "snare", label: "Snare",    range: "200 Hz\u20132 kHz" },
  { id: "hihat", label: "Hi-hat",   range: "2\u201320 kHz"     },
];

export function buildAudioExtractSettingsWebview(clipName: string, defaultBpm: number): string {
  const bandMetaJson = JSON.stringify(BAND_META);

  const resOptions = RES_OPTIONS.map(opt =>
    `<option value="${opt.value}"${Math.abs(opt.value - 0.25) < 1e-9 ? " selected" : ""}>${opt.label}</option>`,
  ).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
.body { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 14px; }
.section-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #555; margin-bottom: 6px; }
.band-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.band-tile { background: #222; border: 1px solid #333; border-radius: 5px; padding: 8px 6px;
  cursor: pointer; text-align: center; user-select: none; transition: border-color .1s, background .1s; }
.band-tile:hover { background: #2a2a2a; border-color: #555; }
.band-tile.selected { background: #1f1209; border-color: #c75a00; }
.band-tile-label { font-size: 12px; font-weight: 700; color: #ddd; line-height: 1.2; }
.band-tile.selected .band-tile-label { color: #c75a00; }
.band-tile-range { font-size: 9px; color: #555; margin-top: 2px; }
.band-tile.selected .band-tile-range { color: #8a4010; }
.row2 { display: flex; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
input[type=number] { background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 6px 8px; border-radius: 4px; font-size: 13px; outline: none; width: 80px; }
input[type=number]:focus { border-color: #c75a00; }
select { background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 6px 8px; border-radius: 4px; font-size: 13px; outline: none; cursor: pointer; }
select:focus { border-color: #c75a00; }
.slider-row { display: flex; flex-direction: column; gap: 4px; }
.slider-labels { display: flex; justify-content: space-between; font-size: 9px; color: #555; margin-top: 2px; }
input[type=range] { width: 100%; accent-color: #c75a00; }
.name-row { display: flex; align-items: center; gap: 10px; }
.name-row label { font-size: 11px; color: #666; text-transform: uppercase;
  letter-spacing: .05em; white-space: nowrap; flex-shrink: 0; }
input[type=text] { flex: 1; background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 6px 10px; border-radius: 4px; font-size: 13px; outline: none; }
input[type=text]:focus { border-color: #c75a00; }
</style>
</head>
<body>
<div class="header">Groove Transplant \u2014 Extract from Audio</div>
<div class="body">
  <div>
    <div class="section-lbl">Frequency Band</div>
    <div class="band-grid" id="band-grid"></div>
  </div>
  <div class="row2">
    <div class="field">
      <label>BPM</label>
      <input type="number" id="bpm" min="20" max="300" step="0.01" value="${defaultBpm.toFixed(2)}">
    </div>
    <div class="field">
      <label>Resolution</label>
      <select id="resolution">${resOptions}</select>
    </div>
  </div>
  <div class="slider-row">
    <div class="section-lbl" style="margin-bottom:2px">Sensitivity \u2014 <span id="sens-label">70%</span></div>
    <input type="range" id="sensitivity" min="0" max="100" value="70">
    <div class="slider-labels"><span>Loud Hits Only</span><span>Include Ghost Notes</span></div>
  </div>
  <div class="name-row">
    <label>Name</label>
    <input type="text" id="name-input" placeholder="Groove name\u2026">
  </div>
</div>
<div class="footer">
  <button onclick="postMsg({action:'cancel'})">Cancel</button>
  <button class="primary" onclick="doExtract()">Extract Groove</button>
</div>
<script>
${POST_MESSAGE_FN}
var BAND_META = ${bandMetaJson};
var clipName = ${escJs(clipName)};
var selectedBand = 'full';

function renderBandGrid() {
  var el = document.getElementById('band-grid');
  var html = '';
  for (var i = 0; i < BAND_META.length; i++) {
    var b = BAND_META[i];
    var sel = b.id === selectedBand ? ' selected' : '';
    html += '<div class="band-tile' + sel + '" data-band="' + b.id + '">'
          +   '<div class="band-tile-label">' + b.label + '</div>'
          +   '<div class="band-tile-range">' + b.range + '</div>'
          + '</div>';
  }
  el.innerHTML = html;
}

document.getElementById('band-grid').addEventListener('click', function(e) {
  var tile = e.target.closest('[data-band]');
  if (!tile) return;
  selectedBand = tile.getAttribute('data-band');
  renderBandGrid();
  updateNameSuggestion();
});

function updateNameSuggestion() {
  var inp = document.getElementById('name-input');
  if (!inp._edited) {
    var suffix = selectedBand === 'full' ? '' : ' (' + selectedBand.charAt(0).toUpperCase() + selectedBand.slice(1) + ')';
    inp.value = clipName + suffix;
  }
}

document.getElementById('name-input').addEventListener('input', function() {
  this._edited = true;
});

document.getElementById('sensitivity').addEventListener('input', function() {
  document.getElementById('sens-label').textContent = this.value + '%';
});

function doExtract() {
  var name = document.getElementById('name-input').value.trim();
  var bpm = parseFloat(document.getElementById('bpm').value) || ${defaultBpm.toFixed(2)};
  var resolution = parseFloat(document.getElementById('resolution').value);
  var sensitivity = parseInt(document.getElementById('sensitivity').value);
  postMsg({ action: 'extract', band: selectedBand, bpm: bpm, resolution: resolution, sensitivity: sensitivity, name: name });
}

renderBandGrid();
updateNameSuggestion();
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drum Rack Builder settings webview
// ─────────────────────────────────────────────────────────────────────────────

export function buildDrumRackSettingsWebview(clipName: string, defaultBpm: number): string {
  const defaultTrackName = `${clipName.slice(0, 30)} Drum Rack`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
.body { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 16px; }
.section-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #555; margin-bottom: 6px; }
.row2 { display: flex; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
input[type=number] { background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 6px 8px; border-radius: 4px; font-size: 13px; outline: none; width: 90px; }
input[type=number]:focus { border-color: #c75a00; }
.slider-row { display: flex; flex-direction: column; gap: 4px; }
.slider-labels { display: flex; justify-content: space-between; font-size: 9px; color: #555; margin-top: 2px; }
input[type=range] { width: 100%; accent-color: #c75a00; }
.voice-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.voice-tile { background: #222; border: 1px solid #333; border-radius: 5px; padding: 10px 8px;
  cursor: pointer; text-align: center; user-select: none; transition: border-color .1s, background .1s; }
.voice-tile:hover { background: #2a2a2a; border-color: #555; }
.voice-tile.selected { background: #1f1209; border-color: #c75a00; }
.voice-tile-label { font-size: 13px; font-weight: 700; color: #ddd; }
.voice-tile.selected .voice-tile-label { color: #c75a00; }
.voice-tile-range { font-size: 9px; color: #555; margin-top: 3px; }
.voice-tile.selected .voice-tile-range { color: #8a4010; }
.name-row { display: flex; align-items: center; gap: 10px; }
.name-row label { font-size: 11px; color: #666; text-transform: uppercase;
  letter-spacing: .05em; white-space: nowrap; flex-shrink: 0; }
input[type=text] { flex: 1; background: #222; border: 1px solid #444; color: #e0e0e0;
  padding: 6px 10px; border-radius: 4px; font-size: 13px; outline: none; }
input[type=text]:focus { border-color: #c75a00; }
.field-row { display: flex; flex-direction: column; gap: 2px; }
.field-row label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ddd; cursor: pointer; }
.field-row input[type=checkbox] { accent-color: #c75a00; }
.field-row .hint { font-size: 10px; color: #666; margin-left: 22px; }
</style>
</head>
<body>
<div class="header">Groove Transplant \u2014 Build Drum Rack</div>
<div class="body">
  <div>
    <div class="section-lbl">Detect Voices</div>
    <div class="voice-grid" id="voice-grid">
      <div class="voice-tile selected" data-voice="kick">
        <div class="voice-tile-label">Kick</div>
        <div class="voice-tile-range">20\u2013200 Hz</div>
      </div>
      <div class="voice-tile selected" data-voice="snare">
        <div class="voice-tile-label">Snare</div>
        <div class="voice-tile-range">200\u20132k Hz</div>
      </div>
      <div class="voice-tile selected" data-voice="hihat">
        <div class="voice-tile-label">Hi-hat</div>
        <div class="voice-tile-range">2k\u201320k Hz</div>
      </div>
      <div class="voice-tile selected" data-voice="openhat">
        <div class="voice-tile-label">Open Hat</div>
        <div class="voice-tile-range">long decay</div>
      </div>
    </div>
  </div>
  <div class="row2">
    <div class="field">
      <label>BPM</label>
      <input type="number" id="bpm" min="20" max="300" step="0.01" value="${defaultBpm.toFixed(2)}">
    </div>
  </div>
  <div class="slider-row">
    <div class="section-lbl" style="margin-bottom:2px">Sensitivity \u2014 <span id="sens-label">50%</span></div>
    <input type="range" id="sensitivity" min="0" max="100" value="50">
    <div class="slider-labels"><span>Loud Hits Only</span><span>Include Ghost Notes</span></div>
  </div>
  <div class="field-row">
    <label><input type="checkbox" id="fill-gaps"> Fill regular gaps</label>
    <span class="hint">Extrapolate missing hits in regular patterns (e.g. hihats masked by kicks)</span>
  </div>
  <div class="name-row">
    <label>Track Name</label>
    <input type="text" id="track-name" value="${escHtml(defaultTrackName)}">
  </div>
</div>
<div class="footer">
  <button onclick="postMsg({action:'cancel'})">Cancel</button>
  <button class="primary" id="build-btn" onclick="doBuild()">Build Drum Rack</button>
</div>
<script>
${POST_MESSAGE_FN}
var selectedVoices = { kick: true, snare: true, hihat: true, openhat: true };

document.getElementById('voice-grid').addEventListener('click', function(e) {
  var tile = e.target.closest('[data-voice]');
  if (!tile) return;
  var voice = tile.getAttribute('data-voice');
  selectedVoices[voice] = !selectedVoices[voice];
  tile.classList.toggle('selected', selectedVoices[voice]);
  updateBuildBtn();
});

document.getElementById('sensitivity').addEventListener('input', function() {
  document.getElementById('sens-label').textContent = this.value + '%';
});

function updateBuildBtn() {
  var any = selectedVoices.kick || selectedVoices.snare || selectedVoices.hihat || selectedVoices.openhat;
  document.getElementById('build-btn').disabled = !any;
}

function doBuild() {
  var voices = Object.keys(selectedVoices).filter(function(v) { return selectedVoices[v]; });
  postMsg({
    action: 'build',
    bpm: parseFloat(document.getElementById('bpm').value) || ${defaultBpm},
    sensitivity: parseInt(document.getElementById('sensitivity').value, 10),
    voices: voices,
    trackName: document.getElementById('track-name').value.trim() || ${escJs(defaultTrackName)},
    fillGaps: document.getElementById('fill-gaps').checked,
  });
}
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manage Samples webview
// ─────────────────────────────────────────────────────────────────────────────

export function buildManageSamplesWebview(
  folders: Array<{ name: string; sizeMb: number; date: string; mtimeMs?: number }>,
): string {
  const foldersJson = tsEscJs(folders);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
.body { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.toolbar-links { display: flex; gap: 10px; flex: 1; }
.toolbar-link { background: none; border: none; color: #666; font-size: 11px; cursor: pointer;
  padding: 0; text-decoration: underline; text-underline-offset: 2px; }
.toolbar-link:hover { color: #c75a00; background: none; }
.empty-state { color: #555; font-size: 13px; padding: 24px 0; text-align: center; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
thead th { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #555;
  text-align: left; padding: 0 10px 6px 0; border-bottom: 1px solid #2a2a2a; }
thead th:first-child { width: 28px; padding-left: 2px; }
tbody tr { border-bottom: 1px solid #222; }
tbody tr:hover { background: #222; }
tbody td { padding: 8px 10px 8px 0; vertical-align: middle; color: #d0d0d0; }
tbody td:first-child { padding-left: 2px; }
.folder-name { font-weight: 500; color: #e0e0e0; word-break: break-all; }
.size-cell { white-space: nowrap; color: #888; }
.date-cell { white-space: nowrap; color: #666; }
input[type=checkbox] { accent-color: #c75a00; width: 13px; height: 13px; cursor: pointer; }
</style>
</head>
<body>
<div class="header">Manage Groove Transplant Samples</div>
<div class="body" id="body-content"></div>
<div class="footer">
  <button onclick="postMsg({action:'cancel'})">Done</button>
  <button class="primary" id="delete-btn" disabled onclick="doDelete()">Delete Selected</button>
</div>
<script>
${POST_MESSAGE_FN}
var folders = ${foldersJson};
var checked = {};

function updateDeleteBtn() {
  var any = Object.keys(checked).some(function(k) { return checked[k]; });
  document.getElementById('delete-btn').disabled = !any;
}

function selectAll() {
  for (var i = 0; i < folders.length; i++) checked[folders[i].name] = true;
  render();
  updateDeleteBtn();
}

function clearAll() {
  checked = {};
  render();
  updateDeleteBtn();
}

function render() {
  var el = document.getElementById('body-content');
  if (!folders.length) {
    el.innerHTML = '<div class="empty-state">No extracted sample sets found.</div>';
    return;
  }
  var rows = '';
  for (var i = 0; i < folders.length; i++) {
    var f = folders[i];
    var isChecked = checked[f.name] ? ' checked' : '';
    rows += '<tr>'
      + '<td><input type="checkbox" data-name="' + escHtml(f.name) + '"' + isChecked + '></td>'
      + '<td><div class="folder-name">' + escHtml(f.name) + '</div></td>'
      + '<td class="size-cell">' + f.sizeMb.toFixed(1) + ' MB</td>'
      + '<td class="date-cell">' + escHtml(f.date) + '</td>'
      + '</tr>';
  }
  el.innerHTML =
    '<div class="toolbar">'
    + '<div class="toolbar-links">'
    + '<button class="toolbar-link" onclick="selectAll()">Select All</button>'
    + '<button class="toolbar-link" onclick="clearAll()">Clear</button>'
    + '</div>'
    + '</div>'
    + '<table>'
    + '<thead><tr><th></th><th>Sample Set</th><th>Size</th><th>Date</th></tr></thead>'
    + '<tbody id="table-body">' + rows + '</tbody>'
    + '</table>';

  document.getElementById('table-body').addEventListener('change', function(e) {
    var cb = e.target;
    if (cb.type === 'checkbox') {
      var name = cb.getAttribute('data-name');
      checked[name] = cb.checked;
      updateDeleteBtn();
    }
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function doDelete() {
  var selected = Object.keys(checked).filter(function(k) { return checked[k]; });
  if (!selected.length) return;
  postMsg({ action: 'delete', folders: selected });
}

render();
updateDeleteBtn();
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// String escaping helpers (used by template interpolations above — hoisted
// function declarations so they are visible in the functions defined earlier).
// ─────────────────────────────────────────────────────────────────────────────

export function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escJs(s: string): string {
  // JSON.stringify produces a safe JS string literal (with surrounding quotes),
  // but it does NOT escape "</" sequences — so a value containing "</script>"
  // would break out of a <script> block. Replace "</" with "<\/" to neutralise.
  return JSON.stringify(s).replace(/<\//gi, "<\\/");
}
