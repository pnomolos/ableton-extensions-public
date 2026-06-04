// Lidal / TidalCycles syntax highlighter for CodeMirror 6.
//
// Implemented as a StreamLanguage so we can keep it small (no Lezer grammar)
// and still get accurate token classification per character. The transpiler
// (lidal/src/transpile.ts) does the real parsing — this just colours enough
// to match a player's mental model.

import { StreamLanguage, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Tag } from "@lezer/highlight";

// ── Identifier categories ─────────────────────────────────────────────────

const ORBIT_RE = /^(?:d(?:1[0-6]|[1-9])|c[1-8])\b/;

const CONSTRUCTORS = new Set([
  "n", "s", "chord", "arp", "scale", "ctrl", "silence", "hush",
  "stack", "cat", "fastcat", "seq", "run", "irand", "choose", "wchoose",
]);

const COMBINATORS = new Set([
  "fast", "slow", "density", "sparsity", "rev", "palindrome",
  "every", "whenmod", "jux", "juxBy", "juxTo",
  "sometimes", "often", "rarely", "sometimesBy",
  "chunk", "iter", "mask", "struct", "stutter",
  "inside", "outside", "rot", "early", "late", "nudge",
  "linger", "trunc", "zoom", "compress", "off",
  "degrade", "degradeBy",
  "add", "sub", "mul", "up", "octave", "range", "range2",
  "gain", "velocity", "chan", "ch",
  "drumMap", "autoMap", "autoMapAll", "learn",
]);

const SIGNALS = new Set([
  "sine", "sine2", "cosine", "cosine2", "cos", "cos2",
  "tri", "tri2", "saw", "saw2", "isaw", "isaw2",
  "square", "square2", "rand", "perlin", "segment",
]);

// Constructor names whose first string argument is mini-notation. When we see
// `n "..."` or `s "..."` etc. the string body gets re-tokenized so operators
// stand out from drum/note tokens.
const MININOTATION_HEADS = new Set(["n", "s", "chord", "arp", "drumMap", "mask", "struct"]);

// ── Stream tokenizer ──────────────────────────────────────────────────────

interface LidalState {
  miniString: boolean;
  blockComment: boolean;
  lastIdent: string | null;
}

function startState(): LidalState {
  return { miniString: false, blockComment: false, lastIdent: null };
}

// Mini-notation special characters used as operators inside `"..."`.
const MINI_OPS = "~[]{}<>,*?@_!|=:()'";

function tokenMiniString(stream: StringStream, state: LidalState): string | null {
  if (stream.peek() === '"') {
    stream.next();
    state.miniString = false;
    return "string";
  }
  const c = stream.next();
  if (c == null) return null;

  if (c === "." && stream.peek() === ".") {
    // ".." range operator
    stream.next();
    return "miniOp";
  }
  if (MINI_OPS.includes(c)) {
    return "miniOp";
  }

  if (c === " " || c === "\t") {
    stream.eatWhile(/[ \t]/);
    return "string";
  }

  if (/[0-9]/.test(c)) {
    stream.eatWhile(/[0-9.]/);
    return "number";
  }

  if (/[a-zA-Z]/.test(c)) {
    stream.eatWhile(/[a-zA-Z0-9#_-]/);
    return "string";
  }

  return "string";
}

function tokenBase(stream: StringStream, state: LidalState): string | null {
  if (state.blockComment) {
    while (!stream.eol()) {
      if (stream.match("-}")) {
        state.blockComment = false;
        return "blockComment";
      }
      stream.next();
    }
    return "blockComment";
  }

  if (stream.eatSpace()) return null;

  // Line comment — Tidal-style only. The transpiler treats `//` as division,
  // so we don't pretend it's a comment.
  if (stream.match("--")) {
    stream.skipToEnd();
    return "lineComment";
  }

  if (stream.match("{-")) {
    state.blockComment = true;
    while (!stream.eol()) {
      if (stream.match("-}")) {
        state.blockComment = false;
        return "blockComment";
      }
      stream.next();
    }
    return "blockComment";
  }

  // Strings.
  if (stream.peek() === '"') {
    stream.next();
    if (state.lastIdent && MININOTATION_HEADS.has(state.lastIdent)) {
      state.miniString = true;
      state.lastIdent = null;
      return "string";
    }
    while (!stream.eol()) {
      const c = stream.next();
      if (c === '"') return "string";
    }
    return "string";
  }

  if (stream.match(/^-?[0-9]+(\.[0-9]+)?/)) return "number";

  // Operators (single-char). $/#/+/-/*//,/;
  if (stream.match(/^(\$|#|\+|-|\*|\/|,|;)/)) {
    state.lastIdent = null;
    return "operator";
  }

  if (stream.eat("(") || stream.eat(")") || stream.eat("[") || stream.eat("]") || stream.eat("{") || stream.eat("}")) {
    return "bracket";
  }

  const orbitMatch = stream.match(ORBIT_RE) as RegExpMatchArray | boolean | null;
  if (orbitMatch && typeof orbitMatch !== "boolean") {
    state.lastIdent = orbitMatch[0];
    return "orbit";
  }

  if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
    // `stream.current()` includes the whole matched ident.
    const id = stream.current();
    state.lastIdent = id;
    if (CONSTRUCTORS.has(id)) return "constructor";
    if (COMBINATORS.has(id)) return "combinator";
    if (SIGNALS.has(id)) return "signal";
    return "identifier";
  }

  // Unrecognised — advance one char to avoid an infinite loop.
  stream.next();
  return null;
}

// ── Token → Tag table ─────────────────────────────────────────────────────

const lidalTokenTable: { [name: string]: Tag | readonly Tag[] } = {
  orbit:        t.special(t.variableName),  // d1..d16 / c1..c8
  constructor:  t.keyword,
  combinator:   t.function(t.variableName),
  signal:       t.atom,
  identifier:   t.variableName,
  string:       t.string,
  number:       t.number,
  operator:     t.operatorKeyword,
  miniOp:       t.operator,
  bracket:      t.bracket,
  lineComment:  t.lineComment,
  blockComment: t.blockComment,
};

export const lidalLanguage = StreamLanguage.define<LidalState>({
  name: "lidal",
  startState,
  token(stream, state) {
    if (state.miniString) return tokenMiniString(stream, state);
    return tokenBase(stream, state);
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "{-", close: "-}" } },
    closeBrackets: { brackets: ["(", "[", "{", "\""] },
  },
  tokenTable: lidalTokenTable,
});

// ── Highlight palette (dark theme) ────────────────────────────────────────
// Six distinct hues at ≥ AA contrast on #0e0e0e (--bg-input).

export const lidalHighlightStyle = HighlightStyle.define([
  { tag: t.special(t.variableName),  color: "#6fb37b", fontWeight: "600" }, // orbit
  { tag: t.keyword,                   color: "#e0a87a" },                    // constructor
  { tag: t.function(t.variableName),  color: "#7fb6d9" },                    // combinator
  { tag: t.atom,                      color: "#c896e3" },                    // signal
  { tag: t.variableName,              color: "#cfd2d6" },                    // misc ident
  { tag: t.string,                    color: "#d9c187" },                    // string body
  { tag: t.number,                    color: "#a8c98c" },                    // numbers
  { tag: t.operator,                  color: "#f0c469" },                    // mini-notation ops
  { tag: t.operatorKeyword,           color: "#c4c4c4" },                    // $ # + - * /
  { tag: t.bracket,                   color: "#999" },                       // [] {} ()
  { tag: t.lineComment,               color: "#666", fontStyle: "italic" },
  { tag: t.blockComment,              color: "#666", fontStyle: "italic" },
]);

export const lidalHighlighting = syntaxHighlighting(lidalHighlightStyle);
