import { describe, it, expect } from "vitest";
import { n, cat } from "../../src/patterns.ts";

describe("composition (cross-cutting laws)", () => {
  it("slow(2) then fast(2) round-trips", () => {
    const p = n("a b c d");
    for (let c = 0; c < 4; c++) {
      expect(p.slow(2).fast(2).getEvents(c)).toEqual(p.getEvents(c));
    }
  });

  it("rev is self-inverse", () => {
    const p = n("a b c d");
    for (let c = 0; c < 4; c++) {
      expect(p.rev().rev().getEvents(c)).toEqual(p.getEvents(c));
    }
  });

  it("every(2, id) is a no-op", () => {
    const p = n("a b c");
    for (let c = 0; c < 6; c++) {
      expect(p.every(2, (q) => q).getEvents(c)).toEqual(p.getEvents(c));
    }
  });

  it("iter(N) returns to original at cycle N", () => {
    for (const N of [2, 3, 5, 8]) {
      const p = n("0 1 2 3").iter(N);
      expect(p.getEvents(0)).toEqual(p.getEvents(N));
    }
  });

  it("palindrome equivalent to cat([p, rev p])", () => {
    const p = n("a b c d");
    for (let c = 0; c < 4; c++) {
      expect(p.palindrome().getEvents(c)).toEqual(cat([p, p.rev()]).getEvents(c));
    }
  });
});
