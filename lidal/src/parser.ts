import { parseChordToken } from "./music.js";

// Mini-notation supporting:
//   "c4 e4 g4"      sequence — N items split a cycle into N equal slots
//   "[c4 e4] g4"    subdivision — children share their parent's slot
//   "[bd, cp] hh"   parallel-in-slot — bd and cp fire simultaneously in the slot
//   "<a b c>"       alternation — picks children[cycleN % len] each cycle
//   "c4*4"          repeat 4× within the slot
//   "~"             rest (silence)
//   "bd _ _ sd"     elongate — `_` extends the previous element by one slot (bd@3, sd@1)
//   "0 .. 7"        numeric range expansion — equivalent to "0 1 2 3 4 5 6 7"
//   "bd(3,8)"       Euclidean — 3 hits distributed across 8 slots
//   "bd(3,8,2)"     Euclidean with rotation — Tidal's `euclidOff` (rotL by r/n cycles).
//                   Equivalent to left-rotating the slot array by r slots: for
//                   bd(3,8) = [T,F,F,T,F,F,T,F] (hits 0,3,6), bd(3,8,2) yields
//                   [F,T,F,F,T,F,T,F] (hits 1,4,6).
//   "bd?"           degrade — element drops in 50% of cycles (deterministic per cycleN)
//   "bd?0.3"        degrade with explicit probability
//   "bd@2 sd"       weighted slot — bd takes 2/3 of cycle, sd takes 1/3
//   "bd ! sd"       replicate previous — equivalent to "bd bd sd"
//   "bd !*3 sd"     replicate previous N more times — "bd bd bd bd sd"
//   "{a b, c d}"    polyrhythm — each lane plays one cycle independently
//   "{a b c}%4"     polymeter — force lane(s) to N slots regardless of element count
//   "a b | c d"     random pick (chooseTail) — picks one sequence per cycle, seeded
//   "c'maj"         chord shorthand — fires chord intervals concurrently in the slot
//   "f#3'min7"      chord with explicit octave

export type Pattern =
  | { type: "note"; name: string; repeat: number; weight?: number; degrade?: number }
  | { type: "rest"; repeat: number; weight?: number; degrade?: number }
  | { type: "group"; children: Pattern[]; repeat: number; weight?: number; degrade?: number }
  | { type: "alternate"; children: Pattern[]; repeat: number; weight?: number; degrade?: number }
  | { type: "polyrhythm"; lanes: Pattern[]; repeat: number; weight?: number; degrade?: number; meter?: number }
  | { type: "cycleChoose"; lanes: Pattern[]; repeat: number; weight?: number; degrade?: number; seed: number };

export type Event = { start: number; duration: number; name: string };

const DELIMS = " \t\n[]<>{},|";
// Suffix-operator characters. When they appear immediately after the start of
// an atom word, they DON'T belong to the atom — they start a new "suffix"
// token (e.g. `*4`, `?0.5`, `@2`, `!*3`). Without this split, `bd!*2`
// tokenizes as one word `bd!*2` and `parseAtom` produces a literal note
// named `bd!`. Chord/sample separators (`'` and `:`) are NOT in this list,
// so `c'maj!*2` still works.
const SUFFIX_OPS = "*?@!";

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if ("[]<>{},|".includes(c)) { out.push(c); i++; continue; }
    // Suffix tokens (`*N`, `?N`, `@N`, `!*N`, bare `!`): read the leading
    // suffix-op char, then any further suffix-op chars and digits/dots/minus
    // that form the numeric tail. This lets `[a b]*2` and `bd!*3` both
    // tokenize suffixes uniformly: one suffix word per cluster of suffix
    // chars + numeric tail. We include `-` so that `@-2` is captured as a
    // single suffix token — parseSuffix then hard-errors on negatives.
    if (SUFFIX_OPS.includes(c)) {
      let word = c;
      i++;
      while (i < s.length) {
        const ch = s[i];
        if (SUFFIX_OPS.includes(ch) || ch === "." || ch === "-" || (ch >= "0" && ch <= "9")) {
          word += ch;
          i++;
        } else break;
      }
      out.push(word);
      continue;
    }
    // Regular word: read until a top-level delim OR a suffix-op char.
    // Parentheses (used by Euclidean `(n,k[,r])`) are treated as opaque —
    // delims and suffix-op chars inside are absorbed so the whole atom stays
    // one token (`bd(3,8)` doesn't split on the `,`).
    let word = "";
    let parenDepth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (parenDepth === 0 && (DELIMS.includes(ch) || SUFFIX_OPS.includes(ch))) break;
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      word += ch;
      i++;
    }
    out.push(word);
  }
  return out;
}

// Canonical Bjorklund Euclidean distribution — transliterated from TidalCycles'
// `Sound.Tidal.Bjorklund` (GPL-3.0). Returns `slots` booleans with `hits` true,
// distributed as evenly as possible by Toussaint's "Euclidean Algorithm Generates
// Traditional Musical Rhythms" (2005). For (h,n) where gcd(h,n) is well-behaved
// the result matches `floor(i*h/n) !== floor((i-1)*h/n)`; for ratios like (5,8)
// or (3,5) the two diverge and Bjorklund is the canonical form used by Tidal/Strudel.
//
// Algorithm sketch (recursive list-merge):
//   start with `hits` copies of [True] (xs) and `slots-hits` copies of [False] (ys);
//   while min(|xs|, |ys|) > 1, fold the smaller pile into the larger pile element-wise
//   (longer goes first); flatten what remains.
export function bjorklund(hits: number, slots: number): boolean[] {
  if (slots <= 0) return [];
  if (hits <= 0) return new Array(slots).fill(false);
  if (hits >= slots) return new Array(slots).fill(true);
  let xs: boolean[][] = Array.from({ length: hits }, () => [true]);
  let ys: boolean[][] = Array.from({ length: slots - hits }, () => [false]);
  let i = hits;
  let j = slots - hits;
  while (Math.min(i, j) > 1) {
    if (i > j) {
      // `left`: split xs at j; new xs = zipWith (++) xs' ys; new ys = xs''.
      const xsHead = xs.slice(0, j);
      const xsTail = xs.slice(j);
      xs = xsHead.map((row, k) => row.concat(ys[k]));
      ys = xsTail;
      const newI = j;
      const newJ = i - j;
      i = newI;
      j = newJ;
    } else {
      // `right`: split ys at i; new xs = zipWith (++) xs ys'; new ys = ys''.
      const ysHead = ys.slice(0, i);
      const ysTail = ys.slice(i);
      xs = xs.map((row, k) => row.concat(ysHead[k]));
      ys = ysTail;
      j = j - i;
    }
  }
  const out: boolean[] = [];
  for (const row of xs) for (const v of row) out.push(v);
  for (const row of ys) for (const v of row) out.push(v);
  return out;
}

// Parse a string of postfix suffixes (`*N`, `@N[.M]`, `?[<prob>]`) into AST flags.
// Suffixes can appear in any order. Unknown/garbage suffix chars are silently skipped.
//
// `*0` produces silence (zero events) — handled by the flattener via the
// repeat-loop bound. `@0` would produce a zero-width slot which is ambiguous;
// we floor it at 0.0001 to keep the layout meaningful.
//
// Leading-minus on the numeric tail (e.g. `@-2`, `?-0.5`) is hard-errored —
// none of these operators have a meaningful negative value, and the previous
// regex `/([*@?])(\d*\.?\d*)/g` silently consumed only the operator and
// dropped the `-N`, producing surprising defaults.
function parseSuffix(suffix: string): { repeat: number; weight: number; degrade: number | undefined } {
  let repeat = 1;
  let weight = 1;
  let degrade: number | undefined;
  // Match the operator plus an OPTIONAL leading-minus plus the numeric tail
  // so we can detect & reject negatives explicitly instead of leaking them
  // back as un-parsed garbage.
  const re = /([*@?])(-?)(\d*\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(suffix)) !== null) {
    const sym = m[1];
    const sign = m[2];
    const num = m[3];
    if (sign === "-" && num.length > 0) {
      throw new Error(`suffix '${sym}-${num}' cannot be negative`);
    }
    if (sym === "*") {
      // Allow 0 explicitly (= silence). Empty/non-numeric → default 1.
      if (num === "" || num === undefined) repeat = 1;
      else {
        const parsed = parseInt(num, 10);
        repeat = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
      }
    }
    else if (sym === "@") weight = num ? Math.max(0.0001, parseFloat(num) || 1) : 1;
    else if (sym === "?") degrade = num ? Math.max(0, Math.min(1, parseFloat(num))) : 0.5;
  }
  return { repeat, weight, degrade };
}

function clonePattern(p: Pattern): Pattern {
  if (p.type === "group" || p.type === "alternate") return { ...p, children: p.children.map(clonePattern) };
  if (p.type === "polyrhythm" || p.type === "cycleChoose") return { ...p, lanes: p.lanes.map(clonePattern) };
  return { ...p };
}

function parseAtom(tok: string): Pattern {
  // Chord shorthand: <note>['<chordName>] (e.g. "c'maj", "f#3'min7"). Expanded
  // to a polyrhythm whose lanes are the chord's notes (as numeric tokens — semitone
  // offsets from C4, which `n()` resolves correctly).
  //
  // Split off any postfix (`*N`, `?[prob]`, `@N`) before `parseChordToken` —
  // the chord recognizer expects only the bare `<pitch>'<quality>` form. Mirrors
  // the literal-note suffix split at the bottom of this function and the Euclidean
  // pre-extraction below.
  const chordMatch = tok.match(/^([^*?@]+)(.*)$/);
  if (chordMatch) {
    const chord = parseChordToken(chordMatch[1]);
    if (chord) {
      const { repeat, weight, degrade } = parseSuffix(chordMatch[2]);
      const lanes: Pattern[] = chord.intervals.map((iv) => ({
        type: "group",
        children: [{ type: "note", name: String(chord.root + iv - 60), repeat: 1 }],
        repeat: 1,
      }));
      return { type: "polyrhythm", lanes, repeat, weight, degrade };
    }
  }
  // Euclidean: name(hits,slots[,rotation]) optionally followed by suffix(es).
  // Name can include digits (e.g. "0(3,8)"); we just exclude `(`, `*`, `?`, `@`, `!`.
  const eucMatch = tok.match(/^([^(*?@!]+)\((\d+),(\d+)(?:,(-?\d+))?\)(.*)$/);
  if (eucMatch) {
    const name = eucMatch[1];
    const hits = parseInt(eucMatch[2], 10);
    const slots = parseInt(eucMatch[3], 10);
    const rotation = eucMatch[4] ? parseInt(eucMatch[4], 10) : 0;
    const { repeat, weight, degrade } = parseSuffix(eucMatch[5]);
    if (slots <= 0) return { type: "rest", repeat, weight, degrade };
    const hitArr = bjorklund(hits, slots);
    const children: Pattern[] = hitArr.map((h) => h
      ? ({ type: "note" as const, name, repeat: 1 })
      : ({ type: "rest" as const, repeat: 1 }));
    // Rotation matches TidalCycles' `_euclidOff n k s = rotL (s/k) (euclid n k)`.
    // `rotL` shifts the time axis LEFT, which is equivalent to taking the slot
    // array from index `rot` onward and appending the prefix. E.g. bd(3,8,2):
    // [T,F,F,T,F,F,T,F] → [F,F,T,F,F,T,F,T] sliced(2)+sliced(0,2) → hits at 1,4,6.
    const rot = ((rotation % slots) + slots) % slots;
    const rotated = rot === 0 ? children : children.slice(rot).concat(children.slice(0, rot));
    return { type: "group", children: rotated, repeat, weight, degrade };
  }
  // Split off any postfix (`*N`, `@N`, `?prob`) — `name` is everything before the first such marker.
  const m = tok.match(/^([^*?@]*)(.*)$/);
  const core = m![1];
  const { repeat, weight, degrade } = parseSuffix(m![2]);
  if (core === "~") return { type: "rest", repeat, weight, degrade };
  return { type: "note", name: core, repeat, weight, degrade };
}

export function parsePattern(input: string): Pattern {
  const tokens = tokenize(input);
  let i = 0;
  // Per-parse counter assigned to each `|` cycleChoose occurrence so independent
  // groups don't correlate (Tidal's chooseTail uses unique seeds per group too).
  let chooseSeed = 0;

  // Consume any trailing pure-suffix tokens (`*N`, `?prob`, `@N`) and apply them
  // to `node`. Pure-suffix means the token starts with one of those markers — so
  // it can't be confused with an atom. Used after `]`, `>`, `}` so users can
  // write `[bd cp]?0.5` or `<a b c>*2` and have the suffix attach to the group.
  function applyTrailingSuffix(node: Pattern): void {
    while (i < tokens.length && /^[*?@]/.test(tokens[i])) {
      const sx = parseSuffix(tokens[i]);
      if (sx.repeat !== 1) node.repeat = sx.repeat;
      if (sx.weight !== 1) node.weight = sx.weight;
      if (sx.degrade !== undefined) node.degrade = sx.degrade;
      i++;
    }
  }

  // Wrap `block` with chooseTail handling: when we encounter `|`, split the
  // sequence into multiple sub-sequences and emit a single `cycleChoose` node.
  // Tidal semantics: `a b | c d | e f` picks one of [a b], [c d], [e f] per cycle.
  // Returns the children to insert at the parent's position — either the original
  // sequence (no `|`) or a single-element array containing the cycleChoose.
  function readSequence(close: string | null, breakOn: string[] = []): Pattern[] {
    const breakOnPipe = breakOn.includes("|") ? breakOn : [...breakOn, "|"];
    const first = block(close, breakOnPipe);
    if (i >= tokens.length || tokens[i] !== "|") return first;
    // `|` was hit (without being consumed). Collect alternative sub-sequences.
    const lanes: Pattern[] = [{ type: "group", children: first, repeat: 1 }];
    while (i < tokens.length && tokens[i] === "|") {
      i++;  // consume the |
      const next = block(close, breakOnPipe);
      lanes.push({ type: "group", children: next, repeat: 1 });
    }
    const node: Pattern = { type: "cycleChoose", lanes, repeat: 1, seed: chooseSeed++ };
    return [node];
  }

  // Parse a sequence of children inside a balanced delimiter pair, OR until end of input.
  // `close` is the explicit closing delim (consumed when encountered). `breakOn` is a
  // list of tokens that end the block WITHOUT being consumed — used for lane parsing
  // inside `[...]` and `{...}` where `,` separates lanes.
  function block(close: string | null, breakOn: string[] = []): Pattern[] {
    const children: Pattern[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === close) { i++; break; }
      if (breakOn.includes(tok)) break;
      if (tok === "[") {
        i++;
        children.push(parseSquareBrackets());
      } else if (tok === "<") {
        i++;
        // `<>` reads ONE sequence (which can contain `|` chooseTail). Tidal's
        // angles are `pSequence sepBy ","` but our impl currently doesn't support
        // `,` inside `<>` — only `|`. Single sequence → wrap as alternate.
        const alt: Pattern = { type: "alternate", children: readSequence(">"), repeat: 1 };
        applyTrailingSuffix(alt);
        children.push(alt);
      } else if (tok === "{") {
        i++;
        children.push(parsePolyrhythm());
      } else if (tok === "!" || /^!\*\d+$/.test(tok)) {
        if (children.length === 0) throw new Error(`'!' replicate at start of block has no previous element`);
        const repCount = tok === "!" ? 1 : Math.max(1, parseInt(tok.slice(2), 10) || 1);
        const prev = children[children.length - 1];
        for (let k = 0; k < repCount; k++) children.push(clonePattern(prev));
        i++;
      } else if (/^[*?@]/.test(tok)) {
        // Pure-suffix token (`*N`, `?N`/`?N.M`, `@N[.M]`) — attach to the previous
        // sibling. Produced by the tokenizer when a suffix char follows an atom
        // with no whitespace (e.g. `bd*2`, `c'maj?0.3`). At the start of a
        // block we have no element to attach to, so this is an error.
        if (children.length === 0) {
          throw new Error(`suffix '${tok}' at start of block has no previous element`);
        }
        const sx = parseSuffix(tok);
        const prev = children[children.length - 1];
        if (sx.repeat !== 1) prev.repeat = sx.repeat;
        if (sx.weight !== 1) prev.weight = sx.weight;
        if (sx.degrade !== undefined) prev.degrade = sx.degrade;
        i++;
      } else if (tok === "_") {
        // Tidal-style elongate: extend the previous sibling's slot by N more.
        // `_` adds 1 (so `bd _` → bd takes 2 slots); `_*N` adds N.
        // The tokenizer always splits the `*N` off as its own suffix token
        // (suffix-op chars terminate the regular-word scan), so `_*3` arrives
        // as two tokens — `_` and `*3` — and we peek-merge here. A combined
        // `_*N` single token can't appear under the current tokenizer, so the
        // earlier regex branch for that shape was dead code.
        if (children.length === 0) throw new Error(`'_' elongate at start of block has no previous element`);
        let n = 1;
        const peekTok = tokens[i + 1];
        const starMatch = peekTok?.match(/^\*(\d+)$/);
        if (starMatch) {
          n = Math.max(1, parseInt(starMatch[1], 10) || 1);
          i++;
        }
        const prev = children[children.length - 1];
        prev.weight = (prev.weight ?? 1) + n;
        i++;
      } else if (tok === "..") {
        // Numeric range expansion: `0 .. 7` → 0,1,2,...,7. Previous sibling must be
        // an integer note; next token must be an integer. Inclusive on both ends.
        if (children.length === 0) throw new Error(`'..' at start of block needs a previous integer`);
        const next = tokens[i + 1];
        if (next === undefined) throw new Error(`'..' at end of input needs an upper bound`);
        if (!/^-?\d+$/.test(next)) throw new Error(`'..' upper bound must be an integer (got '${next}')`);
        const prev = children[children.length - 1];
        if (prev.type !== "note" || !/^-?\d+$/.test(prev.name)) {
          throw new Error(`'..' previous element must be an integer note`);
        }
        const lo = parseInt(prev.name, 10);
        const hi = parseInt(next, 10);
        // Cap range expansion so a typo (`0 .. 1000`) can't DoS the scheduler.
        // The full expansion would allocate one event per slot per cycle — at
        // 1000 slots and 30 cycles/sec that's 30k events/sec just from a typo.
        // 64 covers musically realistic uses (two octaves of MIDI numbers) with
        // headroom; users who want longer can write the sequence explicitly.
        const RANGE_LIMIT = 64;
        const span = Math.abs(hi - lo) + 1;
        if (span > RANGE_LIMIT) {
          throw new Error(`'..' range too large (${span} > ${RANGE_LIMIT}); split into explicit sequences`);
        }
        const step = hi >= lo ? 1 : -1;
        for (let v = lo + step; step > 0 ? v <= hi : v >= hi; v += step) {
          children.push({ type: "note", name: String(v), repeat: 1 });
        }
        i += 2;
      } else if (tok === "]" || tok === ">" || tok === "}") {
        // Unmatched closing delim — without this guard `a b ]` parses as three
        // atoms (the last one literally named `]`) which is almost never what
        // the user meant. Hard-error so the typo surfaces immediately.
        throw new Error(`unmatched '${tok}' (no opening delimiter)`);
      } else if (tok === ",") {
        // A `,` here means we're inside a context that hasn't declared `,` as
        // a lane separator. Inside `[a, b]` and `{a, b}` the parsers add `,`
        // to `breakOn` so it's never reached. Inside `<a, b>` we DON'T (Tidal's
        // multi-lane alternation isn't implemented), so without this guard
        // `<a, b>` would silently produce a phantom slot literally named `,`.
        throw new Error(`',' here separates parallel lanes — use [a, b] or {a, b}; alternation <> does not support multi-lane`);
      } else {
        i++;
        children.push(parseAtom(tok));
      }
    }
    return children;
  }

  // `[a b c]` is a group; `[a, b]` (with commas) becomes parallel lanes within the
  // slot — implemented as a polyrhythm so all lanes share the slot's time.
  function parseSquareBrackets(): Pattern {
    const lanes: Pattern[][] = [];
    while (i < tokens.length) {
      const lane = readSequence(null, [",", "]"]);
      lanes.push(lane);
      const t = tokens[i];
      if (t === ",") { i++; continue; }
      if (t === "]") { i++; break; }
      break;  // EOF inside `[`
    }
    const node: Pattern = lanes.length === 1
      ? { type: "group", children: lanes[0], repeat: 1 }
      : { type: "polyrhythm", lanes: lanes.map((c) => ({ type: "group" as const, children: c, repeat: 1 })), repeat: 1 };
    applyTrailingSuffix(node);
    return node;
  }

  function parsePolyrhythm(): Pattern {
    const lanes: Pattern[] = [];
    while (i < tokens.length) {
      const lane = readSequence(null, [",", "}"]);
      lanes.push({ type: "group", children: lane, repeat: 1 });
      const t = tokens[i];
      if (t === ",") { i++; continue; }
      if (t === "}") { i++; break; }
      // EOF inside `{`
      break;
    }
    // Optional `%N` polymeter after the closing `}`
    let meter: number | undefined;
    if (i < tokens.length && /^%\d+$/.test(tokens[i])) {
      meter = parseInt(tokens[i].slice(1), 10);
      i++;
    }
    const node: Pattern = { type: "polyrhythm", lanes, repeat: 1, meter };
    applyTrailingSuffix(node);
    return node;
  }

  return { type: "group", children: readSequence(null), repeat: 1 };
}

// Tiny PRNG used for `?`-degrade. Same algorithm as patterns.ts:mulberry32 but kept
// local so the parser has no dependency on patterns.ts (would be circular).
function mulberry32Once(seed: number): number {
  let s = seed >>> 0;
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function flatten(node: Pattern, start: number, length: number, cycleN: number, acc: Event[]): void {
  // Per-element degrade: use cycleN + slot start as seed. Different start positions
  // get different random rolls, so siblings degrade independently.
  if (node.degrade !== undefined) {
    const seed = (cycleN * 7919 + Math.floor(start * 1e6)) >>> 0;
    if (mulberry32Once(seed) < node.degrade) return;
  }
  if (node.type === "rest") return;
  if (node.type === "note") {
    const slot = length / node.repeat;
    for (let r = 0; r < node.repeat; r++) {
      acc.push({ start: start + r * slot, duration: slot, name: node.name });
    }
    return;
  }
  if (node.type === "alternate") {
    if (node.children.length === 0) return;
    // `repeat=0` (from a `*0` suffix) means silence — emit nothing. Mirrors
    // the `note` branch which already loops `0..node.repeat`. Without this
    // a stray `<a b>*0` would silently fall back to one cycle's worth.
    if (node.repeat <= 0) return;
    const repeat = node.repeat;
    const repeatLen = length / repeat;
    // Alternation advances per-occurrence within a cycle. `<a b c>*2` plays a,b in
    // cycle 0; c,a in cycle 1; b,c in cycle 2 — combining cycleN with the repeat index.
    for (let r = 0; r < repeat; r++) {
      const pick = node.children[(cycleN * repeat + r) % node.children.length];
      flatten(pick, start + r * repeatLen, repeatLen, cycleN, acc);
    }
    return;
  }
  if (node.type === "cycleChoose") {
    if (node.lanes.length === 0) return;
    if (node.repeat <= 0) return;
    const repeat = node.repeat;
    const repeatLen = length / repeat;
    for (let r = 0; r < repeat; r++) {
      const segStart = start + r * repeatLen;
      // Per-cycle uniform pick. Seed namespace 4271 distinct from other random sources.
      const idx = Math.floor(mulberry32Once(((cycleN * 4271) + node.seed) >>> 0) * node.lanes.length);
      const lane = node.lanes[Math.min(idx, node.lanes.length - 1)];
      flatten(lane, segStart, repeatLen, cycleN, acc);
    }
    return;
  }
  if (node.type === "polyrhythm") {
    if (node.lanes.length === 0) return;
    if (node.repeat <= 0) return;
    const repeat = node.repeat;
    const repeatLen = length / repeat;
    for (let r = 0; r < repeat; r++) {
      const segStart = start + r * repeatLen;
      for (const lane of node.lanes) {
        // Polymeter: rebuild the lane to have exactly `meter` children (cycling source).
        if (node.meter !== undefined && lane.type === "group" && lane.children.length > 0) {
          const meteredChildren: Pattern[] = [];
          for (let k = 0; k < node.meter; k++) {
            meteredChildren.push(clonePattern(lane.children[k % lane.children.length]));
          }
          flatten({ ...lane, children: meteredChildren }, segStart, repeatLen, cycleN, acc);
        } else {
          flatten(lane, segStart, repeatLen, cycleN, acc);
        }
      }
    }
    return;
  }
  // group — children share the segment, weighted by `weight` (default 1 each).
  // `repeat=0` (from `[a b]*0`) means silence; mirrors the `note` branch where
  // `bd*0` already emits nothing. Without this the `Math.max(1, …)` floor
  // silently promoted zero copies to one.
  if (node.repeat <= 0) return;
  const repeat = node.repeat;
  const repeatLen = length / repeat;
  for (let r = 0; r < repeat; r++) {
    const segStart = start + r * repeatLen;
    if (node.children.length === 0) continue;
    let totalWeight = 0;
    for (const c of node.children) totalWeight += (c.weight ?? 1);
    if (totalWeight <= 0) totalWeight = 1;
    let cursor = segStart;
    for (const child of node.children) {
      const w = (child.weight ?? 1) / totalWeight;
      const childLen = repeatLen * w;
      flatten(child, cursor, childLen, cycleN, acc);
      cursor += childLen;
    }
  }
}

// Cache parsed mini-notation ASTs by source string. parsePattern is cheap but
// non-trivial — at high BPM with many orbits we re-parse the same string ~30+
// times per second. Cap the cache size to avoid unbounded growth from a buffer
// that programmatically generates pattern strings.
const PARSE_CACHE_LIMIT = 256;
const parseCache = new Map<string, Pattern>();

function getCachedAst(input: string): Pattern {
  const cached = parseCache.get(input);
  if (cached) return cached;
  const tree = parsePattern(input);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    // FIFO eviction — delete oldest insertion-order entry.
    const firstKey = parseCache.keys().next().value;
    if (firstKey !== undefined) parseCache.delete(firstKey);
  }
  parseCache.set(input, tree);
  return tree;
}

export function evaluatePattern(input: string, cycleN: number = 0): Event[] {
  const tree = getCachedAst(input);
  const events: Event[] = [];
  flatten(tree, 0, 1, cycleN, events);
  return events;
}
