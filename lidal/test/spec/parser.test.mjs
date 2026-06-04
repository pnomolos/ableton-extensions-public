import { describe, it, expect } from "vitest";
import { bjorklund, evaluatePattern } from "../../src/parser.ts";
import { expectEventsMatch, sortEvents } from "./helpers.mjs";

describe("mini-notation parser", () => {
  describe("atoms / rests", () => {
    it("a single atom fills the cycle", () => {
      expectEventsMatch(evaluatePattern("a"), [{ start: 0, duration: 1, name: "a" }]);
    });

    it("a lone rest produces no events", () => {
      expect(evaluatePattern("~")).toEqual([]);
    });
  });

  describe("sequences", () => {
    it("two-item sequence splits the cycle in half", () => {
      expectEventsMatch(evaluatePattern("a b"), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("three-item sequence splits the cycle in thirds", () => {
      expectEventsMatch(evaluatePattern("a b c"), [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "c" },
      ]);
    });
  });

  describe("subdivision", () => {
    it("nested brackets share parent slot", () => {
      expectEventsMatch(evaluatePattern("a [b c]"), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/4, name: "b" },
        { start: 3/4, duration: 1/4, name: "c" },
      ]);
    });

    it("depth halves duration each level", () => {
      expectEventsMatch(evaluatePattern("a [b [c d]]"), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/4, name: "b" },
        { start: 3/4, duration: 1/8, name: "c" },
        { start: 7/8, duration: 1/8, name: "d" },
      ]);
    });

    it("a subdivision containing a rest leaves silence", () => {
      expectEventsMatch(evaluatePattern("[a ~]"), [
        { start: 0, duration: 1/2, name: "a" },
      ]);
    });
  });

  describe("parallel-in-slot", () => {
    it("[a, b] fires both at once within the slot", () => {
      const events = sortEvents(evaluatePattern("[a, b] c"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 0,   duration: 1/2, name: "b" },
        { start: 1/2, duration: 1/2, name: "c" },
      ]);
    });

    it("three-voice parallel shares the slot", () => {
      const events = sortEvents(evaluatePattern("[a, b, c] d"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 0,   duration: 1/2, name: "b" },
        { start: 0,   duration: 1/2, name: "c" },
        { start: 1/2, duration: 1/2, name: "d" },
      ]);
    });
  });

  describe("alternation <a b c>", () => {
    it("picks one child per cycle mod len", () => {
      expectEventsMatch(evaluatePattern("<a b c>", 0), [{ start: 0, duration: 1, name: "a" }]);
      expectEventsMatch(evaluatePattern("<a b c>", 1), [{ start: 0, duration: 1, name: "b" }]);
      expectEventsMatch(evaluatePattern("<a b c>", 2), [{ start: 0, duration: 1, name: "c" }]);
      expectEventsMatch(evaluatePattern("<a b c>", 3), [{ start: 0, duration: 1, name: "a" }]);
      expectEventsMatch(evaluatePattern("<a b c>", 4), [{ start: 0, duration: 1, name: "b" }]);
    });

    it("only the alternated slot rotates", () => {
      expectEventsMatch(evaluatePattern("x <a b>", 0), [
        { start: 0,   duration: 1/2, name: "x" },
        { start: 1/2, duration: 1/2, name: "a" },
      ]);
      expectEventsMatch(evaluatePattern("x <a b>", 1), [
        { start: 0,   duration: 1/2, name: "x" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("alternation containing rest produces no event on rest cycle", () => {
      expectEventsMatch(evaluatePattern("<a ~ b>", 0), [{ start: 0, duration: 1, name: "a" }]);
      expect(evaluatePattern("<a ~ b>", 1)).toEqual([]);
      expectEventsMatch(evaluatePattern("<a ~ b>", 2), [{ start: 0, duration: 1, name: "b" }]);
    });
  });

  describe("polyrhythm {a b, c d e}", () => {
    it("each lane fills the cycle independently", () => {
      const events = sortEvents(evaluatePattern("{a b, c d e}"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 0,   duration: 1/3, name: "c" },
        { start: 1/3, duration: 1/3, name: "d" },
        { start: 1/2, duration: 1/2, name: "b" },
        { start: 2/3, duration: 1/3, name: "e" },
      ]);
    });
  });

  describe("polymeter %N", () => {
    it("forces both lanes to N slots — %4", () => {
      const events = sortEvents(evaluatePattern("{a b, c d e}%4"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 0,   duration: 1/4, name: "c" },
        { start: 1/4, duration: 1/4, name: "b" },
        { start: 1/4, duration: 1/4, name: "d" },
        { start: 1/2, duration: 1/4, name: "a" },
        { start: 1/2, duration: 1/4, name: "e" },
        { start: 3/4, duration: 1/4, name: "b" },
        { start: 3/4, duration: 1/4, name: "c" },
      ]);
    });

    it("uneven lanes with %3", () => {
      const events = sortEvents(evaluatePattern("{a b, c d e}%3"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 0,   duration: 1/3, name: "c" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 1/3, duration: 1/3, name: "d" },
        { start: 2/3, duration: 1/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "e" },
      ]);
    });
  });

  describe("repeat a*N", () => {
    it("places N copies inside the slot", () => {
      expectEventsMatch(evaluatePattern("a*3 b"), [
        { start: 0,   duration: 1/6, name: "a" },
        { start: 1/6, duration: 1/6, name: "a" },
        { start: 2/6, duration: 1/6, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("a*N is equivalent to [a a ... a]", () => {
      expect(evaluatePattern("a*3 b")).toEqual(evaluatePattern("[a a a] b"));
    });
  });

  describe("elongate _", () => {
    it("a _ b weights 2:1", () => {
      expectEventsMatch(evaluatePattern("a _ b"), [
        { start: 0,   duration: 2/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "b" },
      ]);
    });

    it("two underscores stack additively", () => {
      expectEventsMatch(evaluatePattern("a _ _ b"), [
        { start: 0,   duration: 3/4, name: "a" },
        { start: 3/4, duration: 1/4, name: "b" },
      ]);
    });
  });

  describe("weighted slot @N", () => {
    it("a@2 b divides 2:1", () => {
      expectEventsMatch(evaluatePattern("a@2 b"), [
        { start: 0,   duration: 2/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "b" },
      ]);
    });

    it("a@2 b@3 splits 2/5 : 3/5", () => {
      expectEventsMatch(evaluatePattern("a@2 b@3"), [
        { start: 0,   duration: 2/5, name: "a" },
        { start: 2/5, duration: 3/5, name: "b" },
      ]);
    });
  });

  describe("replicate !", () => {
    it("a ! b becomes a a b", () => {
      expectEventsMatch(evaluatePattern("a ! b"), [
        { start: 0,   duration: 1/3, name: "a" },
        { start: 1/3, duration: 1/3, name: "a" },
        { start: 2/3, duration: 1/3, name: "b" },
      ]);
    });

    it("a !*3 b becomes a a a a b", () => {
      expectEventsMatch(evaluatePattern("a !*3 b"), [
        { start: 0,   duration: 1/5, name: "a" },
        { start: 1/5, duration: 1/5, name: "a" },
        { start: 2/5, duration: 1/5, name: "a" },
        { start: 3/5, duration: 1/5, name: "a" },
        { start: 4/5, duration: 1/5, name: "b" },
      ]);
    });

    it("replication of a group via [a b] ! c", () => {
      expectEventsMatch(evaluatePattern("[a b] ! c"), [
        { start: 0,   duration: 1/6, name: "a" },
        { start: 1/6, duration: 1/6, name: "b" },
        { start: 1/3, duration: 1/6, name: "a" },
        { start: 3/6, duration: 1/6, name: "b" },
        { start: 2/3, duration: 1/3, name: "c" },
      ]);
    });
  });

  describe("Euclidean rhythms (n,k[,r])", () => {
    it("bd(3,8) emits hits at 0, 3, 6", () => {
      expectEventsMatch(evaluatePattern("bd(3,8)"), [
        { start: 0,   duration: 1/8, name: "bd" },
        { start: 3/8, duration: 1/8, name: "bd" },
        { start: 6/8, duration: 1/8, name: "bd" },
      ]);
    });

    it("bd(5,8) emits hits at 0, 2, 3, 5, 6 — Cuban cinquillo", () => {
      expectEventsMatch(evaluatePattern("bd(5,8)"), [
        { start: 0,   duration: 1/8, name: "bd" },
        { start: 2/8, duration: 1/8, name: "bd" },
        { start: 3/8, duration: 1/8, name: "bd" },
        { start: 5/8, duration: 1/8, name: "bd" },
        { start: 6/8, duration: 1/8, name: "bd" },
      ]);
    });

    // Rotation matches Tidal's `_euclidOff n k s = rotL (s/k) (euclid n k)` —
    // shifts the time axis LEFT by 2/8 cycle. bd(3,8) = hits at {0, 3/8, 6/8};
    // subtracting 2/8 mod 1 = {6/8, 1/8, 4/8} → sorted indices {1, 4, 6}.
    it("bd(3,8,2) — left-rotated by 2 yields hits at 1, 4, 6", () => {
      expectEventsMatch(evaluatePattern("bd(3,8,2)"), [
        { start: 1/8, duration: 1/8, name: "bd" },
        { start: 4/8, duration: 1/8, name: "bd" },
        { start: 6/8, duration: 1/8, name: "bd" },
      ]);
    });

    it("(n,n) is all hits", () => {
      const events = evaluatePattern("x(8,8)");
      expect(events.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(events[i].start).toBeCloseTo(i / 8, 9);
        expect(events[i].duration).toBeCloseTo(1 / 8, 9);
        expect(events[i].name).toBe("x");
      }
    });

    it("(0,n) produces no events", () => {
      expect(evaluatePattern("x(0,4)")).toEqual([]);
    });

    // Toussaint spot-check table — canonical Bjorklund indices (matches
    // Tidal/Strudel). Each row asserts the slot indices that fire for x(h,n).
    const TOUSSAINT = [
      ["x(1,2)",  2,  [0]],
      ["x(1,4)",  4,  [0]],
      ["x(2,5)",  5,  [0, 2]],
      ["x(3,4)",  4,  [0, 1, 2]],
      ["x(3,5)",  5,  [0, 2, 4]],          // canonical (spec doc previously [0,2,3])
      ["x(3,7)",  7,  [0, 2, 4]],
      ["x(4,7)",  7,  [0, 2, 4, 6]],
      ["x(4,9)",  9,  [0, 2, 4, 6]],
      ["x(4,11)", 11, [0, 3, 6, 9]],       // canonical (spec doc previously [0,3,6,8])
      ["x(4,12)", 12, [0, 3, 6, 9]],
      ["x(5,7)",  7,  [0, 2, 3, 5, 6]],
      ["x(5,9)",  9,  [0, 2, 4, 6, 8]],    // canonical (spec doc previously [0,2,4,5,7])
      ["x(5,11)", 11, [0, 2, 4, 6, 8]],    // canonical (spec doc previously [0,3,4,6,8])
      ["x(5,16)", 16, [0, 3, 6, 9, 12]],   // canonical (spec doc previously [0,4,7,10,13])
      ["x(7,8)",  8,  [0, 1, 2, 3, 4, 5, 6]],
    ];
    for (const [input, n, idxs] of TOUSSAINT) {
      it(`Toussaint check ${input} → ${idxs.join(",")}`, () => {
        const events = evaluatePattern(input);
        expect(events.length).toBe(idxs.length);
        events.forEach((ev, i) => {
          expect(ev.start).toBeCloseTo(idxs[i] / n, 9);
          expect(ev.duration).toBeCloseTo(1 / n, 9);
        });
      });
    }
  });

  // Direct unit tests for the bjorklund() algorithm (no parser plumbing).
  // Spot-checks against the canonical Toussaint table from his 2005 paper.
  describe("Bjorklund algorithm (direct)", () => {
    function hitsOf(arr) { return arr.map((b, i) => b ? i : -1).filter((i) => i >= 0); }
    const VECTORS = [
      [3, 8,  [0, 3, 6]],              // Cuban tresillo
      [5, 8,  [0, 2, 3, 5, 6]],        // Cuban cinquillo
      [3, 7,  [0, 2, 4]],              // Ruchenitza
      [5, 12, [0, 3, 5, 8, 10]],       // Venda
      [7, 8,  [0, 1, 2, 3, 4, 5, 6]],
      [7, 12, [0, 2, 3, 5, 7, 8, 10]], // Bell pattern
      [4, 9,  [0, 2, 4, 6]],
      [5, 16, [0, 3, 6, 9, 12]],
      [9, 16, [0, 2, 3, 5, 7, 9, 10, 12, 14]],
      [2, 5,  [0, 2]],
      [3, 5,  [0, 2, 4]],
      [4, 12, [0, 3, 6, 9]],
    ];
    for (const [h, n, expected] of VECTORS) {
      it(`bjorklund(${h}, ${n}) → [${expected.join(",")}]`, () => {
        const arr = bjorklund(h, n);
        expect(arr.length).toBe(n);
        expect(hitsOf(arr)).toEqual(expected);
      });
    }

    it("bjorklund(0, n) is all false", () => {
      expect(bjorklund(0, 4)).toEqual([false, false, false, false]);
      expect(bjorklund(0, 1)).toEqual([false]);
    });

    it("bjorklund(n, n) is all true", () => {
      expect(bjorklund(4, 4)).toEqual([true, true, true, true]);
    });

    it("bjorklund(h, n) with h >= n saturates to all true", () => {
      expect(bjorklund(8, 5)).toEqual([true, true, true, true, true]);
    });

    it("bjorklund(h, 0) is empty", () => {
      expect(bjorklund(3, 0)).toEqual([]);
    });

    it("first slot is always a hit when hits > 0", () => {
      for (let h = 1; h <= 16; h++) {
        for (let n = h; n <= 16; n++) {
          expect(bjorklund(h, n)[0], `bjorklund(${h}, ${n})[0] expected true`).toBe(true);
        }
      }
    });

    it("hit count equals `hits` for h <= n", () => {
      for (let h = 0; h <= 16; h++) {
        for (let n = Math.max(1, h); n <= 16; n++) {
          const arr = bjorklund(h, n);
          expect(arr.filter(Boolean).length).toBe(h);
        }
      }
    });
  });

  describe("numeric range ..", () => {
    it("0 .. 7 expands inclusively", () => {
      const events = evaluatePattern("0 .. 7");
      expect(events.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(events[i].start).toBeCloseTo(i / 8, 9);
        expect(events[i].duration).toBeCloseTo(1 / 8, 9);
        expect(events[i].name).toBe(String(i));
      }
    });

    it("5 .. 2 descends", () => {
      const events = evaluatePattern("5 .. 2");
      const names = events.map((e) => e.name);
      expect(names).toEqual(["5", "4", "3", "2"]);
      events.forEach((ev, i) => expect(ev.duration).toBeCloseTo(1 / 4, 9));
    });
  });

  describe("degrade ?", () => {
    it("a? is deterministic per cycle", () => {
      for (let k = 0; k < 20; k++) {
        expect(evaluatePattern("a?", k)).toEqual(evaluatePattern("a?", k));
      }
    });

    it("a? drops a in roughly half of 1000 cycles", () => {
      let kept = 0;
      for (let c = 0; c < 1000; c++) {
        if (evaluatePattern("a?", c).length === 1) kept++;
      }
      expect(kept).toBeGreaterThanOrEqual(460);
      expect(kept).toBeLessThanOrEqual(540);
    });

    it("a?0.8 drops in most cycles", () => {
      let kept = 0;
      for (let c = 0; c < 1000; c++) {
        if (evaluatePattern("a?0.8", c).length === 1) kept++;
      }
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(300);
    });

    it("a? b? — degrade independence across siblings", () => {
      const cells = { tt: 0, tf: 0, ft: 0, ff: 0 };
      for (let c = 0; c < 2000; c++) {
        const evs = evaluatePattern("a? b?", c);
        const aPresent = evs.some((e) => e.name === "a");
        const bPresent = evs.some((e) => e.name === "b");
        const k = (aPresent ? "t" : "f") + (bPresent ? "t" : "f");
        cells[k]++;
      }
      for (const v of Object.values(cells)) {
        // 25% of 2000 = 500; allow generous bounds (~10 sigma) for stability.
        expect(v).toBeGreaterThan(400);
        expect(v).toBeLessThan(600);
      }
    });
  });

  describe("random pick |", () => {
    it("[a b | c d] picks one whole branch per cycle, deterministically", () => {
      for (let c = 0; c < 100; c++) {
        const evs = evaluatePattern("a b | c d", c);
        const names = evs.map((e) => e.name).join(",");
        expect(["a,b", "c,d"]).toContain(names);
        // Determinism
        const evs2 = evaluatePattern("a b | c d", c);
        expect(evs2).toEqual(evs);
      }
    });

    it("a b | c d picks a-b roughly half of 1000 cycles", () => {
      let ab = 0;
      for (let c = 0; c < 1000; c++) {
        const evs = evaluatePattern("a b | c d", c);
        if (evs[0].name === "a") ab++;
      }
      expect(ab).toBeGreaterThanOrEqual(440);
      expect(ab).toBeLessThanOrEqual(560);
    });

    it("a | b | c distributes roughly evenly across three branches", () => {
      const counts = { a: 0, b: 0, c: 0 };
      for (let c = 0; c < 900; c++) {
        const evs = evaluatePattern("a | b | c", c);
        counts[evs[0].name]++;
      }
      for (const k of ["a", "b", "c"]) {
        expect(counts[k]).toBeGreaterThan(230);
        expect(counts[k]).toBeLessThan(370);
      }
    });

    it("two independent | groups have independent seeds", () => {
      const cells = { aa: 0, ab: 0, ba: 0, bb: 0 };
      for (let c = 0; c < 2000; c++) {
        const evs = evaluatePattern("[a|b] [a|b]", c);
        // Each half is a sub-sequence picked once.
        const left = evs[0].name;
        const right = evs[1].name;
        cells[left + right]++;
      }
      for (const v of Object.values(cells)) {
        expect(v).toBeGreaterThan(380);
        expect(v).toBeLessThan(620);
      }
    });
  });

  describe("chord shorthand '", () => {
    it("c'maj emits three concurrent voices at C4 → 0,4,7", () => {
      const events = sortEvents(evaluatePattern("c'maj"));
      expectEventsMatch(events, [
        { start: 0, duration: 1, name: "0" },
        { start: 0, duration: 1, name: "4" },
        { start: 0, duration: 1, name: "7" },
      ]);
    });

    it("c5'maj — rooted at C5 → 12,16,19", () => {
      const events = sortEvents(evaluatePattern("c5'maj"));
      // sort by parsed number so 12 < 16 < 19
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["12", "16", "19"]);
    });

    it("f#3'min7 — root MIDI 54 with min7 intervals → -6,-3,1,4", () => {
      const events = evaluatePattern("f#3'min7");
      const names = events.map((e) => e.name).map(Number).sort((a, b) => a - b).map(String);
      expect(names).toEqual(["-6", "-3", "1", "4"]);
    });

    it("chord shares a slot in a sequence", () => {
      const events = sortEvents(evaluatePattern("a c'maj"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "0" },
        { start: 1/2, duration: 1/2, name: "4" },
        { start: 1/2, duration: 1/2, name: "7" },
      ]);
    });

    it("chord at start of sequence — c'maj b c", () => {
      const events = sortEvents(evaluatePattern("c'maj b c"));
      expectEventsMatch(events, [
        { start: 0,   duration: 1/3, name: "0" },
        { start: 0,   duration: 1/3, name: "4" },
        { start: 0,   duration: 1/3, name: "7" },
        { start: 1/3, duration: 1/3, name: "b" },
        { start: 2/3, duration: 1/3, name: "c" },
      ]);
    });

    it("c'maj? — degrade applies to the chord AST node; each kept cycle yields 3 voices", () => {
      // Deterministic per-cycle: a kept cycle yields all 3 chord notes; a dropped
      // cycle yields none. Survey 200 cycles — each cycle's event count is in {0, 3}.
      let kept = 0;
      let dropped = 0;
      for (let c = 0; c < 200; c++) {
        const evs = evaluatePattern("c'maj?", c);
        expect([0, 3]).toContain(evs.length);
        if (evs.length === 3) {
          kept++;
          const names = sortEvents(evs).map((e) => e.name);
          expect(names).toEqual(["0", "4", "7"]);
        } else {
          dropped++;
        }
      }
      // Roughly 50/50 (10-sigma bounds for 200 trials).
      expect(kept).toBeGreaterThan(60);
      expect(dropped).toBeGreaterThan(60);
    });
  });

  describe("trailing suffix on group", () => {
    it("[a b]*2 plays the group twice per cycle", () => {
      expectEventsMatch(evaluatePattern("[a b]*2"), [
        { start: 0,   duration: 1/4, name: "a" },
        { start: 1/4, duration: 1/4, name: "b" },
        { start: 1/2, duration: 1/4, name: "a" },
        { start: 3/4, duration: 1/4, name: "b" },
      ]);
    });

    it("<a b>*2 — len-2 alternation with *2 stays (a,b) per cycle", () => {
      expectEventsMatch(evaluatePattern("<a b>*2", 0), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
      expectEventsMatch(evaluatePattern("<a b>*2", 1), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
    });

    it("<a b c>*2 — three-step alternation advances per occurrence", () => {
      expectEventsMatch(evaluatePattern("<a b c>*2", 0), [
        { start: 0,   duration: 1/2, name: "a" },
        { start: 1/2, duration: 1/2, name: "b" },
      ]);
      expectEventsMatch(evaluatePattern("<a b c>*2", 1), [
        { start: 0,   duration: 1/2, name: "c" },
        { start: 1/2, duration: 1/2, name: "a" },
      ]);
      expectEventsMatch(evaluatePattern("<a b c>*2", 2), [
        { start: 0,   duration: 1/2, name: "b" },
        { start: 1/2, duration: 1/2, name: "c" },
      ]);
    });
  });

  describe("Euclidean inside parallel-in-slot", () => {
    it("[bd(3,8), hh*4] interleaves both lanes", () => {
      const events = sortEvents(evaluatePattern("[bd(3,8), hh*4]"));
      // Two lanes share the cycle.
      const expected = [
        { start: 0,   duration: 1/8, name: "bd" },
        { start: 0,   duration: 1/4, name: "hh" },
        { start: 1/4, duration: 1/4, name: "hh" },
        { start: 3/8, duration: 1/8, name: "bd" },
        { start: 1/2, duration: 1/4, name: "hh" },
        { start: 3/4, duration: 1/8, name: "bd" },
        { start: 3/4, duration: 1/4, name: "hh" },
      ];
      expectEventsMatch(events, expected);
    });
  });

  describe("parser cache idempotency", () => {
    it("repeated evaluatePattern calls return equal arrays", () => {
      const a = evaluatePattern("a [b c] d", 3);
      const b = evaluatePattern("a [b c] d", 3);
      expect(a).toEqual(b);
    });
  });

  // TOFIX critical/high regression suite — bugs found in the Opus review.
  describe("error handling and edge cases (TOFIX regressions)", () => {
    // #7 — Range expansion is unbounded.
    it("range `0 .. 1000` throws (cap at 64)", () => {
      expect(() => evaluatePattern("0 .. 1000")).toThrow(/range too large/);
    });

    it("range at exactly the cap (0..63 = 64 elements) succeeds", () => {
      const events = evaluatePattern("0 .. 63");
      expect(events.length).toBe(64);
    });

    // #8 — `bd!*2` produces atom literally named `"bd!"`.
    it("`bd!*2` replicates bd (does NOT create a note named 'bd!')", () => {
      // `!*2` = replicate the previous element 2 more times. So `bd !*2` ≡ `bd bd bd`.
      // Without the suffix-op tokenizer split, the old code produced a single note
      // literally named `bd!` with repeat=2.
      const events = evaluatePattern("bd!*2");
      // 3 copies of bd, none named "bd!".
      expect(events.length).toBe(3);
      for (const e of events) expect(e.name).toBe("bd");
    });

    it("`bd*2` (no whitespace) repeats bd twice", () => {
      const events = evaluatePattern("bd*2");
      expect(events.length).toBe(2);
      for (const e of events) expect(e.name).toBe("bd");
    });

    it("`bd?` (no whitespace) deg-rolls; never produces a note named 'bd?'", () => {
      for (let c = 0; c < 50; c++) {
        const events = evaluatePattern("bd?", c);
        for (const e of events) expect(e.name).toBe("bd");
      }
    });

    it("`c'maj!*2` replicates the chord twice (does NOT produce a note named 'c'maj!')", () => {
      const events = sortEvents(evaluatePattern("c'maj!*2"));
      // 3 chord copies × 3 voices each = 9 events.
      expect(events.length).toBe(9);
      // All event names should be numeric (semitone offsets), not chord shorthand.
      for (const e of events) expect(e.name).toMatch(/^-?\d+$/);
    });

    // #17 — `<a, b>` (alternation w/ comma) silently produces a phantom slot.
    it("`<a, b>` (comma inside alternation) hard-errors", () => {
      expect(() => evaluatePattern("<a, b>")).toThrow(/separates parallel lanes|alternation/);
    });

    // #31 — `bd*0` emits one note (clamped to 1) instead of silence.
    it("`bd*0` produces silence (zero events from that slot)", () => {
      expect(evaluatePattern("bd*0")).toEqual([]);
    });

    it("`bd*0 sd` produces only sd", () => {
      const events = evaluatePattern("bd*0 sd");
      expect(events.length).toBe(1);
      expect(events[0].name).toBe("sd");
    });

    // Group/alternate/polyrhythm `*0` consistency with note `*0`.
    // Old flattener Math.max(1, node.repeat) silently promoted 0 → 1 copy.
    it("`[bd sd]*0` produces silence (zero events from the group)", () => {
      expect(evaluatePattern("[bd sd]*0")).toEqual([]);
    });

    it("`[bd sd]*0 cp` produces only cp", () => {
      const events = evaluatePattern("[bd sd]*0 cp");
      expect(events.length).toBe(1);
      expect(events[0].name).toBe("cp");
    });

    it("`<a b>*0` (alternation) produces silence", () => {
      expect(evaluatePattern("<a b>*0")).toEqual([]);
    });

    it("`{a b, c d}*0` (polyrhythm) produces silence", () => {
      expect(evaluatePattern("{a b, c d}*0")).toEqual([]);
    });

    // #32 — Unmatched closing delim becomes a literal note.
    it("unmatched `]` hard-errors", () => {
      expect(() => evaluatePattern("a b ]")).toThrow(/unmatched/);
    });

    it("unmatched `}` hard-errors", () => {
      expect(() => evaluatePattern("a b }")).toThrow(/unmatched/);
    });

    it("unmatched `>` hard-errors", () => {
      expect(() => evaluatePattern("a b >")).toThrow(/unmatched/);
    });

    // Smaller item — parseSuffix should not silently sanitize leading minus.
    it("`a@-2` hard-errors (negative weight is meaningless)", () => {
      expect(() => evaluatePattern("a@-2")).toThrow(/cannot be negative/);
    });

    it("`a?-0.5` hard-errors (negative probability is meaningless)", () => {
      expect(() => evaluatePattern("a?-0.5")).toThrow(/cannot be negative/);
    });
  });
});
