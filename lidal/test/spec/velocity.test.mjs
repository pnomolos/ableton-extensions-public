import { describe, it, expect } from "vitest";
import { n, sine } from "../../src/patterns.ts";

describe("velocity / gain", () => {
  describe("gain", () => {
    it("gain(0.5) scales velocity by 0.5", () => {
      expect(n("a").gain(0.5).getEvents(0)[0].velocity).toBe(50);
    });

    it("gain(2) clamps to 127", () => {
      expect(n("a").gain(2).getEvents(0)[0].velocity).toBe(127);
    });

    it("gain(0) yields velocity 0", () => {
      expect(n("a").gain(0).getEvents(0)[0].velocity).toBe(0);
    });

    it("gain(-1) throws", () => {
      expect(() => n("a").gain(-1).getEvents(0)).toThrow();
    });

    it("gain(sine) samples per-event at event start phase", () => {
      const events = n("0 1 2 3").gain(sine).getEvents(0);
      // phase 0, 1/4, 2/4, 3/4 → sine = 0.5, 1.0, 0.5, 0.0
      expect(events[0].velocity).toBe(50);
      expect(events[1].velocity).toBe(100);
      expect(events[2].velocity).toBe(50);
      expect(events[3].velocity).toBe(0);
    });

    it("gain accepts a Pattern as argument", () => {
      const events = n("0 1 2 3").gain(n("0.5 1")).getEvents(0);
      // Source events at 0, 1/4, 2/4, 3/4. Gain pattern events: (0.5 @ 0..1/2), (1 @ 1/2..1).
      expect(events[0].velocity).toBe(50);
      expect(events[1].velocity).toBe(50);
      expect(events[2].velocity).toBe(100);
      expect(events[3].velocity).toBe(100);
    });
  });

  describe("velocity", () => {
    it("velocity(0.5) sets velocity to round(0.5 * 127) = 64", () => {
      expect(n("a").velocity(0.5).getEvents(0)[0].velocity).toBe(64);
    });

    it("velocity(80) sets velocity directly to 80", () => {
      expect(n("a").velocity(80).getEvents(0)[0].velocity).toBe(80);
    });

    it("velocity(200) clamps to 127", () => {
      expect(n("a").velocity(200).getEvents(0)[0].velocity).toBe(127);
    });

    it("velocity(-1) throws", () => {
      expect(() => n("a").velocity(-1).getEvents(0)).toThrow();
    });
  });
});
