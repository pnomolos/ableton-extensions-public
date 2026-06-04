import type { MidiNote } from "@arclight/core";
import type { OscillationSettings } from "./ecology.js";

export interface ClipEntry {
  id: number;
  trackName: string;
  clipName: string;
  noteCount: number;
  notes: MidiNote[];
}

// ─── Shared ────────────────────────────────────────────────────────────────

const SHARED_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:#060610;color:#c8d4e8;
    font-family:'Courier New',Courier,monospace;font-size:12px;
    overflow:hidden;user-select:none;
  }
  .header{
    display:flex;align-items:center;justify-content:space-between;
    padding:9px 16px 7px;border-bottom:1px solid #1a1f3a;
    background:linear-gradient(180deg,#0c0c20 0%,#06060f 100%);
    flex-shrink:0;
  }
  .header-logo{font-size:10px;letter-spacing:0.3em;color:#3a6fff;text-transform:uppercase}
  .header-title{font-size:13px;letter-spacing:0.12em;color:#8ab4f8}
  .header-meta{font-size:10px;color:#2a3560;letter-spacing:0.1em}
  canvas{display:block}
  .dish-label{text-align:center;font-size:9px;letter-spacing:0.18em;color:#3a5080;text-transform:uppercase;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dish-sublabel{text-align:center;font-size:9px;color:#253560;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  input[type=range]{
    width:100%;height:3px;-webkit-appearance:none;appearance:none;
    background:linear-gradient(90deg,#3a6fff var(--pct,30%),#1a2240 var(--pct,30%));
    border-radius:2px;outline:none;cursor:pointer;display:block;
  }
  input[type=range]::-webkit-slider-thumb{
    -webkit-appearance:none;width:11px;height:11px;border-radius:50%;
    background:#3a6fff;border:2px solid #8ab4f8;box-shadow:0 0 5px #3a6fff;cursor:pointer;
  }
  .btn{
    padding:5px 13px;border-radius:3px;border:none;cursor:pointer;
    font-family:inherit;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;transition:all 0.12s;
  }
  .btn-ghost{background:transparent;border:1px solid #2a3560;color:#506080}
  .btn-ghost:hover{border-color:#3a6fff;color:#8ab4f8}
  .btn-primary{background:#3a6fff;color:#e8f0ff;box-shadow:0 0 10px rgba(58,111,255,0.35)}
  .btn-primary:hover{background:#5a8fff;box-shadow:0 0 16px rgba(58,111,255,0.55)}
  .btn-danger{background:#ff3a3a;color:#ffe8e8;box-shadow:0 0 10px rgba(255,58,58,0.35)}
  .btn-danger:hover{background:#ff5a5a}
  .scanlines{position:fixed;inset:0;pointer-events:none;z-index:100;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px)}
  label.row-label{font-size:9px;letter-spacing:0.15em;color:#3a5080;text-transform:uppercase;display:block;margin-bottom:4px}
`;

const DISH_JS = `
  function drawDish(canvas, notes, opts) {
    opts=opts||{};
    var ctx=canvas.getContext('2d');
    var W=canvas.width,H=canvas.height,cx=W/2,cy=H/2;
    var r=Math.min(cx,cy)-6;
    ctx.clearRect(0,0,W,H);
    var bg=ctx.createRadialGradient(cx,cy*0.8,0,cx,cy,r);
    bg.addColorStop(0,'rgba(14,18,42,0.97)');
    bg.addColorStop(1,'rgba(4,6,18,0.97)');
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle=bg;ctx.fill();
    ctx.strokeStyle='rgba(40,60,110,0.18)';ctx.lineWidth=0.5;
    for(var i=1;i<4;i++){ctx.beginPath();ctx.arc(cx,cy,r*i/4,0,Math.PI*2);ctx.stroke();}
    for(var a=0;a<8;a++){var ag=a*Math.PI/4;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ag)*r,cy+Math.sin(ag)*r);ctx.stroke();}
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle=opts.rimColor||'rgba(40,70,150,0.3)';ctx.lineWidth=opts.rimWidth||1.5;ctx.stroke();
    if(!notes||!notes.length)return;
    var t=opts.staticT!==undefined?opts.staticT:Date.now()/1000;
    var maxT=0;for(var ni=0;ni<notes.length;ni++){var e=notes[ni].startTime+notes[ni].duration;if(e>maxT)maxT=e;}
    if(maxT<=0)maxT=1;
    var rs=opts.radScale||1;
    for(var ni=0;ni<notes.length;ni++){
      var n=notes[ni];
      var nx=(n.startTime/maxT)*1.65-0.825;
      var ny=((n.pitch-60)/52)*0.82;
      var dist=Math.sqrt(nx*nx+ny*ny);
      var sc=dist>0.88?0.88/dist:1;
      var wobX=opts.staticT!==undefined?0:Math.sin(t*0.38+ni*1.71)*0.032;
      var wobY=opts.staticT!==undefined?0:Math.cos(t*0.31+ni*2.27)*0.032;
      var px=cx+(nx*sc+wobX)*r;
      var py=cy-(ny*sc+wobY)*r;
      var hue=(n.pitch%12)*30;
      var light=38+(n.velocity/127)*32;
      var baseRad=3+(n.duration/maxT)*r*0.25*rs;
      var pulse=opts.staticT!==undefined?1:1+0.13*Math.sin(t*2.1+n.pitch*0.53);
      var rad=baseRad*pulse;
      var alp=opts.alpha||1;
      var g=ctx.createRadialGradient(px,py,0,px,py,rad*3);
      g.addColorStop(0,'hsla('+hue+',88%,'+light+'%,'+(0.55*alp)+')');
      g.addColorStop(0.45,'hsla('+hue+',88%,'+light+'%,'+(0.14*alp)+')');
      g.addColorStop(1,'hsla('+hue+',88%,'+light+'%,0)');
      ctx.beginPath();ctx.arc(px,py,rad*3,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
      ctx.beginPath();ctx.arc(px,py,rad,0,Math.PI*2);
      ctx.fillStyle='hsla('+hue+',90%,'+(light+20)+'%,'+alp+')';ctx.fill();
    }
  }
`;

function sendMsg(): string {
  return `
    function sendResult(payload){
      var m={method:"close_and_send",params:[payload]};
      if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)
        window.webkit.messageHandlers.live.postMessage(m);
      else if(window.chrome&&window.chrome.webview)
        window.chrome.webview.postMessage(m);
    }
  `;
}

function breedJS(): string {
  return `
    function seededRng(s){
      return function(){s=Math.imul(s,1664525)+1013904223;return(s>>>0)/0xffffffff;};
    }
    function breed(notesA,notesB,rate,seed){
      var rng=seededRng(seed);
      var sA=notesA.slice().sort(function(a,b){return a.startTime-b.startTime;});
      var sB=notesB.slice().sort(function(a,b){return a.startTime-b.startTime;});
      if(!sA.length||!sB.length)return[];
      return sB.map(function(beat,i){
        var pitch=sA[i%sA.length];
        var n={pitch:pitch.pitch,startTime:beat.startTime,duration:beat.duration,velocity:Math.round((pitch.velocity+beat.velocity)/2)};
        if(rng()<rate){
          if(rng()<0.7)n.pitch=Math.max(0,Math.min(127,n.pitch+Math.round((rng()-0.5)*8)));
          if(rng()<0.5)n.startTime=Math.max(0,n.startTime+(rng()-0.5)*0.15);
          if(rng()<0.5)n.duration=Math.max(0.0625,n.duration*(0.75+rng()*0.5));
          if(rng()<0.6)n.velocity=Math.max(1,Math.min(127,n.velocity+Math.round((rng()-0.5)*40)));
        }
        return n;
      });
    }
  `;
}

// ─── Petri Lab ────────────────────────────────────────────────────────────

export function buildLabWebview(clips: ClipEntry[], clickedId: number): string {
  const initData = JSON.stringify({ clips, clickedId });
  const safeInitData = initData.replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
${SHARED_CSS}
html,body{width:800px;height:520px;display:flex;flex-direction:column}
.body{display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0}

/* grid */
.grid-section{flex-shrink:0;padding:8px 14px 6px;border-bottom:1px solid #111828}
.grid-scroll{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}
.grid-scroll::-webkit-scrollbar{height:4px}
.grid-scroll::-webkit-scrollbar-track{background:#0a0a18}
.grid-scroll::-webkit-scrollbar-thumb{background:#1e2848;border-radius:2px}
.clip-card{flex:0 0 auto;cursor:pointer;display:flex;flex-direction:column;align-items:center;
  padding:4px 5px;border-radius:4px;border:1px solid transparent;transition:border-color 0.15s,background 0.15s;width:76px}
.clip-card:hover{background:rgba(58,111,255,0.06);border-color:#1e2848}
.clip-card.sel-a{border-color:#3a6fff;background:rgba(58,111,255,0.1)}
.clip-card.sel-a canvas{filter:drop-shadow(0 0 5px rgba(58,111,255,0.7))}
.clip-card.sel-b{border-color:#00c870;background:rgba(0,200,112,0.08)}
.clip-card.sel-b canvas{filter:drop-shadow(0 0 5px rgba(0,200,112,0.6))}
.clip-card .note-count{font-size:8px;color:#2a3a60;text-align:center;margin-top:1px;letter-spacing:0.05em}

/* breed area */
.breed-area{display:flex;gap:0;flex:1;min-height:0;padding:10px 14px 0}
.parent-panel{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;flex:0 0 170px}
.parent-title{font-size:9px;letter-spacing:0.25em;margin-bottom:6px;text-transform:uppercase}
.parent-title.a{color:#2a5acc}
.parent-title.b{color:#008a4e}
.parent-name{font-size:9px;color:#3a5080;text-align:center;margin-top:3px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.center-panel{flex:1;display:flex;flex-direction:column;align-items:center;padding:0 10px}
.offspring-title{font-size:9px;letter-spacing:0.25em;color:#6030a0;text-transform:uppercase;margin-bottom:4px}
.mut-row{display:flex;align-items:center;gap:8px;width:100%;margin-top:8px}
.mut-row label{font-size:9px;letter-spacing:0.12em;color:#3a5080;text-transform:uppercase;white-space:nowrap}
.mut-row .val{font-size:10px;color:#6070a0;min-width:30px;text-align:right}
.center-btns{display:flex;gap:6px;margin-top:6px}
.empty-hint{font-size:10px;color:#2a3560;text-align:center;padding:30px 10px;letter-spacing:0.08em;line-height:1.6}

/* footer */
.footer{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px 10px;border-top:1px solid #111828;gap:8px}
.write-row{display:flex;align-items:center;gap:7px}
.write-row label{font-size:9px;letter-spacing:0.12em;color:#3a5080;text-transform:uppercase;white-space:nowrap}
select{background:#0e1020;border:1px solid #2a3560;color:#8ab4f8;font-family:inherit;
  font-size:10px;padding:4px 6px;border-radius:3px;outline:none;max-width:180px}
select:focus{border-color:#3a6fff}
</style></head>
<body>
<div class="scanlines"></div>
<div class="header">
  <span class="header-logo">Petri</span>
  <span class="header-title">Lab</span>
  <span class="header-meta" id="headerMeta"></span>
</div>
<div class="body">
  <div class="grid-section">
    <div class="grid-scroll" id="clipGrid"></div>
  </div>
  <div class="breed-area">
    <div class="parent-panel">
      <div class="parent-title a">▲ Parent A</div>
      <canvas id="cA" width="150" height="150"></canvas>
      <div class="parent-name" id="nameA">— none selected —</div>
    </div>
    <div class="center-panel" id="centerPanel">
      <div class="empty-hint" id="emptyHint">Select two clips above<br>to begin breeding</div>
      <div id="breedPanel" style="display:none;width:100%;flex-direction:column;align-items:center">
        <div class="offspring-title">↓ Offspring</div>
        <canvas id="cO" width="140" height="140"></canvas>
        <div class="mut-row">
          <label>Mutation</label>
          <input type="range" id="mutRate" min="0" max="1" step="0.01" value="0.15">
          <span class="val" id="mutVal">0.15</span>
        </div>
        <div class="center-btns">
          <button class="btn btn-ghost" id="reroll">Re-roll</button>
        </div>
      </div>
    </div>
    <div class="parent-panel">
      <div class="parent-title b">▲ Parent B</div>
      <canvas id="cB" width="150" height="150"></canvas>
      <div class="parent-name" id="nameB">— none selected —</div>
    </div>
  </div>
  <div class="footer">
    <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
    <div class="write-row">
      <label>Write to:</label>
      <select id="targetSel"></select>
      <button class="btn btn-primary" id="breedBtn" disabled>Breed &amp; Write</button>
    </div>
  </div>
</div>
<script>
${DISH_JS}
${breedJS()}
${sendMsg()}

var data=${safeInitData};
var clips=data.clips||[];
var clickedId=data.clickedId;
var selA=-1,selB=-1,seed=Math.floor(Math.random()*0xffffff),offspring=[];

// populate header
document.getElementById('headerMeta').textContent=clips.length+' clip'+(clips.length===1?'':'s');

// populate target dropdown
var targetSel=document.getElementById('targetSel');
clips.forEach(function(c){
  var o=document.createElement('option');
  o.value=c.id;
  o.textContent=c.trackName+' / '+c.clipName;
  targetSel.appendChild(o);
});
if(clickedId>=0&&clickedId<clips.length) targetSel.value=clickedId;

// build grid
var grid=document.getElementById('clipGrid');
var gridCanvases=[];
clips.forEach(function(c){
  var card=document.createElement('div');
  card.className='clip-card';
  card.dataset.id=c.id;
  var cv=document.createElement('canvas');
  cv.width=62;cv.height=62;
  card.appendChild(cv);
  var lbl=document.createElement('div');
  lbl.className='dish-label';
  lbl.style.maxWidth='70px';
  lbl.textContent=c.clipName;
  card.appendChild(lbl);
  var sub=document.createElement('div');
  sub.className='note-count';
  sub.textContent=c.noteCount+'nt';
  card.appendChild(sub);
  grid.appendChild(card);
  gridCanvases.push({canvas:cv,card:card,clip:c});
  // draw static
  drawDish(cv,c.notes,{rimColor:'rgba(40,70,150,0.25)',staticT:0,radScale:0.75});
  card.addEventListener('click',function(){
    var id=parseInt(card.dataset.id);
    if(id===selA){selA=-1;}
    else if(id===selB){selB=-1;}
    else if(selA===-1){selA=id;}
    else{selB=id;}
    updateSelection();
  });
});

// auto-select clicked clip as Parent A
if(clickedId>=0&&clickedId<clips.length){
  selA=clickedId;
  updateSelection();
}

function updateSelection(){
  gridCanvases.forEach(function(g){
    var id=parseInt(g.card.dataset.id);
    g.card.className='clip-card'+(id===selA?' sel-a':id===selB?' sel-b':'');
  });
  var clipA=selA>=0?clips.find(function(c){return c.id===selA;}):null;
  var clipB=selB>=0?clips.find(function(c){return c.id===selB;}):null;
  document.getElementById('nameA').textContent=clipA?clipA.trackName+' / '+clipA.clipName:'— none —';
  document.getElementById('nameB').textContent=clipB?clipB.trackName+' / '+clipB.clipName:'— none —';
  var ready=clipA&&clipB;
  document.getElementById('emptyHint').style.display=ready?'none':'block';
  var bp=document.getElementById('breedPanel');
  bp.style.display=ready?'flex':'none';
  document.getElementById('breedBtn').disabled=!ready;
  if(ready) recompute();
}

function getClipNotes(id){
  var c=clips.find(function(x){return x.id===id;});
  return c?c.notes:[];
}

function recompute(){
  if(selA<0||selB<0){offspring=[];return;}
  offspring=breed(getClipNotes(selA),getClipNotes(selB),
    parseFloat(document.getElementById('mutRate').value),seed);
  document.getElementById('breedBtn').disabled = offspring.length === 0;
}

var cA=document.getElementById('cA'),cB=document.getElementById('cB'),cO=document.getElementById('cO');

function loop(){
  var clipA=selA>=0?clips.find(function(c){return c.id===selA;}):null;
  var clipB=selB>=0?clips.find(function(c){return c.id===selB;}):null;
  drawDish(cA,clipA?clipA.notes:[],{rimColor:'rgba(40,100,255,0.55)',rimWidth:2});
  drawDish(cB,clipB?clipB.notes:[],{rimColor:'rgba(0,200,100,0.5)',rimWidth:2});
  drawDish(cO,offspring,{rimColor:'rgba(160,60,255,0.6)',rimWidth:2});
  requestAnimationFrame(loop);
}

var mutSlider=document.getElementById('mutRate');
mutSlider.addEventListener('input',function(){
  var v=parseFloat(this.value);
  document.getElementById('mutVal').textContent=v.toFixed(2);
  this.style.setProperty('--pct',(v*100)+'%');
  recompute();
});

document.getElementById('reroll').addEventListener('click',function(){
  seed=Math.floor(Math.random()*0xffffff);recompute();
});

document.getElementById('cancelBtn').addEventListener('click',function(){sendResult(JSON.stringify(null));});

document.getElementById('breedBtn').addEventListener('click',function(){
  if(!offspring.length)return;
  var targetId=parseInt(targetSel.value);
  sendResult(JSON.stringify({action:'breed',targetId:targetId,notes:offspring}));
});

updateSelection();
// Scroll the pre-selected clip into view
if(clickedId>=0&&clickedId<gridCanvases.length){
  gridCanvases[clickedId].card.scrollIntoView({block:'nearest',inline:'center'});
}
loop();
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─── Mutate ────────────────────────────────────────────────────────────────

export function buildMutateWebview(notes: MidiNote[]): string {
  const initData = JSON.stringify({ notes });
  const safeInitData = initData.replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
${SHARED_CSS}
html,body{width:510px;height:450px;display:flex;flex-direction:column}
.body{flex:1;overflow:hidden;display:flex;flex-direction:column;padding:12px 16px 10px;gap:10px}
.dishes{display:flex;gap:14px;justify-content:center;flex-shrink:0}
.dish-wrap{display:flex;flex-direction:column;align-items:center}
.controls{display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;gap:8px}
.row label{font-size:9px;letter-spacing:0.15em;color:#506080;text-transform:uppercase;white-space:nowrap;min-width:56px}
.row .val{font-size:10px;color:#8ab4f8;min-width:32px;text-align:right}
.cb-row{display:flex;gap:12px}
.cb-label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:9px;letter-spacing:0.1em;color:#506080}
.cb-label input{accent-color:#3a6fff}
.btn-row{display:flex;justify-content:space-between;align-items:center}
</style></head>
<body>
<div class="scanlines"></div>
<div class="header">
  <span class="header-logo">Petri</span>
  <span class="header-title">Mutation</span>
  <span class="header-meta">${(notes || []).length} notes</span>
</div>
<div class="body">
  <div class="dishes">
    <div class="dish-wrap">
      <canvas id="cOrig" width="185" height="185"></canvas>
      <div class="dish-label" style="color:#2a4060">Original</div>
    </div>
    <div class="dish-wrap">
      <canvas id="cMut" width="185" height="185"></canvas>
      <div class="dish-label" style="color:#604020">Mutated</div>
    </div>
  </div>
  <div class="controls">
    <div class="row">
      <label>Rate</label>
      <input type="range" id="rate" min="0.01" max="1" step="0.01" value="0.3">
      <span class="val" id="rateVal">0.30</span>
    </div>
    <div class="cb-row">
      <label class="cb-label"><input type="checkbox" id="cbPitch" checked> Pitch</label>
      <label class="cb-label"><input type="checkbox" id="cbTiming" checked> Timing</label>
      <label class="cb-label"><input type="checkbox" id="cbDuration"> Duration</label>
      <label class="cb-label"><input type="checkbox" id="cbVelocity" checked> Velocity</label>
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" id="reroll">Re-roll</button>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="cancel">Cancel</button>
        <button class="btn btn-primary" id="apply">Apply</button>
      </div>
    </div>
  </div>
</div>
<script>
${DISH_JS}
${sendMsg()}

var data=${safeInitData};
var original=data.notes||[];
var seed=Math.floor(Math.random()*0xffffff);
var mutated=[];

function seededRng(s){return function(){s=Math.imul(s,1664525)+1013904223;return(s>>>0)/0xffffffff;};}

function getOpts(){
  return{pitch:document.getElementById('cbPitch').checked,timing:document.getElementById('cbTiming').checked,
    duration:document.getElementById('cbDuration').checked,velocity:document.getElementById('cbVelocity').checked};
}

function computeMutation(){
  var rate=parseFloat(document.getElementById('rate').value);
  var opts=getOpts();var rng=seededRng(seed);
  mutated=original.map(function(note){
    if(rng()>=rate)return Object.assign({},note);
    var n=Object.assign({},note);
    if(opts.pitch&&rng()<0.8)n.pitch=Math.max(0,Math.min(127,n.pitch+Math.round((rng()-0.5)*10)));
    if(opts.timing&&rng()<0.7)n.startTime=Math.max(0,n.startTime+(rng()-0.5)*0.18);
    if(opts.duration&&rng()<0.7)n.duration=Math.max(0.0625,n.duration*(0.7+rng()*0.6));
    if(opts.velocity&&rng()<0.8)n.velocity=Math.max(1,Math.min(127,n.velocity+Math.round((rng()-0.5)*44)));
    return n;
  });
}

var cOrig=document.getElementById('cOrig'),cMut=document.getElementById('cMut');
function loop(){
  drawDish(cOrig,original,{rimColor:'rgba(30,80,200,0.4)'});
  drawDish(cMut,mutated,{rimColor:'rgba(200,100,20,0.5)'});
  requestAnimationFrame(loop);
}

function onchange(){
  var v=parseFloat(document.getElementById('rate').value);
  document.getElementById('rateVal').textContent=v.toFixed(2);
  document.getElementById('rate').style.setProperty('--pct',(v*100)+'%');
  computeMutation();
}
document.getElementById('rate').addEventListener('input',onchange);
['cbPitch','cbTiming','cbDuration','cbVelocity'].forEach(function(id){
  document.getElementById(id).addEventListener('change',computeMutation);
});
document.getElementById('reroll').addEventListener('click',function(){seed=Math.floor(Math.random()*0xffffff);computeMutation();});
document.getElementById('cancel').addEventListener('click',function(){sendResult(JSON.stringify(null));});
document.getElementById('apply').addEventListener('click',function(){
  var rate=parseFloat(document.getElementById('rate').value);
  sendResult(JSON.stringify({action:'mutate',notes:mutated,rate:rate,opts:getOpts(),nextSeed:seed+1}));
});

computeMutation();
loop();
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─── Oscillate ────────────────────────────────────────────────────────────

export function buildOscillateWebview(
  notes: MidiNote[],
  current: OscillationSettings | undefined
): string {
  const initData = JSON.stringify({
    notes,
    active: !!current,
    intervalMode: current?.intervalMode ?? "bars",
    division: current?.division ?? 1,
    intervalSec: current?.intervalSec ?? 4,
    intensity: current?.intensity ?? 0.25,
    transportSync: current?.transportSync ?? true,
    scaleLock: current?.scaleLock ?? false,
  });
  const safeInitData = initData.replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
${SHARED_CSS}
html,body{width:440px;height:380px;display:flex;flex-direction:column}
.body{flex:1;display:flex;flex-direction:column;padding:12px 16px 10px;gap:9px}
.status-row{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot-active{background:#00ff88;box-shadow:0 0 7px #00ff88}
.dot-inactive{background:#2a3560}
.status-text{font-size:10px;letter-spacing:0.15em;text-transform:uppercase}
.ctrl-row{display:flex;align-items:center;gap:8px}
.ctrl-row label{font-size:9px;letter-spacing:0.12em;color:#3a5080;text-transform:uppercase;white-space:nowrap;min-width:64px}
.ctrl-row .val{font-size:10px;color:#6070a0;min-width:32px;text-align:right}
.seg-btns{display:flex;gap:3px}
.seg-btn{
  padding:3px 9px;border-radius:3px;border:1px solid #2a3560;
  background:transparent;color:#506080;cursor:pointer;font-family:inherit;
  font-size:9px;letter-spacing:0.1em;text-transform:uppercase;transition:all 0.1s;
}
.seg-btn:hover{border-color:#3a6fff;color:#8ab4f8}
.seg-btn.active{background:#1a2a50;border-color:#3a6fff;color:#8ab4f8;box-shadow:0 0 5px rgba(58,111,255,0.25)}
.interval-btns{display:flex;gap:3px;flex:1}
.interval-btn{
  flex:1;padding:4px 0;border-radius:3px;border:1px solid #2a3560;
  background:transparent;color:#506080;cursor:pointer;font-family:inherit;
  font-size:10px;letter-spacing:0.05em;transition:all 0.1s;
}
.interval-btn:hover{border-color:#3a6fff;color:#8ab4f8}
.interval-btn.active{background:#1a2a50;border-color:#3a6fff;color:#8ab4f8;box-shadow:0 0 5px rgba(58,111,255,0.25)}
.check-label{display:flex;align-items:center;gap:6px;cursor:pointer}
.check-label input[type=checkbox]{width:12px;height:12px;accent-color:#3a6fff;cursor:pointer}
.check-label span{font-size:9px;color:#506080;letter-spacing:0.08em}
.btn-row{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
</style></head>
<body>
<div class="scanlines"></div>
<div class="header">
  <span class="header-logo">Petri</span>
  <span class="header-title">Oscillation</span>
  <span class="header-meta">${(notes || []).length} notes</span>
</div>
<div class="body">
  <div class="status-row">
    <span class="dot" id="statusDot"></span>
    <span class="status-text" id="statusText"></span>
  </div>
  <canvas id="ecg" width="408" height="56" style="border-radius:3px"></canvas>

  <div class="ctrl-row">
    <label>Mode</label>
    <div class="seg-btns">
      <button class="seg-btn" id="modeBars">Bars</button>
      <button class="seg-btn" id="modeSecs">Seconds</button>
    </div>
  </div>

  <div class="ctrl-row" id="barsRow">
    <label>Every</label>
    <div class="interval-btns">
      <button class="interval-btn" data-bars="0.5">½</button>
      <button class="interval-btn" data-bars="1">1</button>
      <button class="interval-btn" data-bars="2">2</button>
      <button class="interval-btn" data-bars="4">4</button>
      <button class="interval-btn" data-bars="8">8</button>
    </div>
    <span style="font-size:9px;color:#3a5080;letter-spacing:0.08em">bars</span>
  </div>

  <div class="ctrl-row" id="secsRow">
    <label>Every</label>
    <div class="interval-btns">
      <button class="interval-btn" data-secs="1">1s</button>
      <button class="interval-btn" data-secs="2">2s</button>
      <button class="interval-btn" data-secs="4">4s</button>
      <button class="interval-btn" data-secs="8">8s</button>
      <button class="interval-btn" data-secs="16">16s</button>
      <button class="interval-btn" data-secs="30">30s</button>
    </div>
  </div>

  <div class="ctrl-row">
    <label>Intensity</label>
    <input type="range" id="intSlider" min="0.05" max="0.8" step="0.01" style="flex:1">
    <span class="val" id="intVal"></span>
  </div>

  <div class="ctrl-row">
    <label>Options</label>
    <div style="display:flex;gap:16px">
      <label class="check-label">
        <input type="checkbox" id="syncCheck">
        <span>Transport sync</span>
      </label>
      <label class="check-label">
        <input type="checkbox" id="scaleCheck">
        <span>Scale lock</span>
      </label>
    </div>
  </div>

  <div class="btn-row">
    <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
    <button class="btn" id="actionBtn"></button>
  </div>
</div>
<script>
${sendMsg()}
var init=${safeInitData};
var isActive=init.active;
var selMode=init.intervalMode;
var selDivision=init.division;
var selSecs=init.intervalSec;

// Mode toggle
function setMode(m){
  selMode=m;
  document.getElementById('modeBars').classList.toggle('active',m==='bars');
  document.getElementById('modeSecs').classList.toggle('active',m==='seconds');
  document.getElementById('barsRow').style.display=m==='bars'?'flex':'none';
  document.getElementById('secsRow').style.display=m==='seconds'?'flex':'none';
}
document.getElementById('modeBars').addEventListener('click',function(){setMode('bars');});
document.getElementById('modeSecs').addEventListener('click',function(){setMode('seconds');});
setMode(selMode);

// Bar buttons
document.querySelectorAll('[data-bars]').forEach(function(btn){
  if(parseFloat(btn.dataset.bars)===selDivision) btn.classList.add('active');
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-bars]').forEach(function(b){b.classList.remove('active');});
    this.classList.add('active');
    selDivision=parseFloat(this.dataset.bars);
  });
});

// Seconds buttons
document.querySelectorAll('[data-secs]').forEach(function(btn){
  if(parseFloat(btn.dataset.secs)===selSecs) btn.classList.add('active');
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-secs]').forEach(function(b){b.classList.remove('active');});
    this.classList.add('active');
    selSecs=parseFloat(this.dataset.secs);
  });
});

// Checkboxes
document.getElementById('syncCheck').checked=init.transportSync;
document.getElementById('scaleCheck').checked=init.scaleLock;

function setStatus(a){
  isActive=a;
  document.getElementById('statusDot').className='dot '+(a?'dot-active':'dot-inactive');
  document.getElementById('statusText').textContent=a?'Oscillating':'Inactive';
  document.getElementById('statusText').style.color=a?'#00ff88':'#2a3560';
  var btn=document.getElementById('actionBtn');
  btn.textContent=a?'Stop':'Start Oscillating';
  btn.className='btn '+(a?'btn-danger':'btn-primary');
}
setStatus(isActive);

// Intensity slider
var intEl=document.getElementById('intSlider');
intEl.value=init.intensity;
intEl.style.setProperty('--pct',((init.intensity-0.05)/0.75*100)+'%');
document.getElementById('intVal').textContent=parseFloat(init.intensity).toFixed(2);
intEl.addEventListener('input',function(){
  this.style.setProperty('--pct',((this.value-0.05)/0.75*100)+'%');
  document.getElementById('intVal').textContent=parseFloat(this.value).toFixed(2);
});

// ECG
var ecg=document.getElementById('ecg'),ectx=ecg.getContext('2d'),W=ecg.width,H=ecg.height,phase=0;
var syncEl=document.getElementById('syncCheck');
function drawEcg(){
  ectx.clearRect(0,0,W,H);
  ectx.fillStyle='rgba(4,6,18,0.95)';ectx.fillRect(0,0,W,H);
  var intensity=parseFloat(document.getElementById('intSlider').value);
  var speed=selMode==='bars'?(1/selDivision):(1/selSecs*2);
  phase+=0.022*speed;
  ectx.beginPath();
  ectx.strokeStyle=isActive?'rgba(0,255,136,0.85)':'rgba(40,80,130,0.5)';
  ectx.lineWidth=1.5;ectx.shadowColor=isActive?'#00ff88':'transparent';ectx.shadowBlur=isActive?5:0;
  for(var x=0;x<W;x++){
    var t=(x/W)*Math.PI*6+phase;
    var spike=Math.exp(-Math.pow((t%(Math.PI*2))-Math.PI*0.5,2)*8)*intensity*2;
    var y=H/2-(Math.sin(t*0.3)*4+spike*H*0.38);
    if(x===0)ectx.moveTo(x,y);else ectx.lineTo(x,y);
  }
  ectx.stroke();
  var labels=[];
  if(syncEl.checked) labels.push('SYNC');
  if(document.getElementById('scaleCheck').checked) labels.push('SCALE');
  if(labels.length){
    ectx.font='8px monospace';ectx.textAlign='right';ectx.shadowBlur=0;
    var x2=W-4;
    labels.forEach(function(lbl){
      ectx.fillStyle='rgba(0,255,136,0.06)';
      var w=ectx.measureText(lbl).width+6;
      ectx.fillRect(x2-w,2,w+2,12);
      ectx.fillStyle='rgba(0,255,136,0.5)';
      ectx.fillText(lbl,x2,12);
      x2-=w+4;
    });
  }
  var sx=(phase*10)%W;
  ectx.strokeStyle='rgba(0,255,136,0.1)';ectx.lineWidth=1;ectx.shadowBlur=0;
  ectx.beginPath();ectx.moveTo(sx,0);ectx.lineTo(sx,H);ectx.stroke();
  requestAnimationFrame(drawEcg);
}
drawEcg();

document.getElementById('cancelBtn').addEventListener('click',function(){sendResult(JSON.stringify(null));});
document.getElementById('actionBtn').addEventListener('click',function(){
  if(isActive){
    sendResult(JSON.stringify({action:'stop'}));
  } else {
    sendResult(JSON.stringify({
      action:'start',
      intervalMode:selMode,
      division:selDivision,
      intervalSec:selSecs,
      intensity:parseFloat(document.getElementById('intSlider').value),
      transportSync:document.getElementById('syncCheck').checked,
      scaleLock:document.getElementById('scaleCheck').checked,
    }));
  }
});
</script>
</body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
