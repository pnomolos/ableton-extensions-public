import { describe, it, expect } from "vitest";
import {
  sine, sine2, saw, saw2, isaw, isaw2, tri, square, square2,
  rand, perlin, segment,
  slowSignal, fastSignal, revSignal, earlySignal, lateSignal,
} from "../../src/patterns.ts";

describe("continuous signals", () => {
  describe("sine / sine2", () => {
    it("sine unipolar [0,1] with peak at 0.25", () => {
      expect(sine(0, 0)).toBeCloseTo(0.5, 9);
      expect(sine(0, 0.25)).toBeCloseTo(1.0, 9);
      expect(sine(0, 0.5)).toBeCloseTo(0.5, 9);
      expect(sine(0, 0.75)).toBeCloseTo(0.0, 9);
    });

    it("sine2 bipolar [-1,1] with peak at 0.25", () => {
      expect(sine2(0, 0)).toBeCloseTo(0, 9);
      expect(sine2(0, 0.25)).toBeCloseTo(1, 9);
      expect(sine2(0, 0.5)).toBeCloseTo(0, 9);
      expect(sine2(0, 0.75)).toBeCloseTo(-1, 9);
    });
  });

  describe("saw / saw2", () => {
    it("saw unipolar 0..1 ramp", () => {
      expect(saw(0, 0)).toBeCloseTo(0, 9);
      expect(saw(0, 0.25)).toBeCloseTo(0.25, 9);
      expect(saw(0, 0.5)).toBeCloseTo(0.5, 9);
      expect(saw(0, 0.75)).toBeCloseTo(0.75, 9);
    });

    it("saw2 bipolar -1..1 ramp", () => {
      expect(saw2(0, 0)).toBeCloseTo(-1, 9);
      expect(saw2(0, 0.25)).toBeCloseTo(-0.5, 9);
      expect(saw2(0, 0.5)).toBeCloseTo(0, 9);
      expect(saw2(0, 0.75)).toBeCloseTo(0.5, 9);
    });
  });

  describe("isaw / isaw2", () => {
    it("isaw unipolar 1..0 ramp", () => {
      expect(isaw(0, 0)).toBeCloseTo(1, 9);
      expect(isaw(0, 0.25)).toBeCloseTo(0.75, 9);
      expect(isaw(0, 0.5)).toBeCloseTo(0.5, 9);
      expect(isaw(0, 0.75)).toBeCloseTo(0.25, 9);
    });

    it("isaw2 bipolar 1..-1 ramp", () => {
      expect(isaw2(0, 0)).toBeCloseTo(1, 9);
      expect(isaw2(0, 0.25)).toBeCloseTo(0.5, 9);
      expect(isaw2(0, 0.5)).toBeCloseTo(0, 9);
      expect(isaw2(0, 0.75)).toBeCloseTo(-0.5, 9);
    });
  });

  describe("tri", () => {
    it("triangle unipolar peak at 0.5", () => {
      expect(tri(0, 0)).toBeCloseTo(0, 9);
      expect(tri(0, 0.25)).toBeCloseTo(0.5, 9);
      expect(tri(0, 0.5)).toBeCloseTo(1, 9);
      expect(tri(0, 0.75)).toBeCloseTo(0.5, 9);
    });
  });

  describe("square / square2", () => {
    it("square 50% pulse", () => {
      expect(square(0, 0)).toBe(0);
      expect(square(0, 0.49)).toBe(0);
      expect(square(0, 0.5)).toBe(1);
      expect(square(0, 0.99)).toBe(1);
    });

    it("square2 bipolar pulse", () => {
      expect(square2(0, 0)).toBe(-1);
      expect(square2(0, 0.5)).toBe(1);
    });
  });

  describe("rand", () => {
    it("deterministic per (cycle, phase)", () => {
      for (let c = 0; c < 5; c++) {
        for (const ph of [0, 0.1, 0.5, 0.9]) {
          expect(rand(c, ph)).toBe(rand(c, ph));
        }
      }
    });

    it("adjacent phase queries return distinct values", () => {
      const a = rand(0, 0.0);
      const b = rand(0, 0.000002);
      expect(a).not.toBe(b);
    });
  });

  describe("perlin", () => {
    it("perlin(c, 1) interpolates to perlin(c+1, 0)", () => {
      for (let c = 0; c < 5; c++) {
        // perlin(c, 1) → fract(1)=0, smootherstep(0)=0 → returns `a` (lattice c).
        // perlin(c, 0) is the same lattice value. So they should match.
        // What we really want: perlin(c, 0.9999) approaching perlin(c+1, 0).
        const near1 = perlin(c, 0.99999);
        const next = perlin(c + 1, 0);
        // smootherstep is approximately 1 at t=0.99999.
        expect(near1).toBeCloseTo(next, 3);
      }
    });
  });

  describe("signal time transforms", () => {
    it("slowSignal(2, tri) — peak at cycle 1 phase 0 (half-rate)", () => {
      // tri unipolar peaks at phase 0.5. Slowed by 2, one period spans 2 cycles:
      // virtual phase = (c + ph) / 2. Peak (vp = 0.5) lands at c=1, ph=0.
      expect(slowSignal(2, tri)(0, 0)).toBeCloseTo(0, 9);
      expect(slowSignal(2, tri)(0, 0.5)).toBeCloseTo(0.5, 9);
      expect(slowSignal(2, tri)(1, 0)).toBeCloseTo(1, 9);
      expect(slowSignal(2, tri)(1, 0.5)).toBeCloseTo(0.5, 9);
    });

    it("fastSignal(2, tri) — two full triangles per cycle", () => {
      expect(fastSignal(2, tri)(0, 0)).toBeCloseTo(0, 9);
      expect(fastSignal(2, tri)(0, 0.25)).toBeCloseTo(1, 9);
      expect(fastSignal(2, tri)(0, 0.5)).toBeCloseTo(0, 9);
      expect(fastSignal(2, tri)(0, 0.75)).toBeCloseTo(1, 9);
    });

    it("revSignal(saw) — reversed within each cycle", () => {
      // saw: 0..1 ramp. rev → (c, ph) => saw(c, 1 - ph) → ramps 1..0 (matches isaw at non-zero ph).
      expect(revSignal(saw)(0, 0)).toBeCloseTo(0, 9); // saw(0,1)=fract(1)=0
      expect(revSignal(saw)(0, 0.25)).toBeCloseTo(0.75, 9);
      expect(revSignal(saw)(0, 0.5)).toBeCloseTo(0.5, 9);
      expect(revSignal(saw)(0, 0.75)).toBeCloseTo(0.25, 9);
    });

    it("earlySignal(0.25, tri) — shifts signal a quarter cycle earlier", () => {
      // tri peaks at phase 0.5. early 0.25 → peak now at phase 0.25.
      expect(earlySignal(0.25, tri)(0, 0.25)).toBeCloseTo(1, 9);
      expect(earlySignal(0.25, tri)(0, 0.75)).toBeCloseTo(0, 9);
    });

    it("lateSignal(0.25, tri) — shifts signal a quarter cycle later", () => {
      // tri peaks at phase 0.5. late 0.25 → peak now at phase 0.75.
      expect(lateSignal(0.25, tri)(0, 0.75)).toBeCloseTo(1, 9);
      expect(lateSignal(0.25, tri)(0, 0.25)).toBeCloseTo(0, 9);
    });

    it("slowSignal rejects non-positive n", () => {
      expect(() => slowSignal(0, tri)(0, 0)).toThrow(/positive number/);
      expect(() => slowSignal(-1, tri)(0, 0)).toThrow(/positive number/);
    });
  });

  describe("segment", () => {
    it("segment(4, sine) — 4 equal events with sampled sine values", () => {
      const events = segment(4, sine).getEvents(0);
      expect(events.length).toBe(4);
      // Names will be JS-stringified floats; parse back and compare numerically.
      const vs = events.map((e) => parseFloat(e.name));
      expect(vs[0]).toBeCloseTo(0.5, 9);
      expect(vs[1]).toBeCloseTo(1.0, 9);
      expect(vs[2]).toBeCloseTo(0.5, 9);
      expect(vs[3]).toBeCloseTo(0.0, 9);
      for (let i = 0; i < 4; i++) {
        expect(events[i].start).toBeCloseTo(i / 4, 9);
        expect(events[i].duration).toBeCloseTo(1 / 4, 9);
      }
    });
  });
});
