import { describe, it, expect } from "vitest";
import { n } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("time scaling", () => {
  describe("fast", () => {
    it("fast(2) doubles density, halves duration", () => {
      const events = n("0 1 2 3").fast(2).getEvents(0);
      expectEventsMatch(events, [
        { start: 0/8, duration: 1/8, name: "0", velocity: 100 },
        { start: 1/8, duration: 1/8, name: "1", velocity: 100 },
        { start: 2/8, duration: 1/8, name: "2", velocity: 100 },
        { start: 3/8, duration: 1/8, name: "3", velocity: 100 },
        { start: 4/8, duration: 1/8, name: "0", velocity: 100 },
        { start: 5/8, duration: 1/8, name: "1", velocity: 100 },
        { start: 6/8, duration: 1/8, name: "2", velocity: 100 },
        { start: 7/8, duration: 1/8, name: "3", velocity: 100 },
      ]);
    });

    it("fast(1) is a no-op", () => {
      expect(n("a b").fast(1).getEvents(0)).toEqual(n("a b").getEvents(0));
    });

    it("fast(3) triples density", () => {
      const events = n("a").fast(3).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 1/3, duration: 1/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "a" },
      ]);
    });

    it("rejects non-positive arguments", () => {
      expect(() => n("a").fast(0).getEvents(0)).toThrow();
      expect(() => n("a").fast(-1).getEvents(0)).toThrow();
    });

    it("Patternable<number> fast — fast(\"<2 3>\") alternates", () => {
      const c0 = n("a b").fast("<2 3>").getEvents(0);
      expectEventsMatch(c0, [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/4, name: "b" },
        { start: 1/2, duration: 1/4, name: "a" },
        { start: 3/4, duration: 1/4, name: "b" },
      ]);
      const c1 = n("a b").fast("<2 3>").getEvents(1);
      expectEventsMatch(c1, [
        { start: 0,   duration: 1/6, name: "a" },
        { start: 1/6, duration: 1/6, name: "b" },
        { start: 2/6, duration: 1/6, name: "a" },
        { start: 3/6, duration: 1/6, name: "b" },
        { start: 4/6, duration: 1/6, name: "a" },
        { start: 5/6, duration: 1/6, name: "b" },
      ]);
    });
  });

  describe("slow", () => {
    it("slow(2) halves density: cycle 0 shows first half", () => {
      const events = n("a b").slow(2).getEvents(0);
      expectEventsMatch(events, [{ start: 0, duration: 1, name: "a" }]);
    });

    it("slow(2) cycle 1 shows second half", () => {
      const events = n("a b").slow(2).getEvents(1);
      expectEventsMatch(events, [{ start: 0, duration: 1, name: "b" }]);
    });

    it("slow(2) then fast(2) round-trips", () => {
      expect(n("a b c d").slow(2).fast(2).getEvents(0))
        .toEqual(n("a b c d").getEvents(0));
    });
  });
});
