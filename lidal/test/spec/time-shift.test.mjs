import { describe, it, expect } from "vitest";
import { n } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("time shifting", () => {
  describe("early / late", () => {
    it("early(0.25) shifts events leftward and wraps with split", () => {
      const events = n("a b").early(0.25).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/2, name: "b" },
        { start: 3/4, duration: 1/4, name: "a" },
      ]);
    });

    it("late(0.25) shifts events rightward and wraps with split", () => {
      const events = n("a b").late(0.25).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "b" },
        { start: 1/4, duration: 1/2, name: "a" },
        { start: 3/4, duration: 1/4, name: "b" },
      ]);
    });

    it("nudge is alias for late", () => {
      const a = n("0 1 2 3").nudge(0.1).getEvents(0);
      const b = n("0 1 2 3").late(0.1).getEvents(0);
      expect(a).toEqual(b);
    });

    it("early(1) is a no-op (normalization)", () => {
      const a = n("a b c d").early(1).getEvents(0);
      const b = n("a b c d").getEvents(0);
      expect(a).toEqual(b);
    });

    it("late(1000000) is equivalent to late(0)", () => {
      const a = n("a b c").late(1000000).getEvents(0);
      const b = n("a b c").late(0).getEvents(0);
      expect(a).toEqual(b);
    });

    it("early(-0.25) equivalent to late(0.25)", () => {
      const a = n("a b c d").early(-0.25).getEvents(0);
      const b = n("a b c d").late(0.25).getEvents(0);
      expect(a).toEqual(b);
    });
  });

  describe("off", () => {
    it("off(0.25, fast(2)) stacks original + shifted transformed copy", () => {
      const events = n("a").off(0.25, (p) => p.fast(2)).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1,   name: "a" },
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/2, name: "a" },
        { start: 3/4, duration: 1/4, name: "a" },
      ]);
    });
  });
});
