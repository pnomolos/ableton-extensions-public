import { describe, it, expect } from "vitest";
import { transpile } from "../../src/transpile.ts";

// Pure transpile tests — no runtime/sandbox. Focused on regressions for
// TOFIX critical items #3 (string-aware comments) and #4 (# method <neg-literal>).

describe("transpile", () => {
  describe("string-aware comment stripping (#3)", () => {
    it("`--` inside string literal does NOT start a comment", () => {
      // Sample names like "bd--cp" are realistic; the old regex pass ate the
      // closing quote and raised an unterminated-string error.
      const js = transpile('d1 $ s "bd--cp"');
      expect(js).toContain('"bd--cp"');
    });

    it("`{- ... -}` inside string literal is preserved", () => {
      const js = transpile('d1 $ s "{- ignore -}"');
      expect(js).toContain('"{- ignore -}"');
    });

    it("line comment after a string still stripped", () => {
      const js = transpile('d1 $ s "bd" -- trailing comment\nd2 $ s "cp"');
      // d1 keeps its bd, d2 follows on the next line.
      expect(js).toContain('"bd"');
      expect(js).toContain('"cp"');
      expect(js).not.toContain("trailing comment");
    });

    it("block comment outside string still stripped", () => {
      const js = transpile('d1 $ s "bd" {- removed -} # gain 0.8');
      expect(js).not.toContain("removed");
      expect(js).toContain('"bd"');
      expect(js).toContain(".gain(0.8)");
    });
  });

  describe("# method <neg-literal> (#4)", () => {
    it("`# shift -3` parses as shift(-3), not (... # shift) - 3", () => {
      const js = transpile('d1 $ s "bd" # shift -3');
      expect(js).toContain(".shift(-3)");
      // The buggy parse called __sub(...) at the outer level.
      expect(js).not.toContain("__sub");
    });

    it("`# shift (-3)` (explicit paren form) still works", () => {
      const js = transpile('d1 $ s "bd" # shift (-3)');
      // Either shape (paren-wrapped or inline negative) is acceptable; just
      // assert the value made it through and __sub wasn't synthesised.
      expect(js).toMatch(/\.shift\((-3|\(-3\))\)/);
      expect(js).not.toContain("__sub");
    });

    it("multi-arg with trailing negative: `# foo 2 -1`", () => {
      const js = transpile('d1 $ s "bd" # foo 2 -1');
      expect(js).toContain(".foo(2, -1)");
    });

    it("plain positive literal still parses normally", () => {
      const js = transpile('d1 $ s "bd" # gain 0.8');
      expect(js).toContain(".gain(0.8)");
    });

    it("multi-line: `# shift` on one line, `-3` indented on next", () => {
      // Before the fix the peek-for-`-<number>` loop didn't skip
      // continuation newlines, so the `-3` leaked out as a stray top-level
      // statement and shift() was called with no args.
      const js = transpile('d1 $ s "bd"\n  # shift\n  -3');
      expect(js).toContain(".shift(-3)");
      // The stray top-level `-3` (or `__neg(3)`) must not appear.
      expect(js).not.toMatch(/;\s*-?3\b/);
      expect(js).not.toContain("__neg");
    });

    it("multi-line: blank line between `# shift` and `-3` still absorbs", () => {
      const js = transpile('d1 $ s "bd"\n  # shift\n\n  -3');
      expect(js).toContain(".shift(-3)");
    });
  });
});
