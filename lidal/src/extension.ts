import {
  initialize, MidiClip, RackDevice, DrumChain, Simpler, Track,
  type ActivationContext, type ExtensionContext, type Handle, type NoteDescription,
} from "@ableton-extensions/sdk";
import * as easymidi from "easymidi";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { mkdir, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { PatternScheduler, type CycleSnapshot } from "./scheduler.js";
import { buildSandbox, runUserCode, type AutoMapResult } from "./patterns.js";
import { startServer, generateCsrfToken, type BakeBody, type BakeResult, type ServerHandle } from "./server.js";
import { editorPage } from "./editor-page.js";
import { setDrumMap, clearDrumMap, sampleFilenameToAlias, DRUM_MAP } from "./drums.js";
import {
  ManualSource, LomSource, MidiClockSource, LinkSource,
  type SyncMode, type TempoSource, type SongLike,
} from "./sync.js";
import {
  logAppend, logSnapshot, logClear, onLogAppend, errorDetail,
  type LogEntry, type LogLevel, type LogSource,
} from "./log.js";
import type { OrbitMonitorSample } from "./scheduler.js";
import type { SyncStatusEvent } from "./server.js";

// Coalescing throttle. Leading-edge fire, then suppress for minIntervalMs;
// any calls during the suppression window collapse into a single trailing
// fire at the window's end so the latest state is never lost.
function makeThrottledBroadcaster(broadcast: () => void, minIntervalMs: number): () => void {
  let lastRun = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  return () => {
    const now = Date.now();
    const since = now - lastRun;
    if (since >= minIntervalMs) {
      lastRun = now;
      if (trailing) { clearTimeout(trailing); trailing = null; }
      try { broadcast(); } catch { /* ignore */ }
      return;
    }
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastRun = Date.now();
      try { broadcast(); } catch { /* ignore */ }
    }, minIntervalMs - since);
  };
}

const NOTES_PORT = "Lidal Notes";
const DRUMS_PORT = "Lidal Drums";
const CONTROL_PORT = "Lidal Control";
const MIDI_CLOCK_PORT = "Lidal Clock In";
// `LIDAL_HTTP_PORT` env override lets the headless e2e harness run alongside a
// live Extension Host on 7654 without colliding. Falls back to the production
// port for normal Live launches.
const HTTP_PORT = (() => {
  const raw = process.env.LIDAL_HTTP_PORT;
  if (!raw) return 7654;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 7654;
})();

// Virtual MIDI ports are opened in `activate()` (not at module load) so a
// SIGHUP-driven reload starts from a clean slate: the previous host's
// cleanup handler is given the chance to call `close()` and remove the OS
// port from the MIDI graph before we try to claim it again. Opening at
// module load races that cleanup and historically leaked ports across
// `dev-launch.sh` reload cycles.
//
// To keep the scheduler constructor immutable (it captures the outputs by
// reference), we hand it a `SwappableOutput` that forwards `send`/`close`
// to a swappable inner `easymidi.Output`. `activate()` opens the three
// real outputs (with one retry on failure) and wires them in; the cleanup
// path closes them and clears the inner reference so subsequent sends
// after teardown become no-ops rather than crashes.
interface SwappableOutput extends easymidi.Output {
  setInner(inner: easymidi.Output | null): void;
  getInner(): easymidi.Output | null;
}

function makeSwappableOutput(): SwappableOutput {
  let inner: easymidi.Output | null = null;
  const wrapper: SwappableOutput = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: ((type: any, msg: any) => {
      if (!inner) return;  // port not yet open or already closed — drop silently
      try { (inner.send as (t: unknown, m: unknown) => void)(type, msg); }
      catch { /* OS port disappeared mid-send — drop and let the next open recover */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    close: () => { /* no-op: lifetime is owned by activate()/cleanup, not the scheduler */ },
    setInner(v: easymidi.Output | null) { inner = v; },
    getInner() { return inner; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return wrapper;
}

// Open a virtual MIDI output once, synchronously. Returns null on failure
// so the caller can decide whether to retry/log.
function tryOpenOutputOnce(name: string): easymidi.Output | null {
  try { return new easymidi.Output(name, true); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] virtual MIDI port "${name}" open failed: ${msg}`);
    return null;
  }
}

// Open a port with a single deferred retry. Some macOS launches briefly
// leave a stale port from a crashed prior process visible; a 150ms retry
// covers that without blocking activation. Calls `onResolved` when the
// final state is known (success or both attempts failed).
function openOutputWithRetry(
  name: string,
  onResolved: (out: easymidi.Output | null) => void,
): void {
  const first = tryOpenOutputOnce(name);
  if (first) { onResolved(first); return; }
  setTimeout(() => {
    const second = tryOpenOutputOnce(name);
    if (second) console.log(`[Lidal] virtual MIDI port "${name}" opened on retry`);
    onResolved(second);
  }, 150);
}

const notesPortSwap = makeSwappableOutput();
const drumsPortSwap = makeSwappableOutput();
const controlPortSwap = makeSwappableOutput();
const scheduler = new PatternScheduler(notesPortSwap, drumsPortSwap, controlPortSwap);

// Cross-platform "open URL in default browser" shim. macOS uses `open`,
// Windows uses `start ""` via cmd.exe (the empty title is required because
// the first quoted argument to `start` is taken as the window title),
// Linux uses `xdg-open`. If none of those resolve (uncommon Linux, locked-
// down environment), we don't fail — we log the URL with an instruction so
// the user can still copy/paste it into their browser of choice.
function openUrlInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin": cmd = "open"; args = [url]; break;
    case "win32":  cmd = "cmd";  args = ["/c", "start", "", url]; break;
    case "linux":
    case "freebsd":
    case "openbsd":
    default:       cmd = "xdg-open"; args = [url]; break;
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => {
      console.error(`[Lidal] openUrlInBrowser: spawn "${cmd}" failed: ${e.message}`);
      logEvent(
        "warn",
        "system",
        `couldn't auto-open browser via "${cmd}" — open this URL manually: ${url}`,
      );
    });
    child.unref();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] openUrlInBrowser: spawn "${cmd}" threw: ${msg}`);
    logEvent(
      "warn",
      "system",
      `couldn't auto-open browser via "${cmd}" — open this URL manually: ${url}`,
    );
  }
}

// Minimal HTML entity encoder for use in the auto-map preview dialogs.
// We can't depend on `@arclight/core`'s `escHtml` (lidal deliberately has
// no dependency on arclight-core), so this is a local copy. Used anywhere
// untrusted strings (sample filenames, track names) are interpolated into
// inline HTML — without it, the previous `.replace(/[<>&"']/g, "")` was
// *deleting* those characters, so "Conga & Bell.aif" became "Conga  Bell.aif"
// in the preview rather than rendering correctly as "Conga &amp; Bell.aif".
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shorthand for logAppend — fills in `ts` and accepts an optional detail.
// Keeping this inline (vs. exporting from log.ts) lets us evolve the entry
// shape here without touching call sites elsewhere.
function logEvent(level: LogLevel, source: LogSource, message: string, detail?: string): void {
  const entry: LogEntry = { ts: Date.now(), level, source, message };
  if (detail) entry.detail = detail;
  logAppend(entry);
}

scheduler.setOnPatternError((msg) => {
  lastError = msg;
  console.error(`[Lidal] ${msg}`);
  logEvent("error", "pattern", msg);
});

const DEFAULT_BUFFER = `-- Lidal — TidalCycles-flavored syntax for Ableton Live.
-- Cmd+Enter evaluates the block under cursor. Cmd+Shift+Enter evaluates everything.
-- \`hush\` stops all orbits.

d1 $ s "bd ~ sd ~"

d2 $ n "c2 e2 g2 b2"

d3 $ s "[~ hh*4]" # gain 0.6

-- d4 $ every 4 (fast 2) $ n "c4 e4 g4 b4" # velocity 0.7
-- hush
`;

// Late-bound reference so the sandbox can perform Live introspection (autoMap)
// from inside user code. Set in activate(); throws clearly if called before.
let extRef: ExtensionContext<"1.0.0"> | null = null;

const sandbox = buildSandbox({
  setOrbit: (orbit, pattern) => scheduler.setOrbit(orbit, pattern),
  clearOrbit: (orbit) => scheduler.clearOrbit(orbit),
  setControlOrbit: (orbit, pattern) => scheduler.setControlOrbit(orbit, pattern),
  clearControlOrbit: (orbit) => scheduler.clearControlOrbit(orbit),
  installLearn: (pattern, durationCycles) => scheduler.installLearn(pattern, durationCycles),
  setDrumMap: (orbit, map) => setDrumMap(orbit, map),
  clearDrumMap: (orbit) => clearDrumMap(orbit),
  autoMap: (orbit, trackName, aliasUnknown) => {
    if (!extRef) throw new Error("autoMap: extension not yet active");
    const track = findTrackByName(extRef, trackName);
    if (!track) throw new Error(`autoMap: track "${trackName}" not found`);
    const result = introspectDrumRack(extRef, track, aliasUnknown);
    setDrumMap(orbit, result.map);
    const knownCount = Object.keys(result.map).length;
    const skipNote = result.skipped.length > 0 ? ` · skipped ${result.skipped.length}` : "";
    console.log(`[Lidal] autoMap d${orbit} → "${result.trackName}" · ${knownCount} pads${skipNote}`);
    logEvent("info", "automap", `d${orbit} → "${result.trackName}" · ${knownCount} pads${skipNote}`);
    return result;
  },
  hush: () => scheduler.hush(),
});

let buffer = DEFAULT_BUFFER;
let bufferFilePath: string | null = null;
let bpm = 120;
let cycleBeats = 4;
let lastError: string | null = null;
let lastBake: { ts: number; ok: boolean; message: string } | null = null;

// Persistence of session knobs that should survive a reload. Kept in a sidecar
// JSON next to the buffer file so the user's setup snaps back the way they
// left it (sync mode + manual BPM + cycle length). Writes are atomic and
// debounced. Restore happens before the scheduler / sync source starts so the
// first tick uses the restored values.
interface PersistedState {
  version: 1;
  syncMode: SyncMode;
  manualBpm: number;
  cycleBeats: number;
}
let stateFilePath: string | null = null;
let manualBpm = 120;  // Snapshot of BPM the user picked while in manual mode.
const STATE_FILE = "state.json";
const STATE_DEBOUNCE_MS = 750;

// ── Sync state ──────────────────────────────────────────────────────────
let syncMode: SyncMode = "manual";
let activeSource: TempoSource = new ManualSource();
let syncError: string | null = null;
let linkPeers = 0;
let linkIsPlaying: boolean | null = null;  // last observed Link play state
let getSong: () => SongLike | null = () => null;

// Throttled SSE broadcaster — installed once the server is up. Until then,
// the no-op fallback simply drops calls; status will resync on the next eval.
let pushStatus: () => void = () => { /* server not up yet */ };

// Sync-status SSE pusher, similarly installed once the server is up. Separate
// channel from status; the editor's status pill reads `sync-status` for the
// rendered transport/peers display, while `status` carries scheduler state.
let pushSyncStatus: () => void = () => { /* server not up yet */ };

function setSyncMode(mode: SyncMode): void {
  if (mode === syncMode && mode === "manual") return;
  activeSource.stop();
  scheduler.setPhaseSource(null);
  syncError = null;
  linkPeers = 0;
  // `linkIsPlaying` is only meaningful while we're actually following Link.
  // Clear it unconditionally on every mode transition — including re-entry
  // into Link (link → manual → link), where the freshly-constructed
  // LinkSource hasn't issued its first onTransport callback yet and the
  // previous session's value would otherwise linger as a stale "playing"
  // indicator until that callback fires. Every transition re-derives the
  // play state from the new source.
  linkIsPlaying = null;
  let nextSource: TempoSource;
  switch (mode) {
    case "manual":     nextSource = new ManualSource(); break;
    case "lom":        nextSource = new LomSource(getSong); break;
    case "midi-clock": nextSource = new MidiClockSource(MIDI_CLOCK_PORT); break;
    case "link":
      if (!LinkSource.available()) {
        // Soft failure: native binding missing or unloadable. Fall back to
        // manual silently in the runtime but surface the reason on both the
        // log panel (so users see *why* they're stuck on manual) and via the
        // sync-status SSE channel (so the status pill renders the warning
        // immediately, not just after the next eval).
        syncError = `Link unavailable: ${LinkSource.loadFailureReason() ?? "unknown reason"}`;
        nextSource = new ManualSource();
        syncMode = "manual";
        // Restore manual BPM so the user's last manual tempo isn't replaced
        // by whatever Link last reported (otherwise switching to Link then
        // back to manual would lose the user's tempo).
        if (manualBpm > 0) {
          bpm = manualBpm;
          scheduler.setTempo(bpm, cycleBeats);
        }
        console.error(`[Lidal] ${syncError} — falling back to manual`);
        logEvent("warn", "sync", `${syncError} — falling back to manual`);
        activeSource = nextSource;
        scheduler.setTransportEnabled(true);
        persistState();
        pushStatus();
        pushSyncStatus();
        return;
      }
      nextSource = new LinkSource();
      break;
  }
  activeSource = nextSource;
  syncMode = mode;
  // Non-manual sources: the source drives transport; start in "follow" mode.
  // Manual: scheduler is always allowed to play once orbits exist.
  scheduler.setTransportEnabled(mode === "manual" ? true : false);
  // Link is also a phase provider — scheduler aligns ticks to its bar boundaries.
  if (nextSource instanceof LinkSource) scheduler.setPhaseSource(nextSource);
  // Snap manual BPM back when re-entering manual mode so the user's last
  // explicit choice survives a Link/LOM excursion.
  if (mode === "manual" && manualBpm > 0) {
    bpm = manualBpm;
    scheduler.setTempo(bpm, cycleBeats);
  }
  activeSource.start({
    onTempo: (t) => {
      if (!Number.isFinite(t) || t <= 0) return;
      bpm = t;
      scheduler.setTempo(bpm, cycleBeats);
      pushStatus();
      pushSyncStatus();
    },
    onTransport: (playing) => {
      scheduler.setTransportEnabled(playing);
      if (mode === "link") linkIsPlaying = playing;
      pushStatus();
      pushSyncStatus();
    },
    onError: (msg) => {
      syncError = msg;
      console.error(`[Lidal] sync (${mode}) error:`, msg);
      logEvent("error", "sync", `${mode}: ${msg}`);
      pushStatus();
      pushSyncStatus();
    },
    onPeers: (n) => { linkPeers = n; pushStatus(); pushSyncStatus(); },
  });
  persistState();
  pushSyncStatus();
  console.log(`[Lidal] sync mode → ${mode}`);
}

function buildSyncStatusEvent(): SyncStatusEvent {
  return {
    mode: syncMode,
    bpm,
    quantum: cycleBeats,
    linkAvailable: LinkSource.available(),
    linkError: syncError,
    peers: syncMode === "link" ? linkPeers : null,
  };
}

function tryEval(code: string): { ok: boolean; error?: string } {
  try {
    runUserCode(code, sandbox);
    lastError = null;
    return { ok: true };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    logEvent("error", "eval", lastError, errorDetail(e));
    return { ok: false, error: lastError };
  }
}

function hhmmss(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Write `text` to `path` atomically: stage in `<path>.tmp` then rename. POSIX
// rename on the same filesystem is atomic, so concurrent readers either see
// the old contents or the new — never a half-flushed file.
async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

// Serialize persistence so rapid Cmd-Enter evals can't interleave (write-2
// truncating while write-1 is mid-flush would tear the file). Each call
// chains onto the previous promise; failures are logged but don't break the
// chain — `.catch` swallows so the next write still runs.
let pendingWrite: Promise<void> = Promise.resolve();

function persistBuffer(text: string): void {
  if (!bufferFilePath) return;
  const path = bufferFilePath;
  pendingWrite = pendingWrite.then(() => writeFileAtomic(path, text)).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] persistBuffer failed: ${msg}`);
    logEvent("warn", "system", `buffer persistence failed: ${msg}`);
  });
}

// State persistence is debounced (one trailing-edge write per quiet window) so
// rapid changes like dragging a BPM slider don't thrash disk. The state file
// is tiny (~80 bytes) but writing it on every tempo callback would still
// produce hundreds of writes per minute under Link.
let pendingStateWrite: Promise<void> = Promise.resolve();
let stateWriteTimer: ReturnType<typeof setTimeout> | null = null;

function persistStateNow(): void {
  if (!stateFilePath) return;
  const path = stateFilePath;
  const state: PersistedState = {
    version: 1,
    syncMode,
    manualBpm,
    cycleBeats,
  };
  const text = JSON.stringify(state);
  pendingStateWrite = pendingStateWrite.then(() => writeFileAtomic(path, text)).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] persistState failed: ${msg}`);
    logEvent("warn", "system", `state persistence failed: ${msg}`);
  });
}

function persistState(): void {
  if (!stateFilePath) return;
  if (stateWriteTimer) clearTimeout(stateWriteTimer);
  stateWriteTimer = setTimeout(() => {
    stateWriteTimer = null;
    persistStateNow();
  }, STATE_DEBOUNCE_MS);
}

// Returns the restored state if the file exists and parses as PersistedState
// shape. Unknown fields are tolerated (forward-compat) but a missing required
// field falls back to defaults. I/O errors other than ENOENT log a warning so
// we don't silently drop user settings on a permissions glitch.
function restoreState(path: string): PersistedState | null {
  try {
    const text = readFileSync(path, "utf8");
    const raw = JSON.parse(text) as Partial<PersistedState>;
    if (!raw || typeof raw !== "object") return null;
    const VALID_MODES: SyncMode[] = ["manual", "link", "midi-clock", "lom"];
    const mode = VALID_MODES.includes(raw.syncMode as SyncMode) ? (raw.syncMode as SyncMode) : "manual";
    const bpm = typeof raw.manualBpm === "number" && raw.manualBpm > 0 ? raw.manualBpm : 120;
    const cb = typeof raw.cycleBeats === "number" && raw.cycleBeats > 0 ? raw.cycleBeats : 4;
    return { version: 1, syncMode: mode, manualBpm: bpm, cycleBeats: cb };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] state restore failed: ${msg}`);
    logEvent("warn", "system", `state restore failed; using defaults: ${msg}`);
    return null;
  }
}

// ── Drum-rack introspection (for autoMap) ──────────────────────────────
// SDK 0.0.5 doesn't expose Chain.devices on the typed surface; we reach the
// runtime binding `chainGetDevices` through the protected dataModel.

function findTrackByName(ext: ExtensionContext<"1.0.0">, name: string): Track<"1.0.0"> | null {
  // Trim on both sides so a user-typed `"My Drums "` (with stray trailing
  // whitespace from a paste) still matches a track literally named "My Drums".
  // Live's track name field doesn't reject trailing whitespace either, so we
  // also normalize the live-side names before comparing.
  const target = name.trim();
  return ext.application.song.tracks.find((t) => t.name.trim() === target) ?? null;
}

// Heuristic: a RackDevice is a Drum Rack iff at least one of its chains
// coerces to a DrumChain (i.e. has a `receivingNote`). Instrument Racks and
// Audio-Effect Racks have plain Chains and will throw on the coercion.
// We try every chain, not just the first, because a Drum Rack may have a
// non-drum return chain at index 0 in some Live configurations.
function isDrumRack(ext: ExtensionContext<"1.0.0">, rack: RackDevice<"1.0.0">): boolean {
  for (const chain of rack.chains) {
    try {
      ext.getObjectFromHandle(chain.handle, DrumChain);
      return true;
    } catch { /* not a DrumChain — keep looking */ }
  }
  return false;
}

// Walk the track's device chain and return the first RackDevice that is a
// Drum Rack. If the first rack encountered is a non-Drum Rack (Instrument
// Rack / Audio-Effect Rack) we surface a clear error rather than silently
// continuing past it — the user almost certainly meant that rack.
//
// Exported `findDrumRackResult` so the helper is testable in isolation
// (the surrounding command resolves `track` and `ext` via the SDK, which
// the unit tests stub out).
export type DrumRackLookup =
  | { kind: "drum-rack";        rack: RackDevice<"1.0.0"> }
  | { kind: "non-drum-rack";    rackTypeHint: string }
  | { kind: "no-rack" };

export function findFirstDrumRack(
  ext: ExtensionContext<"1.0.0">,
  track: Track<"1.0.0">,
): DrumRackLookup {
  for (const dev of track.devices) {
    let rack: RackDevice<"1.0.0"> | null = null;
    try { rack = ext.getObjectFromHandle(dev.handle, RackDevice); }
    catch { rack = null; }
    if (!rack) continue;
    if (isDrumRack(ext, rack)) return { kind: "drum-rack", rack };
    // First rack hit but it isn't a Drum Rack — stop and report. The hint
    // is best-effort: SDK 0.0.5 doesn't expose the rack subclass so we
    // describe what we *can* see.
    return { kind: "non-drum-rack", rackTypeHint: "Instrument Rack / Audio-Effect Rack" };
  }
  return { kind: "no-rack" };
}

// TODO(sdk-upgrade): `chainGetDevices` is part of the SDK 0.0.5 *private*
// dataModel surface — it isn't on the typed `ExtensionContext` API. When
// we bump @ableton-extensions/sdk past 0.0.5, audit whether a public
// `chain.devices` accessor has shipped and switch to it. Until then,
// reaching through `dataModel` is the only way to enumerate Simplers on
// a Drum Rack chain.
type DataModelWithChainDevices = {
  chainGetDevices?: (handle: Handle) => Handle[];
};

function findSimplerOnChain(
  ext: ExtensionContext<"1.0.0">,
  chainHandle: Handle,
): Simpler<"1.0.0"> | null {
  const dm = (ext as unknown as { application: { dataModel: DataModelWithChainDevices } }).application.dataModel;
  if (!dm?.chainGetDevices) return null;
  const deviceHandles = dm.chainGetDevices(chainHandle) ?? [];
  for (const h of deviceHandles) {
    try {
      return ext.getObjectFromHandle(h, Simpler);
    } catch { /* not a Simpler — keep looking */ }
  }
  return null;
}

// aliasUnknown=false → only override names already in DRUM_MAP; everything
// else lands in skipped. =true → use the filename-derived alias for every pad.
function introspectDrumRack(
  ext: ExtensionContext<"1.0.0">,
  track: Track<"1.0.0">,
  aliasUnknown: boolean,
): AutoMapResult {
  const lookup = findFirstDrumRack(ext, track);
  if (lookup.kind === "no-rack") {
    throw new Error(`autoMap: track "${track.name}" has no Drum Rack device`);
  }
  if (lookup.kind === "non-drum-rack") {
    // The first rack on the chain is not a Drum Rack — almost always means
    // the user pointed autoMap at the wrong track (e.g. a synth track with
    // an Instrument Rack). Spell that out so the message isn't the much
    // less helpful "no pads resolved".
    throw new Error(
      `autoMap: track "${track.name}" — first rack is a ${lookup.rackTypeHint}, not a Drum Rack. ` +
      `Move or replace it so the Drum Rack is the first rack on the device chain.`,
    );
  }
  const rack = lookup.rack;

  const map: Record<string, number> = {};
  const skipped: string[] = [];
  const knownAliases = new Set(Object.keys(DRUM_MAP));

  for (const chain of rack.chains) {
    let receivingNote: number;
    try {
      const drumChain = ext.getObjectFromHandle(chain.handle, DrumChain);
      receivingNote = drumChain.receivingNote;
    } catch {
      continue;  // not a DrumChain (e.g. return chain) — skip silently
    }
    const simpler = findSimplerOnChain(ext, chain.handle);
    const sample = simpler?.sample;
    if (!sample) continue;  // empty pad — no name to map
    const alias = sampleFilenameToAlias(sample.filePath);
    if (!alias) continue;

    const include = knownAliases.has(alias) || aliasUnknown;
    if (!include) { skipped.push(alias); continue; }
    // Two pads sanitizing to the same alias (e.g. two "Tom" samples) would
    // silently overwrite — push the loser into skipped so the user notices.
    if (Object.prototype.hasOwnProperty.call(map, alias)) { skipped.push(alias); continue; }
    map[alias] = receivingNote;
  }

  return { trackName: track.name, map, skipped };
}

// Re-walk the rack to collect (alias, note, filename) rows for the preview
// dialog. Only includes pads whose alias landed in `acceptedMap` — skipped
// pads aren't shown (their count is surfaced separately). Display-only; the
// preview never depends on this for the actual installed map (that comes
// from introspectDrumRack).
function collectAutoMapPreviewRows(
  ext: ExtensionContext<"1.0.0">,
  track: Track<"1.0.0">,
  acceptedMap: Record<string, number>,
): { alias: string; note: number; filename: string }[] {
  const rows: { alias: string; note: number; filename: string }[] = [];
  const lookup = findFirstDrumRack(ext, track);
  if (lookup.kind !== "drum-rack") return rows;
  const rack = lookup.rack;
  // Reverse map (note → alias) so we can match each pad to its accepted alias
  // without re-running the alias-resolution logic.
  const noteToAlias = new Map<number, string>();
  for (const [alias, note] of Object.entries(acceptedMap)) noteToAlias.set(note, alias);
  for (const chain of rack.chains) {
    let receivingNote: number;
    try {
      const drumChain = ext.getObjectFromHandle(chain.handle, DrumChain);
      receivingNote = drumChain.receivingNote;
    } catch { continue; }
    const alias = noteToAlias.get(receivingNote);
    if (!alias) continue;
    const simpler = findSimplerOnChain(ext, chain.handle);
    const sample = simpler?.sample;
    if (!sample) continue;
    // Strip the directory portion of the path for the display column. Users
    // care about the sample's name, not its absolute location.
    const fp = sample.filePath;
    const lastSlash = Math.max(fp.lastIndexOf("/"), fp.lastIndexOf("\\"));
    const filename = lastSlash >= 0 ? fp.slice(lastSlash + 1) : fp;
    rows.push({ alias, note: receivingNote, filename });
  }
  return rows;
}

// Order by MIDI note so the line reads bottom-of-keyboard up.
function formatDrumMapLine(orbit: number, map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
  const spec = entries.map(([k, v]) => `${k}:${v}`).join(" ");
  return `drumMap ${orbit} "${spec}"`;
}

// Idempotent buffer rewrite for auto-map: if a `drumMap <orbit> "..."` line
// already exists, replace it in place; otherwise prepend the new snippet (with
// a blank-line separator if there's content). Conservative — matches only
// straightforward single-line drumMap forms; comments and multi-line literals
// are left to the user.
export function replaceDrumMapLineInBuffer(buf: string, orbit: number, snippet: string): string {
  // Match `drumMap <orbit> "..."` at line start (optionally indented), with
  // anything else up to end-of-line. The closing quote is greedy-up-to-EOL so
  // a missing close still consumes one line, not the rest of the buffer.
  const re = new RegExp(`^[ \\t]*drumMap[ \\t]+${orbit}\\b[^\\n]*$`, "m");
  if (re.test(buf)) return buf.replace(re, snippet);
  return buf.length > 0 ? `${snippet}\n\n${buf}` : snippet;
}

// Preview dialog shown after introspection. Renders the proposed alias →
// MIDI note → filename mapping as a table with Apply / Cancel buttons. The
// right-click path uses this so the user can sanity-check the mapping before
// it modifies their editor buffer; the in-editor `autoMap` function call
// keeps the immediate-apply behavior (explicit function call IS the
// confirmation).
function buildAutoMapPreviewDataUrl(
  trackName: string,
  orbit: number,
  rows: { alias: string; note: number; filename: string }[],
  skippedCount: number,
): string {
  const safeName = escHtml(trackName);
  const sortedRows = rows.slice().sort((a, b) => a.note - b.note);
  const rowsHtml = sortedRows.map((r) => {
    const a = escHtml(r.alias);
    const f = escHtml(r.filename);
    return `<tr><td><code>${a}</code></td><td class="num">${r.note}</td><td class="fn">${f}</td></tr>`;
  }).join("");
  const skipNote = skippedCount > 0 ? ` · skipped ${skippedCount}` : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lidal — Auto-map drums (preview)</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1c1c1c; color: #e8e8e8; margin: 0; padding: 20px; font-size: 12px; }
  h1 { font-size: 14px; margin: 0 0 4px 0; font-weight: 600; }
  .sub { color: #999; font-size: 12px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #2a2a2a; }
  th { color: #999; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { font-family: ui-monospace, monospace; color: #6fb37b; width: 50px; }
  td.fn { color: #888; font-family: ui-monospace, monospace; font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { font-family: ui-monospace, monospace; color: #e8e8e8; }
  .tbl-wrap { max-height: 320px; overflow: auto; border: 1px solid #2a2a2a; border-radius: 3px; }
  .empty { padding: 14px; color: #999; text-align: center; }
  .ftr { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 16px; }
  .info { color: #888; font-size: 11px; }
  .btns { display: flex; gap: 8px; }
  button { padding: 7px 14px; font-size: 12px; font-weight: 600; border: 1px solid #3a3a3a; border-radius: 3px; background: #1c1c1c; color: #e8e8e8; cursor: pointer; }
  button:hover { background: #252525; }
  button.primary { background: #2d6a3a; border-color: #3a8a4a; color: #fff; }
  button.primary:hover { background: #357d44; }
</style></head>
<body>
  <h1>Auto-map drums — preview</h1>
  <div class="sub">Orbit <code>d${orbit}</code> · Track <code>${safeName}</code> · ${sortedRows.length} pads${skipNote}</div>
  ${sortedRows.length === 0
    ? `<div class="empty">No pads to map.</div>`
    : `<div class="tbl-wrap"><table><thead><tr><th>Alias</th><th class="num">Note</th><th class="fn">Sample</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`}
  <div class="ftr">
    <span class="info">Apply will install the map and insert a <code>drumMap d${orbit} …</code> line.</span>
    <div class="btns">
      <button onclick="send(null)">Cancel</button>
      <button class="primary" id="applyBtn" onclick="send({ confirm: true })">Apply</button>
    </div>
  </div>
<script>
  function send(payload) {
    var m = { method: 'close_and_send', params: [payload == null ? '' : JSON.stringify(payload)] };
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live)
      window.webkit.messageHandlers.live.postMessage(m);
    else if (window.chrome && window.chrome.webview)
      window.chrome.webview.postMessage(m);
  }
  document.getElementById('applyBtn').focus();
</script>
</body></html>`;
  return "data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64");
}

function buildAutoMapDialogDataUrl(trackName: string): string {
  const safeName = escHtml(trackName);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lidal — Auto-map drums</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1c1c1c; color: #e8e8e8; margin: 0; padding: 20px; }
  h1 { font-size: 14px; margin: 0 0 4px 0; font-weight: 600; }
  .sub { color: #999; font-size: 12px; margin-bottom: 18px; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  label { font-size: 12px; color: #ccc; }
  input[type=number] { background: #0e0e0e; color: #e8e8e8; border: 1px solid #3a3a3a; border-radius: 3px; padding: 6px 8px; width: 70px; font-family: ui-monospace, monospace; font-size: 13px; }
  input[type=number]:focus { outline: none; border-color: #3a8a4a; }
  .check { display: flex; align-items: flex-start; gap: 8px; }
  .check input { margin-top: 3px; }
  .check .desc { color: #888; font-size: 11px; margin-top: 2px; }
  .ftr { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  button { padding: 7px 14px; font-size: 12px; font-weight: 600; border: 1px solid #3a3a3a; border-radius: 3px; background: #1c1c1c; color: #e8e8e8; cursor: pointer; }
  button:hover { background: #252525; }
  button.primary { background: #2d6a3a; border-color: #3a8a4a; color: #fff; }
  button.primary:hover { background: #357d44; }
  code { font-family: ui-monospace, monospace; color: #6fb37b; }
</style></head>
<body>
  <h1>Auto-map drums</h1>
  <div class="sub">Track: <code>${safeName}</code></div>
  <div class="row">
    <label for="orbit">Orbit</label>
    <span style="color:#999">d</span>
    <input id="orbit" type="number" min="1" max="16" value="1">
  </div>
  <div class="check">
    <input id="aliasUnknown" type="checkbox">
    <div>
      <label for="aliasUnknown">Alias unknown samples (use filenames)</label>
      <div class="desc">Unchecked: only override names that match the built-in drum map (bd, sd, hh, …). Checked: every pad gets an alias derived from its sample filename (e.g. <code>conga_lo</code>).</div>
    </div>
  </div>
  <div class="ftr">
    <button onclick="send(null)">Cancel</button>
    <button class="primary" onclick="apply()">Apply</button>
  </div>
<script>
  function send(payload) {
    var m = { method: 'close_and_send', params: [payload == null ? '' : JSON.stringify(payload)] };
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live)
      window.webkit.messageHandlers.live.postMessage(m);
    else if (window.chrome && window.chrome.webview)
      window.chrome.webview.postMessage(m);
  }
  function apply() {
    var orbit = parseInt(document.getElementById('orbit').value, 10) || 1;
    var aliasUnknown = document.getElementById('aliasUnknown').checked;
    send({ orbit: orbit, aliasUnknown: aliasUnknown });
  }
  document.getElementById('orbit').focus();
  document.getElementById('orbit').select();
</script>
</body></html>`;
  return "data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64");
}

// Maps a captured snapshot's orbit slot + portType to a stable per-orbit
// track name. Notes orbits use "d<N>"; drums orbits use "s<N>" so a melodic
// pattern and a percussion pattern on the same orbit number never collide.
function orbitLabelFor(slot: number, portType: "notes" | "drums"): string {
  return portType === "drums" ? `s${slot}` : `d${slot}`;
}

// Fire-and-forget per-orbit bake. Looks up an existing `lidal_<label>` track,
// appends a new clip to the first empty session-view slot, and writes the
// captured notes. If every slot is full, falls back to a fresh track tagged
// with the current time so the user never gets a phantom "where did my bake
// go?" — the failure mode is at most an extra track, never silent data loss.
async function bakeOrbitToTrack(
  ext: ExtensionContext<"1.0.0">,
  label: string,
  snapshots: CycleSnapshot[],
): Promise<{ trackName: string; clipSlotIndex: number }> {
  if (snapshots.length === 0) throw new Error("empty snapshots");
  // Sum the per-snapshot cycleBeats so a tempo/quantum change *during* the
  // bake window produces a clip whose length matches the actual elapsed
  // musical time. Using snapshots[0].cycleBeats × N would mis-size the clip
  // whenever cycleBeats varied across the captured cycles.
  const totalBeats = Math.max(
    snapshots.reduce((acc, s) => acc + s.cycleBeats, 0),
    1 / 96,
  );

  const song = ext.application.song;
  const baseName = `lidal_${label}`;
  const wantedName = baseName;

  let track = song.tracks.find((t) => t.name === wantedName) ?? null;
  let slotIdx = -1;
  let trackName = wantedName;

  if (track) {
    const slots = track.clipSlots;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].clip == null) { slotIdx = i; break; }
    }
    if (slotIdx === -1) {
      // No free slot on the existing track — make a fresh timestamped one so
      // we still surface a clip without silently overwriting. Surfaced to the
      // user via the returned trackName.
      track = await song.createMidiTrack();
      trackName = `${baseName}_${hhmmss(new Date())}`;
      ext.withinTransaction(() => { if (track) track.name = trackName; });
      slotIdx = 0;
    }
  } else {
    track = await song.createMidiTrack();
    ext.withinTransaction(() => { if (track) track.name = trackName; });
    slotIdx = 0;
  }

  const slot = track.clipSlots[slotIdx];
  if (!slot) throw new Error(`slot ${slotIdx} not present on ${trackName}`);
  // `createMidiClip` is itself async and runs outside our transaction (SDK
  // 0.0.5 doesn't expose a way to create-and-populate atomically); the
  // post-create name + notes writes below are merged into a single
  // `withinTransaction` so the user gets one Live undo step for the
  // "populated clip" portion.
  const clip = await slot.createMidiClip(totalBeats);

  const notes: NoteDescription[] = [];
  // Beat offset accumulator so each snapshot lands at the sum of all preceding
  // snapshots' cycleBeats. This is robust to cycleBeats varying across the
  // captured window (the user changed quantum/tempo during the bake history).
  let snapStartBeats = 0;
  for (const snap of snapshots) {
    for (const ev of snap.notes) {
      const startTime = snapStartBeats + ev.start * snap.cycleBeats;
      const duration = Math.max(ev.duration * snap.cycleBeats, 1 / 96);
      notes.push({ pitch: ev.midi, startTime, duration, velocity: ev.velocity });
    }
    snapStartBeats += snap.cycleBeats;
  }
  ext.withinTransaction(() => {
    clip.name = `${label}_${hhmmss(new Date())}`;
    clip.notes = notes;
  });

  return { trackName, clipSlotIndex: slotIdx };
}

export function activate(activation: ActivationContext): void {
  const ext = initialize(activation, "1.0.0");
  extRef = ext;
  console.log("[Lidal] Starting...");

  // Restore editor buffer from disk if a previous session persisted one.
  // Sync read keeps activate() synchronous; missing file is a non-error
  // (first run / fresh user). Other I/O errors are *not* a no-op: if we
  // logged-and-continued, the next eval would overwrite a possibly-valid
  // on-disk buffer with DEFAULT, silently losing the user's work. So on any
  // non-ENOENT error we disable persistence for this session (leave
  // `bufferFilePath = null`) and surface a loud error.
  const storageDir = ext.environment.storageDirectory;
  if (storageDir) {
    const candidatePath = join(storageDir, "buffer.lidal");
    try {
      if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Lidal] could not ensure storage directory: ${msg}`);
      logEvent("warn", "system", `storage directory unusable; editor buffer will not persist: ${msg}`);
    }
    try {
      const restored = readFileSync(candidatePath, "utf8");
      if (restored.length > 0) buffer = restored;
      bufferFilePath = candidatePath;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // Normal: no saved buffer yet. Enable persistence so the next eval
        // saves the user's current text.
        bufferFilePath = candidatePath;
      } else {
        // Real I/O problem (permissions, EIO, decode failure, etc). Disable
        // persistence so we don't clobber whatever is on disk.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Lidal] buffer restore failed; disabling persistence: ${msg}`);
        logEvent("error", "system", `buffer restore failed; persistence disabled this session: ${msg}`);
        bufferFilePath = null;
      }
    }
    // Sidecar state file (sync mode, manual BPM, cycle length). Lives next to
    // the buffer file so the user only ever sees one storage directory.
    stateFilePath = join(storageDir, STATE_FILE);
    const restored = restoreState(stateFilePath);
    if (restored) {
      manualBpm = restored.manualBpm;
      cycleBeats = restored.cycleBeats;
      // In manual mode, the saved BPM is authoritative. For Link/LOM we'll
      // overwrite once the source reports its first tempo callback, but it's
      // useful to start with a sensible non-zero value so the first cycle
      // doesn't divide by 120-default if the user was at 80 last time.
      bpm = restored.manualBpm;
      logEvent("info", "system", `state restored — sync=${restored.syncMode} bpm=${restored.manualBpm} quantum=${restored.cycleBeats}`);
    }
  } else {
    // No storage directory at all — log once so the user knows their buffer
    // won't survive an Extension Host reload.
    logEvent("warn", "system", "storageDirectory unavailable; editor buffer will not persist across extension restarts");
  }

  // Open the virtual MIDI ports here (not at module load) so a prior
  // host's cleanup handler has had a chance to release them. Each open
  // retries once after 150ms; a permanent failure logs an error but does
  // not break activation — the scheduler keeps running with a no-op port.
  const portTargets: Array<{ name: string; swap: SwappableOutput }> = [
    { name: NOTES_PORT,   swap: notesPortSwap   },
    { name: DRUMS_PORT,   swap: drumsPortSwap   },
    { name: CONTROL_PORT, swap: controlPortSwap },
  ];
  const portFailures: string[] = [];
  for (const { name, swap } of portTargets) {
    openOutputWithRetry(name, (out) => {
      if (out) {
        swap.setInner(out);
        return;
      }
      portFailures.push(name);
      // Final failure: emit a single combined log entry when all three
      // openings have resolved.
      if (portFailures.length === portTargets.filter((t) => !t.swap.getInner()).length) {
        // Defer one tick so we don't log mid-loop while other ports may still
        // be resolving from their setTimeout retries.
        setTimeout(() => {
          const stillMissing = portTargets.filter((t) => !t.swap.getInner()).map((t) => t.name);
          if (stillMissing.length > 0) {
            logEvent(
              "error",
              "system",
              `failed to open virtual MIDI ports: ${stillMissing.join(", ")} — MIDI output disabled for these ports until extension is reloaded`,
            );
          }
        }, 200);
      }
    });
  }

  // Wire LOM song accessor lazily — Application is on the ext object.
  getSong = () => {
    try {
      const app = (ext as unknown as { application?: { song?: SongLike } }).application;
      return app?.song ?? null;
    } catch { return null; }
  };

  // Pick initial sync mode. If we restored a previous mode, honor it (Link
  // unavailability is handled inside setSyncMode — it falls back to manual and
  // surfaces the reason). If no state, default to Link if it loads, else LOM.
  let initialMode: SyncMode;
  if (stateFilePath) {
    const restored = restoreState(stateFilePath);
    initialMode = restored?.syncMode ?? (LinkSource.available() ? "link" : "lom");
  } else {
    initialMode = LinkSource.available() ? "link" : "lom";
  }
  setSyncMode(initialMode);

  // Captured for the async bake side-effects; the server handle's
  // broadcastStatus pushes lastBake to SSE clients once SDK writes resolve.
  let serverHandle: ServerHandle | null = null;

  // In-flight bake guard. `bakeOrbitToTrack` performs `slot.createMidiClip`
  // and `clip.notes = …` as separate SDK transactions; a Cmd+B double-tap
  // would race the second invocation against the first and produce two
  // interleaved tracks on the same orbit. We block re-entry per-orbit until
  // the previous bake settles (success or failure), then release the slot.
  const bakesInFlight = new Set<number>();

  // [ED-agent] Generate the per-launch CSRF token here so we can both pass it
  // to startServer and inject it into the editor page HTML. The page reads it
  // from a `data-csrf-token` attribute on #editor-host (see editor-page.ts);
  // client.ts sends it as `x-lidal-token` on POSTs and as `?t=` on the SSE
  // EventSource (the latter is necessary because EventSource has no header
  // API). Token never leaves this process unencrypted to disk or env.
  const csrfToken = generateCsrfToken();

  const onBake = (body: BakeBody): BakeResult => {
    const noteOrbits = Array.isArray(body.orbits) ? body.orbits.filter((n) => Number.isInteger(n)) : [];
    const ccOrbits = Array.isArray(body.controlOrbits) ? body.controlOrbits.filter((n) => Number.isInteger(n)) : [];
    const cycles = Math.max(1, Math.min(8, Math.floor(body.cycles ?? 4)));

    if (noteOrbits.length === 0 && ccOrbits.length === 0) {
      // Distinguish "block has no orbits at all" from "block has only CC
      // orbits" (handled below). Actionable message: tell the user what to type.
      const msg = "bake: no active note orbits in selection. Evaluate a `dN $ …` block first (Cmd+Enter), then Cmd+B.";
      logEvent("warn", "bake", msg);
      return { ok: false, message: msg, reason: "no-orbits" };
    }
    if (noteOrbits.length === 0 && ccOrbits.length > 0) {
      // Control orbits (c1–c8) carry continuous CC streams which the Extensions SDK
      // has no envelope/automation API for. Spell out the workaround so the
      // user knows their options rather than just hitting a dead-end.
      const msg = "bake: control orbits (c1–c8) aren't bakeable — the Extensions SDK has no envelope API. Use note orbits (d1–d16), or bridge CCs through a Max for Live device.";
      logEvent("warn", "bake", msg);
      return { ok: false, message: msg, reason: "cc-only" };
    }

    // Snapshot synchronously so the rest is unaffected by hot reloads or
    // hushes that happen after the HTTP response returns.
    const snapsByOrbit = new Map<number, CycleSnapshot[]>();
    const inFlightSkipped: number[] = [];
    for (const o of noteOrbits) {
      if (bakesInFlight.has(o)) {
        // A previous bake for this orbit is still resolving its SDK
        // transactions; drop the request to avoid two interleaved tracks.
        inFlightSkipped.push(o);
        continue;
      }
      const snaps = scheduler.getBakeHistory(o, cycles);
      if (snaps.length > 0) snapsByOrbit.set(o, snaps);
    }
    if (snapsByOrbit.size === 0) {
      if (inFlightSkipped.length > 0 && noteOrbits.every((o) => inFlightSkipped.includes(o))) {
        // All requested orbits are already mid-bake — surface this clearly so
        // a double-tap doesn't look like "nothing happened".
        const orbitList = inFlightSkipped.map((n) => `d${n}`).join(", ");
        const msg = `bake: already baking ${orbitList}; ignoring duplicate request.`;
        logEvent("warn", "bake", msg);
        return { ok: false, message: msg, reason: "in-flight" };
      }
      // Block has orbits, but none have produced audible cycles yet. Either
      // playback hasn't started or the user evaluated and immediately baked.
      const orbitList = noteOrbits.map((n) => `d${n}`).join(", ");
      const msg = `bake: no playback history for ${orbitList} yet — wait one cycle after evaluating, then retry.`;
      logEvent("warn", "bake", msg);
      return { ok: false, message: msg, reason: "no-history" };
    }

    const skipped: string[] = [];
    if (ccOrbits.length > 0) skipped.push(...ccOrbits.map((c) => `c${c}`));
    for (const o of noteOrbits) {
      if (!snapsByOrbit.has(o) && !inFlightSkipped.includes(o)) skipped.push(`d${o}`);
    }
    if (inFlightSkipped.length > 0) skipped.push(...inFlightSkipped.map((o) => `d${o} (in-flight)`));

    // Reserve every orbit we're about to bake before kicking off the async
    // pipeline so a second tap during the synchronous window of this call
    // (before the loop starts awaiting) also no-ops.
    for (const o of snapsByOrbit.keys()) bakesInFlight.add(o);

    void (async () => {
      const created: string[] = [];
      const errors: string[] = [];
      for (const [orbit, snaps] of snapsByOrbit) {
        const label = orbitLabelFor(orbit, snaps[0].portType);
        try {
          const result = await bakeOrbitToTrack(ext, label, snaps);
          created.push(`${result.trackName} (clip ${result.clipSlotIndex})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${label}: ${msg}`);
          console.error(`[Lidal] bake ${label} failed:`, e);
          logEvent("error", "bake", `${label} failed: ${msg}`, errorDetail(e));
        } finally {
          // Always release the in-flight slot — a failed bake shouldn't lock
          // the orbit out of future attempts.
          bakesInFlight.delete(orbit);
        }
      }

      let message: string;
      let ok: boolean;
      if (created.length > 0 && errors.length === 0) {
        ok = true;
        message = `✓ baked → ${created.join(", ")}`;
        if (skipped.length > 0) message += ` (skipped ${skipped.join(", ")})`;
      } else if (created.length > 0) {
        ok = false;
        message = `partial bake → ${created.join(", ")}; failed: ${errors.join("; ")}`;
      } else {
        ok = false;
        message = `bake failed: ${errors.join("; ") || "unknown"}`;
      }
      lastBake = { ts: Date.now(), ok, message };
      logEvent(ok ? "info" : "error", "bake", message);
      try { serverHandle?.broadcastStatus(); } catch { /* ignore */ }
    })();

    const skippedSuffix = skipped.length > 0 ? ` (skipped ${skipped.join(", ")})` : "";
    return { ok: true, message: `baking ${[...snapsByOrbit.keys()].map((o) => `d${o}`).join(", ")}…${skippedSuffix}` };
  };

  const serverPromise = startServer(
    HTTP_PORT,
    {
      onEval: (body) => {
        buffer = body.buffer;
        persistBuffer(buffer);
        const prevCycleBeats = cycleBeats;
        cycleBeats = body.cycleBeats;
        // Only honor user-supplied BPM when not synced
        if (syncMode === "manual" && Number.isFinite(body.bpm) && body.bpm > 0) {
          bpm = body.bpm;
          manualBpm = bpm;
        }
        scheduler.setTempo(bpm, cycleBeats);
        // Persist state on cycle-length or manual-tempo change.
        if (prevCycleBeats !== cycleBeats || syncMode === "manual") {
          persistState();
        }
        const result = tryEval(body.code);
        if (result.ok) {
          const dOrbits = scheduler.activeOrbits().map((o) => "d" + o);
          const cOrbits = scheduler.activeControlOrbits().map((o) => "c" + o);
          const all = [...dOrbits, ...cOrbits];
          console.log(`[Lidal] eval ok · orbits ${all.length ? all.join(",") : "none"}`);
        } else {
          console.error(`[Lidal] eval error: ${result.error}`);
          // Note: tryEval already logged the error via logEvent — don't double-log.
        }
        return { error: result.error };
      },
      onStop: () => {
        scheduler.hush();
        lastError = null;
        console.log("[Lidal] hushed");
      },
      onSetSync: (mode) => {
        try { setSyncMode(mode); return { ok: true }; }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          syncError = msg;
          return { ok: false, error: msg };
        }
      },
      onBake,
      getStatus: () => ({
        running: scheduler.isRunning(),
        buffer,
        bpm,
        cycleBeats,
        lastError,
        orbits: scheduler.activeOrbits(),
        controlOrbits: scheduler.activeControlOrbits(),
        cycleN: scheduler.currentCycle(),
        syncMode,
        syncError,
        linkPeers,
        linkIsPlaying,
        linkAvailable: LinkSource.available(),
        ...(lastBake ? { lastBake } : {}),
      }),
      getLogSnapshot: () => logSnapshot(),
      onClearLog: () => logClear(),
      // Debounced editor → server push. Keeps the in-memory `buffer` aligned
      // with unsaved edits so auto-map snippet-prepend uses the user's live
      // text (not the last-eval'd snapshot) and so a Live restart restores
      // what they were actually typing.
      onBufferSync: (text) => {
        buffer = text;
        persistBuffer(buffer);
      },
    },
    () => editorPage({ notesPort: NOTES_PORT, drumsPort: DRUMS_PORT, controlPort: CONTROL_PORT, defaultBuffer: buffer, csrfToken }),
    { csrfToken },
  ).then((h) => {
    serverHandle = h;
    // Install the throttled broadcaster once the server is up. ~100ms cap is
    // well below human perception of "live" yet absorbs Link's 50ms update
    // bursts and any chatter from phase-locking tempo nudges.
    pushStatus = makeThrottledBroadcaster(() => h.broadcastStatus(), 100);
    // Sync-status pushes are also throttled — Link emits ~20 Hz tempo updates
    // and we'd rather coalesce. The fallback path (per-cycle emission) lives
    // in the cycle handler below.
    pushSyncStatus = makeThrottledBroadcaster(() => h.broadcastSyncStatus(buildSyncStatusEvent()), 100);
    scheduler.setOnCycle(() => {
      pushStatus();
      // Per-cycle fallback for sync-status: ensures the editor's pill stays
      // fresh even when no transport / mode / availability change has fired.
      pushSyncStatus();
    });
    // Orbit monitor — scheduler-level throttle already collapses rapid
    // changes; we just fan out raw samples. broadcastOrbitMonitor short-
    // circuits when no SSE clients are attached, so the scheduler's emit
    // call is the only per-cycle cost when nobody's watching.
    scheduler.setOnOrbitMonitor((sample: OrbitMonitorSample) => {
      try {
        h.broadcastOrbitMonitor({
          type: sample.type,
          orbit: (sample.type === "ctrl" ? "c" : "d") + sample.orbit,
          channel: sample.channel,
          lastValue: sample.lastValue,
          lastCycle: sample.lastCycle,
          active: sample.active,
        });
      } catch { /* client gone */ }
    });
    // Wire the ring buffer to SSE: every appended entry fans out to clients.
    // Entries logged before the server came up are still in the buffer and
    // will be delivered as the log-snapshot on each client connect.
    onLogAppend((entry) => {
      try { h.broadcastLog(entry); } catch { /* ignore — client gone */ }
    });
    // Push an initial sync-status snapshot so any client connecting before
    // the first cycle has accurate state in their pill.
    try { h.broadcastSyncStatus(buildSyncStatusEvent()); } catch { /* no clients yet */ }
    return h;
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Lidal] failed to start HTTP server on :${HTTP_PORT}:`, e);
    // [ED-agent fix #34] EADDRINUSE recovery: surface the failure loudly so
    // openEditor can refuse to spawn a browser (which would just hit either
    // the other Lidal launch's editor or a dead port).
    logEvent(
      "error",
      "system",
      `failed to start editor server on :${HTTP_PORT}: ${msg} — Open Lidal Editor disabled until the conflict is resolved (most likely cause: another Lidal extension host is already running).`,
      errorDetail(e),
    );
    return null;
  });

  const editorUrl = `http://localhost:${HTTP_PORT}/`;

  ext.commands.registerCommand("lidal.openEditor", async () => {
    // [ED-agent fix #34] Don't spawn the browser if the server never came up
    // — otherwise the user gets either a connection-refused page or
    // (worse) is dropped into someone else's already-running Lidal editor.
    if (!serverHandle) {
      const msg = `Lidal editor server failed to start on port ${HTTP_PORT} — check the Extension Host log for details.`;
      console.error(`[Lidal] openEditor: ${msg}`);
      logEvent("error", "system", msg);
      return;
    }
    openUrlInBrowser(editorUrl);
    console.log(`[Lidal] opened browser → ${editorUrl}`);
  });

  ext.commands.registerCommand("lidal.learnCC1", async () => {
    try {
      const result = tryEval("learn 1");
      if (!result.ok) {
        console.error(`[Lidal] learn failed: ${result.error}`);
        logEvent("error", "system", `learn failed: ${result.error}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Lidal] learn failed:`, e);
      logEvent("error", "system", `learn failed: ${msg}`, errorDetail(e));
    }
  });

  // Right-click → Auto-map drums: walk this clip's track for its Drum Rack,
  // ask the user for orbit + alias mode, then push a `drumMap …` line into
  // the editor buffer via SSE so the user can re-evaluate and pick it up.
  // Registered on MidiClip + MidiTrack — resolve whichever the handle is.
  ext.commands.registerCommand("lidal.autoMapDrums", async (args: unknown) => {
    try {
      // Resolve the right-clicked handle as either a MidiClip (whose track we
      // walk up to) or a MidiTrack directly. We try each in turn and capture
      // *both* errors before giving up so a transient SDK fault doesn't get
      // hidden by the misleading "neither" message.
      let track: Track<"1.0.0"> | null = null;
      let clipErr: unknown = null;
      try {
        const clip = ext.getObjectFromHandle(args as Handle, MidiClip);
        // Clip parent → ClipSlot or TakeLane; that parent → Track.
        const parent = clip.parent;
        const trackObj = parent?.parent;
        if (!trackObj) {
          console.error("[Lidal] autoMapDrums: could not resolve clip's track");
          logEvent("error", "automap", "could not resolve clip's track");
          return;
        }
        track = ext.getObjectFromHandle(trackObj.handle, Track);
      } catch (e) {
        clipErr = e;
      }
      if (!track) {
        try {
          track = ext.getObjectFromHandle(args as Handle, Track);
        } catch (trackErr) {
          const clipMsg = clipErr instanceof Error ? clipErr.message : String(clipErr ?? "n/a");
          const trackMsg = trackErr instanceof Error ? trackErr.message : String(trackErr);
          const combined = `handle is neither a MIDI clip nor a track — clip: ${clipMsg}; track: ${trackMsg}`;
          console.error(`[Lidal] autoMapDrums: ${combined}`);
          logEvent("error", "automap", combined, errorDetail(trackErr));
          return;
        }
      }
      if (!track) return;  // belt-and-braces: future branch additions can't leak undefined

      const dataUrl = buildAutoMapDialogDataUrl(track.name);
      const resultJson = await ext.ui.showModalDialog(dataUrl, 460, 300);
      if (!resultJson) return;
      const choice = JSON.parse(resultJson) as { orbit?: number; aliasUnknown?: boolean };
      const orbit = Number.isInteger(choice.orbit) && (choice.orbit as number) >= 1
        ? (choice.orbit as number)
        : 1;
      const aliasUnknown = choice.aliasUnknown === true;

      let result: AutoMapResult;
      let previewRows: { alias: string; note: number; filename: string }[];
      try {
        result = introspectDrumRack(ext, track, aliasUnknown);
        // Build a parallel preview-rows array carrying the original sample
        // filename for the table. The autoMap algorithm doesn't surface
        // filenames in its return value, so we re-walk the rack here. This is
        // cheap (a handful of pads) and avoids polluting AutoMapResult with a
        // display-only field.
        previewRows = collectAutoMapPreviewRows(ext, track, result.map);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Lidal] autoMapDrums failed:`, msg);
        logEvent("error", "automap", `failed: ${msg}`, errorDetail(e));
        return;
      }
      if (Object.keys(result.map).length === 0) {
        console.warn(`[Lidal] autoMapDrums: no pads resolved on "${track.name}"`);
        logEvent("error", "automap", `no pads resolved on "${track.name}"`);
        return;
      }

      // Preview step: show the proposed mapping and offer Apply/Cancel.
      // Cancel-on-empty-string (close-without-confirm) is treated as cancel
      // by the dialog protocol; falsy resultJson means the user dismissed
      // the dialog without explicit Apply.
      const previewUrl = buildAutoMapPreviewDataUrl(track.name, orbit, previewRows, result.skipped.length);
      // Sized to fit the table comfortably: 520x520 → ~16 rows + chrome.
      const previewResult = await ext.ui.showModalDialog(previewUrl, 560, 540);
      if (!previewResult) {
        logEvent("info", "automap", `cancelled by user for "${track.name}"`);
        return;
      }
      let confirmed = false;
      try {
        const parsed = JSON.parse(previewResult) as { confirm?: boolean };
        confirmed = parsed?.confirm === true;
      } catch { confirmed = false; }
      if (!confirmed) {
        logEvent("info", "automap", `cancelled by user for "${track.name}"`);
        return;
      }

      // Install the map immediately so subsequent evals route correctly even
      // before the user re-evaluates the snippet — useful when they want to
      // just keep playing without touching the editor.
      setDrumMap(orbit, result.map);

      const snippet = formatDrumMapLine(orbit, result.map);
      // [ED-agent fix #12] Tag the snippet with its orbit so the client
      // replaces an existing `drumMap N` line instead of stacking new ones.
      // The server-side buffer also needs to be kept in sync — replace any
      // prior `drumMap <orbit> "…"` line (single or multi-line indented), or
      // prepend if none exists.
      serverHandle?.broadcastSnippet({ snippet, orbit, kind: "drumMap" });
      buffer = replaceDrumMapLineInBuffer(buffer, orbit, snippet);
      persistBuffer(buffer);
      const skipNote = result.skipped.length > 0 ? ` (skipped ${result.skipped.length})` : "";
      console.log(`[Lidal] autoMapDrums → d${orbit} · "${track.name}" · ${Object.keys(result.map).length} pads${skipNote}`);
      logEvent("info", "automap", `d${orbit} → "${track.name}" · ${Object.keys(result.map).length} pads${skipNote}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Lidal] autoMapDrums error:", e);
      logEvent("error", "automap", msg, errorDetail(e));
    }
  });

  // Editor is a global browser app — the clip/track/scene context is irrelevant.
  ext.ui.registerContextMenuAction("MidiClip",  "Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("AudioClip", "Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("MidiTrack", "Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("AudioTrack","Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("ClipSlot",  "Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("Scene",     "Open Lidal Editor", "lidal.openEditor");
  ext.ui.registerContextMenuAction("MidiClip",  "Lidal: Auto-map drums…", "lidal.autoMapDrums");
  ext.ui.registerContextMenuAction("MidiTrack", "Lidal: Auto-map drums…", "lidal.autoMapDrums");

  // SDK 0.0.5 does not expose a deactivate / dispose hook on ActivationContext
  // (verified via extensions-sdk/dist types). Falling back to Node process
  // events is the closest substitute: 'exit' fires for normal teardown, and
  // SIGHUP / SIGTERM cover the dev-launch reload path. These handlers are
  // idempotent and best-effort — if any close() throws, we soldier on.
  let cleanupRan = false;
  async function runCleanup(why: string): Promise<void> {
    if (cleanupRan) return;
    cleanupRan = true;
    console.log(`[Lidal] cleanup (${why}) — closing ports + stopping sources`);
    logEvent("info", "lifecycle", `cleanup (${why}) — closing virtual MIDI ports`);
    // Best-effort: stop sync source (closes Link binding, MIDI Clock input,
    // LOM polling timer).
    try { activeSource.stop(); } catch (e) {
      console.error(`[Lidal] cleanup: activeSource.stop failed:`, e);
    }
    // Fire ctrl-orbit rest values *before* hush. hush() clears controlOrbits
    // wholesale and skips the rest emission (it's a hard stop). The explicit
    // per-orbit clearControlOrbit path *does* fire `# rest N` — call that
    // first so users with `# rest 0` get a clean reset on extension unload.
    for (const orbit of scheduler.activeControlOrbits()) {
      try { scheduler.clearControlOrbit(orbit); }
      catch (e) { console.error(`[Lidal] cleanup: clearControlOrbit ${orbit} failed:`, e); }
    }
    // hush() also iterates noteon/noteoff via playedNotes; safe to call even
    // when scheduler isn't running.
    try { scheduler.hush(); } catch (e) {
      console.error(`[Lidal] cleanup: scheduler.hush failed:`, e);
    }
    // Close virtual MIDI outputs we successfully opened. The OS-level virtual
    // port is owned by easymidi.Output; closing it removes it from the system
    // MIDI graph so a re-activation gets a fresh port instead of stacking.
    // We pull `inner` off the swap wrapper and then clear it so any in-flight
    // scheduler sends after this point are silently dropped (vs. crashing on
    // a closed handle).
    for (const [name, swap] of [
      [NOTES_PORT, notesPortSwap],
      [DRUMS_PORT, drumsPortSwap],
      [CONTROL_PORT, controlPortSwap],
    ] as const) {
      const inner = swap.getInner();
      swap.setInner(null);
      if (!inner) continue;
      try { inner.close(); }
      catch (e) {
        console.error(`[Lidal] cleanup: closing "${name}" failed:`, e);
      }
    }
    // HTTP server: terminate SSE clients + stop accepting connections. The
    // promise has already resolved by the time we reach here in practice,
    // but await it so a startup race doesn't leak a half-open server.
    //
    // Race the await with a 1s timeout: if the server's startup never
    // resolves (port-binding hang, internal startup race, etc.) we must
    // still proceed with the rest of the cleanup so MIDI ports and the
    // state file get flushed before the parent (dev-launch.sh) restarts
    // us. 1s is comfortably under the parent's restart window and well
    // beyond a normally-resolved startup. If it fires, the half-open
    // server gets reaped along with the process exit below.
    const closeServer = serverPromise
      .then((h) => { try { h?.close(); } catch (e) { console.error(`[Lidal] cleanup: server close failed:`, e); } })
      .catch((e) => { console.error(`[Lidal] cleanup: awaiting server promise failed:`, e); });
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 1000));
    await Promise.race([closeServer, timeout]);
    if (timedOut) {
      console.warn(`[Lidal] cleanup: server close timed out after 1s — proceeding with remaining teardown`);
    }
    // Flush any pending state write synchronously by clearing the debounce
    // timer and writing immediately — otherwise an exit during the 750ms
    // window loses the last setting change.
    if (stateWriteTimer) {
      clearTimeout(stateWriteTimer);
      stateWriteTimer = null;
      try { persistStateNow(); } catch { /* ignore */ }
    }
  }
  // Signal handlers: await full cleanup then explicitly exit so the parent's
  // (dev-launch.sh's) restart sequence proceeds cleanly. Without an explicit
  // exit, the process can linger until Node decides to terminate, which
  // races the parent's next-child fork and can stack ports / SSE listeners.
  // 'exit' is synchronous (no async work allowed there): we just fire-and-forget.
  process.on("exit", () => { void runCleanup("exit"); });
  const handleSignal = (sig: NodeJS.Signals) => {
    runCleanup(sig)
      .catch((e) => console.error(`[Lidal] cleanup (${sig}) threw:`, e))
      .finally(() => {
        // Use the conventional 128+signum exit codes so the parent can see
        // why we left if it ever inspects $?. SIGHUP=1, SIGINT=2, SIGTERM=15.
        const code = sig === "SIGHUP" ? 129 : sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 0;
        process.exit(code);
      });
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGHUP", () => handleSignal("SIGHUP"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  console.log(`[Lidal] Ready — editor at ${editorUrl}, ports "${NOTES_PORT}" + "${DRUMS_PORT}" + "${CONTROL_PORT}", sync=${syncMode}`);
}
