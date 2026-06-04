import { describe, it, expect } from "vitest";
import { n, cat } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("structural transforms", () => {
  describe("rev", () => {
    it("reverses event order within a cycle", () => {
      const events = n("a b c").rev().getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "c" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "a" },
      ]);
    });
  });

  describe("palindrome", () => {
    it("cycle 0 plays forward", () => {
      const events = n("a b c").palindrome().getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "c" },
      ]);
    });

    it("cycle 1 plays reversed", () => {
      const events = n("a b c").palindrome().getEvents(1);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "c" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "a" },
      ]);
    });

    it("palindrome equivalent to cat([p, rev(p)])", () => {
      const p = n("0 1 2 3");
      for (let c = 0; c < 4; c++) {
        expect(p.palindrome().getEvents(c)).toEqual(cat([p, p.rev()]).getEvents(c));
      }
    });
  });

  describe("linger", () => {
    it("linger(4) repeats the first 1/4 four times", () => {
      const events = n("0 1 2 3 4 5 6 7").linger(4).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/8, name: "0" },
        { start: 1/8, duration: 1/8, name: "1" },
        { start: 2/8, duration: 1/8, name: "0" },
        { start: 3/8, duration: 1/8, name: "1" },
        { start: 4/8, duration: 1/8, name: "0" },
        { start: 5/8, duration: 1/8, name: "1" },
        { start: 6/8, duration: 1/8, name: "0" },
        { start: 7/8, duration: 1/8, name: "1" },
      ]);
    });
  });

  describe("inside / outside", () => {
    it("inside(2, rev) reverses within a doubled pattern", () => {
      const events = n("a b c d").inside(2, (p) => p.rev()).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "b" },
        { start: 1/4, duration: 1/4, name: "a" },
        { start: 2/4, duration: 1/4, name: "d" },
        { start: 3/4, duration: 1/4, name: "c" },
      ]);
    });

    it("outside(2, rev) on a slow pattern reverses across cycles", () => {
      const events = n("a b c d").slow(2).outside(2, (p) => p.rev()).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "d" },
        { start: 1/2, duration: 1/2, name: "c" },
      ]);
    });
  });

  describe("iter", () => {
    it("iter(4) is unchanged at cycle 0", () => {
      const events = n("0 1 2 3").iter(4).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "0" },
        { start: 1/4, duration: 1/4, name: "1" },
        { start: 2/4, duration: 1/4, name: "2" },
        { start: 3/4, duration: 1/4, name: "3" },
      ]);
    });

    it("iter(4) shifts left by 1/4 at cycle 1", () => {
      const events = n("0 1 2 3").iter(4).getEvents(1);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "1" },
        { start: 1/4, duration: 1/4, name: "2" },
        { start: 2/4, duration: 1/4, name: "3" },
        { start: 3/4, duration: 1/4, name: "0" },
      ]);
    });

    it("iter(4) at cycle 2 shifts by 2/4", () => {
      const events = n("0 1 2 3").iter(4).getEvents(2);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "2" },
        { start: 1/4, duration: 1/4, name: "3" },
        { start: 2/4, duration: 1/4, name: "0" },
        { start: 3/4, duration: 1/4, name: "1" },
      ]);
    });

    it("iter(4) returns to original at cycle 4", () => {
      const p = n("0 1 2 3").iter(4);
      expect(p.getEvents(0)).toEqual(p.getEvents(4));
    });
  });

  describe("rot", () => {
    it("rot(1) rotates event names leftward", () => {
      const events = n("a b c d").rot(1).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "b" },
        { start: 1/4, duration: 1/4, name: "c" },
        { start: 2/4, duration: 1/4, name: "d" },
        { start: 3/4, duration: 1/4, name: "a" },
      ]);
    });

    it("rot is constant across cycles (unlike iter)", () => {
      const p = n("a b c d").rot(1);
      const c0 = p.getEvents(0);
      const c1 = p.getEvents(1);
      expect(c0).toEqual(c1);
    });
  });

  describe("chunk", () => {
    it("chunk(4, add(10)) at cycle 0 transforms slot 0", () => {
      const events = n("0 1 2 3").chunk(4, (p) => p.add(10)).getEvents(0);
      // Slot 0 (positions [0, 1/4)) gets +10; others unchanged.
      // We assert names (with offset applied separately) and timings.
      expect(events.length).toBe(4);
      expect(events[0].name).toBe("0");
      expect(events[0].offset).toBe(10);
      expect(events[1].name).toBe("1");
      expect(events[1].offset ?? 0).toBe(0);
      expect(events[2].name).toBe("2");
      expect(events[2].offset ?? 0).toBe(0);
      expect(events[3].name).toBe("3");
      expect(events[3].offset ?? 0).toBe(0);
    });

    it("chunk(4, add(10)) at cycle 1 transforms slot 1", () => {
      const events = n("0 1 2 3").chunk(4, (p) => p.add(10)).getEvents(1);
      expect(events.length).toBe(4);
      expect(events[0].offset ?? 0).toBe(0);
      expect(events[1].offset).toBe(10);
      expect(events[2].offset ?? 0).toBe(0);
      expect(events[3].offset ?? 0).toBe(0);
    });
  });

  describe("stutter", () => {
    it("stutter(3, 1/4) places three copies with 1/4 gaps", () => {
      const events = n("a").stutter(3, 1/4).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1,   name: "a" },
        { start: 1/4, duration: 3/4, name: "a" },
        { start: 2/4, duration: 1/2, name: "a" },
      ]);
    });

    it("stutter copies past cycle boundary are dropped", () => {
      const events = n("a").stutter(5, 1/3).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1,   name: "a" },
        { start: 1/3, duration: 2/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "a" },
      ]);
    });
  });

  describe("mask", () => {
    it("mask keeps events covered by mask hits", () => {
      const events = n("a b").mask("x ~ x x").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("mask drops events not covered", () => {
      const events = n("a b").mask("~ x").getEvents(0);
      expectEventsMatch(events, [
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("mask accepts a string and promotes via n()", () => {
      const a = n("a b").mask("x ~ x x").getEvents(0);
      const b = n("a b").mask(n("x ~ x x")).getEvents(0);
      expect(a).toEqual(b);
    });
  });

  describe("struct", () => {
    it("struct uses the structure pattern's timing, cycling source values", () => {
      const events = n("a b").struct("1 1 1").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "a" },
      ]);
    });
  });
});
