import { describe, it, expect } from "vitest";
import { n, chord } from "../../src/patterns.ts";
import { expectEventsMatch, sortEvents } from "./helpers.mjs";

describe("music theory", () => {
  describe("scale", () => {
    it("major scale: degrees 0..6 → 0,2,4,5,7,9,11", () => {
      const events = n("0 1 2 3 4 5 6").scale("major").getEvents(0);
      const names = events.map((e) => e.name);
      expect(names).toEqual(["0", "2", "4", "5", "7", "9", "11"]);
    });

    it("major scale wraps octave: degree 7 → 12, degree 8 → 14, degree -1 → -1", () => {
      expect(n("7").scale("major").getEvents(0)[0].name).toBe("12");
      expect(n("8").scale("major").getEvents(0)[0].name).toBe("14");
      expect(n("-1").scale("major").getEvents(0)[0].name).toBe("-1");
    });

    it("minor scale degrees 0..6 → 0,2,3,5,7,8,10", () => {
      const events = n("0 1 2 3 4 5 6").scale("minor").getEvents(0);
      const names = events.map((e) => e.name);
      expect(names).toEqual(["0", "2", "3", "5", "7", "8", "10"]);
    });

    it("dorian scale degrees 0..6 → 0,2,3,5,7,9,10", () => {
      const events = n("0 1 2 3 4 5 6").scale("dorian").getEvents(0);
      const names = events.map((e) => e.name);
      expect(names).toEqual(["0", "2", "3", "5", "7", "9", "10"]);
    });

    it("pentatonicMinor — 5 notes; degree 5 wraps to next octave root", () => {
      expect(n("5").scale("pentatonicMinor").getEvents(0)[0].name).toBe("12");
      expect(n("4").scale("pentatonicMinor").getEvents(0)[0].name).toBe("10");
    });

    it("rejects unknown scale names", () => {
      expect(() => n("0").scale("frobnitz").getEvents(0)).toThrow();
    });

    it("rejects non-integer tokens", () => {
      expect(() => n("a").scale("major").getEvents(0)).toThrow();
    });
  });

  describe("chord constructor", () => {
    it("chord('Cmaj') produces 0,4,7 concurrent", () => {
      const events = sortEvents(chord("Cmaj").getEvents(0));
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["0", "4", "7"]);
      for (const e of events) {
        expect(e.start).toBe(0);
        expect(e.duration).toBe(1);
      }
    });

    it("chord('C7') is dominant 7 — 0,4,7,10", () => {
      const events = chord("C7").getEvents(0);
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["0", "4", "7", "10"]);
    });

    it("chord('F#3min7') — -6,-3,1,4", () => {
      const events = chord("F#3min7").getEvents(0);
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["-6", "-3", "1", "4"]);
    });

    it("chord('Bb9') — 10,14,17,20,24", () => {
      const events = chord("Bb9").getEvents(0);
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["10", "14", "17", "20", "24"]);
    });

    it("chord('C') defaults to major", () => {
      const a = chord("C").getEvents(0);
      const b = chord("Cmaj").getEvents(0);
      const aN = a.map((e) => parseFloat(e.name)).sort((x, y) => x - y);
      const bN = b.map((e) => parseFloat(e.name)).sort((x, y) => x - y);
      expect(aN).toEqual(bN);
    });
  });

  describe("arp", () => {
    it("arp('up') arpeggiates low to high", () => {
      const events = chord("Cmaj").arp("up").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "0" },
        { start: 1/3, duration: 1/3, name: "4" },
        { start: 2/3, duration: 1/3, name: "7" },
      ]);
    });

    it("arp('down') arpeggiates high to low", () => {
      const events = chord("Cmaj").arp("down").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "7" },
        { start: 1/3, duration: 1/3, name: "4" },
        { start: 2/3, duration: 1/3, name: "0" },
      ]);
    });

    it("arp('updown') — [0,4,7,4]", () => {
      const events = chord("Cmaj").arp("updown").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "0" },
        { start: 1/4, duration: 1/4, name: "4" },
        { start: 2/4, duration: 1/4, name: "7" },
        { start: 3/4, duration: 1/4, name: "4" },
      ]);
    });

    it("arp('converge') — outer to inner: [0,7,4]", () => {
      const events = chord("Cmaj").arp("converge").getEvents(0);
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "0" },
        { start: 1/3, duration: 1/3, name: "7" },
        { start: 2/3, duration: 1/3, name: "4" },
      ]);
    });

    it("arp passes through sequential events unchanged", () => {
      const a = n("a b c").arp("up").getEvents(0);
      const b = n("a b c").getEvents(0);
      expect(a).toEqual(b);
    });
  });
});
