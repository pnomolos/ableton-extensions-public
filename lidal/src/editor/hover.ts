// CM6 hover tooltip for Lidal identifiers.
//
// Looks up the word under the cursor in HELP_BY_NAME (from help-data.ts) and
// renders type signature + description + example. Mini-notation strings
// (anywhere inside a "..." literal) are skipped — the names inside aren't
// real identifiers from the host language's perspective.
//
// The tooltip DOM matches the autocomplete popup styling defined in
// client.ts's `EditorView.theme(.cm-tooltip)` block, plus a few extra rules
// for the structured layout (signature + body + example). We attach an
// internal style ID exactly once.

import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { HELP_BY_NAME } from "./help-data.js";

const TOOLTIP_STYLE_ID = "lidal-hover-tooltip-style";

function ensureStyles(): void {
  if (document.getElementById(TOOLTIP_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOOLTIP_STYLE_ID;
  style.textContent = `
    .cm-tooltip.cm-tooltip-hover.lidal-hover-tip {
      padding: 0;
      max-width: 380px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    }
    .lidal-hover-tip .lidal-hover-head {
      display: flex; align-items: baseline; gap: 8px;
      padding: 6px 10px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid #2a2a2a;
    }
    .lidal-hover-tip .lidal-hover-name {
      font-family: ui-monospace, Menlo, monospace;
      font-weight: 600;
      font-size: 12px;
    }
    .lidal-hover-tip .lidal-hover-kind {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
    }
    .lidal-hover-tip .lidal-hover-body {
      padding: 6px 10px;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .lidal-hover-tip .lidal-hover-sig {
      font-family: ui-monospace, Menlo, monospace;
      font-size: 11px;
      color: #999;
      margin-bottom: 4px;
      white-space: pre-wrap;
    }
    .lidal-hover-tip .lidal-hover-desc { color: #cfd2d6; }
    .lidal-hover-tip .lidal-hover-example {
      margin-top: 6px;
      padding: 4px 6px;
      background: rgba(0,0,0,0.25);
      border-left: 2px solid #3a8a4a;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 11px;
      color: #d9c187;
      border-radius: 2px;
      overflow-x: auto;
    }
    .lidal-hover-tip.kind-orbit       .lidal-hover-name { color: #6fb37b; }
    .lidal-hover-tip.kind-constructor .lidal-hover-name { color: #e0a87a; }
    .lidal-hover-tip.kind-combinator  .lidal-hover-name { color: #7fb6d9; }
    .lidal-hover-tip.kind-signal      .lidal-hover-name { color: #c896e3; }
    .lidal-hover-tip.kind-function    .lidal-hover-name { color: #cfd2d6; }
  `;
  document.head.appendChild(style);
}

// Determine whether a given offset sits inside a "..." string literal. The
// language definition emits a "string" token for the body, but querying
// syntaxTree is brittle because we use a StreamLanguage. We do a quick scan
// of the line: count unescaped quotes from the line start up to `pos` — if
// the count is odd, we're inside a string.
function insideString(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const upToCursor = view.state.doc.sliceString(line.from, pos);
  let count = 0;
  for (let i = 0; i < upToCursor.length; i++) {
    if (upToCursor[i] === '"') {
      // Tidal/Haskell doesn't use \" inside Lidal mini-notation literals, so
      // we don't bother with backslash escapes.
      count++;
    }
  }
  return count % 2 === 1;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function renderTooltip(name: string): HTMLElement | null {
  const entry = HELP_BY_NAME.get(name);
  if (!entry) return null;
  ensureStyles();

  const root = document.createElement("div");
  root.className = `lidal-hover-tip kind-${entry.kind}`;

  const head = document.createElement("div");
  head.className = "lidal-hover-head";
  const nameEl = document.createElement("span");
  nameEl.className = "lidal-hover-name";
  nameEl.textContent = entry.name;
  head.appendChild(nameEl);
  const kindEl = document.createElement("span");
  kindEl.className = "lidal-hover-kind";
  kindEl.textContent = entry.kind;
  head.appendChild(kindEl);
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "lidal-hover-body";
  const sig = document.createElement("div");
  sig.className = "lidal-hover-sig";
  sig.textContent = entry.signature;
  body.appendChild(sig);
  const desc = document.createElement("div");
  desc.className = "lidal-hover-desc";
  desc.textContent = entry.description;
  body.appendChild(desc);
  if (entry.example) {
    const ex = document.createElement("div");
    ex.className = "lidal-hover-example";
    ex.textContent = entry.example;
    body.appendChild(ex);
  }
  root.appendChild(body);

  return root;
}

// CM6 hoverTooltip handler — returns a Tooltip|null. We resolve the word at
// the hovered offset (respecting CM's "side" hint) and gate on insideString.
function lidalHoverHandler(view: EditorView, pos: number, side: -1 | 1): Tooltip | null {
  if (insideString(view, pos)) return null;
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const col = pos - line.from;

  // Expand left/right while we're on identifier characters.
  let start = col;
  let end = col;
  const isIdChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  while (start > 0 && isIdChar(lineText[start - 1])) start--;
  while (end < lineText.length && isIdChar(lineText[end])) end++;
  if (start === end) {
    // No identifier character at cursor — if `side` is +1 try the char to the
    // right anyway (CM passes us the gap between glyphs).
    if (side === 1 && end < lineText.length && isIdChar(lineText[end])) {
      end++;
    } else {
      return null;
    }
  }

  const name = lineText.slice(start, end);
  if (!IDENT_RE.test(name)) return null;
  const dom = renderTooltip(name);
  if (!dom) return null;

  return {
    pos: line.from + start,
    end: line.from + end,
    above: true,
    create() { return { dom }; },
  };
}

export const lidalHoverTooltip: Extension = hoverTooltip(lidalHoverHandler, {
  hideOnChange: true,
  hoverTime: 250,
});
