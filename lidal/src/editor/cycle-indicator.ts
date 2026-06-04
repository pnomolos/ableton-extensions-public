// A small SVG ring rendered next to the status pill that shows the current
// position within the host cycle (phase 0..1). Phase is computed client-side
// from `Date.now() - lastSyncTs` and the latest BPM + quantum reported by
// `sync-status` SSE events; we don't poll the server.
//
// Inactive states:
//   - mode === "link" && linkAvailable === false → hide (would mislead).
//   - the scheduler is stopped (mode === "link" && !linkIsPlaying, or hush)
//     → ring paused at phase 0, faded out.

export type CycleIndicatorMode = "manual" | "lom" | "midi-clock" | "link";

export interface CycleIndicatorInputs {
  mode: CycleIndicatorMode;
  bpm: number;
  quantum: number;          // cycle length in beats (typically 4)
  linkAvailable: boolean;
  /** True if the scheduler is currently allowed to advance (transport playing). */
  playing: boolean;
  /**
   * Current scheduler cycle number. When it changes between updates we snap
   * the indicator's phase back to 0 to compensate for drift accumulated over
   * many cycles (RAF + wall-clock timer don't agree exactly over minutes).
   * Optional — pre-existing callers may not pass it; when absent we skip the
   * resync and behave like before.
   */
  cycleN?: number;
}

export interface CycleIndicator {
  /** The mounted DOM root — caller appends to its preferred location. */
  el: HTMLElement;
  /** Push new inputs (mode/bpm/quantum/playing); re-bases the phase clock. */
  update(inputs: CycleIndicatorInputs): void;
  /** Stop the RAF loop and detach the element. */
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const RING_RADIUS = 8.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Build the cycle indicator. The element is a fixed-size flex item ~40px wide;
 * a track ring + a progress arc + a centred cycle counter.
 */
export function createCycleIndicator(): CycleIndicator {
  const host = document.createElement("div");
  host.id = "feedback-cycle";
  host.className = "lidal-feedback-cycle-ring";
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", "Cycle progress");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "11");
  track.setAttribute("cy", "11");
  track.setAttribute("r", String(RING_RADIUS));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "rgba(255,255,255,0.12)");
  track.setAttribute("stroke-width", "2");
  svg.appendChild(track);

  const arc = document.createElementNS(SVG_NS, "circle");
  arc.setAttribute("cx", "11");
  arc.setAttribute("cy", "11");
  arc.setAttribute("r", String(RING_RADIUS));
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "var(--accent, #6fb37b)");
  arc.setAttribute("stroke-width", "2");
  arc.setAttribute("stroke-linecap", "round");
  // Start the arc at 12-o'clock so phase 0 is straight-up.
  arc.setAttribute("transform", "rotate(-90 11 11)");
  arc.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
  arc.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
  svg.appendChild(arc);

  host.appendChild(svg);

  // State snapshot. We re-base every time inputs change; between updates the
  // RAF loop just samples `Date.now()` and reads these values.
  let inputs: CycleIndicatorInputs = {
    mode: "manual",
    bpm: 120,
    quantum: 4,
    linkAvailable: true,
    playing: false,
  };

  // `cycleMs` is the millisecond duration of one cycle, derived from bpm and
  // quantum. We snapshot the phase at the time of `update()` so we can keep
  // moving smoothly even when no new sync-status comes in for a while.
  // `phaseAtBase` is in [0..1); `baseTs` is the wall-clock ms at which that
  // phase was correct.
  let baseTs = performance.now();
  let phaseAtBase = 0;
  let raf = 0;

  function cycleMs(): number {
    if (!Number.isFinite(inputs.bpm) || inputs.bpm <= 0) return 2000;
    return (inputs.quantum * 60_000) / inputs.bpm;
  }

  function isActive(): boolean {
    if (!inputs.playing) return false;
    if (inputs.mode === "link" && !inputs.linkAvailable) return false;
    return true;
  }

  function isVisible(): boolean {
    // Hide entirely when Link is selected but unavailable — the status pill
    // already explains the situation, the ring would just lie.
    if (inputs.mode === "link" && !inputs.linkAvailable) return false;
    return true;
  }

  function applyArc(phase: number): void {
    const clamped = ((phase % 1) + 1) % 1;
    const dash = RING_CIRCUMFERENCE * (1 - clamped);
    arc.setAttribute("stroke-dashoffset", String(dash));
  }

  function tick(): void {
    if (!isVisible()) {
      host.classList.add("hidden");
    } else {
      host.classList.remove("hidden");
    }
    if (!isActive()) {
      // Paused — render a faded ring frozen at the last phase. We still
      // schedule the next frame because the host might flip `playing` true
      // at any moment.
      host.classList.add("paused");
      applyArc(phaseAtBase);
    } else {
      host.classList.remove("paused");
      const now = performance.now();
      const elapsed = now - baseTs;
      const cm = cycleMs();
      // Phase wraps every cycle. We don't worry about absolute cycle count;
      // the server's status pill shows that.
      const phase = phaseAtBase + (elapsed / cm);
      applyArc(phase);
    }
    raf = requestAnimationFrame(tick);
  }

  function rebase(): void {
    // Recompute phase-at-base from the current animation: the just-rendered
    // value should remain visually continuous after a parameter change.
    // (Without this, switching BPM would teleport the ring backward.)
    if (!isActive()) {
      baseTs = performance.now();
      // Keep phaseAtBase as-is so the paused ring doesn't snap.
      return;
    }
    const now = performance.now();
    const elapsed = now - baseTs;
    const cm = cycleMs();
    const phase = phaseAtBase + (elapsed / cm);
    phaseAtBase = ((phase % 1) + 1) % 1;
    baseTs = now;
  }

  function update(next: CycleIndicatorInputs): void {
    rebase();
    const prevCycleN = inputs.cycleN;
    inputs = next;
    // Resync on cycleN change (TOFIX smaller-fix): RAF-driven phase is
    // necessarily drift-prone over minutes; whenever the server reports a
    // new cycleN we snap our phase back to 0 so the ring stays visually
    // aligned with the scheduler. We only snap when cycleN strictly
    // advances — going backwards (e.g. tempo nudges that re-evaluate the
    // current cycle) is left alone.
    if (typeof next.cycleN === "number" && typeof prevCycleN === "number"
        && next.cycleN > prevCycleN) {
      phaseAtBase = 0;
      baseTs = performance.now();
    }
    // ARIA: report mode + bpm + quantum so screen readers know what's going on.
    host.setAttribute("aria-label", `Cycle progress — ${next.quantum} beats at ${Math.round(next.bpm)} BPM (${next.mode})`);
  }

  raf = requestAnimationFrame(tick);

  return {
    el: host,
    update,
    destroy() {
      cancelAnimationFrame(raf);
      if (host.parentNode) host.parentNode.removeChild(host);
    },
  };
}
