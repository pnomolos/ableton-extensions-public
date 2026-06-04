// Pure-function tests for the diagnostic-error-locator (`locateErrorInRange`).
// We deliberately avoid pulling in CodeMirror — locateErrorInRange only needs
// a minimal `doc` shape (line/lines/length and now sliceString), so we stub
// it from a plain string. This locks down TOFIX #25: leading-whitespace
// inside the eval range previously caused the squiggle to drift right by
// `leadingWS` characters.

import { describe, it, expect } from "vitest";
import { locateErrorInRange } from "../../src/editor/diagnostics.ts";

function stubDoc(text) {
  // CM6's Text has line numbers 1-based. We expose only what locateErrorInRange
  // needs: line(n) → {from, to}, lines, length, sliceString.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  return {
    length: text.length,
    lines: lineStarts.length,
    line(n) {
      const from = lineStarts[n - 1];
      let to = lineStarts[n] != null ? lineStarts[n] - 1 : text.length;
      return { from, to };
    },
    sliceString(from, to) {
      return text.slice(from, to ?? text.length);
    },
  };
}

describe("locateErrorInRange / offset path", () => {
  it("places the squiggle at the right position when no leading whitespace", () => {
    const text = "d1 $ s 'bad'";
    const doc = stubDoc(text);
    const loc = locateErrorInRange(
      "syntax error at offset 4",
      undefined,
      doc,
      { from: 0, to: text.length },
    );
    // Offset 4 → "$" at column 4
    expect(loc).toEqual({ from: 4, to: 5 });
  });

  it("compensates for leading whitespace inside the range (TOFIX #25)", () => {
    // 4 spaces of leading indent before the eval'd code. The transpiler
    // trims leading whitespace, so its offset 0 maps to source position 4.
    const text = "    d1 $ s 'bad'";
    const doc = stubDoc(text);
    const loc = locateErrorInRange(
      "syntax error at offset 4",
      undefined,
      doc,
      { from: 0, to: text.length },
    );
    // With the fix: 4 (leading WS) + 4 (transpiler offset) = 8 → "$"
    expect(loc).toEqual({ from: 8, to: 9 });
  });

  it("handles leading tab + space mix", () => {
    const text = "\t  bad";
    const doc = stubDoc(text);
    const loc = locateErrorInRange(
      "syntax error at offset 0",
      undefined,
      doc,
      { from: 0, to: text.length },
    );
    // 3 chars of leading WS (\t  ) + 0 transpiler offset = 3 → "b"
    expect(loc?.from).toBe(3);
    expect(loc?.to).toBe(4);
  });

  it("falls back to range.from + offset when sliceString isn't provided (legacy callers)", () => {
    const text = "    d1 $ s 'bad'";
    const docNoSlice = {
      length: text.length,
      lines: 1,
      line: () => ({ from: 0, to: text.length }),
      // sliceString intentionally missing
    };
    const loc = locateErrorInRange(
      "syntax error at offset 4",
      undefined,
      docNoSlice,
      { from: 0, to: text.length },
    );
    // Without the optional helper we revert to the original behaviour.
    expect(loc).toEqual({ from: 4, to: 5 });
  });

  it("returns null when message has no offset and no stack", () => {
    const text = "d1 $ s 'bad'";
    const doc = stubDoc(text);
    const loc = locateErrorInRange("oh no", undefined, doc, { from: 0, to: text.length });
    expect(loc).toBeNull();
  });

  it("clamps absFrom inside the range when offset overshoots", () => {
    const text = "d1 $ s 'bad'";
    const doc = stubDoc(text);
    const loc = locateErrorInRange(
      "syntax error at offset 10000",
      undefined,
      doc,
      { from: 0, to: text.length },
    );
    // Clamps to range.to.
    expect(loc?.from).toBeLessThanOrEqual(text.length);
    expect(loc?.to).toBeLessThanOrEqual(text.length);
  });
});
