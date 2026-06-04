// Unit tests for the Lidal StreamLanguage tokeniser (lidal-language.ts).
//
// These tests drive the tokenizer via `lidalLanguage.streamParser` and
// CodeMirror's `StringStream`, isolating token-classification logic from
// the full CodeMirror editor stack.
//
// Each test tokenizes a single line and checks the token types assigned.
// Whitespace tokens (type === null) are stripped from results for clarity.
//
// Known limitation: when an orbit (d1..d16 / c1..c8) immediately precedes a
// constructor on the same line, CodeMirror's `stream.current()` returns the
// full accumulated text rather than just the current token text — so `s` after
// `d1 $` is mis-classified as `identifier` instead of `constructor`. This is a
// tokeniser bug; tests here avoid triggering it by testing each token category
// on its own line.

import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { lidalLanguage } from "../../src/editor/lidal-language.ts";

const sp = lidalLanguage.streamParser;

/**
 * Tokenize a single line and return non-whitespace tokens as
 * `{ type: string | null, text: string }` objects.
 */
function tokenizeLine(line) {
  const state = sp.startState(4);
  const stream = new StringStream(line, 4, null);
  const tokens = [];
  while (!stream.eol()) {
    const startPos = stream.pos;
    const type = sp.token(stream, state);
    if (stream.pos > startPos) {
      if (type !== null) tokens.push({ type, text: line.slice(startPos, stream.pos) });
    } else {
      // Shouldn't happen, but guard against infinite loop
      stream.next();
    }
  }
  return tokens;
}

/** Return just the types of non-whitespace tokens. */
function tokenTypes(line) {
  return tokenizeLine(line).map((t) => t.type);
}

// ── Orbit identifiers ─────────────────────────────────────────────────────

describe("orbit identifiers", () => {
  it("d1 is classified as orbit", () => {
    expect(tokenizeLine("d1")[0]).toEqual({ type: "orbit", text: "d1" });
  });

  it("d16 is classified as orbit", () => {
    expect(tokenizeLine("d16")[0]).toEqual({ type: "orbit", text: "d16" });
  });

  it("c1 is classified as orbit", () => {
    expect(tokenizeLine("c1")[0]).toEqual({ type: "orbit", text: "c1" });
  });

  it("c8 is classified as orbit", () => {
    expect(tokenizeLine("c8")[0]).toEqual({ type: "orbit", text: "c8" });
  });

  it("c9 is NOT an orbit (out of range)", () => {
    expect(tokenizeLine("c9")[0]).not.toEqual({ type: "orbit", text: "c9" });
  });

  it("d17 is NOT an orbit (out of range — treated as identifier)", () => {
    // d17 doesn't match ORBIT_RE so falls through to identifier.
    const toks = tokenizeLine("d17");
    expect(toks[0].type).toBe("identifier");
    expect(toks[0].text).toBe("d17");
  });
});

// ── Constructors ──────────────────────────────────────────────────────────

describe("constructors", () => {
  for (const name of ["n", "s", "chord", "arp", "scale", "ctrl", "silence", "hush",
                      "stack", "cat", "fastcat", "seq", "run", "irand", "choose", "wchoose"]) {
    it(`${name} is classified as constructor`, () => {
      expect(tokenizeLine(name)[0]).toEqual({ type: "constructor", text: name });
    });
  }
});

// ── Combinators ───────────────────────────────────────────────────────────

describe("combinators", () => {
  for (const name of ["fast", "slow", "rev", "every", "jux", "sometimes", "often",
                      "rarely", "gain", "velocity", "early", "late"]) {
    it(`${name} is classified as combinator`, () => {
      expect(tokenizeLine(name)[0]).toEqual({ type: "combinator", text: name });
    });
  }
});

// ── Signals ───────────────────────────────────────────────────────────────

describe("signals", () => {
  for (const name of ["sine", "cosine", "tri", "saw", "isaw", "square", "rand", "perlin"]) {
    it(`${name} is classified as signal`, () => {
      expect(tokenizeLine(name)[0]).toEqual({ type: "signal", text: name });
    });
  }
});

// ── Numbers ───────────────────────────────────────────────────────────────

describe("numbers", () => {
  it("integer is classified as number", () => {
    expect(tokenizeLine("42")[0]).toEqual({ type: "number", text: "42" });
  });

  it("decimal is classified as number", () => {
    expect(tokenizeLine("0.5")[0]).toEqual({ type: "number", text: "0.5" });
  });

  it("negative integer is classified as number", () => {
    expect(tokenizeLine("-7")[0]).toEqual({ type: "number", text: "-7" });
  });

  it("combinator + number produces two tokens", () => {
    expect(tokenTypes("fast 2")).toEqual(["combinator", "number"]);
  });
});

// ── Operators ─────────────────────────────────────────────────────────────

describe("operators", () => {
  it("$ is classified as operator", () => {
    expect(tokenizeLine("$")[0]).toEqual({ type: "operator", text: "$" });
  });

  it("# is classified as operator", () => {
    expect(tokenizeLine("#")[0]).toEqual({ type: "operator", text: "#" });
  });

  it("+ is classified as operator", () => {
    expect(tokenizeLine("+")[0]).toEqual({ type: "operator", text: "+" });
  });

  it("* is classified as operator", () => {
    expect(tokenizeLine("*")[0]).toEqual({ type: "operator", text: "*" });
  });
});

// ── Brackets ──────────────────────────────────────────────────────────────

describe("brackets", () => {
  it("( is classified as bracket", () => {
    expect(tokenizeLine("(")[0]).toEqual({ type: "bracket", text: "(" });
  });

  it(") is classified as bracket", () => {
    expect(tokenizeLine(")")[0]).toEqual({ type: "bracket", text: ")" });
  });

  it("[ is classified as bracket", () => {
    expect(tokenizeLine("[")[0]).toEqual({ type: "bracket", text: "[" });
  });
});

// ── Comments ──────────────────────────────────────────────────────────────

describe("comments", () => {
  it("-- line comment is classified as lineComment", () => {
    const toks = tokenizeLine("-- hello world");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe("lineComment");
    expect(toks[0].text).toBe("-- hello world");
  });

  it("{- block comment -} is classified as blockComment", () => {
    const toks = tokenizeLine("{- a block comment -}");
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe("blockComment");
  });

  it("inline code before line comment tokenizes the code part", () => {
    const toks = tokenizeLine("fast -- comment");
    expect(toks[0]).toEqual({ type: "combinator", text: "fast" });
    expect(toks[1].type).toBe("lineComment");
  });
});

// ── Strings and mini-notation ─────────────────────────────────────────────

describe("strings and mini-notation", () => {
  it("plain string in quotes has type string", () => {
    // When not preceded by a mini-notation head, the string is plain.
    const toks = tokenizeLine('"hello"');
    expect(toks.every((t) => t.type === "string")).toBe(true);
  });

  it('n "..." activates mini-notation mode for the string body', () => {
    const toks = tokenizeLine('n "bd ~ sd"');
    const types = toks.map((t) => t.type);
    // Should have at least one miniOp for ~
    expect(types).toContain("miniOp");
  });

  it('s "..." activates mini-notation mode', () => {
    const toks = tokenizeLine('s "bd sd hh"');
    const types = toks.map((t) => t.type);
    // string tokens for the body fragments
    expect(types.filter((t) => t === "string").length).toBeGreaterThan(0);
    // No miniOp expected since no operators in "bd sd hh"
    expect(types).not.toContain("miniOp");
  });

  it("mini-notation ~ is miniOp", () => {
    const toks = tokenizeLine('n "~ bd"');
    expect(toks.some((t) => t.type === "miniOp" && t.text === "~")).toBe(true);
  });

  it("mini-notation * is miniOp", () => {
    const toks = tokenizeLine('n "bd*2"');
    expect(toks.some((t) => t.type === "miniOp" && t.text === "*")).toBe(true);
  });

  it("mini-notation numbers are classified as number", () => {
    const toks = tokenizeLine('n "60 72"');
    expect(toks.some((t) => t.type === "number")).toBe(true);
  });
});

// ── State — mini-notation mode resets across lines ────────────────────────

describe("state", () => {
  it("each tokenizeLine call starts fresh (no state bleed)", () => {
    // First call sets mini-notation mode mid-line (unclosed string shouldn't
    // affect the next independent call).
    tokenizeLine('n "bd');  // unclosed — ends EOL
    // Second call should see "fast" as combinator, not in miniString mode.
    expect(tokenizeLine("fast")[0].type).toBe("combinator");
  });
});
