// Line-flash decoration for evaluated / baked code blocks.
//
// CodeMirror 6 doesn't have a built-in "flash these lines and fade" primitive,
// so we model it with a StateField holding a DecorationSet plus a StateEffect
// that schedules a removal after the CSS animation. The CSS class transitions
// to transparent on its own; we just need to add and remove the decoration.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export type FlashVariant = "fired" | "baking";

interface FlashRange {
  from: number;
  to: number;
  variant: FlashVariant;
}

// Add and clear effects. We model clears explicitly (rather than e.g. timers
// embedded in the field) so the host can issue an explicit clear if the
// document is replaced underneath us.
export const flashAddEffect = StateEffect.define<FlashRange>();
export const flashClearEffect = StateEffect.define<void>();

const firedDeco = Decoration.line({ class: "cm-lidal-flash-fired" });
const bakingDeco = Decoration.line({ class: "cm-lidal-flash-baking" });

export const flashField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const eff of tr.effects) {
      if (eff.is(flashClearEffect)) {
        decos = Decoration.none;
      } else if (eff.is(flashAddEffect)) {
        const { from, to, variant } = eff.value;
        const deco = variant === "baking" ? bakingDeco : firedDeco;
        // Add a line decoration at every line start in [from..to].
        const adds = [];
        const startLine = tr.state.doc.lineAt(from).number;
        const endLine = tr.state.doc.lineAt(to).number;
        for (let l = startLine; l <= endLine; l++) {
          const line = tr.state.doc.line(l);
          adds.push(deco.range(line.from));
        }
        decos = decos.update({ add: adds, sort: true });
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Theme: the flash class fades from coloured to transparent over ~700ms. We
// remove the decoration after that, but the visual is driven by CSS, not by
// re-applying classes per frame.
export const flashTheme = EditorView.baseTheme({
  ".cm-lidal-flash-fired": {
    animation: "cm-lidal-flash-fired-fade 750ms ease-out forwards",
  },
  ".cm-lidal-flash-baking": {
    animation: "cm-lidal-flash-baking-fade 750ms ease-out forwards",
  },
  "@keyframes cm-lidal-flash-fired-fade": {
    "0%":   { backgroundColor: "rgba(111, 179, 123, 0.55)" },
    "30%":  { backgroundColor: "rgba(111, 179, 123, 0.45)" },
    "100%": { backgroundColor: "rgba(0, 0, 0, 0)" },
  },
  "@keyframes cm-lidal-flash-baking-fade": {
    "0%":   { backgroundColor: "rgba(224, 168, 122, 0.55)" },
    "30%":  { backgroundColor: "rgba(224, 168, 122, 0.45)" },
    "100%": { backgroundColor: "rgba(0, 0, 0, 0)" },
  },
});

// Helper: flash a range and auto-clear after a delay.
export function flashLines(view: EditorView, from: number, to: number, variant: FlashVariant): void {
  view.dispatch({ effects: flashAddEffect.of({ from, to, variant }) });
  // The decoration sits there until the next flash on the same line (it gets
  // replaced) or until we explicitly clear. We aggressively re-clear ALL
  // flashes ~750ms later so they don't accumulate visually; subsequent flashes
  // will simply re-add. Trade-off: slightly more churn in the StateField, but
  // simpler reasoning than per-range timers.
  setTimeout(() => {
    try { view.dispatch({ effects: flashClearEffect.of() }); }
    catch { /* view destroyed */ }
  }, 750);
}

export const flashExtension: Extension = [flashField, flashTheme];
