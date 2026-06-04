// Unit tests for the editor-side feedback helpers: orbit colour mapping is
// deterministic across reloads, and the bake-toast summariser extracts a
// clean list of orbit names from the backend's success message.
//
// The full UI of these features is exercised manually in the running editor;
// these tests just lock down the small, pure functions that drive them.

import { describe, it, expect } from "vitest";
import { getOrbitColor, PALETTE_SIZE, KNOWN_ORBITS } from "../../src/editor/orbit-colors.ts";
import { summarizeBakeMessage } from "../../src/editor/bake-toast.ts";

describe("orbit-colors / getOrbitColor", () => {
  it("returns a deterministic mapping for every known orbit", () => {
    for (const orbit of KNOWN_ORBITS) {
      const c1 = getOrbitColor(orbit);
      const c2 = getOrbitColor(orbit);
      expect(c1.color).toBe(c2.color);
      expect(c1.bg).toBe(c2.bg);
      expect(c1.index).toBeGreaterThanOrEqual(0);
      expect(c1.index).toBeLessThan(PALETTE_SIZE);
    }
  });

  it("orbits sharing palette slots get identical colours (d1 == c1, d1 == d11)", () => {
    expect(getOrbitColor("d1").color).toBe(getOrbitColor("c1").color);
    expect(getOrbitColor("d1").color).toBe(getOrbitColor("d11").color);
    expect(getOrbitColor("d2").color).toBe(getOrbitColor("d12").color);
  });

  it("returns a neutral fallback for unknown identifiers", () => {
    const fb = getOrbitColor("not-an-orbit");
    expect(fb.index).toBe(-1);
    // Greyish neutral colour, not from the palette.
    expect(fb.color.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns ten distinct hues across d1..d10", () => {
    const hues = new Set();
    for (let i = 1; i <= PALETTE_SIZE; i++) hues.add(getOrbitColor(`d${i}`).color);
    expect(hues.size).toBe(PALETTE_SIZE);
  });
});

describe("bake-toast / summarizeBakeMessage", () => {
  it("strips the backend prefix and (clip N) suffixes", () => {
    const msg = "✓ baked → lidal_d1 (clip 0), lidal_d3 (clip 2)";
    expect(summarizeBakeMessage(msg, 4)).toBe("Baked 4 cycles → d1, d3");
  });

  it("renders singular cycle correctly", () => {
    const msg = "✓ baked → lidal_d2 (clip 0)";
    expect(summarizeBakeMessage(msg, 1)).toBe("Baked 1 cycle → d2");
  });

  it("preserves drum (s) orbit prefix", () => {
    const msg = "✓ baked → lidal_s4 (clip 1)";
    expect(summarizeBakeMessage(msg, 2)).toBe("Baked 2 cycles → s4");
  });

  it("drops trailing (skipped …) clause", () => {
    const msg = "✓ baked → lidal_d1 (clip 0) (skipped c1, c2)";
    expect(summarizeBakeMessage(msg, 4)).toBe("Baked 4 cycles → d1");
  });

  it("falls back gracefully when format isn't recognised", () => {
    const msg = "unexpected bake message";
    // No "baked →" prefix → body is the whole message; no lidal_* tracks
    // means it passes through unchanged in the orbit list.
    expect(summarizeBakeMessage(msg, 4)).toBe("Baked 4 cycles → unexpected bake message");
  });

  it("omits cycle count when not provided", () => {
    const msg = "✓ baked → lidal_d1 (clip 0)";
    expect(summarizeBakeMessage(msg, undefined)).toBe("Baked → d1");
  });
});
