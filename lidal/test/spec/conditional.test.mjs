import { describe, it, expect } from "vitest";
import { n, s } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("conditional transforms", () => {
  describe("every", () => {
    it("every(3, fast(2)) — cycle 0 transformed", () => {
      const events = n("a b c").every(3, (p) => p.fast(2)).getEvents(0);
      // fast(2) of "a b c" → 6 events in one host cycle.
      expect(events.length).toBe(6);
      expectEventsMatch(events, [
        { start: 0/6, duration: 1/6, name: "a" },
        { start: 1/6, duration: 1/6, name: "b" },
        { start: 2/6, duration: 1/6, name: "c" },
        { start: 3/6, duration: 1/6, name: "a" },
        { start: 4/6, duration: 1/6, name: "b" },
        { start: 5/6, duration: 1/6, name: "c" },
      ]);
    });

    it("every(3, fast(2)) — cycles 1 and 2 untransformed", () => {
      const p = n("a b c").every(3, (q) => q.fast(2));
      expect(p.getEvents(1).length).toBe(3);
      expect(p.getEvents(2).length).toBe(3);
    });

    it("every(3, fast(2)) — cycle 3 transformed", () => {
      const events = n("a b c").every(3, (p) => p.fast(2)).getEvents(3);
      expect(events.length).toBe(6);
    });

    it("rejects N < 1", () => {
      expect(() => n("a").every(0, (p) => p).getEvents(0)).toThrow();
      expect(() => n("a").every(-1, (p) => p).getEvents(0)).toThrow();
    });

    it("every(2, id) is a no-op", () => {
      const p = n("0 1 2 3");
      for (let c = 0; c < 4; c++) {
        expect(p.every(2, (x) => x).getEvents(c)).toEqual(p.getEvents(c));
      }
    });

    it("every(1_000_000, fast(2)) never fires at small c (except c=0)", () => {
      const p = n("a b").every(1_000_000, (q) => q.fast(2));
      for (let c = 1; c < 50; c++) {
        expect(p.getEvents(c)).toEqual(n("a b").getEvents(c));
      }
    });
  });

  describe("whenmod", () => {
    it("whenmod(3, 1, fast(2)) — cycle 0 untransformed", () => {
      const p = n("a").whenmod(3, 1, (q) => q.fast(2));
      expect(p.getEvents(0).length).toBe(1);
    });

    it("whenmod(3, 1, fast(2)) — cycle 1 transformed", () => {
      const p = n("a").whenmod(3, 1, (q) => q.fast(2));
      expect(p.getEvents(1).length).toBe(2);
    });

    it("whenmod(3, 1, fast(2)) — cycle 4 transformed", () => {
      const p = n("a").whenmod(3, 1, (q) => q.fast(2));
      expect(p.getEvents(4).length).toBe(2);
    });
  });

  describe("sometimes / often / rarely", () => {
    it("sometimesBy(0.5) flips roughly half of 1000 cycles", () => {
      const base = n("a");
      const flipped = base.sometimesBy(0.5, (p) => p.fast(2));
      let twoCount = 0;
      for (let c = 0; c < 1000; c++) {
        if (flipped.getEvents(c).length === 2) twoCount++;
      }
      expect(twoCount).toBeGreaterThanOrEqual(460);
      expect(twoCount).toBeLessThanOrEqual(540);
    });

    it("sometimesBy(0) is a no-op", () => {
      const p = n("a b c").sometimesBy(0, (q) => q.fast(3));
      for (let c = 0; c < 20; c++) {
        expect(p.getEvents(c)).toEqual(n("a b c").getEvents(c));
      }
    });

    it("sometimesBy(1) always transforms", () => {
      const base = n("a b c");
      const always = base.sometimesBy(1, (q) => q.fast(3));
      const xformed = base.fast(3);
      for (let c = 0; c < 20; c++) {
        expect(always.getEvents(c)).toEqual(xformed.getEvents(c));
      }
    });
  });

  describe("degrade / degradeBy", () => {
    it("degradeBy(0) is a no-op", () => {
      const base = s("bd bd bd bd");
      const p = base.degradeBy(0);
      for (let c = 0; c < 20; c++) {
        expect(p.getEvents(c)).toEqual(base.getEvents(c));
      }
    });

    it("degradeBy(1) drops every event", () => {
      const p = s("bd bd bd bd").degradeBy(1);
      for (let c = 0; c < 20; c++) {
        expect(p.getEvents(c)).toEqual([]);
      }
    });

    it("degrade keeps ~half of 4000 total events", () => {
      const p = s("bd bd bd bd").degrade();
      let kept = 0;
      for (let c = 0; c < 1000; c++) kept += p.getEvents(c).length;
      // E = 2000, sd ≈ sqrt(1000) ≈ 32. 99% CI ~ [1920, 2080].
      expect(kept).toBeGreaterThan(1900);
      expect(kept).toBeLessThan(2100);
    });
  });
});
