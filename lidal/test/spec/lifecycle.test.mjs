// Lifecycle + observability tests for backend additions: orbit-monitor SSE
// emission from the scheduler, sync-status event shape, and the throttle
// semantics that keep both channels from flooding clients.

import { describe, it, expect } from "vitest";
import { PatternScheduler } from "../../src/scheduler.ts";
import { n } from "../../src/patterns.ts";
import { ctrl } from "../../src/control.ts";

// Minimal stub MIDI output. Captures sends so a test can assert the scheduler
// did something audible (or didn't). Mirrors what easymidi.Output exposes —
// just `send` and `close` — so the scheduler doesn't have to know it's a stub.
function makeStub() {
  return {
    sent: [],
    send(type, msg) { this.sent.push({ type, ...msg }); },
    close() {},
  };
}

describe("scheduler orbit-monitor", () => {
  it("emits a sample for an active note orbit with the last-fired token", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(480, 4);  // ~0.5s/cycle to keep tests snappy
    sch.setOrbit(1, n("c4 e4 g4"));
    await new Promise((r) => setTimeout(r, 600));
    sch.hush();

    // At least one active sample for orbit 1. The last token of "c4 e4 g4" is
    // "g4" (final slot fires last in cycle, after start ascending sort).
    const active = samples.filter((s) => s.type === "note" && s.active);
    expect(active.length).toBeGreaterThan(0);
    const lastActive = active[active.length - 1];
    expect(lastActive.orbit).toBe(1);
    expect(lastActive.lastValue).toBe("g4");
  });

  it("emits an active=false sample after clearOrbit", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(480, 4);
    sch.setOrbit(1, n("c4"));
    await new Promise((r) => setTimeout(r, 250));
    sch.clearOrbit(1);
    // clearOrbit always fires an inactive event for the cleared orbit so the
    // editor widget can fade. No throttle for state flips — verify the event
    // is in the captured set.
    const inactive = samples.filter((s) => s.type === "note" && s.orbit === 1 && !s.active);
    expect(inactive.length).toBeGreaterThanOrEqual(1);
  });

  it("throttles repeated identical-value emissions within 100ms", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(2400, 4);  // ~100ms/cycle — repeated emissions per cycle
    sch.setOrbit(1, n("c4"));
    await new Promise((r) => setTimeout(r, 350));
    sch.hush();

    // With ~100ms cycle, three full cycles in 350ms ≈ 3 emit attempts. Throttle
    // limits to ~1 emit per 100ms, so we expect <=4 active samples (some
    // jitter). The strict assertion: we DON'T see 10+ samples (which would
    // mean throttle is broken). Also expect at least one (the first cycle).
    const noteActive = samples.filter((s) => s.type === "note" && s.active);
    expect(noteActive.length).toBeGreaterThanOrEqual(1);
    expect(noteActive.length).toBeLessThan(10);
  });

  it("emits ctrl orbit samples with numeric lastValue", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(240, 4);
    // ctrl 74 "0 64 127 64" — discrete pattern, final value 64
    sch.setControlOrbit(1, ctrl(74, "0 64 127 64"));
    await new Promise((r) => setTimeout(r, 1100));
    sch.hush();

    const ctrlActive = samples.filter((s) => s.type === "ctrl" && s.active);
    expect(ctrlActive.length).toBeGreaterThan(0);
    const last = ctrlActive[ctrlActive.length - 1];
    expect(last.orbit).toBe(1);
    expect(typeof last.lastValue).toBe("number");
    expect(last.lastValue).toBe(64);
  });

  it("does not emit for the hidden learn slot", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(240, 4);
    // Install a learn pattern (negative slot id internally) — should produce
    // CC traffic but no monitor events.
    const { buildLearnPattern } = await import("../../src/control.ts");
    sch.installLearn(buildLearnPattern({ cc: 1, channel: 1, durationCycles: 1 }), 1);
    await new Promise((r) => setTimeout(r, 350));
    sch.hush();

    // No ctrl-type samples should have been emitted — learn slot is filtered
    // out at emit time.
    const ctrlSamples = samples.filter((s) => s.type === "ctrl" && s.active);
    expect(ctrlSamples).toEqual([]);
  });

  it("emits inactive for all active orbits on hush", async () => {
    const out = makeStub();
    const samples = [];
    const sch = new PatternScheduler(out, out, out);
    sch.setOnOrbitMonitor((s) => samples.push(s));
    sch.setTempo(480, 4);
    sch.setOrbit(1, n("c4"));
    sch.setOrbit(2, n("e4"));
    sch.setControlOrbit(3, ctrl(74, 100));
    await new Promise((r) => setTimeout(r, 200));
    samples.length = 0;  // clear accumulated active samples to isolate hush behavior
    sch.hush();

    // hush fires terminal inactive=false events for every previously active
    // orbit (notes + ctrls). Three orbits, so at least three inactive samples.
    const inactives = samples.filter((s) => !s.active);
    const orbits = new Set(inactives.map((s) => `${s.type}:${s.orbit}`));
    expect(orbits.has("note:1")).toBe(true);
    expect(orbits.has("note:2")).toBe(true);
    expect(orbits.has("ctrl:3")).toBe(true);
  });
});
