// Inline diagnostics for eval / transpile errors.
//
// Wraps @codemirror/lint's setDiagnostics: callers hand us a typed list of
// errors with line/col + a fallback document range, and we turn them into
// CM6 Diagnostic markers with a red squiggle, a gutter dot, and a hover
// tooltip showing the message. The lint extension itself is the carrier —
// we just push diagnostics into it as the eval result arrives.

import { setDiagnostics, lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Caller-facing diagnostic input. Either supply explicit `from`/`to` (after
 * locating a line + col in the source), or just supply a `fallbackRange` to
 * mark the whole evaluated block.
 */
export interface LidalDiagnostic {
  message: string;
  /** Override the underline range. Cleared on success / replacement. */
  from?: number;
  to?: number;
  /** Used when from/to are not provided. */
  fallbackRange?: { from: number; to: number };
  /** Defaults to "error". */
  severity?: "error" | "warning" | "info" | "hint";
  /** Marker tag — shown in the tooltip. Defaults to "lidal". */
  source?: string;
}

const DIAGNOSTIC_THEME = EditorView.baseTheme({
  // Match the colour palette used elsewhere in the editor; default lint
  // styling skews red-orange but on our background the saturation reads
  // washed-out. Slightly punchier red for the squiggle and a clear dot in
  // the gutter.
  ".cm-lintRange-error": {
    backgroundImage: "linear-gradient(135deg, rgba(217,112,112,0) 33%, rgba(217,112,112,0.9) 33%, rgba(217,112,112,0.9) 50%, rgba(217,112,112,0) 50%, rgba(217,112,112,0) 83%, rgba(217,112,112,0.9) 83%, rgba(217,112,112,0.9))",
    backgroundRepeat: "repeat-x",
    backgroundPosition: "left bottom",
    backgroundSize: "4px 2px",
    paddingBottom: "1px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "linear-gradient(135deg, rgba(240,196,105,0) 33%, rgba(240,196,105,0.9) 33%, rgba(240,196,105,0.9) 50%, rgba(240,196,105,0) 50%, rgba(240,196,105,0) 83%, rgba(240,196,105,0.9) 83%, rgba(240,196,105,0.9))",
    backgroundRepeat: "repeat-x",
    backgroundPosition: "left bottom",
    backgroundSize: "4px 2px",
    paddingBottom: "1px",
  },
  ".cm-gutter-lint": {
    width: "1.4em",
  },
  ".cm-gutter-lint .cm-gutterElement": {
    padding: "0",
  },
  ".cm-lint-marker-error": {
    content: "''",
    display: "block",
    width: "8px",
    height: "8px",
    margin: "5px auto",
    borderRadius: "50%",
    backgroundColor: "#d97070",
    boxShadow: "0 0 4px rgba(217, 112, 112, 0.55)",
  },
  ".cm-lint-marker-warning": {
    content: "''",
    display: "block",
    width: "8px",
    height: "8px",
    margin: "5px auto",
    borderRadius: "50%",
    backgroundColor: "#f0c469",
  },
  ".cm-tooltip-lint": {
    backgroundColor: "var(--bg-elevated)",
    color: "var(--fg)",
    border: "1px solid var(--border-strong)",
    fontSize: "12px",
  },
  ".cm-diagnostic": {
    padding: "4px 8px",
    borderLeftWidth: "3px",
  },
  ".cm-diagnostic-error": { borderLeftColor: "#d97070" },
  ".cm-diagnostic-warning": { borderLeftColor: "#f0c469" },
});

/**
 * The composite extension to install in buildView(). Combines:
 *   - linter(null): the carrier; we never poll a lint source, but installing
 *     `linter(null)` enables the diagnostic state field that `setDiagnostics`
 *     transactions depend on. (Per @codemirror/lint docs, passing `null` only
 *     configures the field.)
 *   - lintGutter(): the gutter dot.
 *   - theme overrides keyed to our dark palette.
 */
export const diagnosticsExtension: Extension = [
  linter(null, { delay: 0 }),
  lintGutter(),
  DIAGNOSTIC_THEME,
];

/**
 * Normalise the caller's input → @codemirror/lint Diagnostic, then dispatch
 * a setDiagnostics transaction. Passing an empty array clears all markers.
 */
export function setLidalDiagnostics(view: EditorView, items: ReadonlyArray<LidalDiagnostic>): void {
  const docLen = view.state.doc.length;
  const out: Diagnostic[] = [];
  for (const d of items) {
    let from = d.from;
    let to = d.to;
    if (from == null || to == null || from === to) {
      // Fall back to the supplied block range. Trim to doc bounds so a stale
      // diagnostic (from a buffer that's since shrunk) doesn't throw.
      const fb = d.fallbackRange;
      if (fb && fb.from <= docLen) {
        from = Math.max(0, Math.min(docLen, fb.from));
        to = Math.max(from, Math.min(docLen, fb.to));
        // CM expects from < to for marking; collapse 0-length ranges by
        // extending one char (or back-pad to non-empty document start).
        if (to === from) {
          if (to < docLen) to = from + 1;
          else if (from > 0) from = to - 1;
        }
      } else {
        // No usable range; skip rather than emit a degenerate marker.
        continue;
      }
    } else {
      from = Math.max(0, Math.min(docLen, from));
      to = Math.max(from, Math.min(docLen, to));
      if (to === from && to < docLen) to = from + 1;
    }
    out.push({
      from,
      to,
      severity: d.severity ?? "error",
      source: d.source ?? "lidal",
      message: d.message,
    });
  }
  try {
    view.dispatch(setDiagnostics(view.state, out));
  } catch {
    // View was likely destroyed mid-transaction; nothing to recover.
  }
}

/** Clears all current diagnostics. */
export function clearLidalDiagnostics(view: EditorView): void {
  setLidalDiagnostics(view, []);
}

/**
 * Best-effort extraction of a 1-based line/col from a runtime error message.
 * Catches:
 *   - the transpiler's "unexpected character 'X' at offset N" form
 *   - V8-ish `at <fn> (<file>:line:col)` stack frames (when the message is the
 *     full toString, not just .message)
 *
 * Returns absolute document offsets, scoped within the supplied range
 * (`base + lineOffset` clamped to `to`). When nothing matches, returns null.
 */
export function locateErrorInRange(
  message: string,
  stackDetail: string | undefined,
  doc: {
    line: (n: number) => { from: number; to: number };
    lines: number;
    length: number;
    /** Optional — when present, we can slice text and compensate for leading
     *  whitespace stripped by the transpiler. Falls back to range.from when
     *  absent. */
    sliceString?: (from: number, to?: number) => string;
  },
  range: { from: number; to: number },
): { from: number; to: number } | null {
  // "at offset N" — N is a 0-based offset into the *trimmed* code string the
  // transpiler saw. The runner trims the input before transpiling, so we map
  // back to the eval range by counting from `range.from` after skipping
  // leading whitespace.
  const offsetMatch = /\bat offset (\d+)\b/.exec(message);
  if (offsetMatch) {
    const off = parseInt(offsetMatch[1], 10);
    if (Number.isFinite(off)) {
      // [ED-agent fix #25] Subtract the leading-whitespace offset when
      // mapping transpile errors back to source ranges. The transpiler sees
      // a trimmed string (no leading whitespace), so offset 0 in its view
      // maps to range.from + leadingWS in the source. Without this, the
      // squiggle drifts right by N where N is the line's leading-whitespace
      // count.
      let leadingWs = 0;
      if (doc.sliceString) {
        const text = doc.sliceString(range.from, range.to);
        while (leadingWs < text.length) {
          const ch = text.charCodeAt(leadingWs);
          // Match ASCII whitespace the transpiler's `trimStart()` removes:
          // space, tab, CR, LF, vertical tab, form feed.
          if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x0B || ch === 0x0C) {
            leadingWs++;
          } else break;
        }
      }
      const absFrom = Math.min(range.to, Math.max(range.from, range.from + leadingWs + off));
      const absTo = Math.min(range.to, absFrom + 1);
      return { from: absFrom, to: absTo };
    }
  }
  // Stack-frame pattern — captures the deepest line:col. We rely on V8 here;
  // other engines (currently none in scope) would need extra patterns.
  if (stackDetail) {
    const stackMatch = /:(\d+):(\d+)\)?$/m.exec(stackDetail);
    if (stackMatch) {
      const line = parseInt(stackMatch[1], 10);
      const col = parseInt(stackMatch[2], 10);
      if (Number.isFinite(line) && line >= 1 && line <= doc.lines) {
        const lineInfo = doc.line(line);
        const from = Math.min(lineInfo.to, lineInfo.from + Math.max(0, col - 1));
        return { from, to: lineInfo.to };
      }
    }
  }
  return null;
}
