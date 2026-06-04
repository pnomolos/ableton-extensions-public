// Lidal editor client — bundled separately from the extension and served by
// the in-process HTTP server at /editor-client.js. Owns: the CodeMirror 6
// editor, the status pill, the orbit monitor strip, the log panel filters,
// the first-run banner, and the SSE → DOM glue. The page shell (HTML +
// chrome styles) is rendered by editor-page.ts and includes <div id="…">
// placeholders that this script wires up.

import { EditorState, Compartment, Transaction } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection,
  highlightSpecialChars, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentMore, indentLess,
  toggleLineComment, toggleBlockComment,
} from "@codemirror/commands";
import {
  bracketMatching, indentOnInput, foldKeymap, syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
  startCompletion,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";

import { lidalLanguage, lidalHighlighting } from "./lidal-language.js";
import { flashExtension, flashLines } from "./flash.js";
import { lidalCompletions } from "./autocomplete.js";
import { orbitColorPlugin, orbitColorCss, getOrbitColor } from "./orbit-colors.js";
import {
  diagnosticsExtension, setLidalDiagnostics, clearLidalDiagnostics,
  locateErrorInRange,
} from "./diagnostics.js";
import { createCycleIndicator, type CycleIndicator } from "./cycle-indicator.js";
import { createBakeToast, summarizeBakeMessage } from "./bake-toast.js";
import { toggleHelpOverlay, openHelpOverlay } from "./help-overlay.js";
import { lidalHoverTooltip } from "./hover.js";
import { registerPaletteCommands, openPalette } from "./command-palette.js";
import { mergeLogSnapshot as mergeLogSnapshotPure } from "./log-merge.js";

// ── Types mirroring server.ts (kept local; we tolerate missing fields) ────

type SyncMode = "manual" | "lom" | "midi-clock" | "link";

interface ServerStatus {
  running: boolean;
  buffer: string;
  bpm: number;
  cycleBeats: number;
  lastError: string | null;
  orbits: number[];
  controlOrbits: number[];
  cycleN: number;
  syncMode: SyncMode;
  syncError: string | null;
  linkPeers: number;
  linkIsPlaying: boolean | null;
  linkAvailable: boolean;
  lastBake?: { ts: number; ok: boolean; message: string };
}

type LogLevel = "error" | "warn" | "info" | "debug";
type LogSource = "eval" | "pattern" | "sync" | "bake" | "automap" | "system";

interface LogEntry {
  ts: number;
  level: LogLevel;
  source: LogSource;
  message: string;
  // Monotonic per-launch id supplied by the server. Lets us merge a fresh
  // log-snapshot with already-shown entries on SSE reconnect instead of
  // full-replacing (which would otherwise wipe entries that scrolled out of
  // the server's 200-entry ring during the disconnect window).
  id?: number;
  detail?: string;
}

interface OrbitMonitorEvent {
  type: "note" | "ctrl";
  orbit: string;       // "d1".."d16" | "c1".."c8"
  channel: number;
  lastValue: string | number;
  lastCycle: number;
  active: boolean;
}

interface SyncStatusEvent {
  mode: SyncMode;
  bpm: number;
  quantum: number;
  linkAvailable: boolean;
  linkError: string | null;
  peers: number | null;
}

// ── DOM utilities ────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Partial<Record<string, string>>,
  children?: (HTMLElement | string)[],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v != null) e.setAttribute(k, v);
  }
  if (children) for (const c of children) {
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// Per-launch CSRF token (TOFIX #1). Injected by editor-page.ts as a
// `data-csrf-token` attribute on #editor-host; we read it lazily on first use
// so test pages without the marker still load. Every POST attaches it as
// `x-lidal-token` and the SSE EventSource passes it via `?t=…` (because
// EventSource has no custom-header API). Server rejects mismatches with 403.
let cachedCsrfToken: string | null = null;
function csrfToken(): string {
  if (cachedCsrfToken != null) return cachedCsrfToken;
  const host = document.getElementById("editor-host");
  cachedCsrfToken = host?.dataset.csrfToken ?? "";
  return cachedCsrfToken;
}

// Compact JSON POST helper. Matches the old textarea-based client's contract.
async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lidal-token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// ── Block-under-cursor (port of editor-page.ts logic) ────────────────────

interface BlockRange {
  code: string;
  from: number;   // doc offset
  to: number;     // doc offset (inclusive of last line's end)
}

function blockUnderCursor(view: EditorView): BlockRange {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const cursorLine = doc.lineAt(head);
  let startLine = cursorLine.number;
  let endLine = cursorLine.number;
  while (startLine > 1 && doc.line(startLine - 1).text.trim() !== "") startLine--;
  while (endLine < doc.lines && doc.line(endLine + 1).text.trim() !== "") endLine++;
  const from = doc.line(startLine).from;
  const to = doc.line(endLine).to;
  return { code: doc.sliceString(from, to), from, to };
}

// ── Editor state (refs the rest of the page leans on) ────────────────────

interface PageState {
  view: EditorView;
  status: HTMLElement;
  bpmInput: HTMLInputElement;
  cycleInput: HTMLInputElement;
  bakeCyclesInput: HTMLInputElement;
  syncSelect: HTMLSelectElement;
  monitor: HTMLElement;
  lastStatus: ServerStatus | null;
  lastSeenBakeTs: number;
  bakeMessageUntil: number;
  // Map of orbit → last monitor event. Used for compact rendering.
  monitorByOrbit: Map<string, OrbitMonitorEvent>;
  syncStatus: SyncStatusEvent | null;
  // Most recently evaluated range — used to scope diagnostic markers.
  lastEvalRange: { from: number; to: number } | null;
  // Per-orbit fade-out timers; lets pills linger ~3s after going inactive
  // instead of snap-disappearing.
  pillFadeTimers: Map<string, number>;
  // Cycle-indicator handle (mounted into the header).
  cycleIndicator: CycleIndicator | null;
  // Bake-toast handle (mounted into <main>).
  bakeToast: ReturnType<typeof createBakeToast> | null;
  // Track the last bake `cycles` value the user supplied so we can summarise
  // the toast without round-tripping the server.
  lastBakeCycles: number | null;
}

const state: Partial<PageState> = {};

// ── Status pill ──────────────────────────────────────────────────────────

function setStatusClass(klass: string): void {
  if (!state.status) return;
  state.status.className = klass;
}

// Track the last rendered text so identical updates don't trigger the
// cross-fade animation (which would otherwise flicker on every status push).
let lastStatusText = "";
function setStatusText(text: string, klass: string): void {
  const el = state.status;
  if (!el) return;
  // Class is unconditional (running/error/disconnected variants matter even
  // when the text is unchanged). Only animate on text changes.
  if (text === lastStatusText) {
    el.className = klass;
    return;
  }
  lastStatusText = text;
  // Brief opacity dip — CSS transitions on #status-pill handle the fade.
  // We don't clobber the class while .fading is active; we just toggle the
  // single class on top of whatever's there.
  el.className = klass;
  el.classList.add("fading");
  window.requestAnimationFrame(() => {
    if (!el) return;
    el.textContent = text;
    // Force layout commit before we drop .fading so the opacity transitions
    // back to 1 rather than snapping.
    void el.offsetWidth;
    el.classList.remove("fading");
  });
}

// Like setStatusText, but renders the active-orbit list with per-orbit
// colours. Kept separate so the simple text path (errors, stopped) stays a
// single innerText assignment.
function setStatusRunning(orbits: string[], cycleN: number, bpmLabel: string, peersLabel: string): void {
  if (!state.status) return;
  state.status.className = "running";
  state.status.replaceChildren();
  const lead = document.createTextNode("▶ ");
  state.status.appendChild(lead);
  if (orbits.length === 0) {
    state.status.appendChild(document.createTextNode("—"));
  } else {
    orbits.forEach((o, i) => {
      const span = document.createElement("span");
      const c = getOrbitColor(o);
      span.className = `lidal-feedback-orbit-name lidal-feedback-orbit-${o}`;
      span.style.color = c.color;
      span.style.fontWeight = "700";
      span.textContent = o;
      state.status!.appendChild(span);
      if (i < orbits.length - 1) state.status!.appendChild(document.createTextNode(", "));
    });
  }
  state.status.appendChild(document.createTextNode(` · cycle ${cycleN} · ${bpmLabel}${peersLabel}`));
}

function renderStatus(): void {
  if (!state.status) return;
  const s = state.lastStatus;
  if (!s) { setStatusText("connecting…", ""); return; }

  // Bake message holds the pill for ~3.5s after last bake event lands.
  if (state.bakeMessageUntil && Date.now() < state.bakeMessageUntil) return;

  // Compose the "mode @ bpm" tail used by both running and stopped variants.
  const sync = state.syncStatus;
  const mode = (sync?.mode ?? s.syncMode ?? "manual") as SyncMode;
  const bpm = sync?.bpm ?? s.bpm ?? 120;
  const modeLabel = mode === "manual" ? "Manual" : mode === "link" ? "Link" : mode === "lom" ? "Live" : "MIDI Clock";
  const bpmLabel = `${modeLabel} @ ${Math.round(bpm * 10) / 10} BPM`;
  const peers = sync?.peers ?? (mode === "link" ? s.linkPeers : null);
  const peersLabel = peers != null && mode === "link" ? `, ${peers} ${peers === 1 ? "peer" : "peers"}` : "";

  // Link unavailable warning. Distinct visual: amber, not red.
  if (mode === "link" && sync && sync.linkAvailable === false) {
    state.status.title = sync.linkError ?? "Link library unavailable on this host";
    setStatusText(`⚠ Link unavailable · ${sync.linkError ?? "library not loaded"}`, "warn");
    return;
  }
  state.status.title = "";

  if (s.syncError) { setStatusText(`error · sync: ${s.syncError}`, "error"); return; }
  if (s.lastError)  { setStatusText(`error · ${s.lastError}`, "error"); return; }

  if (s.running) {
    const dOrbits = (s.orbits ?? []).map((o) => `d${o}`);
    const cOrbits = (s.controlOrbits ?? []).map((o) => `c${o}`);
    const orbits = [...dOrbits, ...cOrbits];
    setStatusRunning(orbits, s.cycleN ?? 0, bpmLabel, peersLabel);
    return;
  }

  const hasOrbits = (s.orbits?.length ?? 0) > 0 || (s.controlOrbits?.length ?? 0) > 0;
  const synced = mode !== "manual";
  if (synced && hasOrbits) {
    setStatusText(`■ waiting for ${mode} transport · ${bpmLabel}${peersLabel}`, "");
  } else if (synced) {
    setStatusText(`■ stopped · ${bpmLabel}${peersLabel}`, "");
  } else {
    setStatusText(`■ stopped · ${bpmLabel}`, "");
  }
}

// ── Orbit monitor strip ──────────────────────────────────────────────────
//
// New layout: bigger pills with per-orbit accent (left border + name colour),
// channel + last value, last cycle, and a CC meter for control orbits. Pills
// that go inactive fade for ~3s before unmounting, so a brief silence between
// re-evals doesn't snap the strip empty.

const MAX_VISIBLE_ORBITS = 12;
const PILL_FADE_MS = 3000;

function renderMonitor(): void {
  const host = state.monitor;
  if (!host) return;

  // Order: d1..d16 then c1..c8. Active first; inactive (in the fade-out
  // window) keep their slot until the fade timer removes them.
  const all: OrbitMonitorEvent[] = [];
  for (let i = 1; i <= 16; i++) {
    const e = state.monitorByOrbit?.get(`d${i}`);
    if (e) all.push(e);
  }
  for (let i = 1; i <= 8; i++) {
    const e = state.monitorByOrbit?.get(`c${i}`);
    if (e) all.push(e);
  }
  if (all.length === 0) {
    host.classList.add("empty");
    host.replaceChildren();
    return;
  }
  host.classList.remove("empty");

  // Diff-update: keep existing pill nodes by `data-orbit` so the fire-pulse
  // animation can target a stable element across renders. Anything missing
  // from `all` is removed; new entries are appended in sort order.
  const existing = new Map<string, HTMLElement>();
  for (const node of Array.from(host.children)) {
    const elNode = node as HTMLElement;
    const k = elNode.dataset.orbit;
    if (k) existing.set(k, elNode);
  }

  const visible = all.slice(0, MAX_VISIBLE_ORBITS);
  const overflow = all.length - visible.length;
  const seen = new Set<string>();

  for (const ev of visible) {
    seen.add(ev.orbit);
    let pill = existing.get(ev.orbit) as HTMLElement | undefined;
    if (!pill) {
      pill = createOrbitPill(ev);
      host.appendChild(pill);
    } else {
      updateOrbitPill(pill, ev);
      host.appendChild(pill); // re-append to maintain sort order
    }
  }

  // Anything in `existing` but not in `seen` is a stale pill — remove it.
  // (Note: fade-outs are handled by toggling `.fading` from the SSE handler,
  // not by removal at render time, so the pill stays until the timer fires.)
  for (const [k, node] of existing) {
    if (!seen.has(k)) {
      // Not in the active list — but if state still has it (i.e. event with
      // active=false), keep it; otherwise drop.
      const ev = state.monitorByOrbit?.get(k);
      if (!ev) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }
  }

  // Drop legacy ".orbit-overflow" if any; append the new one.
  for (const node of Array.from(host.querySelectorAll(".orbit-overflow"))) {
    node.remove();
  }
  if (overflow > 0) {
    host.appendChild(el("div", { class: "orbit-overflow" }, [`+${overflow}`]));
  }
}

function createOrbitPill(ev: OrbitMonitorEvent): HTMLElement {
  const c = getOrbitColor(ev.orbit);
  const pill = document.createElement("div");
  pill.className = `lidal-feedback-orbit-pill ${ev.type}`;
  pill.dataset.orbit = ev.orbit;
  pill.style.borderLeftColor = c.color;
  pill.style.color = c.color;

  const fire = document.createElement("span");
  fire.className = "lidal-feedback-orbit-fire";
  fire.setAttribute("aria-hidden", "true");
  pill.appendChild(fire);

  const name = document.createElement("span");
  name.className = "lidal-feedback-orbit-name";
  name.textContent = ev.orbit;
  pill.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "lidal-feedback-orbit-meta";
  pill.appendChild(meta);

  // Note vs ctrl: extra body slot. We always create both placeholders and
  // toggle visibility through textContent so updates don't reshape the DOM.
  if (ev.type === "ctrl") {
    const meter = document.createElement("span");
    meter.className = "lidal-feedback-orbit-meter";
    const fill = document.createElement("span");
    fill.className = "lidal-feedback-orbit-meter-fill";
    meter.appendChild(fill);
    pill.appendChild(meter);
  }
  const val = document.createElement("span");
  val.className = "lidal-feedback-orbit-val";
  pill.appendChild(val);

  const cycle = document.createElement("span");
  cycle.className = "lidal-feedback-orbit-cycle";
  pill.appendChild(cycle);

  updateOrbitPill(pill, ev);
  return pill;
}

function updateOrbitPill(pill: HTMLElement, ev: OrbitMonitorEvent): void {
  const meta = pill.querySelector(".lidal-feedback-orbit-meta") as HTMLElement | null;
  const val = pill.querySelector(".lidal-feedback-orbit-val") as HTMLElement | null;
  const cycle = pill.querySelector(".lidal-feedback-orbit-cycle") as HTMLElement | null;
  const fill = pill.querySelector(".lidal-feedback-orbit-meter-fill") as HTMLElement | null;

  if (ev.type === "ctrl") {
    // For ctrl orbits: prominent CC number, current value (numeric 0..127),
    // and a horizontal meter bar.
    // `lastValue` is typed as string | number on the server side; ctrl emits
    // numbers. Coerce defensively.
    const numeric = typeof ev.lastValue === "number" ? ev.lastValue : Number(ev.lastValue);
    const clamped = Math.max(0, Math.min(127, Number.isFinite(numeric) ? numeric : 0));
    if (meta) meta.textContent = `ch${ev.channel}`;
    if (val) val.textContent = `= ${Math.round(clamped)}`;
    if (fill) fill.style.width = `${(clamped / 127) * 100}%`;
  } else {
    if (meta) meta.textContent = `ch${ev.channel}`;
    if (val) val.textContent = `${ev.lastValue}`;
  }
  if (cycle) cycle.textContent = `· #${ev.lastCycle}`;

  // Fade-out gating: if the orbit just went inactive, mark `.fading` so CSS
  // dims it. (Removal is scheduled by the SSE handler that called us.)
  if (!ev.active) pill.classList.add("fading");
  else pill.classList.remove("fading");
}

function pulseOrbit(orbit: string): void {
  const host = state.monitor;
  if (!host) return;
  const pill = host.querySelector(`.lidal-feedback-orbit-pill[data-orbit="${orbit}"]`) as HTMLElement | null;
  if (!pill) return;
  pill.classList.remove("firing");
  // Trigger a reflow so the animation restarts cleanly.
  void pill.offsetWidth;
  pill.classList.add("firing");
}

// Schedule a 3-second fade then removal for an orbit. Cancels any prior
// pending removal for the same orbit (e.g. it reactivated in the interim,
// in which case the caller has already cleared the timer).
function scheduleOrbitFade(orbit: string): void {
  if (!state.pillFadeTimers) return;
  const prev = state.pillFadeTimers.get(orbit);
  if (prev != null) window.clearTimeout(prev);
  const handle = window.setTimeout(() => {
    state.pillFadeTimers?.delete(orbit);
    // Final state-check: if it came back to active, leave it alone.
    const ev = state.monitorByOrbit?.get(orbit);
    if (ev && ev.active) return;
    state.monitorByOrbit?.delete(orbit);
    renderMonitor();
  }, PILL_FADE_MS);
  state.pillFadeTimers.set(orbit, handle);
}

// ── Log panel (search + filters) ─────────────────────────────────────────

const LOG_MAX_ROWS = 200;
const LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];
const SOURCES: LogSource[] = ["eval", "pattern", "sync", "bake", "automap", "system"];

interface LogState {
  entries: LogEntry[];
  search: string;
  enabledLevels: Set<LogLevel>;
  enabledSources: Set<LogSource>;
}

const logState: LogState = {
  entries: [],
  search: "",
  enabledLevels: new Set(LEVELS),
  enabledSources: new Set(SOURCES),
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logMatches(entry: LogEntry): boolean {
  if (!logState.enabledLevels.has(entry.level)) return false;
  if (!logState.enabledSources.has(entry.source)) return false;
  if (logState.search) {
    const needle = logState.search.toLowerCase();
    const hay = (entry.message + " " + (entry.detail ?? "")).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function logIsAtBottom(body: HTMLElement): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight < 8;
}

function makeRow(entry: LogEntry): HTMLElement {
  const row = el("div", {
    class: `log-row ${entry.level}`,
    role: "listitem",
    "aria-label": `${entry.level} ${entry.source} ${entry.message}`,
  });
  const hasDetail = typeof entry.detail === "string" && entry.detail.length > 0;
  if (hasDetail) row.classList.add("has-detail");
  const expand = el("span", { class: "log-expand" }, [hasDetail ? "+" : " "]);
  const ts  = el("span", { class: "log-ts" },  [fmtTime(entry.ts)]);
  const lvl = el("span", { class: "log-lvl" }, [entry.level.toUpperCase()]);
  const src = el("span", { class: "log-src" }, [entry.source]);
  const msg = el("span", { class: "log-msg" }, [entry.message]);
  row.append(expand, ts, lvl, src, msg);
  if (hasDetail) {
    const detail = el("div", { class: "log-detail" }, [entry.detail!]);
    row.appendChild(detail);
    row.addEventListener("click", () => {
      row.classList.toggle("open");
      expand.textContent = row.classList.contains("open") ? "–" : "+";
    });
  }
  return row;
}

function renderLogList(): void {
  const body = $("logBody");
  const empty = $("logEmpty");
  const badge = $("logBadge");
  if (!body) return;
  body.innerHTML = "";
  const matches = logState.entries.filter(logMatches);
  if (matches.length === 0) {
    if (empty) {
      empty.textContent = logState.entries.length === 0 ? "No log entries yet." : "No entries match the current filters.";
      body.appendChild(empty);
    }
  } else {
    for (const e of matches) body.appendChild(makeRow(e));
    body.scrollTop = body.scrollHeight;
  }
  if (badge) badge.textContent = String(logState.entries.length);
}

// Re-export of the pure merge helper for module-level use. The actual logic
// lives in ./log-merge.ts so it's testable in vitest without pulling in
// CodeMirror.
function mergeLogSnapshot(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  return mergeLogSnapshotPure(existing, incoming, LOG_MAX_ROWS) as LogEntry[];
}

function appendLogEntry(entry: LogEntry): void {
  const body = $("logBody");
  if (!body) return;
  const stick = logIsAtBottom(body);
  // Dedup by id when present — a duplicate emission (e.g. SSE replay + live
  // emit racing) shouldn't double-render.
  if (typeof entry.id === "number" && logState.entries.some((e) => e.id === entry.id)) {
    return;
  }
  logState.entries.push(entry);
  while (logState.entries.length > LOG_MAX_ROWS) logState.entries.shift();
  if (logMatches(entry)) {
    const empty = $("logEmpty");
    if (empty && empty.parentNode === body) body.removeChild(empty);
    const row = makeRow(entry);
    // Tag fresh rows so the CSS keyframes play. Drop the tag after the
    // animation runs so a future re-render of the same DOM element (e.g.
    // when filters change) doesn't re-trigger it.
    row.classList.add("new");
    body.appendChild(row);
    window.setTimeout(() => row.classList.remove("new"), 260);
    while (body.childElementCount > LOG_MAX_ROWS) {
      const first = body.firstElementChild;
      if (first) body.removeChild(first);
    }
    if (stick) body.scrollTop = body.scrollHeight;
  }
  const badge = $("logBadge");
  if (badge) badge.textContent = String(logState.entries.length);
}

// ── Banner (first-run) ───────────────────────────────────────────────────

const BANNER_KEY = "lidal.welcome.dismissed.v1";

function maybeShowBanner(): void {
  let dismissed = false;
  try { dismissed = window.localStorage.getItem(BANNER_KEY) === "1"; } catch { /* ignore */ }
  if (dismissed) return;
  const host = $("banner");
  if (!host) return;
  host.classList.add("visible");
  const show = host.querySelector("[data-action=show]") as HTMLElement | null;
  const dismiss = host.querySelector("[data-action=dismiss]") as HTMLElement | null;
  const details = host.querySelector(".banner-details") as HTMLElement | null;
  if (show && details) {
    show.addEventListener("click", () => {
      const open = details.classList.toggle("open");
      show.setAttribute("aria-expanded", String(open));
    });
  }
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      try { window.localStorage.setItem(BANNER_KEY, "1"); } catch { /* ignore */ }
      host.classList.remove("visible");
    });
  }
}

// ── User-edit tracking ──────────────────────────────────────────────────
//
// Once the user has touched the editor since mount, we never overwrite the
// document from a server-driven event — not for the first-status race, not
// for snippet prepends, not for anything. The editor must never interfere
// with live coding.
//
// `Transaction.userEvent` is set on transactions that originated from input
// devices (typing, paste, delete, etc.); programmatic dispatches don't set
// it unless we explicitly opt in, so this cleanly distinguishes "the user
// touched this" from our own writes (initial sync, snippet insert, palette
// "insert default buffer", flash effects, diagnostics).
let userHasEdited = false;

function noteUserEditsFromUpdate(transactions: readonly Transaction[]): void {
  if (userHasEdited) return;
  for (const tr of transactions) {
    if (tr.annotation(Transaction.userEvent) != null) {
      userHasEdited = true;
      return;
    }
  }
}

// ── Buffer sync (debounced) ──────────────────────────────────────────────

// [ED-agent fix #33] Two-tab divergence guard. We track whether this tab is
// the "primary" (first connected) or a secondary tab; secondary tabs disable
// the debounced /api/buffer push so the server's buffer doesn't ping-pong
// between two editors' debouncers. Set by the editor-presence SSE handler
// (see connectSse). Default = primary so a tab that connects without ever
// hearing presence still autosaves.
let isPrimaryEditor = true;
// Tracks our own arrival order — the first tab is primary, later tabs become
// secondary. Because the server doesn't (yet) tell us "you are #N", we
// promote the first time we receive presence: if at first hearing the count
// is already >1, we joined late → secondary. Otherwise we're primary.
let presenceFirstSeen = true;

let bufferSyncTimer: number | null = null;
function scheduleBufferSync(view: EditorView): void {
  // Secondary tab: skip the debounced server push entirely. The primary tab
  // owns autosave; the secondary keeps editing locally but doesn't fight for
  // the canonical buffer.
  if (!isPrimaryEditor) return;
  if (bufferSyncTimer != null) window.clearTimeout(bufferSyncTimer);
  bufferSyncTimer = window.setTimeout(() => {
    bufferSyncTimer = null;
    const text = view.state.doc.toString();
    if (!text || !text.trim()) return;
    postJson("/api/buffer", { buffer: text }).catch(() => { /* transient */ });
  }, 750);
}

// Show / hide the secondary-tab warning banner. Mounted lazily into <main>
// the first time we have to surface it. Visible as long as another tab is
// connected; auto-clears when this tab becomes the only one.
const SECONDARY_BANNER_ID = "lidal-secondary-warning";
function setSecondaryEditorWarning(visible: boolean): void {
  let banner = document.getElementById(SECONDARY_BANNER_ID);
  if (!visible) {
    if (banner) banner.remove();
    return;
  }
  if (banner) return;
  banner = document.createElement("div");
  banner.id = SECONDARY_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText = [
    "padding:8px 18px",
    "background:#5a4020",
    "border-bottom:1px solid #8a6638",
    "color:#fff",
    "font-size:12px",
    "font-weight:600",
  ].join(";");
  banner.textContent =
    "Lidal is open in another browser tab — autosave is disabled here to prevent the two tabs from overwriting each other. Close one tab to resume normal editing.";
  // Mount just above the orbit-monitor strip so it's visible without
  // scrolling and doesn't displace the header.
  const monitor = document.getElementById("orbit-monitor");
  if (monitor?.parentNode) monitor.parentNode.insertBefore(banner, monitor);
  else document.body.prepend(banner);
}

// ── Actions (eval/stop/bake) ─────────────────────────────────────────────

async function doEval(view: EditorView, code: string, range: { from: number; to: number } | null): Promise<void> {
  if (range) flashLines(view, range.from, range.to, "fired");
  if (range) state.lastEvalRange = range;
  // Speculative: clear any prior diagnostics on the range we're re-evaluating.
  // If the eval errors, we'll re-add them; the brief flicker is fine.
  if (range) clearLidalDiagnostics(view);
  try {
    const result = await postJson<{ error?: string }>("/api/eval", {
      code,
      buffer: view.state.doc.toString(),
      bpm: parseFloat(state.bpmInput!.value) || 120,
      cycleBeats: parseFloat(state.cycleInput!.value) || 4,
    });
    if (result.error) {
      setStatusText(`error: ${result.error}`, "error");
      // Best-effort: locate the error within the eval range so the squiggle
      // hugs a specific token; fall back to the whole range.
      const located = range
        ? locateErrorInRange(result.error, undefined, view.state.doc, range)
        : null;
      setLidalDiagnostics(view, [{
        message: result.error,
        from: located?.from,
        to: located?.to,
        fallbackRange: range ?? undefined,
        severity: "error",
      }]);
    }
  } catch (e) {
    setStatusText(`fetch failed: ${(e as Error).message}`, "error");
  }
}

function doEvalBlock(view: EditorView): void {
  const b = blockUnderCursor(view);
  void doEval(view, b.code, b);
}

function doEvalAll(view: EditorView): void {
  const text = view.state.doc.toString();
  void doEval(view, text, { from: 0, to: text.length });
}

async function doStop(): Promise<void> {
  try { await postJson("/api/stop", {}); }
  catch (e) { setStatusText(`fetch failed: ${(e as Error).message}`, "error"); }
}

function showBakeMessage(klass: string, label: string): void {
  state.bakeMessageUntil = Date.now() + 3500;
  setStatusText(label, klass);
}

async function doBake(view: EditorView): Promise<void> {
  const b = blockUnderCursor(view);
  if (!b.code.trim()) { showBakeMessage("error", "bake: empty block"); return; }

  // Extract typed orbits from the block — same regex semantics as the old client.
  const noteSet = new Set<number>();
  const ctrlSet = new Set<number>();
  const re = /^\s*([dc])(\d+)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(b.code)) !== null) {
    const num = parseInt(m[2], 10);
    if (m[1] === "d" && num >= 1 && num <= 16) noteSet.add(num);
    else if (m[1] === "c" && num >= 1 && num <= 8) ctrlSet.add(num);
  }
  // Intersect against currently-active orbits so commented-out lines don't trip up.
  const activeD = new Set((state.lastStatus?.orbits) || []);
  const activeC = new Set((state.lastStatus?.controlOrbits) || []);
  const orbits = [...noteSet].filter((n) => activeD.has(n));
  const controlOrbits = [...ctrlSet].filter((n) => activeC.has(n));

  if (orbits.length === 0 && controlOrbits.length === 0) {
    showBakeMessage("error", "bake: no orbits in block");
    return;
  }
  if (orbits.length === 0 && controlOrbits.length > 0) {
    showBakeMessage("error", "bake: CC orbits not bakeable (no SDK automation API)");
    return;
  }

  flashLines(view, b.from, b.to, "baking");
  showBakeMessage("", "baking…");
  const cycles = Math.max(1, Math.min(8, parseInt(state.bakeCyclesInput!.value, 10) || 4));
  state.lastBakeCycles = cycles;
  try {
    const result = await postJson<{ ok?: boolean; message?: string }>("/api/bake", { orbits, controlOrbits, cycles });
    if (!result.ok) {
      showBakeMessage("error", result.message || "bake failed");
    }
  } catch (e) {
    showBakeMessage("error", `bake fetch failed: ${(e as Error).message}`);
  }
}

// ── CodeMirror setup ─────────────────────────────────────────────────────

const editableCompartment = new Compartment();

function buildView(parent: HTMLElement, initialDoc: string): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [lidalCompletions], activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      lidalLanguage,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      lidalHighlighting,
      lidalHoverTooltip,
      flashExtension,
      diagnosticsExtension,
      orbitColorPlugin,
      EditorView.lineWrapping,
      keymap.of([
        // Block evaluation
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: (view) => { doEvalBlock(view); return true; },
        },
        // Whole-buffer evaluation
        {
          key: "Shift-Mod-Enter",
          preventDefault: true,
          run: (view) => { doEvalAll(view); return true; },
        },
        // Bake N cycles
        {
          key: "Mod-b",
          preventDefault: true,
          run: (view) => { void doBake(view); return true; },
        },
        // Hush
        {
          key: "Mod-.",
          preventDefault: true,
          run: () => { void doStop(); return true; },
        },
        // Comment toggle (Mod-/) — uses our `--` line comment via languageData.
        {
          key: "Mod-/",
          preventDefault: true,
          run: toggleLineComment,
        },
        // Explicit autocomplete
        {
          key: "Ctrl-Space",
          preventDefault: true,
          run: startCompletion,
        },
        // Help overlay — both `Mod-?` and `Shift-Mod-/` (the actual keystroke
        // most layouts produce when the user thinks "Cmd+?").
        {
          key: "Mod-?",
          preventDefault: true,
          run: () => { toggleHelpOverlay(); return true; },
        },
        {
          key: "Shift-Mod-/",
          preventDefault: true,
          run: () => { toggleHelpOverlay(); return true; },
        },
        // Command palette
        {
          key: "Mod-p",
          preventDefault: true,
          run: () => { openPalette(); return true; },
        },
        // Tab indents (instead of focus-stealing the default), Shift-Tab outdents.
        { key: "Tab", preventDefault: true, run: indentMore },
        { key: "Shift-Tab", preventDefault: true, run: indentLess },
        ...defaultKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...completionKeymap,
        ...foldKeymap,
        ...lintKeymap,
      ]),
      // Push every editor change through the debounced buffer sync. Also
      // mark `userHasEdited` for any transaction that originated from a
      // user input — that flag gates every server-driven doc rewrite, so
      // typing during page load can't be clobbered by the SSE handshake.
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        noteUserEditsFromUpdate(u.transactions);
        scheduleBufferSync(u.view);
      }),
      // Theme — match the editor-page.ts dark palette.
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.theme({
        "&": {
          backgroundColor: "var(--surface)",
          color: "var(--fg)",
          height: "100%",
          fontSize: "14px",
          border: "1px solid var(--border)",
          borderRadius: "4px",
        },
        ".cm-scroller": {
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          lineHeight: "1.55",
        },
        ".cm-content": { caretColor: "var(--accent)", padding: "14px 0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
        ".cm-gutters": {
          backgroundColor: "var(--surface)",
          color: "var(--fg-faint)",
          borderRight: "1px solid var(--border)",
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px", minWidth: "24px" },
        // Bumped from 0.03 to 0.055 — the prior value was nearly invisible.
        ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.055)" },
        ".cm-activeLineGutter": {
          backgroundColor: "rgba(255,255,255,0.07)",
          color: "var(--fg-dim)",
        },
        ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(111,179,123,0.22)" },
        "&.cm-focused": { outline: "none" },
        "&.cm-focused .cm-selectionBackground, &.cm-focused ::selection": { backgroundColor: "rgba(111,179,123,0.32)" },
        ".cm-matchingBracket, .cm-nonmatchingBracket": {
          backgroundColor: "rgba(127,182,217,0.18)",
          outline: "1px solid rgba(127,182,217,0.4)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--surface)",
          color: "var(--fg)",
          border: "1px solid var(--border-strong)",
          borderRadius: "4px",
          fontSize: "12px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul": {
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          maxHeight: "14em",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
          padding: "3px 8px",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
          backgroundColor: "var(--accent-bg)",
          color: "#fff",
        },
        ".cm-completionInfo": {
          backgroundColor: "var(--surface)",
          color: "var(--fg-dim)",
          border: "1px solid var(--border-strong)",
          borderRadius: "4px",
          padding: "6px 10px",
          fontSize: "11.5px",
          maxWidth: "360px",
          lineHeight: "1.5",
        },
        ".cm-snippetField": {
          backgroundColor: "rgba(111,179,123,0.18)",
          borderRadius: "2px",
        },
        ".cm-snippetFieldPosition": {
          borderLeft: "2px solid var(--accent)",
        },
      }, { dark: true }),
    ],
  });
  return new EditorView({ state, parent });
}

// ── Log panel UI wiring ──────────────────────────────────────────────────

function buildLogControls(): void {
  const filterRow = $("logFilters");
  if (!filterRow) return;
  filterRow.innerHTML = "";

  const searchWrap = el("div", { class: "log-search" });
  const search = el("input", {
    type: "search",
    placeholder: "Search logs…",
    "aria-label": "Search log entries",
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    logState.search = search.value;
    renderLogList();
  });
  searchWrap.appendChild(search);
  filterRow.appendChild(searchWrap);

  const levelGroup = el("div", { class: "log-chip-group", role: "group", "aria-label": "Log level filter" });
  for (const lvl of LEVELS) {
    const chip = el("button", {
      type: "button",
      class: `log-chip lvl-${lvl} active`,
      "data-level": lvl,
      "aria-pressed": "true",
    }, [lvl.toUpperCase()]);
    chip.addEventListener("click", () => {
      const active = chip.classList.toggle("active");
      chip.setAttribute("aria-pressed", String(active));
      if (active) logState.enabledLevels.add(lvl);
      else logState.enabledLevels.delete(lvl);
      renderLogList();
    });
    levelGroup.appendChild(chip);
  }
  filterRow.appendChild(levelGroup);

  const sourceGroup = el("div", { class: "log-chip-group", role: "group", "aria-label": "Log source filter" });
  for (const src of SOURCES) {
    const chip = el("button", {
      type: "button",
      class: `log-chip src-${src} active`,
      "data-source": src,
      "aria-pressed": "true",
    }, [src]);
    chip.addEventListener("click", () => {
      const active = chip.classList.toggle("active");
      chip.setAttribute("aria-pressed", String(active));
      if (active) logState.enabledSources.add(src);
      else logState.enabledSources.delete(src);
      renderLogList();
    });
    sourceGroup.appendChild(chip);
  }
  filterRow.appendChild(sourceGroup);
}

// ── Orbit colour stylesheet ──────────────────────────────────────────────

// Inject the per-orbit CSS once at boot. Idempotent — re-init is a no-op.
function injectOrbitColorStyles(): void {
  if (document.getElementById("feedback-orbit-styles")) return;
  const style = document.createElement("style");
  style.id = "feedback-orbit-styles";
  style.textContent = orbitColorCss();
  document.head.appendChild(style);
}

// ── Cycle indicator ──────────────────────────────────────────────────────

function updateCycleIndicator(): void {
  if (!state.cycleIndicator) return;
  const s = state.lastStatus;
  const sync = state.syncStatus;
  const mode = (sync?.mode ?? s?.syncMode ?? "manual") as SyncMode;
  const bpm = sync?.bpm ?? s?.bpm ?? 120;
  const quantum = sync?.quantum ?? s?.cycleBeats ?? 4;
  const linkAvailable = sync?.linkAvailable ?? s?.linkAvailable ?? true;
  // `playing` derivation: manual is always allowed to play when running;
  // external sources are playing when transport reports it (best signal we
  // have is `running` on the status snapshot).
  const playing = !!(s?.running);
  state.cycleIndicator.update({ mode, bpm, quantum, linkAvailable, playing, cycleN: s?.cycleN });
}

// ── SSE wiring ───────────────────────────────────────────────────────────

function connectSse(view: EditorView): void {
  let firstStatus = true;
  const focusTimer = window.setTimeout(() => {
    // Safety: if SSE never connects, focus the editor anyway so the user can type.
    if (firstStatus) view.focus();
  }, 2000);

  // SSE URL carries the CSRF token (the only way to authenticate a stream
  // since EventSource doesn't support custom headers). The server rejects
  // missing/mismatched tokens with 403 before opening the stream.
  const es = new EventSource(`/api/events?t=${encodeURIComponent(csrfToken())}`);

  es.addEventListener("status", (msg) => {
    try {
      const s = JSON.parse((msg as MessageEvent).data) as ServerStatus;
      state.lastStatus = s;
      if (firstStatus) {
        firstStatus = false;
        window.clearTimeout(focusTimer);
        // Initial sync only: cover the race where the server-side buffer
        // changed between rendering the HTML (data-initial-buffer attribute)
        // and the SSE handshake. After this, the client owns the doc — every
        // legitimate server-driven mutation arrives via the explicit
        // `snippet` event, not status broadcasts.
        //
        // Critical guard: if the user already started typing between CM
        // mount and the SSE handshake, do NOT overwrite. Live-coding must
        // never be interrupted by a stale buffer sync. The race we were
        // covering (concurrent /api/buffer push, etc.) is far less likely
        // than the keystroke-race in the other direction.
        if (!userHasEdited
            && typeof s.buffer === "string"
            && s.buffer.length > 0
            && view.state.doc.toString() !== s.buffer) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s.buffer } });
        }
        // Only steal focus on initial mount if the user hasn't already
        // taken focus elsewhere (e.g. a different input or window).
        if (!userHasEdited && document.activeElement === document.body) view.focus();
      }
      // NOTE: we intentionally do NOT consume s.buffer on subsequent status
      // pushes. Status is broadcast on every cycle and includes the
      // round-tripped server buffer; the prior focus-guarded overwrite check
      // was unreliable (CM's focused element is `.cm-content`, not view.dom)
      // and would eat live keystrokes between debounced syncs.
      // Sync inputs (unless focused).
      if (state.bpmInput && document.activeElement !== state.bpmInput) state.bpmInput.value = (s.bpm ?? 120).toFixed(2);
      if (state.cycleInput && document.activeElement !== state.cycleInput) state.cycleInput.value = String(s.cycleBeats);
      if (state.syncSelect && s.syncMode && state.syncSelect.value !== s.syncMode) state.syncSelect.value = s.syncMode;
      // BPM is read-only when externally synced.
      if (state.bpmInput) {
        const synced = s.syncMode && s.syncMode !== "manual";
        state.bpmInput.readOnly = !!synced;
        state.bpmInput.style.opacity = synced ? "0.7" : "1";
      }
      // Disable Link option if not available
      if (state.syncSelect) {
        const linkOpt = state.syncSelect.querySelector('option[value="link"]') as HTMLOptionElement | null;
        if (linkOpt) linkOpt.disabled = !s.linkAvailable;
      }
      // Bake outcome
      if (s.lastBake && s.lastBake.ts && s.lastBake.ts !== state.lastSeenBakeTs) {
        state.lastSeenBakeTs = s.lastBake.ts;
        state.bakeMessageUntil = Date.now() + 3500;
        setStatusText(s.lastBake.message, s.lastBake.ok ? "running" : "error");
        // Success only: show the bake toast. Failures stay in the log panel.
        if (s.lastBake.ok && state.bakeToast) {
          const summary = summarizeBakeMessage(s.lastBake.message, state.lastBakeCycles ?? undefined);
          state.bakeToast.show(summary);
        }
        return;
      }
      renderStatus();
      updateCycleIndicator();
    } catch (e) { console.warn("status parse", e); }
  });

  es.addEventListener("snippet", (msg) => {
    try {
      const parsed = JSON.parse((msg as MessageEvent).data) as {
        snippet?: string;
        orbit?: number;
        kind?: "drumMap" | "raw";
      };
      const snippet = parsed.snippet;
      if (typeof snippet !== "string" || snippet.length === 0) return;
      // [ED-agent fix #12] Idempotent drumMap insert: if the snippet is
      // tagged with an orbit AND the buffer already has a `drumMap <orbit>
      // "..."` line, replace that line in place instead of prepending a new
      // one. Preserves the user's caret + the typing-preservation guard from
      // commit 9933269 — we still gate on `userHasEdited` / `view.hasFocus`
      // to decide whether to keep the cursor or highlight the new snippet.
      const editorFocused = view.hasFocus;
      const orbit = parsed.orbit;
      const isDrumMap = parsed.kind === "drumMap" || (typeof orbit === "number" && /^drumMap\s+\d+\b/.test(snippet));
      if (isDrumMap && typeof orbit === "number") {
        const cur = view.state.doc.toString();
        const re = new RegExp(`^[ \\t]*drumMap[ \\t]+${orbit}\\b[^\\n]*$`, "m");
        const m = re.exec(cur);
        if (m) {
          const from = m.index;
          const to = from + m[0].length;
          const prev = view.state.selection.main;
          // Adjust the caret if it was past the replaced line — keep
          // line-relative position when typing inside the line, otherwise
          // shift by the size delta. We don't want to fight the user.
          const delta = snippet.length - m[0].length;
          let anchor = prev.anchor;
          let head = prev.head;
          if (anchor > to) anchor += delta;
          else if (anchor > from) anchor = Math.min(from + snippet.length, anchor + delta);
          if (head > to) head += delta;
          else if (head > from) head = Math.min(from + snippet.length, head + delta);
          if (editorFocused || userHasEdited) {
            view.dispatch({
              changes: { from, to, insert: snippet },
              selection: { anchor, head },
              scrollIntoView: false,
            });
          } else {
            view.dispatch({
              changes: { from, to, insert: snippet },
              selection: { anchor: from, head: from + snippet.length },
            });
            view.focus();
          }
          return;
        }
      }
      const cur = view.state.doc.toString();
      const sep = cur.startsWith("\n") || cur.length === 0 ? "" : "\n\n";
      const inserted = snippet + sep;
      const insertLen = inserted.length;
      // If the user is actively in the editor (focused or has typed since
      // mount), prepend without disturbing their cursor — shift the existing
      // selection forward by the inserted length so they stay on the same
      // logical character. The new snippet appears at the top, but their
      // typing context is unchanged.
      //
      // If the editor was unfocused (typical post-modal flow: user invoked
      // auto-map drums from a Live context menu and confirmed in the dialog),
      // highlight the new snippet and focus the editor so they can see what
      // landed and Cmd+Z it if needed.
      if (editorFocused || userHasEdited) {
        const prev = view.state.selection.main;
        view.dispatch({
          changes: { from: 0, insert: inserted },
          selection: { anchor: prev.anchor + insertLen, head: prev.head + insertLen },
          scrollIntoView: false,
        });
      } else {
        view.dispatch({
          changes: { from: 0, insert: inserted },
          selection: { anchor: 0, head: snippet.length },
        });
        view.focus();
      }
    } catch (e) { console.warn("snippet parse", e); }
  });

  es.addEventListener("log-snapshot", (msg) => {
    try {
      const entries = JSON.parse((msg as MessageEvent).data) as LogEntry[];
      // [ED-agent fix #9] Merge by monotonic id rather than full-replacing.
      // The server's ring buffer holds at most 200 entries; if more than 200
      // entries scrolled by while the client was disconnected, the snapshot
      // we receive will be missing some that the client already showed. A
      // naive replace would wipe those from the user's view. Instead, union
      // by id (or by `ts+message` for old entries that pre-date the id
      // upgrade), then keep the most recent LOG_MAX_ROWS.
      const incoming = Array.isArray(entries) ? entries : [];
      logState.entries = mergeLogSnapshot(logState.entries, incoming);
      renderLogList();
    } catch (e) { console.warn("log-snapshot parse", e); }
  });

  es.addEventListener("log", (msg) => {
    try {
      const entry = JSON.parse((msg as MessageEvent).data) as LogEntry;
      if (entry && typeof entry.message === "string") appendLogEntry(entry);
    } catch (e) { console.warn("log parse", e); }
  });

  // New SSE event types from the backend agent's lifecycle work. Both are
  // optional — if the backend hasn't merged yet we just never receive them.
  es.addEventListener("orbit-monitor", (msg) => {
    try {
      const ev = JSON.parse((msg as MessageEvent).data) as OrbitMonitorEvent;
      if (!ev || typeof ev.orbit !== "string") return;
      if (!state.monitorByOrbit) state.monitorByOrbit = new Map();
      const prev = state.monitorByOrbit.get(ev.orbit);
      state.monitorByOrbit.set(ev.orbit, ev);

      // Active → inactive: schedule the fade. Inactive → active: cancel any
      // pending fade so the pill stays put.
      if (ev.active) {
        const t = state.pillFadeTimers?.get(ev.orbit);
        if (t != null) { window.clearTimeout(t); state.pillFadeTimers?.delete(ev.orbit); }
      } else if (!prev || prev.active) {
        scheduleOrbitFade(ev.orbit);
      }

      // Re-render on any composition change (presence, type, channel, value,
      // active flip). Just pulsing without a re-render skips the meter fill
      // update for ctrl orbits, so we render on value change too.
      const composeChanged = !prev || prev.active !== ev.active || prev.type !== ev.type
        || prev.channel !== ev.channel || prev.lastValue !== ev.lastValue;
      if (composeChanged) renderMonitor();
      if (prev && prev.lastCycle !== ev.lastCycle && ev.active) pulseOrbit(ev.orbit);
    } catch (e) { console.warn("orbit-monitor parse", e); }
  });

  es.addEventListener("sync-status", (msg) => {
    try {
      const ev = JSON.parse((msg as MessageEvent).data) as SyncStatusEvent;
      state.syncStatus = ev;
      renderStatus();
      updateCycleIndicator();
    } catch (e) { console.warn("sync-status parse", e); }
  });

  // [ED-agent fix #33] Two-tab divergence: server tells us the live client
  // count. First presence event after a fresh connect determines our role:
  //   - count === 1 → we're alone, primary editor, autosave on.
  //   - count >  1 → we joined an already-connected editor → secondary,
  //                  autosave off, warning banner up.
  // Subsequent updates may demote us (another tab opens) or restore us
  // (the other tab closes).
  es.addEventListener("editor-presence", (msg) => {
    try {
      const { clientCount } = JSON.parse((msg as MessageEvent).data) as { clientCount?: number };
      if (typeof clientCount !== "number") return;
      if (presenceFirstSeen) {
        presenceFirstSeen = false;
        // If we arrived as the only client we own autosave. Anything >1
        // means we joined into an existing session.
        isPrimaryEditor = clientCount <= 1;
      } else {
        // After the first read, the only way the count goes back to 1 is if
        // the other tabs closed — in which case we earn primary status.
        if (clientCount <= 1) isPrimaryEditor = true;
      }
      setSecondaryEditorWarning(!isPrimaryEditor && clientCount > 1);
    } catch (e) { console.warn("editor-presence parse", e); }
  });

  es.onerror = () => setStatusText("disconnected — retrying…", "disconnected");
}

// ── Bootstrap ────────────────────────────────────────────────────────────

function init(): void {
  const editorHost = $("editor-host");
  const statusEl = $("status-pill");
  const bpm = $("bpm") as HTMLInputElement | null;
  const cycle = $("cycle") as HTMLInputElement | null;
  const bakeCycles = $("bakeCycles") as HTMLInputElement | null;
  const sync = $("sync") as HTMLSelectElement | null;
  const monitor = $("orbit-monitor");
  if (!editorHost || !statusEl || !bpm || !cycle || !bakeCycles || !sync || !monitor) {
    console.error("[Lidal] editor placeholders missing");
    return;
  }

  // Initial buffer: dataset attribute set by the server-side renderer.
  const initialDoc = editorHost.dataset.initialBuffer ?? "";

  const view = buildView(editorHost, initialDoc);

  // Remove the no-script fallback now that CM has mounted; it was sized
  // to fill #editor-host and would otherwise overlay the live editor.
  const fallback = document.getElementById("editor-fallback");
  if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback);

  state.view = view;
  state.status = statusEl;
  state.bpmInput = bpm;
  state.cycleInput = cycle;
  state.bakeCyclesInput = bakeCycles;
  state.syncSelect = sync;
  state.monitor = monitor;
  state.lastStatus = null;
  state.lastSeenBakeTs = 0;
  state.bakeMessageUntil = 0;
  state.monitorByOrbit = new Map();
  state.syncStatus = null;
  state.lastEvalRange = null;
  state.pillFadeTimers = new Map();
  state.cycleIndicator = null;
  state.bakeToast = null;
  state.lastBakeCycles = null;

  // Inject the per-orbit colour rules once. The host page can't generate them
  // (it's server-rendered without TS imports), so the client owns them.
  injectOrbitColorStyles();

  // Mount the cycle indicator right next to the status pill, before it in
  // the header so the ring sits to the *left* of the textual status.
  const indicator = createCycleIndicator();
  state.cycleIndicator = indicator;
  if (statusEl.parentNode) statusEl.parentNode.insertBefore(indicator.el, statusEl);

  // Mount the bake toast inside <main> so it sits above the log panel.
  const mainEl = document.querySelector("main");
  const toast = createBakeToast();
  state.bakeToast = toast;
  (mainEl ?? document.body).appendChild(toast.el);

  // Status pill ARIA — announced when state changes (server pushes).
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  // Buttons
  const evalBtn = $("evalBlock");
  const evalAllBtn = $("evalAll");
  const stopBtn = $("stop");
  evalBtn?.addEventListener("click", () => doEvalBlock(view));
  evalAllBtn?.addEventListener("click", () => doEvalAll(view));
  stopBtn?.addEventListener("click", () => void doStop());

  // Sync select
  sync.addEventListener("change", async () => {
    try { await postJson("/api/sync", { mode: sync.value }); }
    catch (e) { setStatusText(`sync switch failed: ${(e as Error).message}`, "error"); }
  });

  // Log panel
  const logPanel = $("logPanel");
  const logHeader = $("logHeader");
  const logToggle = $("logToggle");
  const logClearBtn = $("logClear");
  buildLogControls();
  renderLogList();
  logHeader?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.closest(".log-filters")) return;
    const open = logPanel?.classList.toggle("open");
    if (logToggle) logToggle.textContent = open ? "▾" : "▸";
    const body = $("logBody");
    if (open && body) body.scrollTop = body.scrollHeight;
  });
  logClearBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { await postJson("/api/log/clear", {}); }
    catch (err) { setStatusText(`log clear failed: ${(err as Error).message}`, "error"); }
  });

  maybeShowBanner();
  initCheatSheet();
  initCommandPalette(view, editorHost.dataset.defaultBuffer ?? "");
  connectSse(view);
}

// ── Cheat sheet (collapsible) ────────────────────────────────────────────

const CHEAT_KEY = "lidal.cheatsheet.expanded.v1";

function initCheatSheet(): void {
  const root = $("cheatsheet");
  const strip = $("cheatsheetStrip");
  if (!root || !strip) return;

  let expanded = false;
  try { expanded = window.localStorage.getItem(CHEAT_KEY) === "1"; }
  catch { /* ignore — privacy mode etc. */ }

  const applyState = (next: boolean) => {
    expanded = next;
    root.classList.toggle("expanded", expanded);
    strip.setAttribute("aria-expanded", String(expanded));
    try { window.localStorage.setItem(CHEAT_KEY, expanded ? "1" : "0"); }
    catch { /* ignore */ }
  };
  applyState(expanded);

  const toggle = () => applyState(!expanded);
  strip.addEventListener("click", toggle);
  strip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
}

// ── Command palette wiring ───────────────────────────────────────────────

function initCommandPalette(view: EditorView, defaultBuffer: string): void {
  registerPaletteCommands([
    {
      id: "eval-block",
      label: "Eval block",
      hint: "⌘↵",
      detail: "Evaluate the block under the cursor",
      run: () => doEvalBlock(view),
    },
    {
      id: "eval-all",
      label: "Eval all",
      hint: "⇧⌘↵",
      detail: "Evaluate the entire buffer",
      run: () => doEvalAll(view),
    },
    {
      id: "hush",
      label: "Hush",
      hint: "⌘.",
      detail: "Stop all orbits",
      run: () => void doStop(),
    },
    {
      id: "bake",
      label: "Bake",
      hint: "⌘B",
      detail: "Bake the last N cycles into MIDI clips",
      run: () => void doBake(view),
    },
    {
      id: "toggle-comment",
      label: "Toggle comment",
      hint: "⌘/",
      detail: "Toggle line comment on the current line/selection",
      run: () => { toggleLineComment(view); view.focus(); },
    },
    {
      id: "help",
      label: "Show help",
      hint: "⌘?",
      detail: "Open the help & reference overlay",
      run: () => openHelpOverlay(),
    },
    {
      id: "sync-manual",
      label: "Switch sync to Manual",
      detail: "Use the BPM field; no external transport",
      run: () => void switchSync("manual"),
    },
    {
      id: "sync-link",
      label: "Switch sync to Ableton Link",
      detail: "Sync tempo + transport over Link",
      run: () => void switchSync("link"),
    },
    {
      id: "sync-midi-clock",
      label: "Switch sync to MIDI Clock",
      detail: "Receive clock via Lidal Clock In",
      run: () => void switchSync("midi-clock"),
    },
    {
      id: "sync-lom",
      label: "Switch sync to LOM",
      detail: "Use Live's transport (Live Object Model)",
      run: () => void switchSync("lom"),
    },
    {
      id: "insert-default-buffer",
      label: "Insert default buffer",
      detail: "Replace the editor contents with the welcome buffer",
      run: () => {
        if (!defaultBuffer) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: defaultBuffer },
          selection: { anchor: 0 },
        });
        view.focus();
      },
    },
    {
      id: "toggle-log",
      label: "Toggle log panel",
      detail: "Expand or collapse the in-page log",
      run: () => {
        const logPanel = $("logPanel");
        const logToggle = $("logToggle");
        if (!logPanel) return;
        const open = logPanel.classList.toggle("open");
        if (logToggle) logToggle.textContent = open ? "▾" : "▸";
        const body = $("logBody");
        if (open && body) body.scrollTop = body.scrollHeight;
      },
    },
  ]);
  // The help overlay module is already kept in the bundle via openHelpOverlay
  // / toggleHelpOverlay usage above; the prior "void isHelpOpen" placeholder
  // was unnecessary.
}

async function switchSync(mode: SyncMode): Promise<void> {
  if (state.syncSelect) state.syncSelect.value = mode;
  try { await postJson("/api/sync", { mode }); }
  catch (e) { setStatusText(`sync switch failed: ${(e as Error).message}`, "error"); }
}

// Bootstrap once the DOM is ready. The bundle is loaded at the end of <body>
// in editor-page.ts, so DOM is usually parsed; guard for `defer` future-proofing.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
