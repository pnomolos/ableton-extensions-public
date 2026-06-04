import * as easymidi from "easymidi";
import { noteNameToMidi } from "./notes.js";
import { resolveDrum } from "./drums.js";
import type { Pattern, PortType } from "./patterns.js";
import type { ControlPattern } from "./control.js";
import type { PhaseProvider } from "./sync.js";

// Orbit-aware resolver: drum-port lookups check the orbit's override map first
// (set via `drumMap`/`autoMap` in the sandbox) before falling back to the
// global DRUM_MAP. Note-port lookups are orbit-agnostic.
const RESOLVERS: Record<PortType, (orbit: number, token: string) => number | null> = {
  notes: (_orbit, token) => noteNameToMidi(token),
  drums: (orbit, token) => resolveDrum(orbit, token),
};

// Per-orbit ringbuffer depth. The bake gesture caps at 8 cycles; keeping the
// buffer at that ceiling means a bake never needs to reach further back than
// what we've already captured.
export const BAKE_HISTORY_CYCLES = 8;

export interface BakedNote {
  midi: number;
  velocity: number;
  channel: number;
  start: number;     // 0..1 within cycle
  duration: number;  // 0..1
}

export interface CycleSnapshot {
  cycleN: number;
  cycleBeats: number;
  portType: PortType;
  notes: BakedNote[];
}

// Per-orbit activity sample, fed to the editor's monitor widget. `lastValue`
// is a string for note orbits (resolved name like "C4" or drum alias "bd") and
// an int 0..127 for control orbits. `channel` is 1..16 (1-based for display).
// `active` flips false when scheduler stops firing events for the orbit
// (clearOrbit/hush) so the widget can fade out.
export interface OrbitMonitorSample {
  type: "note" | "ctrl";
  orbit: number;        // 1..16 (notes) or 1..8 (ctrl)
  channel: number;      // 1..16
  lastValue: string | number;
  lastCycle: number;
  active: boolean;
}

interface PlayedNote {
  out: easymidi.Output;
  channel: number;
  note: number;
}

// Slot id for the hidden learn-mode pattern. Kept distinct from c1..c8 so a
// learn request doesn't disturb a user's mapped CC orbit.
const LEARN_SLOT = -1;

export class PatternScheduler {
  private notesPort: easymidi.Output;
  private drumsPort: easymidi.Output;
  private controlPort: easymidi.Output | null;
  private orbits: Map<number, Pattern> = new Map();
  private controlOrbits: Map<number, ControlPattern> = new Map();
  // Per-orbit + per-(channel, cc) last value sent — for dedup and so we can
  // reset on orbit replacement without leaking state across reloads.
  private controlLastValue: Map<number, Map<string, number>> = new Map();
  // Per-orbit last CC number we sent on. Used by `# rest N` so we know which
  // (channel, cc) pair to fire the rest value to when the orbit is cleared.
  private lastCcForOrbit: Map<number, number> = new Map();
  // Per-orbit version counter. Incremented on set/clear; in-flight setTimeouts
  // capture the version at schedule time and skip if it changed — so a clear
  // (and its rest emission) cleanly cancels remaining in-flight CCs from the
  // current cycle.
  private controlOrbitVersion: Map<number, number> = new Map();
  // Learn-slot installed-at cycle, so we can auto-clear after durationCycles.
  private learnInstalledCycle: number | null = null;
  private learnDurationCycles = 0;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private noteTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private running = false;
  private cycleN = 0;
  private bpm = 120;
  private cycleBeats = 4;
  // performance.now() when current cycle's tick fired. Read by setTempo to
  // measure how far into the in-flight cycle we are so the reschedule lands
  // at the correct wall-clock time after a tempo change. Reset on every tick
  // and advanced by setTempo when it reschedules.
  private cycleStartedAt = 0;
  // Track the last cycleN we actually fired events for. Phase jitter can produce
  // a tick that lands *before* the bar boundary it was scheduled for, in which
  // case floor(beat/quantum) returns the same cycleN we just processed. Without
  // this guard we'd re-schedule the (already-fired) events of that cycle.
  private lastFiredCycle: number | null = null;
  // Tracks notes we've issued noteon for so allNotesOff only sends noteoff for those.
  // Key: `${portType}:${channel}:${note}`. Value: enough info to send the off.
  private playedNotes: Map<string, PlayedNote> = new Map();
  // External error sink — set by extension.ts to surface pattern errors via SSE status.
  private onPatternError: ((msg: string) => void) | null = null;
  // Per-orbit dedup state for pattern/control errors. Keyed by `${kind}:${orbit}`
  // where kind is "pattern" or "control". Stores the last error message and a
  // suppression counter. The scheduler logs the first occurrence, suppresses
  // identical repeats, and logs again when the message changes (or when the
  // orbit recovers — see emitOrbitError). Without this, a pattern that throws
  // once per cycle floods the SSE log indefinitely.
  private orbitLastError: Map<string, { msg: string; suppressed: number }> = new Map();
  // Fires once per cycle tick (after events are scheduled). Used by extension.ts
  // to push a fresh status (cycleN) to SSE clients without polling.
  private onCycle: ((cycleN: number) => void) | null = null;
  // Per-orbit live monitor sink. Fired at most ~10 Hz per orbit (the scheduler
  // throttles internally); also fires once with active=false on
  // clearOrbit/hush so consumers can mark widgets stale.
  private onOrbitMonitor: ((sample: OrbitMonitorSample) => void) | null = null;
  // Min interval between consecutive monitor emissions per (type, orbit).
  // ~10 Hz is enough for a value display to feel live without overwhelming
  // SSE clients on a 32nd-note pattern.
  private static readonly MONITOR_THROTTLE_MS = 100;
  // Last emit timestamp per `${type}:${orbit}` key — keyed by string so the
  // note and ctrl spaces of orbit 1 don't share a slot.
  private monitorLastEmit: Map<string, number> = new Map();
  // Last fields per orbit, used to decide whether to emit at all (only emit on
  // change). Map key is `${type}:${orbit}`.
  private monitorLastSample: Map<string, OrbitMonitorSample> = new Map();
  // Per-orbit ringbuffer of cycle snapshots, used by the bake gesture. Captured
  // at tick-time alongside scheduling so already-resolved MIDI + channel survive
  // a later hot-reload. CC orbits are not captured (different event shape).
  private cycleHistory: Map<number, CycleSnapshot[]> = new Map();

  constructor(notesPort: easymidi.Output, drumsPort: easymidi.Output, controlPort: easymidi.Output | null = null) {
    this.notesPort = notesPort;
    this.drumsPort = drumsPort;
    this.controlPort = controlPort;
  }

  setOnPatternError(fn: ((msg: string) => void) | null): void { this.onPatternError = fn; }

  // Log a per-orbit pattern error with dedup. First occurrence: emit verbatim
  // (preserving the original message format). Repeated occurrences with the
  // same message: suppress silently, accumulating a counter. When the message
  // changes (or the orbit's pattern is replaced/cleared and emitOrbitErrorOk
  // resets the slot), emit again — and if any repeats were suppressed since
  // the last emission, prepend the count so the user knows the error was
  // sustained.
  private emitOrbitError(kind: "pattern" | "control", orbit: number, msg: string): void {
    const key = `${kind}:${orbit}`;
    const prev = this.orbitLastError.get(key);
    if (prev && prev.msg === msg) {
      prev.suppressed++;
      return;
    }
    const prefix = prev && prev.suppressed > 0
      ? `(repeated ${prev.suppressed}× then changed) `
      : "";
    this.orbitLastError.set(key, { msg, suppressed: 0 });
    if (this.onPatternError) this.onPatternError(`${prefix}${msg}`);
  }

  // Clear a per-orbit error slot — call when the orbit successfully evaluates
  // (so a transient throw doesn't permanently dedup later identical messages)
  // or when the orbit is removed (so cycleHistory/version state stays tidy).
  private clearOrbitError(kind: "pattern" | "control", orbit: number): void {
    const key = `${kind}:${orbit}`;
    const prev = this.orbitLastError.get(key);
    if (prev && prev.suppressed > 0 && this.onPatternError) {
      this.onPatternError(`(previous error repeated ${prev.suppressed}× then cleared)`);
    }
    this.orbitLastError.delete(key);
  }
  setOnCycle(fn: ((cycleN: number) => void) | null): void { this.onCycle = fn; }
  setOnOrbitMonitor(fn: ((sample: OrbitMonitorSample) => void) | null): void {
    this.onOrbitMonitor = fn;
  }

  // Throttled emit. Skips when:
  //   • no listener installed
  //   • this orbit fired < MONITOR_THROTTLE_MS ago and nothing changed except cycleN
  //   • lastValue + active match the previous emission and < throttle window
  // Always emits the inactive flip (active=false) immediately — that's the
  // "widget should fade" signal and the user expects it to feel instant.
  private emitMonitor(sample: OrbitMonitorSample): void {
    if (!this.onOrbitMonitor) return;
    const key = `${sample.type}:${sample.orbit}`;
    const now = performance.now();
    const prev = this.monitorLastSample.get(key);
    const lastAt = this.monitorLastEmit.get(key) ?? 0;
    const stateFlip = !prev || prev.active !== sample.active;
    // Inactive transitions are always allowed through. Otherwise, drop if we
    // emitted recently AND nothing changed.
    if (!stateFlip) {
      if (now - lastAt < PatternScheduler.MONITOR_THROTTLE_MS) {
        if (prev
            && prev.lastValue === sample.lastValue
            && prev.channel === sample.channel) {
          return;  // identical value within throttle window — drop
        }
      }
    }
    this.monitorLastSample.set(key, sample);
    this.monitorLastEmit.set(key, now);
    try { this.onOrbitMonitor(sample); } catch { /* never let a listener kill the tick */ }
  }

  // Resolves the human-readable last value for a note-orbit event in the same
  // way the scheduler does at tick time. Mirrors the pre-resolver token (e.g.
  // "bd" / "c4") rather than the post-resolver MIDI integer — the user wrote
  // the alias, so that's what they want to see scrolling by.
  private noteValueDisplay(token: string, offset: number | undefined): string {
    if (!offset) return token;
    return `${token}${offset > 0 ? "+" : ""}${offset}`;
  }

  isRunning(): boolean { return this.running; }
  currentCycle(): number { return this.cycleN; }
  activeOrbits(): number[] { return [...this.orbits.keys()].sort((a, b) => a - b); }
  activeControlOrbits(): number[] {
    return [...this.controlOrbits.keys()].filter((k) => k !== LEARN_SLOT).sort((a, b) => a - b);
  }

  setOrbit(orbit: number, pattern: Pattern): void {
    this.orbits.set(orbit, pattern);
    // Reset error dedup state — a re-eval with a fresh pattern should not
    // suppress a new failure just because it matches a stale message.
    this.orbitLastError.delete(`pattern:${orbit}`);
    this.ensureRunning();
  }

  clearOrbit(orbit: number): void {
    const wasActive = this.orbits.has(orbit);
    this.orbits.delete(orbit);
    // Drop bake history for this orbit — user explicitly silenced it, so the
    // ringbuffer's contents are stale by intent. setOrbit() does NOT do this;
    // hot reloading preserves the audible material for typo recovery.
    this.cycleHistory.delete(orbit);
    this.clearOrbitError("pattern", orbit);
    if (wasActive) {
      // Fire one terminal inactive event so the widget can fade out. lastValue
      // / channel mirror the prior sample if any — falling back to placeholders
      // for the rare case the orbit was set but never ticked.
      const prev = this.monitorLastSample.get(`note:${orbit}`);
      this.emitMonitor({
        type: "note",
        orbit,
        channel: prev?.channel ?? 1,
        lastValue: prev?.lastValue ?? "",
        lastCycle: this.cycleN,
        active: false,
      });
    }
    if (this.orbits.size === 0 && this.controlOrbits.size === 0) this.stop();
  }

  // Returns the most recent `cycles` snapshots for `orbit`, oldest-first.
  // Empty array if no history. Snapshots are immutable copies of resolved MIDI.
  getBakeHistory(orbit: number, cycles: number): CycleSnapshot[] {
    const buf = this.cycleHistory.get(orbit);
    if (!buf || buf.length === 0) return [];
    const n = Math.max(0, Math.min(cycles, buf.length));
    return buf.slice(buf.length - n);
  }

  setControlOrbit(orbit: number, pattern: ControlPattern): void {
    this.controlOrbits.set(orbit, pattern);
    // Reset dedup so a re-eval re-emits identical values (user expectation:
    // "I changed the line, I want to see fresh CC traffic").
    this.controlLastValue.delete(orbit);
    // Drop any sticky error-dedup state — a fresh pattern should be evaluated
    // on its own merits, not silenced because a previous one happened to fail
    // with the same message.
    this.orbitLastError.delete(`control:${orbit}`);
    // Replacement does NOT fire the outgoing rest — that would inject an
    // audible snap before the new sweep starts. Just drop the address: the
    // new orbit's first emission will repopulate it.
    this.lastCcForOrbit.delete(orbit);
    this.bumpOrbitVersion(orbit);
    this.ensureRunning();
  }

  clearControlOrbit(orbit: number): void {
    const outgoing = this.controlOrbits.get(orbit);
    const wasActive = outgoing !== undefined;
    this.controlOrbits.delete(orbit);
    this.controlLastValue.delete(orbit);
    this.clearOrbitError("control", orbit);
    if (wasActive) {
      const prev = this.monitorLastSample.get(`ctrl:${orbit}`);
      this.emitMonitor({
        type: "ctrl",
        orbit,
        channel: prev?.channel ?? 1,
        lastValue: prev?.lastValue ?? 0,
        lastCycle: this.cycleN,
        active: false,
      });
    }
    // Bump the version BEFORE emitting the rest so any in-flight setTimeouts
    // see a stale version and skip — otherwise stragglers from the current
    // cycle would race past the rest value and overwrite it on the parameter.
    this.bumpOrbitVersion(orbit);
    // If the outgoing orbit declared `# rest N`, emit one final CC at N on the
    // orbit's channel + the CC last seen for that orbit. Without the cc number
    // we have nothing to address (the orbit could have used a Patternable cc),
    // so we replay the last (channel, cc) we observed. If we never sent a CC
    // for this orbit, we can't safely guess — skip silently.
    if (outgoing && outgoing.restValue !== null && this.controlPort) {
      const restCc = this.lastCcForOrbit.get(orbit);
      if (restCc !== undefined) {
        try {
          this.controlPort.send("cc", {
            controller: restCc,
            value: outgoing.restValue,
            channel: outgoing.channel as 0,
          });
        } catch (e) {
          if (this.onPatternError) {
            this.onPatternError(`rest send failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    this.lastCcForOrbit.delete(orbit);
    if (this.orbits.size === 0 && this.controlOrbits.size === 0) this.stop();
  }

  private bumpOrbitVersion(orbit: number): void {
    this.controlOrbitVersion.set(orbit, (this.controlOrbitVersion.get(orbit) ?? 0) + 1);
  }

  // Install a transient learn-mode pattern that auto-clears after `durationCycles`.
  installLearn(pattern: ControlPattern, durationCycles: number): void {
    this.controlOrbits.set(LEARN_SLOT, pattern);
    this.controlLastValue.delete(LEARN_SLOT);
    this.lastCcForOrbit.delete(LEARN_SLOT);
    this.bumpOrbitVersion(LEARN_SLOT);
    this.learnInstalledCycle = this.cycleN;
    this.learnDurationCycles = Math.max(1, Math.floor(durationCycles));
    this.ensureRunning();
  }

  hush(): void {
    // Bump every active orbit so any in-flight setTimeouts skip cleanly.
    for (const orbit of this.controlOrbits.keys()) this.bumpOrbitVersion(orbit);
    // Snapshot active orbits before clearing so we can emit terminal monitor
    // events with the last-known values intact. Without this, the widget would
    // freeze on the most recent active sample and never go inactive.
    const noteOrbitsToInactivate = [...this.orbits.keys()];
    const ctrlOrbitsToInactivate = [...this.controlOrbits.keys()].filter((k) => k !== LEARN_SLOT);
    this.orbits.clear();
    this.controlOrbits.clear();
    this.controlLastValue.clear();
    this.lastCcForOrbit.clear();
    this.cycleHistory.clear();
    // Drop accumulated error-dedup state — hush is a clean slate.
    this.orbitLastError.clear();
    this.learnInstalledCycle = null;
    for (const o of noteOrbitsToInactivate) {
      const prev = this.monitorLastSample.get(`note:${o}`);
      this.emitMonitor({
        type: "note", orbit: o,
        channel: prev?.channel ?? 1,
        lastValue: prev?.lastValue ?? "",
        lastCycle: this.cycleN,
        active: false,
      });
    }
    for (const o of ctrlOrbitsToInactivate) {
      const prev = this.monitorLastSample.get(`ctrl:${o}`);
      this.emitMonitor({
        type: "ctrl", orbit: o,
        channel: prev?.channel ?? 1,
        lastValue: prev?.lastValue ?? 0,
        lastCycle: this.cycleN,
        active: false,
      });
    }
    this.stop();
  }

  setTempo(bpm: number, cycleBeats: number): void {
    if (typeof bpm === "number" && bpm > 0) this.bpm = bpm;
    if (typeof cycleBeats === "number" && cycleBeats > 0) this.cycleBeats = cycleBeats;
    if (this.phaseSource) this.phaseSource.setQuantum(this.cycleBeats);

    // Reschedule the in-flight cycleTimer based on the new tempo. Without this,
    // tempo changes only take effect at the next natural cycle boundary, which
    // accumulates drift in MIDI Clock / LOM polling modes.
    //
    // Correctness invariant: `cycleStartedAt` is the wall-clock time the
    // current cycle's tick() fired. `elapsed` is the real wall-clock time
    // spent in this cycle so far. The cycle is now newCycleMs long, measured
    // from cycleStartedAt — so what's left is `newCycleMs - elapsed`. If the
    // new tempo is fast enough that we've already overrun it (elapsed >=
    // newCycleMs), fire immediately; tick() will reset cycleStartedAt and
    // the next cycle starts fresh. We deliberately do NOT advance
    // cycleStartedAt here — repeated setTempo calls within the same cycle
    // each measure elapsed from the same origin, which is the only way to
    // keep the boundary aligned with what Link/LOM/midi-clock expect.
    if (this.cycleTimer && this.running && !this.phaseSource) {
      const elapsed = performance.now() - this.cycleStartedAt;
      const newCycleMs = (this.cycleBeats * 60_000) / this.bpm;
      const remaining = Math.max(0, newCycleMs - elapsed);
      clearTimeout(this.cycleTimer);
      this.cycleTimer = setTimeout(() => this.tick(), remaining);
    }
  }

  // Phase-aligned mode. When set, scheduler derives cycleN from the provider's
  // beat position and schedules ticks to land exactly on bar boundaries.
  // null = internal scheduling (the legacy behavior).
  private phaseSource: PhaseProvider | null = null;
  setPhaseSource(p: PhaseProvider | null): void {
    this.phaseSource = p;
    this.lastFiredCycle = null;
    if (p) p.setQuantum(this.cycleBeats);
    if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    if (this.running) this.tick();
  }

  // Transport gating — used by sync sources to follow an external transport.
  private transportPlaying = true;
  setTransportEnabled(playing: boolean): void {
    if (this.transportPlaying === playing) return;
    this.transportPlaying = playing;
    if (!playing) {
      if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
      for (const t of this.noteTimers) clearTimeout(t);
      this.noteTimers.clear();
      this.running = false;
      // Reset the re-fire guard. Mirrors setPhaseSource: re-enabling transport
      // after a pause can land on the same cycleN we last fired (especially
      // under LOM where stop/start happens mid-bar), and without a reset the
      // first cycle after resume would be silently skipped.
      this.lastFiredCycle = null;
      this.allNotesOff();
    } else {
      this.ensureRunning();
    }
  }

  private ensureRunning(): void {
    if (this.running) return;
    if (!this.transportPlaying) return;
    if (this.orbits.size === 0 && this.controlOrbits.size === 0) return;
    this.running = true;
    this.tick();
  }

  private portFor(type: PortType): easymidi.Output {
    return type === "drums" ? this.drumsPort : this.notesPort;
  }

  private tick(): void {
    if (!this.running) return;
    this.cycleStartedAt = performance.now();

    let cycleN: number;
    let cycleMs: number;
    let nextDelayMs: number;
    let offsetIntoCycleMs = 0;
    let cycleBeatsNow: number;

    if (this.phaseSource) {
      // When a phase source is configured, never advance cycleN from the internal
      // counter — it must come from the source. If the source temporarily can't
      // report (e.g. Link.update threw, source was just attached), poll again soon
      // without firing or advancing.
      const phase = this.phaseSource.getPhase();
      if (!phase || !(phase.bpm > 0) || !(phase.quantum > 0)) {
        this.cycleTimer = setTimeout(() => this.tick(), 50);
        return;
      }
      const beatMs = 60_000 / phase.bpm;
      cycleN = Math.floor(phase.beat / phase.quantum);
      cycleMs = phase.quantum * beatMs;
      offsetIntoCycleMs = (phase.beat - cycleN * phase.quantum) * beatMs;
      nextDelayMs = cycleMs - offsetIntoCycleMs;
      cycleBeatsNow = phase.quantum;
      this.cycleN = cycleN;
    } else {
      cycleN = this.cycleN++;
      cycleMs = (this.cycleBeats * 60_000) / this.bpm;
      nextDelayMs = cycleMs;
      cycleBeatsNow = this.cycleBeats;
    }

    // Guard against re-firing events for a cycle we already processed. Happens
    // when phase-mode jitter makes the next tick land before the boundary we
    // scheduled it for, which can produce e.g. 5 hits when the pattern has 4.
    if (this.lastFiredCycle === cycleN) {
      this.cycleTimer = setTimeout(() => this.tick(), Math.max(1, nextDelayMs));
      return;
    }
    this.lastFiredCycle = cycleN;
    if (this.onCycle) {
      try { this.onCycle(cycleN); } catch { /* never let a listener kill the tick */ }
    }

    for (const [orbit, pattern] of this.orbits) {
      const out = this.portFor(pattern.portType);
      const resolver = RESOLVERS[pattern.portType];
      const ch = pattern.channel;
      const portType = pattern.portType;
      let events;
      try { events = pattern.getEvents(cycleN); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.emitOrbitError("pattern", orbit, `pattern eval failed: ${msg}`);
        continue;
      }
      // Successful eval: clear any pending suppressed-count for this orbit.
      this.clearOrbitError("pattern", orbit);

      // Pick the last event of the cycle (chronologically) for the monitor
      // sample — that's "what's playing now" most of the time. Empty cycles
      // skip emission entirely so a silent orbit doesn't ping the widget.
      let monitorToken: string | null = null;
      let monitorOffset: number | undefined;
      let monitorChannel = ch + 1;  // 1-based for editor display

      // Captured alongside scheduling so the snapshot reflects exactly what the
      // user heard — post-resolver, post-offset, post-clamp — even if the
      // pattern is later edited or cleared.
      const snapshotNotes: BakedNote[] = [];

      for (const ev of events) {
        const baseMidi = resolver(orbit, ev.name);
        if (baseMidi == null) continue;
        // Pitch offset (from add/sub/mul/up/octave): apply, round, then clamp/drop.
        const midi = Math.round(baseMidi + (ev.offset ?? 0));
        if (midi < 0 || midi > 127 || !Number.isFinite(midi)) continue;
        const onAt = ev.start * cycleMs - offsetIntoCycleMs;
        const offAt = (ev.start + ev.duration) * cycleMs - offsetIntoCycleMs;
        // Skip events whose entire window is already in the past. We deliberately
        // do NOT skip events with a slightly-negative onAt — clamping to 0 produces
        // at most a one-time micro-flam on sync activation, but avoids dropping the
        // first beat of every cycle when there's a few ms of phase jitter.
        if (offAt <= 0) continue;
        const velocity = Math.max(0, Math.min(127, Math.round(ev.velocity)));
        // Per-event channel: explicit absolute > pattern.channel + offset > pattern.channel.
        // Used by stack (per-part .ch tagging) and jux (relative offset for "next channel").
        const evCh = ev.channel !== undefined
          ? ev.channel & 0x0F
          : ev.channelOffset !== undefined
            ? ((ch + ev.channelOffset) % 16 + 16) % 16
            : ch;
        // Track the last (chronologically) fired event for monitor display.
        // Events arrive sorted by start, so the last in-range event is the one
        // the user just heard. Channel display is 1-based; mirror the same
        // channel resolution as MIDI emission so jux/stack route correctly.
        monitorToken = ev.name;
        monitorOffset = ev.offset;
        monitorChannel = (evCh & 0x0F) + 1;
        snapshotNotes.push({
          midi,
          velocity,
          channel: evCh,
          start: ev.start,
          duration: ev.duration,
        });
        const noteKey = `${portType}:${evCh}:${midi}`;
        const onTimer = setTimeout(() => {
          this.noteTimers.delete(onTimer);
          if (this.running) {
            // Record the note in the panic table BEFORE issuing noteon, not
            // after. Without this, a SIGHUP-driven stop() that races between
            // out.send() and playedNotes.set() lands in the gap — the noteon
            // has already left the port, but allNotesOff has nothing to
            // match against, so the synth holds a stuck note. Optimistic
            // insertion closes the hole; the offTimer (or the panic table
            // walk in allNotesOff) clears the entry.
            this.playedNotes.set(noteKey, { out, channel: evCh, note: midi });
            try {
              out.send("noteon", { note: midi, velocity, channel: evCh as easymidi.Channel });
            } catch (e) {
              // If the port send threw, the noteon never made it to the
              // synth — drop the optimistic entry so a future panic doesn't
              // emit a phantom noteoff for a note that was never on. The
              // offTimer's own send is wrapped similarly below.
              this.playedNotes.delete(noteKey);
              if (this.onPatternError) {
                this.onPatternError(`noteon send failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }, onAt);
        const offTimer = setTimeout(() => {
          this.noteTimers.delete(offTimer);
          if (this.running) {
            // Drop from the panic table BEFORE issuing noteoff. Mirrors the
            // noteon side: if SIGHUP races us between send and delete, we
            // prefer the panic walk to skip this key (we already sent the
            // off) rather than double-fire.
            this.playedNotes.delete(noteKey);
            try {
              out.send("noteoff", { note: midi, velocity: 0, channel: evCh as easymidi.Channel });
            } catch {
              // Best-effort: the synth either gets the off here, or — if the
              // port is gone — there's nothing useful we can do. Errors
              // during teardown are not the user's problem.
            }
          }
        }, offAt);
        this.noteTimers.add(onTimer);
        this.noteTimers.add(offTimer);
      }

      let history = this.cycleHistory.get(orbit);
      if (!history) { history = []; this.cycleHistory.set(orbit, history); }
      history.push({ cycleN, cycleBeats: cycleBeatsNow, portType, notes: snapshotNotes });
      if (history.length > BAKE_HISTORY_CYCLES) history.shift();

      // Emit a monitor sample for this orbit if it fired anything resolvable.
      // Empty cycles (all-rest / all-unresolved) skip emission so the widget
      // doesn't get an "active" ping for a silent bar.
      if (monitorToken !== null) {
        this.emitMonitor({
          type: "note",
          orbit,
          channel: monitorChannel,
          lastValue: this.noteValueDisplay(monitorToken, monitorOffset),
          lastCycle: cycleN,
          active: true,
        });
      }
    }

    // ── Control orbits: schedule CC sends for this cycle ────────────────
    if (this.controlPort && this.controlOrbits.size > 0) {
      const cport = this.controlPort;
      // Auto-clear the learn slot once its sweep duration has elapsed.
      if (this.learnInstalledCycle !== null
          && cycleN - this.learnInstalledCycle >= this.learnDurationCycles) {
        this.controlOrbits.delete(LEARN_SLOT);
        this.controlLastValue.delete(LEARN_SLOT);
        this.lastCcForOrbit.delete(LEARN_SLOT);
        this.bumpOrbitVersion(LEARN_SLOT);
        this.learnInstalledCycle = null;
      }

      for (const [orbit, cpat] of this.controlOrbits) {
        let cevents;
        try { cevents = cpat.getEvents(cycleN); }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.emitOrbitError("control", orbit, `control eval failed: ${msg}`);
          continue;
        }
        this.clearOrbitError("control", orbit);
        const ch = cpat.channel;
        let lastVals = this.controlLastValue.get(orbit);
        if (!lastVals) { lastVals = new Map(); this.controlLastValue.set(orbit, lastVals); }
        const scheduledVersion = this.controlOrbitVersion.get(orbit) ?? 0;

        // Last CC value seen this cycle (chronological), for monitor emission.
        // Events arrive sorted by start, so the final entry is the most recent.
        let monitorCcValue: number | null = null;
        let monitorCcChannel = ch + 1;

        for (const ev of cevents) {
          const onAt = ev.start * cycleMs - offsetIntoCycleMs;
          // Skip CC events already in the past (mid-cycle activation flam). The
          // next cycle catches up; the dedup map prevents duplicate-at-t=0 clicks.
          if (onAt < 0) continue;
          const cc = ev.cc & 0x7F;
          const value = ev.value & 0x7F;
          // Per-event channel routing: explicit absolute > pattern.channel + offset > pattern.channel.
          // Used by stack (per-part .ch tagging) and jux (relative offset).
          const evCh = ev.channel !== undefined
            ? ev.channel & 0x0F
            : ev.channelOffset !== undefined
              ? ((ch + ev.channelOffset) % 16 + 16) % 16
              : ch;
          // Track last CC for the monitor — last event in chronological order wins.
          monitorCcValue = value;
          monitorCcChannel = (evCh & 0x0F) + 1;
          const dedupKey = `${evCh}:${cc}`;
          const onTimer = setTimeout(() => {
            this.noteTimers.delete(onTimer);
            if (!this.running) return;
            // Skip if the orbit was cleared/replaced after this CC was scheduled —
            // otherwise a stale in-flight smooth-signal sample races past a rest.
            if ((this.controlOrbitVersion.get(orbit) ?? 0) !== scheduledVersion) return;
            const prev = lastVals!.get(dedupKey);
            if (prev === value) return;
            try {
              cport.send("cc", { controller: cc, value, channel: evCh as 0 });
              lastVals!.set(dedupKey, value);
              this.lastCcForOrbit.set(orbit, cc);
            } catch (e) {
              if (this.onPatternError) {
                this.onPatternError(`cc send failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }, Math.max(0, onAt));
          this.noteTimers.add(onTimer);
        }

        // Skip monitor for the hidden learn slot — it's an internal sweep, not
        // a user-visible orbit. c1..c8 only.
        if (orbit !== LEARN_SLOT && monitorCcValue !== null) {
          this.emitMonitor({
            type: "ctrl",
            orbit,
            channel: monitorCcChannel,
            lastValue: monitorCcValue,
            lastCycle: cycleN,
            active: true,
          });
        }
      }
    }

    this.cycleTimer = setTimeout(() => this.tick(), nextDelayMs);
  }

  stop(): void {
    this.running = false;
    this.lastFiredCycle = null;
    if (this.cycleTimer) { clearTimeout(this.cycleTimer); this.cycleTimer = null; }
    for (const t of this.noteTimers) clearTimeout(t);
    this.noteTimers.clear();
    this.allNotesOff();
  }

  // Targeted noteoff for notes we issued noteon for. Avoids flooding CoreMIDI
  // with 4096 messages (16 channels × 128 notes × 2 ports) on every stop.
  private allNotesOff(): void {
    for (const { out, channel, note } of this.playedNotes.values()) {
      try { out.send("noteoff", { note, velocity: 0, channel: channel as easymidi.Channel }); } catch { /* ignore */ }
    }
    this.playedNotes.clear();
  }
}
