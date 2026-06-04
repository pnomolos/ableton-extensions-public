import * as easymidi from "easymidi";

export type SyncMode = "manual" | "lom" | "midi-clock" | "link";

export interface TempoSourceCallbacks {
  onTempo: (bpm: number) => void;
  onTransport: (playing: boolean) => void;  // true = should play, false = should pause
  onError: (msg: string) => void;
  onPeers?: (count: number) => void;        // Link only
}

export interface TempoSource {
  readonly mode: SyncMode;
  start(cb: TempoSourceCallbacks): void;
  stop(): void;
}

// ── Manual ───────────────────────────────────────────────────────────────
// No-op source. Scheduler tempo is set by the user via the editor UI.
export class ManualSource implements TempoSource {
  readonly mode: SyncMode = "manual";
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
}

// ── LOM (Ableton Live Object Model) ──────────────────────────────────────
// Polls Live's song.tempo and song.is_playing every POLL_MS.
// Constructor takes a getter for the Song object so we can swap in a stub for testing.
export interface SongLike {
  tempo: number;
  is_playing?: boolean;
  isPlaying?: boolean;       // SDK property name varies by version
}

export class LomSource implements TempoSource {
  readonly mode: SyncMode = "lom";
  private readonly POLL_MS = 100;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTempo = 0;
  private lastPlaying: boolean | null = null;
  // Dedup state for repeated read failures. Polling at 10 Hz, any sustained
  // LOM read fault would flood SSE with the same message; emit only when the
  // message changes (or on the first occurrence after a successful read).
  private lastErrorMsg: string | null = null;

  constructor(private readonly getSong: () => SongLike | null) {}

  start(cb: TempoSourceCallbacks): void {
    this.lastTempo = 0;
    this.lastPlaying = null;
    this.lastErrorMsg = null;
    const tick = () => {
      const song = this.getSong();
      if (!song) return;
      try {
        const t = song.tempo;
        if (typeof t === "number" && Math.abs(t - this.lastTempo) > 0.001) {
          this.lastTempo = t;
          cb.onTempo(t);
        }
        const playing = (song.is_playing ?? song.isPlaying);
        if (typeof playing === "boolean" && playing !== this.lastPlaying) {
          this.lastPlaying = playing;
          cb.onTransport(playing);
        }
        // Successful read — clear the error dedup so a *new* fault later
        // surfaces immediately instead of being silenced as a repeat.
        this.lastErrorMsg = null;
      } catch (e) {
        const msg = `LOM read failed: ${e instanceof Error ? e.message : String(e)}`;
        if (msg !== this.lastErrorMsg) {
          this.lastErrorMsg = msg;
          cb.onError(msg);
        }
      }
    };
    tick();
    this.timer = setInterval(tick, this.POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

// ── MIDI Clock (24 PPQ) ──────────────────────────────────────────────────
// Creates a virtual MIDI Input. Live (or any DAW) routes MIDI Clock to this port.
// 24 ticks per quarter note; we keep a rolling window of the last N tick intervals
// to derive BPM. Start/Stop messages drive transport.
export class MidiClockSource implements TempoSource {
  readonly mode: SyncMode = "midi-clock";
  private input: easymidi.Input | null = null;
  private tickTimes: number[] = [];
  private readonly WINDOW = 24;  // one quarter note's worth of ticks
  private lastTempoEmitted = 0;
  private cb: TempoSourceCallbacks | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly WATCHDOG_MS = 500;  // no tick within this window → emit transport=false
  // Dedup transport — glitchy upstream hosts that emit repeated "start" or
  // repeated "stop" messages would otherwise spam SSE with redundant state.
  private lastTransportEmitted: boolean | null = null;

  constructor(private readonly portName: string) {}

  start(cb: TempoSourceCallbacks): void {
    this.cb = cb;
    this.tickTimes = [];
    this.lastTempoEmitted = 0;
    this.lastTransportEmitted = null;
    try {
      this.input = new easymidi.Input(this.portName, true);
    } catch (e) {
      cb.onError(`failed to create MIDI Clock input "${this.portName}": ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    this.input.on("clock" as never, () => this.onTick());
    this.input.on("start" as never, () => this.emitTransport(true));
    this.input.on("continue" as never, () => this.emitTransport(true));
    this.input.on("stop" as never, () => this.emitTransport(false));
  }

  private emitTransport(playing: boolean): void {
    if (playing === this.lastTransportEmitted) return;
    this.lastTransportEmitted = playing;
    this.cb?.onTransport(playing);
  }

  private onTick(): void {
    const now = performance.now();
    this.tickTimes.push(now);
    if (this.tickTimes.length > this.WINDOW) this.tickTimes.shift();
    if (this.tickTimes.length >= 12 && this.cb) {
      const span = this.tickTimes[this.tickTimes.length - 1] - this.tickTimes[0];
      const intervals = this.tickTimes.length - 1;
      const msPerTick = span / intervals;
      const msPerBeat = msPerTick * 24;
      const bpm = 60_000 / msPerBeat;
      if (Math.abs(bpm - this.lastTempoEmitted) > 0.05) {
        this.lastTempoEmitted = bpm;
        this.cb.onTempo(bpm);
      }
    }
    // Re-arm watchdog: if no clock arrives within WATCHDOG_MS, infer the upstream
    // stopped sending (some hosts forget the explicit Stop message).
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.tickTimes.length = 0;
      this.lastTempoEmitted = 0;
      this.emitTransport(false);
    }, this.WATCHDOG_MS);
  }

  stop(): void {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    if (this.input) {
      try { this.input.close(); } catch { /* ignore */ }
      this.input = null;
    }
    this.cb = null;
  }
}

// ── Ableton Link ─────────────────────────────────────────────────────────
// Native binding (abletonlink npm). Loaded lazily so the extension still works
// if the native module is missing (e.g. ABI mismatch on a future Node update).
type AbletonLink = {
  bpm: number;
  beat: number;
  phase: number;
  quantum: number;
  numPeers: number;
  isPlayStateSync: boolean;
  isPlaying: boolean;             // shared session state via Link, undocumented in the README
  isPlayingWhenUpdate: boolean;   // last polled value
  enable: () => void;
  disable: () => void;
  enablePlayStateSync: () => void;
  disablePlayStateSync: () => void;
  update: () => void;
  on: (key: string, cb: (v: unknown) => void) => void;
  off: (key: string) => void;
  startUpdate: (intervalMs: number, cb?: (beat: number, phase: number, bpm: number, playState: boolean) => void) => void;
  stopUpdate: () => void;
};

// What the scheduler needs to compute phase-aligned ticks. `beat` is the
// continuous Link timeline (monotonically increasing); `quantum` is the bar
// length we agreed on with peers. cycleN is `floor(beat / quantum)`.
export interface PhaseProvider {
  getPhase(): { beat: number; quantum: number; bpm: number } | null;
  setQuantum(q: number): void;
}

export class LinkSource implements TempoSource, PhaseProvider {
  readonly mode: SyncMode = "link";
  private link: AbletonLink | null = null;
  private cb: TempoSourceCallbacks | null = null;
  private static loadError: string | null = null;

  static available(): boolean {
    if (LinkSource.loadError) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("abletonlink");
      return true;
    } catch (e) {
      LinkSource.loadError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  static loadFailureReason(): string | null { return LinkSource.loadError; }

  start(cb: TempoSourceCallbacks): void {
    this.cb = cb;
    let LinkCtor: { new(): AbletonLink } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      LinkCtor = require("abletonlink") as { new(): AbletonLink };
    } catch (e) {
      cb.onError(`Ableton Link unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      const link = new LinkCtor();
      link.enablePlayStateSync();
      link.enable();
      this.link = link;

      // Poll for state changes. We read `link.isPlaying` (the actual getter)
      // rather than the callback's `playState` arg — both work in practice but
      // the getter is the documented surface in the C++ source.
      let lastBpm: number | null = null;
      let lastPeers = -1;
      let lastIsPlaying: boolean | null = null;
      link.startUpdate(50, (_beat, _phase, bpm) => {
        if (typeof bpm === "number" && bpm > 0 && (lastBpm === null || Math.abs(bpm - lastBpm) > 0.01)) {
          lastBpm = bpm;
          cb.onTempo(bpm);
        }
        const peers = link.numPeers;
        if (typeof peers === "number" && peers !== lastPeers) {
          lastPeers = peers;
          cb.onPeers?.(peers);
        }
        const playing = link.isPlaying;
        if (typeof playing === "boolean" && playing !== lastIsPlaying) {
          lastIsPlaying = playing;
          cb.onTransport(playing);
        }
      });
    } catch (e) {
      cb.onError(`Link init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop(): void {
    if (this.link) {
      try { this.link.stopUpdate(); } catch { /* ignore */ }
      try { this.link.disable(); } catch { /* ignore */ }
      this.link = null;
    }
    this.cb = null;
  }

  currentBeat(): number | null { return this.link?.beat ?? null; }
  currentPhase(): number | null { return this.link?.phase ?? null; }
  numPeers(): number { return this.link?.numPeers ?? 0; }

  // PhaseProvider — scheduler uses this to align cycle ticks to Link bar boundaries.
  getPhase(): { beat: number; quantum: number; bpm: number } | null {
    if (!this.link) return null;
    try {
      this.link.update();
      return { beat: this.link.beat, quantum: this.link.quantum, bpm: this.link.bpm };
    } catch { return null; }
  }

  setQuantum(q: number): void {
    if (!this.link || !(q > 0)) return;
    try { this.link.quantum = q; } catch { /* ignore */ }
  }
}
