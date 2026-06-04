import { describe, it, expect } from "vitest";
import { n, sine2, range, range2 } from "../../src/patterns.ts";

describe("pitch arithmetic", () => {
  describe("add", () => {
    it("add(5) accumulates +5 onto every event's offset", () => {
      const events = n("0 1 2 3").add(5).getEvents(0);
      for (const e of events) expect(e.offset).toBe(5);
    });

    it("add chains accumulate", () => {
      expect(n("0").add(3).add(4).getEvents(0)[0].offset).toBe(7);
    });

    it("add with sine2 range — smooth offset", () => {
      const events = n("0 0 0 0").add(range2(-12, 12, sine2)).getEvents(0);
      // phase 0:   sine2 = 0     → offset 0
      // phase 1/4: sine2 = 1     → offset 12
      // phase 2/4: sine2 = 0     → offset 0
      // phase 3/4: sine2 = -1    → offset -12
      expect(events[0].offset).toBeCloseTo(0, 9);
      expect(events[1].offset).toBeCloseTo(12, 9);
      expect(events[2].offset).toBeCloseTo(0, 9);
      expect(events[3].offset).toBeCloseTo(-12, 9);
    });
  });

  describe("sub", () => {
    it("sub(3) yields offset -3", () => {
      expect(n("0").sub(3).getEvents(0)[0].offset).toBe(-3);
    });
  });

  describe("mul", () => {
    it("add(4) then mul(2) yields offset 8", () => {
      expect(n("0").add(4).mul(2).getEvents(0)[0].offset).toBe(8);
    });
  });

  describe("up (alias for add)", () => {
    it("up(5) equals add(5)", () => {
      const a = n("0").up(5).getEvents(0)[0];
      const b = n("0").add(5).getEvents(0)[0];
      expect(a.offset).toBe(b.offset);
    });
  });

  describe("octave", () => {
    it("octave(2) adds 24 to offset", () => {
      expect(n("0").octave(2).getEvents(0)[0].offset).toBe(24);
    });
  });

  describe("range / range2", () => {
    it("range(50,100, saw) signal — at phase 0 = 50, phase 0.5 = 75", () => {
      // We test with the function form
      const sig = range(50, 100, (c, ph) => ph);
      expect(typeof sig).toBe("function");
      expect(sig(0, 0)).toBeCloseTo(50, 9);
      expect(sig(0, 0.5)).toBeCloseTo(75, 9);
      // phase 1.0 wraps to 0 conceptually; but the function here uses raw ph
      // so 1.0 → 100. Use the actual saw signal for cycle wrap test.
    });

    it("range2(1000,1100, src) on numeric pattern with -1..0.5", () => {
      const src = n("-1 -0.5 0 0.5");
      const events = range2(1000, 1100, src).getEvents(0);
      const names = events.map((e) => parseFloat(e.name));
      expect(names[0]).toBeCloseTo(1000, 6);
      expect(names[1]).toBeCloseTo(1025, 6);
      expect(names[2]).toBeCloseTo(1050, 6);
      expect(names[3]).toBeCloseTo(1075, 6);
    });
  });
});
