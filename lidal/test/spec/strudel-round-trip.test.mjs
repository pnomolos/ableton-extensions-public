// Strudel-spec round-trip smoke test (TOFIX #15).
//
// Walks test/specs/strudel-derived-specs.md, extracts every **Input:** code
// snippet, and verifies that each one can be evaluated without throwing.
//
// Snippets that call `evaluatePattern("...")` are exercised directly via the
// parser.  Snippets that use the Pattern API (`.getEvents()`, `.fast()`, etc.)
// are run inside the real Lidal sandbox (via buildSandbox) so the curried
// sandbox combinators (rev, fast, inside, off, jux …) are correctly wired.
//
// The goal is structural: if a mini-notation feature is documented in the spec
// but its input snippet throws at parse or evaluation time, this test catches
// the regression.  Exact output correctness is covered by the per-feature
// vitest files in test/spec/.

import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluatePattern } from "../../src/parser.ts";
import { buildSandbox, range2, segment } from "../../src/patterns.ts";

// ── Minimal stub engine for buildSandbox ─────────────────────────────────
// The sandbox combinators only need the engine for orbit registration (d1,
// c1, hush, etc.) which the spec snippets don't invoke — they call .getEvents()
// directly on the returned Pattern.  A no-op engine is sufficient.
const stubEngine = {
  setOrbit() {},
  clearOrbit() {},
  setControlOrbit() {},
  clearControlOrbit() {},
  hush() {},
};

const sandbox = buildSandbox(stubEngine);

// The spec uses direct (non-curried) form for a few functions that the real
// sandbox exposes in curried Tidal-style form.  Override with direct exports
// so the round-trip snippets evaluate as written in the spec.
sandbox.range2  = range2;   // spec: range2(lo, hi, src) — not curried
sandbox.segment = segment;  // spec: segment(n, sig) — not curried

// ── Read and extract snippets from the spec ──────────────────────────────

const SPEC_PATH = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../specs/strudel-derived-specs.md",
);
const specText = fs.readFileSync(SPEC_PATH, "utf8");

// Match lines of the form:  **Input:** `<code>`
const INPUT_RE = /^\*\*Input:\*\* `([^`]+)`/gm;

const snippets = [];
let m;
while ((m = INPUT_RE.exec(specText)) !== null) {
  snippets.push(m[1].trim());
}

// ── Classify each snippet ─────────────────────────────────────────────────

// Snippets that are prose descriptions or contain bare "cycleN" variable
// references that aren't a single evaluable JS expression.  We skip these.
// Also skip literal mini-notation snippets not wrapped in a function call.
const SKIP_RE = /\bfor\b.*cycleN|evaluated over|\bcycleN\b\s*=|^\[/;

// evaluatePattern("…") snippets: extract the inner string and call directly.
const EVAL_PAT_RE = /^evaluatePattern\("([^"]+)"\)$/;

// ── Sandbox evaluator ─────────────────────────────────────────────────────

function evalSnippet(snippet) {
  const argNames = Object.keys(sandbox);
  const argValues = argNames.map((k) => sandbox[k]);
  // Expose evaluatePattern and cycleN (defaulting to 0) in the sandbox.
  // `cycleN` is referenced in spec alternation snippets like
  // `evaluatePattern("<a b c>", cycleN)` where it's a placeholder for any cycle.
  const allNames  = [...argNames, "evaluatePattern", "cycleN"];
  const allValues = [...argValues, evaluatePattern, 0];
  // eslint-disable-next-line no-new-func
  const fn = new Function(...allNames, `return (${snippet})`);
  return fn(...allValues);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("strudel-spec round-trip: every **Input:** snippet evaluates without error", () => {
  for (const snippet of snippets) {
    if (SKIP_RE.test(snippet)) {
      it.skip(`[skipped — not a single expression] ${snippet.slice(0, 80)}`);
      continue;
    }

    const evalPatMatch = EVAL_PAT_RE.exec(snippet);

    if (evalPatMatch) {
      // Direct evaluatePattern call — exercise the parser directly.
      const miniSrc = evalPatMatch[1];
      it(`evaluatePattern("${miniSrc}") does not throw`, () => {
        evaluatePattern(miniSrc);
      });
    } else {
      // Pattern-API or other JS expression — run through the real sandbox.
      it(`${snippet.slice(0, 80)} does not throw`, () => {
        evalSnippet(snippet);
      });
    }
  }
});
