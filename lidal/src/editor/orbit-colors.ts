// Per-orbit colour mapping + a CM6 ViewPlugin that decorates orbit identifiers
// in the editor with a per-orbit class name. The palette is intentionally small
// (10 hues) so multiple orbits read clearly side-by-side; with 16 d-orbits +
// 8 c-orbits, some sharing is unavoidable and acceptable.
//
// Reds are deliberately excluded — the editor reserves red for error/diagnostic
// states (cf. diagnostics.ts).

import { ViewPlugin, Decoration, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export interface OrbitColor {
  /** Foreground colour for the orbit identifier and pill text. */
  color: string;
  /** A translucent fill suitable for backgrounds / left borders. */
  bg: string;
  /** A short hash-stable index 0..PALETTE.length-1 — mostly for tests/debug. */
  index: number;
}

// 10 hues picked to:
//   - read at ≥ AA contrast on the editor's #0e0e0e background,
//   - be distinguishable side-by-side,
//   - avoid red (reserved for error states),
//   - sit within a single tasteful palette (refined-Tailwind-ish saturation).
//
// Order matters: d1/c1 → palette[0], d2/c2 → palette[1], … wrapping with
// modulo so d11 / d1 share, d12 / d2 share, etc.
const PALETTE: ReadonlyArray<{ color: string; bg: string }> = [
  { color: "#6fb37b", bg: "rgba(111, 179, 123, 0.18)" }, // green (matches current "active" accent)
  { color: "#7fb6d9", bg: "rgba(127, 182, 217, 0.18)" }, // sky
  { color: "#e0a87a", bg: "rgba(224, 168, 122, 0.18)" }, // peach
  { color: "#c896e3", bg: "rgba(200, 150, 227, 0.18)" }, // violet
  { color: "#f0c469", bg: "rgba(240, 196, 105, 0.18)" }, // amber
  { color: "#8fd6c7", bg: "rgba(143, 214, 199, 0.18)" }, // teal
  { color: "#dfb3e3", bg: "rgba(223, 179, 227, 0.18)" }, // pink-mauve
  { color: "#b0c98a", bg: "rgba(176, 201, 138, 0.18)" }, // olive
  { color: "#9bb5f0", bg: "rgba(155, 181, 240, 0.18)" }, // periwinkle
  { color: "#d7b58a", bg: "rgba(215, 181, 138, 0.18)" }, // sand
];

const ORBIT_RE = /^([dc])(\d+)$/;

/**
 * Deterministic colour mapping: `d1`, `c1` → palette[0]; `d2`, `c2` →
 * palette[1]; … wrapping by modulo PALETTE.length. Unknown orbit names fall
 * back to a neutral grey-blue.
 */
export function getOrbitColor(orbit: string): OrbitColor {
  const m = ORBIT_RE.exec(orbit);
  if (!m) {
    return { color: "#9aa0a6", bg: "rgba(154, 160, 166, 0.18)", index: -1 };
  }
  const num = parseInt(m[2], 10);
  if (!Number.isFinite(num) || num < 1) {
    return { color: "#9aa0a6", bg: "rgba(154, 160, 166, 0.18)", index: -1 };
  }
  const idx = (num - 1) % PALETTE.length;
  const entry = PALETTE[idx];
  return { color: entry.color, bg: entry.bg, index: idx };
}

/** The orbit IDs we recognise — used to bound the regex and the CSS rules. */
export const KNOWN_ORBITS: ReadonlyArray<string> = (() => {
  const all: string[] = [];
  for (let i = 1; i <= 16; i++) all.push(`d${i}`);
  for (let i = 1; i <= 8; i++) all.push(`c${i}`);
  return all;
})();

export const PALETTE_SIZE = PALETTE.length;

// ── ViewPlugin: scan visible content and tag orbit identifiers ────────────
//
// We rely on a string-level regex rather than the syntax tree because the
// existing tokenizer already returns "orbit" via StreamLanguage tags and
// re-tagging it per orbit would require a parallel highlighter. The regex is
// scoped to visible ranges so it stays cheap even on long buffers.

// Orbits only appear at the start of a line (possibly indented) followed by
// `$` — i.e. the canonical `d1 $ ...` / `c1 $ ...` form. We avoid matching
// e.g. `c4` inside `n "c4"` (a note name in mini-notation) by anchoring to
// line start. Per-line scan keeps this simple and bounded.
const ORBIT_LINE_RE = /^[ \t]*((?:d(?:1[0-6]|[1-9])|c[1-8]))(?=[ \t]+\$)/;

function buildOrbitDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const m = ORBIT_LINE_RE.exec(line.text);
      if (m) {
        const orbit = m[1];
        const leadingOffset = m[0].length - orbit.length;
        const start = line.from + leadingOffset;
        const end = start + orbit.length;
        const klass = `lidal-feedback-orbit-token lidal-feedback-orbit-${orbit}`;
        builder.add(start, end, Decoration.mark({ class: klass, attributes: { "data-orbit": orbit } }));
      }
      pos = line.to + 1;
      if (line.to >= to) break;
    }
  }
  return builder.finish();
}

export const orbitColorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildOrbitDecorations(view); }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = buildOrbitDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Emit a single `<style>` block worth of CSS rules — one per known orbit —
 * setting `color` for `.lidal-feedback-orbit-<id>` so the editor decoration
 * and any host-side `.lidal-feedback-orbit-<id>` element pick up the colour.
 * Generated rather than hand-written so palette changes propagate.
 */
export function orbitColorCss(): string {
  const lines: string[] = [];
  for (const orbit of KNOWN_ORBITS) {
    const c = getOrbitColor(orbit);
    // The CM6 highlighter wraps each token in an inner span with its own
    // `color` declaration (e.g. `.ͼo`), so we need to target descendants too —
    // otherwise the inner span shadows our wrapper colour. Specificity is 0,2,0
    // (the descendant selector) which ties with CM's `.ͼN .ͼo`; source order
    // wins because our stylesheet is appended after CM's theme.
    lines.push(`.lidal-feedback-orbit-${orbit},.lidal-feedback-orbit-${orbit} *{color:${c.color};}`);
    lines.push(`.lidal-feedback-orbit-${orbit}-bg{background:${c.bg};}`);
    lines.push(`.lidal-feedback-orbit-${orbit}-bd{border-color:${c.color};}`);
  }
  return lines.join("");
}
