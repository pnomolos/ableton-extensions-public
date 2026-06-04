import { describe, it, expect } from "vitest";
import { n, s, stack, cat, fastcat, seq } from "../../src/patterns.ts";
import { expectEventsMatch, sortEvents } from "./helpers.mjs";

describe("multi-pattern combinators", () => {
  describe("stack", () => {
    it("plays all parts simultaneously", () => {
      const events = sortEvents(stack([n("a"), n("b"), n("c")]).getEvents(0));
      expectEventsMatch(events, [
        { start: 0, duration: 1, name: "a" },
        { start: 0, duration: 1, name: "b" },
        { start: 0, duration: 1, name: "c" },
      ]);
    });

    it("rejects empty array", () => {
      expect(() => stack([])).toThrow();
    });

    it("rejects mixed note + drum patterns", () => {
      expect(() => stack([n("a"), s("bd")])).toThrow();
    });
  });

  describe("cat", () => {
    it("picks one part per cycle (mod-N)", () => {
      const p = cat([n("a"), n("b")]);
      expectEventsMatch(p.getEvents(0), [{ start: 0, duration: 1, name: "a" }]);
      expectEventsMatch(p.getEvents(1), [{ start: 0, duration: 1, name: "b" }]);
      expectEventsMatch(p.getEvents(2), [{ start: 0, duration: 1, name: "a" }]);
    });

    it("handles negative cycle indices via mod", () => {
      const p = cat([n("a"), n("b")]);
      expect(p.getEvents(-1)).toEqual(p.getEvents(1));
    });
  });

  describe("fastcat / seq", () => {
    it("crams all parts into one cycle", () => {
      const events = fastcat([n("a"), n("b")]).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("internal sequence rescaled to slot", () => {
      const events = fastcat([n("a b"), n("c")]).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/4, name: "b" },
        { start: 1/2, duration: 1/2, name: "c" },
      ]);
    });

    it("seq is exactly fastcat", () => {
      const a = fastcat([n("a"), n("b c")]).getEvents(0);
      const b = seq([n("a"), n("b c")]).getEvents(0);
      expect(a).toEqual(b);
    });
  });

  describe("port-type mixing rejection", () => {
    it("cat rejects mixed notes + drums", () => {
      expect(() => cat([n("a"), s("bd")])).toThrow();
    });

    it("fastcat rejects mixed notes + drums", () => {
      expect(() => fastcat([n("a"), s("bd")])).toThrow();
    });
  });
});
