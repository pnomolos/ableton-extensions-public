import { describe, it, expect } from "vitest";
import { run, silence, irand, choose, wchoose } from "../../src/patterns.ts";
import { expectEventsMatch } from "./helpers.mjs";

describe("value constructors", () => {
  describe("run", () => {
    it("run(4) produces 0..3 across one cycle", () => {
      const events = run(4).getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "0" },
        { start: 1/4, duration: 1/4, name: "1" },
        { start: 2/4, duration: 1/4, name: "2" },
        { start: 3/4, duration: 1/4, name: "3" },
      ]);
    });
  });

  describe("silence", () => {
    it("emits no events at any cycle", () => {
      for (let c = -10; c < 10; c++) {
        expect(silence.getEvents(c)).toEqual([]);
      }
    });
  });

  describe("irand", () => {
    it("emits one event per cycle, name in 0..N-1", () => {
      for (let c = 0; c < 20; c++) {
        const events = irand(8).getEvents(c);
        expect(events.length).toBe(1);
        const v = parseInt(events[0].name, 10);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(8);
      }
    });

    it("is deterministic per cycle", () => {
      for (let c = 0; c < 20; c++) {
        expect(irand(8).getEvents(c)).toEqual(irand(8).getEvents(c));
      }
    });

    it("distributes roughly evenly over 800 cycles", () => {
      const counts = new Array(8).fill(0);
      for (let c = 0; c < 800; c++) {
        const v = parseInt(irand(8).getEvents(c)[0].name, 10);
        counts[v]++;
      }
      // Each bin expected ~100, sd ≈ sqrt(800*0.125*0.875) ≈ 9.3. Allow ±5 sigma (~50).
      for (const x of counts) {
        expect(x).toBeGreaterThan(50);
        expect(x).toBeLessThan(150);
      }
    });
  });

  describe("choose", () => {
    it("returns deterministic single-event picks per cycle", () => {
      const p = choose(["a", "b", "c"]);
      for (let c = 0; c < 20; c++) {
        const events = p.getEvents(c);
        expect(events.length).toBe(1);
        expect(["a", "b", "c"]).toContain(events[0].name);
        expect(p.getEvents(c)).toEqual(events);
      }
    });

    it("distributes roughly evenly over 900 cycles", () => {
      const p = choose(["a", "b", "c"]);
      const counts = { a: 0, b: 0, c: 0 };
      for (let c = 0; c < 900; c++) counts[p.getEvents(c)[0].name]++;
      for (const k of ["a", "b", "c"]) {
        expect(counts[k]).toBeGreaterThan(230);
        expect(counts[k]).toBeLessThan(370);
      }
    });
  });

  describe("wchoose", () => {
    it("picks proportional to weight: 3/1 a/b → ~75% a", () => {
      const p = wchoose([[3, "a"], [1, "b"]]);
      let aCount = 0;
      for (let c = 0; c < 1000; c++) {
        if (p.getEvents(c)[0].name === "a") aCount++;
      }
      expect(aCount).toBeGreaterThanOrEqual(700);
      expect(aCount).toBeLessThanOrEqual(800);
    });

    it("zero total weight throws", () => {
      expect(() => wchoose([[0, "a"], [0, "b"]]).getEvents(0)).toThrow();
    });
  });
});
