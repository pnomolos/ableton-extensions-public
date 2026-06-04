import { describe, it, expect } from "vitest";
import { n, stack } from "../../src/patterns.ts";

describe("routing", () => {
  describe("ch", () => {
    it("ch(5) sets channel to 4 (0-indexed)", () => {
      expect(n("a").ch(5).channel).toBe(4);
    });

    it("ch(20) clamps to 15", () => {
      expect(n("a").ch(20).channel).toBe(15);
    });

    it("ch(0) is rejected (1-indexed surface)", () => {
      expect(() => n("a").ch(0)).toThrow(/1-indexed/);
    });

    it("ch(-3) clamps to 0", () => {
      expect(n("a").ch(-3).channel).toBe(0);
    });
  });

  describe("jux", () => {
    it("jux(rev) emits original + transformed-with-channelOffset", () => {
      const events = n("a").jux((p) => p.rev()).getEvents(0);
      expect(events.length).toBe(2);
      // Both share start=0 (single full-cycle event reversed = same).
      const hasOffset = events.some((e) => e.channelOffset === 1);
      const hasPlain = events.some((e) => e.channelOffset === undefined && e.channel === undefined);
      expect(hasOffset).toBe(true);
      expect(hasPlain).toBe(true);
    });
  });

  describe("juxBy", () => {
    it("juxBy(3, fn) tags transformed events with channelOffset 3", () => {
      const events = n("a").juxBy(3, (p) => p).getEvents(0);
      const tagged = events.find((e) => e.channelOffset === 3);
      expect(tagged).toBeDefined();
    });
  });

  describe("juxTo", () => {
    it("juxTo(5, fn) tags transformed events with absolute channel 4", () => {
      const events = n("a").juxTo(5, (p) => p).getEvents(0);
      const tagged = events.find((e) => e.channel === 4);
      expect(tagged).toBeDefined();
    });
  });

  describe("jux respects explicit-channel transform", () => {
    it("if transformed pattern has its own .ch(), that wins over channelOffset", () => {
      const events = n("a").jux((p) => p.ch(7)).getEvents(0);
      // One side should have explicit channel 6 (7-1=0-indexed); none should have channelOffset 1.
      const hasOffset = events.some((e) => e.channelOffset === 1);
      const hasExplicit = events.some((e) => e.channel === 6);
      expect(hasOffset).toBe(false);
      expect(hasExplicit).toBe(true);
    });
  });

  describe("stack channel inheritance", () => {
    it("plain stack — no event has channel or channelOffset", () => {
      const events = stack([n("a"), n("b")]).getEvents(0);
      for (const e of events) {
        expect(e.channel).toBeUndefined();
        expect(e.channelOffset).toBeUndefined();
      }
    });

    it("per-part .ch() tags only that part", () => {
      const events = stack([n("a"), n("b").ch(5)]).getEvents(0);
      const a = events.find((e) => e.name === "a");
      const b = events.find((e) => e.name === "b");
      expect(a.channel).toBeUndefined();
      expect(a.channelOffset).toBeUndefined();
      expect(b.channel).toBe(4);
    });
  });
});
