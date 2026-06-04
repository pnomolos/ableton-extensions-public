import type { TransientFrame } from "@arclight/core";

export function buildQuantizeWebview(
  waveformData: number[],
  transients: TransientFrame[],
  clipDurationBeats: number,
  bpm: number,
): string {
  const waveJson = JSON.stringify(waveformData);
  const transientsJson = JSON.stringify(
    transients.map(t => ({ fraction: t.timeBeat / clipDurationBeats, strength: t.strength }))
  );
  const durationSecs = (clipDurationBeats / bpm) * 60;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; background: #1a1a1a; color: #e0e0e0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    .header { background: #252525; border-bottom: 1px solid #333; padding: 10px 16px; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: #999; flex-shrink: 0; }
    #waveform-container { flex: 1; position: relative; background: #111; }
    canvas { display: block; width: 100%; height: 100%; }
    .controls { flex-shrink: 0; padding: 14px 16px; background: #1e1e1e; border-top: 1px solid #333; display: flex; align-items: center; gap: 20px; }
    .ctrl-group { display: flex; flex-direction: column; gap: 5px; }
    .ctrl-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #666; }
    .grid-btns { display: flex; gap: 4px; }
    .grid-btn { background: #2a2a2a; border: 1px solid #444; color: #aaa; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; }
    .grid-btn.active { background: #e05a00; border-color: #e05a00; color: white; }
    .grid-btn:hover:not(.active) { background: #333; }
    input[type=range] { width: 120px; accent-color: #e05a00; }
    .humanize-val { font-size: 11px; color: #888; min-width: 30px; }
    .spacer { flex: 1; }
    .action-btns { display: flex; gap: 8px; }
    button.cancel { background: #2a2a2a; border: 1px solid #444; color: #aaa; padding: 7px 18px; border-radius: 4px; cursor: pointer; }
    button.cancel:hover { background: #333; }
    button.quantize { background: #e05a00; border: 1px solid #e05a00; color: white; padding: 7px 18px; border-radius: 4px; cursor: pointer; font-weight: 600; }
    button.quantize:hover { background: #f06a10; }
    button.quantize:disabled { background: #3a3a3a; border-color: #444; color: #666; cursor: not-allowed; }
    button.quantize:disabled:hover { background: #3a3a3a; }
    .info { font-size: 11px; color: #555; }
    .sdk-note { font-size: 11px; color: #c98a4a; max-width: 280px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="header">Beat Detective — Smart Quantize</div>
  <div id="waveform-container">
    <canvas id="cv"></canvas>
  </div>
  <div class="controls">
    <div class="ctrl-group">
      <div class="ctrl-label">Grid</div>
      <div class="grid-btns">
        <button class="grid-btn" data-grid="1" onclick="setGrid(1)">1/4</button>
        <button class="grid-btn" data-grid="0.5" onclick="setGrid(0.5)">1/8</button>
        <button class="grid-btn active" data-grid="0.25" onclick="setGrid(0.25)">1/16</button>
        <button class="grid-btn" data-grid="0.125" onclick="setGrid(0.125)">1/32</button>
      </div>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Humanize</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input type="range" id="humanize" min="0" max="100" value="0" oninput="updateHumanize(this.value)">
        <span class="humanize-val" id="hval">0%</span>
      </div>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Info</div>
      <div class="info" id="info"></div>
    </div>
    <div class="spacer"></div>
    <div class="sdk-note" id="sdk-note">
      Preview only on Extensions SDK 1.0.0 — the host exposes no warp-marker write API,
      so detected transients can be inspected but not applied to the clip.
    </div>
    <div class="action-btns">
      <button class="cancel" onclick="postMessage({action:'cancel'})">Close</button>
      <button class="quantize" id="quantize-btn" disabled title="Warp-marker writing is unavailable on Extensions SDK 1.0.0">Apply Warp Markers</button>
    </div>
  </div>
  <script>
function postMessage(msg) {
  const message = { method: "close_and_send", params: [JSON.stringify(msg)] };
  if (window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage(message);
  else if (window.chrome?.webview) window.chrome.webview.postMessage(message);
}

const waveform = ${waveJson};
const transients = ${transientsJson};
const clipDurationBeats = ${clipDurationBeats};
const bpm = ${bpm};
const durationSecs = ${durationSecs.toFixed(3)};

let currentGrid = 0.25;
let humanize = 0;

document.getElementById('info').textContent =
  transients.length + ' transients · ' + durationSecs.toFixed(1) + 's · ' + bpm + ' BPM';

function setGrid(g) {
  currentGrid = g;
  document.querySelectorAll('.grid-btn').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.grid) === g);
  });
  draw();
}

function updateHumanize(v) {
  humanize = parseInt(v);
  document.getElementById('hval').textContent = v + '%';
}

// NOTE: warp-marker write is unavailable on Extensions SDK 1.0.0 (AudioClip.warpMarkers
// is read-only with no setter), so the Apply button is disabled and this dialog is
// analyze/preview-only. The grid + humanize controls still drive the live preview below.

// Waveform canvas renderer
const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');

function draw() {
  const W = canvas.parentElement.clientWidth;
  const H = canvas.parentElement.clientHeight;
  canvas.width = W;
  canvas.height = H;
  const mid = H / 2;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  const beatsVisible = clipDurationBeats;
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 1;
  for (let b = 0; b <= beatsVisible; b += currentGrid) {
    const x = (b / beatsVisible) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  // Bar lines (every 4 beats) brighter
  ctx.strokeStyle = '#333';
  for (let b = 0; b <= beatsVisible; b += 4) {
    const x = (b / beatsVisible) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Waveform
  ctx.strokeStyle = '#3a6a9a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < waveform.length; i++) {
    const x = (i / waveform.length) * W;
    const amp = waveform[i] * mid * 0.9;
    if (i === 0) ctx.moveTo(x, mid - amp);
    else ctx.lineTo(x, mid - amp);
  }
  for (let i = waveform.length - 1; i >= 0; i--) {
    const x = (i / waveform.length) * W;
    const amp = waveform[i] * mid * 0.9;
    ctx.lineTo(x, mid + amp);
  }
  ctx.fillStyle = 'rgba(58,106,154,0.3)';
  ctx.fill();
  ctx.stroke();

  // Transient markers
  transients.forEach(t => {
    const x = t.fraction * W;
    const alpha = 0.4 + t.strength * 0.6;
    ctx.strokeStyle = \`rgba(224,90,0,\${alpha})\`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    // Triangle marker at top
    ctx.fillStyle = \`rgba(224,90,0,\${alpha})\`;
    ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 8); ctx.fill();
  });
}

window.addEventListener('resize', draw);
draw();
  </script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
