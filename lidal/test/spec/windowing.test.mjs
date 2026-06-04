import { describe, it, expect } from "vitest";
import { n } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("windowing", () => {
  describe("zoom", () => {
    it("zoom(1/4, 3/4) selects window and rescales", () => {
      const events = n("a b c d").zoom(1/4, 3/4).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "b" },
        { start: 1/2, duration: 1/2, name: "c" },
      ]);
    });

    it("zoom rejects invalid ranges", () => {
      expect(() => n("a b").zoom(0, 0).getEvents(0)).toThrow();
      expect(() => n("a b").zoom(0.5, 0.2).getEvents(0)).toThrow();
      expect(() => n("a b").zoom(-0.1, 0.5).getEvents(0)).toThrow();
      expect(() => n("a b").zoom(0.5, 1.5).getEvents(0)).toThrow();
    });
  });

  describe("compress", () => {
    it("compress(1/4, 3/4) squeezes the cycle into the window", () => {
      const events = n("a b").compress(1/4, 3/4).getEvents(0);
      expectEventsMatch(events, [
        { start: 1/4, duration: 1/4, name: "a" },
        { start: 1/2, duration: 1/4, name: "b" },
      ]);
    });
  });

  describe("trunc", () => {
    it("trunc(0.5) truncates to first half", () => {
      const events = n("a b c d").trunc(0.5).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/4, name: "b" },
      ]);
    });
  });
});
