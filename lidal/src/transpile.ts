// TidalCycles → JS transpiler.
//
// Subset supported:
//   d1 $ s "bd sd"                          → d1(s("bd sd"))
//   d1 $ every 4 (fast 2) $ s "bd"          → d1(every(4)(fast(2))(s("bd")))
//   d1 $ s "bd" # gain 0.8                  → d1(s("bd").gain(0.8))
//   d1 $ s "bd" # gain 0.8 # speed 1.5      → d1(s("bd").gain(0.8).speed(1.5))
//   d1 $ s "bd" # every 4 (fast 2)          → d1(s("bd").every(4, fast(2)))   -- multi-arg method
//   hush                                    → hush()
//   d1 silence                              → d1(silence)
//   gain (sine + 0.5)                       → gain(__add(sine, 0.5))
//   add (n "0 7" * 2)                       → add(__mul(n("0 7"), 2))
//
// Operators (low → high precedence):
//   $        right-assoc, lowest
//   + -      left-assoc (addsub)
//   * /      left-assoc (muldiv)
//   #        left-assoc (method-chain; sits between hash math and juxtaposition)
//   unary -  prefix
//   juxtaposition (function application), highest
// Comments: `-- line` and `{- block -}`. Newlines end statements unless inside parens or
//           adjacent to `$` / `#`.

type Token =
  | { type: "ident"; value: string }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "lparen" } | { type: "rparen" }
  | { type: "dollar" } | { type: "hash" }
  | { type: "plus" } | { type: "minus" } | { type: "star" } | { type: "slash" }
  | { type: "semi" } | { type: "newline" }
  | { type: "eof" };

function tokenize(src: string): Token[] {
  // Strip comments while respecting string boundaries — running the comment
  // regexes over the whole source first would eat `--`/`{- -}` inside string
  // literals (e.g. `s "bd--cp"` or sample names containing those markers).
  // We walk the source once, copying string contents verbatim and dropping
  // comment spans only in code regions.
  let s = "";
  {
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        // Copy the string literal (including quotes) verbatim. If the closing
        // quote is missing, fall through and let the main lexer raise the
        // "unterminated string literal" error.
        let j = i + 1;
        while (j < n && src[j] !== '"') j++;
        if (j >= n) { s += src.slice(i); break; }
        s += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === "-" && src[i + 1] === "-") {
        // Line comment — skip to end of line (but keep the newline so token
        // statement separators still work).
        let j = i + 2;
        while (j < n && src[j] !== "\n") j++;
        i = j;
        continue;
      }
      if (c === "{" && src[i + 1] === "-") {
        // Block comment — skip to matching `-}`. Unterminated block comment
        // is silently accepted (matches the prior regex-based behaviour).
        let j = i + 2;
        while (j < n && !(src[j] === "-" && src[j + 1] === "}")) j++;
        i = j < n ? j + 2 : n;
        continue;
      }
      s += c;
      i++;
    }
  }

  const tokens: Token[] = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") { tokens.push({ type: "newline" }); i++; continue; }
    if (c === ";") { tokens.push({ type: "semi" }); i++; continue; }
    if (c === "(") { tokens.push({ type: "lparen" }); i++; continue; }
    if (c === ")") { tokens.push({ type: "rparen" }); i++; continue; }
    if (c === "$") { tokens.push({ type: "dollar" }); i++; continue; }
    if (c === "#") { tokens.push({ type: "hash" }); i++; continue; }

    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j++;
      if (j >= n) throw new Error("unterminated string literal");
      tokens.push({ type: "string", value: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    // Negative number literal — only when leading (start of expression / after operator / paren-open).
    // This preserves `(-3)` and `$ -5` as literals; in non-leading positions a `-`
    // becomes a binary/unary operator token handled by the parser.
    if (c === "-" && i + 1 < n && /[0-9]/.test(s[i + 1])) {
      const prev = tokens[tokens.length - 1];
      const isLeading = !prev ||
        prev.type === "lparen" || prev.type === "dollar" || prev.type === "hash" ||
        prev.type === "plus"   || prev.type === "minus"  || prev.type === "star" || prev.type === "slash" ||
        prev.type === "semi"   || prev.type === "newline";
      if (isLeading) {
        let j = i + 1;
        while (j < n && /[0-9.]/.test(s[j])) j++;
        tokens.push({ type: "number", value: parseFloat(s.slice(i, j)) });
        i = j;
        continue;
      }
    }

    if (c === "+") { tokens.push({ type: "plus" });  i++; continue; }
    if (c === "-") { tokens.push({ type: "minus" }); i++; continue; }
    if (c === "*") { tokens.push({ type: "star" });  i++; continue; }
    if (c === "/") { tokens.push({ type: "slash" }); i++; continue; }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(s[j])) j++;
      tokens.push({ type: "number", value: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      // Reject Haskell prime since it's not valid in JS identifiers.
      if (s[j] === "'") throw new Error(`Haskell prime ('') not supported in identifier '${word}\\''`);
      tokens.push({ type: "ident", value: word });
      i = j;
      continue;
    }

    throw new Error(`unexpected character '${c}' at offset ${i}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}

type BinOp = "+" | "-" | "*" | "/";
type Expr =
  | { kind: "ident"; name: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "paren"; inner: Expr }
  | { kind: "curried"; fn: Expr; args: Expr[] }   // f a b c
  | { kind: "apply"; fn: Expr; arg: Expr }        // f $ x
  | { kind: "method"; target: Expr; name: string; args: Expr[] }  // x # method args
  | { kind: "binop"; op: BinOp; left: Expr; right: Expr }
  | { kind: "unaryneg"; operand: Expr };

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(toks: Token[]) { this.toks = toks; }

  private peek(off = 0): Token { return this.toks[this.pos + off]; }
  private advance(): Token { return this.toks[this.pos++]; }
  private match(type: Token["type"]): boolean {
    if (this.peek().type === type) { this.advance(); return true; }
    return false;
  }
  private expect(type: Token["type"]): Token {
    if (this.peek().type !== type) throw new Error(`expected ${type}, got ${this.peek().type}`);
    return this.advance();
  }

  // Skip newlines, but only when they're a continuation of an expression
  // (prev token was operator / paren open, OR next non-newline is $ or #).
  private skipContinuationNewlines(): void {
    while (this.peek().type === "newline") {
      let j = this.pos + 1;
      while (this.toks[j]?.type === "newline") j++;
      const next = this.toks[j];
      if (next && (next.type === "dollar" || next.type === "hash" || next.type === "rparen")) {
        this.advance();
      } else break;
    }
  }

  private skipStatementSeparators(): void {
    while (this.peek().type === "newline" || this.peek().type === "semi") this.advance();
  }

  parse(): Expr[] {
    const stmts: Expr[] = [];
    this.skipStatementSeparators();
    while (this.peek().type !== "eof") {
      stmts.push(this.expr());
      this.skipStatementSeparators();
    }
    return stmts;
  }

  // expr := dollar
  private expr(): Expr { return this.dollar(); }

  // dollar := addsub ('$' dollar)?     -- right-assoc, lowest
  private dollar(): Expr {
    const left = this.addsub();
    // peek past newlines that are followed by $
    let saved = this.pos;
    while (this.peek().type === "newline") this.advance();
    if (this.match("dollar")) {
      while (this.peek().type === "newline") this.advance();
      const right = this.dollar();
      return { kind: "apply", fn: left, arg: right };
    }
    this.pos = saved;
    return left;
  }

  // addsub := muldiv (('+' | '-') muldiv)*     -- left-assoc
  private addsub(): Expr {
    let left = this.muldiv();
    while (true) {
      const t = this.peek().type;
      if (t !== "plus" && t !== "minus") break;
      this.advance();
      const right = this.muldiv();
      left = { kind: "binop", op: t === "plus" ? "+" : "-", left, right };
    }
    return left;
  }

  // muldiv := hash (('*' | '/') hash)*         -- left-assoc, higher than addsub
  private muldiv(): Expr {
    let left = this.hash();
    while (true) {
      const t = this.peek().type;
      if (t !== "star" && t !== "slash") break;
      this.advance();
      const right = this.hash();
      left = { kind: "binop", op: t === "star" ? "*" : "/", left, right };
    }
    return left;
  }

  // hash := unary ('#' unary)*             -- left-assoc
  //
  // Note on precedence: in Tidal, `#` is roughly equivalent to `|>` (left-assoc,
  // mid-precedence) and is used to chain control patterns. Here we model it as
  // a method call on the left-hand pattern. We deliberately place `#` ABOVE
  // `*/` and `+-` in precedence so that `s "bd" # gain (sine + 0.5)` parses
  // cleanly (the `+ 0.5` doesn't grab the gain). This inverts Tidal's own
  // precedence — be careful when comparing parses against upstream Tidal.
  private hash(): Expr {
    let left = this.unary();
    while (true) {
      const saved = this.pos;
      while (this.peek().type === "newline") this.advance();
      if (!this.match("hash")) { this.pos = saved; break; }
      while (this.peek().type === "newline") this.advance();
      const right = this.unary();
      // Unwrap a single layer of parens — `# (gain 0.8)` should behave like `# gain 0.8`.
      const unwrapped = right.kind === "paren" ? right.inner : right;
      let methodName: string;
      let methodArgs: Expr[] = [];
      if (unwrapped.kind === "ident") {
        methodName = unwrapped.name;
      } else if (unwrapped.kind === "curried" && unwrapped.fn.kind === "ident") {
        methodName = unwrapped.fn.name;
        methodArgs = unwrapped.args;
      } else {
        throw new Error("right of # must be a method (e.g. `gain 0.8`)");
      }
      // After the method name + args, pick up any trailing `-<number>` tokens
      // as additional args. The lexer doesn't fold these into a single number
      // literal because the previous token is an ident (not a leading-context
      // token), so without this we'd parse `# shift -3` as `(... # shift) - 3`,
      // silently calling shift() with no args and then NaN-subtracting 3.
      //
      // The `-<number>` may live on a continuation line (e.g.
      //   d1 $ s "bd"
      //     # shift
      //     -3
      // ). Peek past any intervening newlines first; only commit to consuming
      // them if a `-<number>` actually follows — otherwise an innocent
      // multi-line statement like `n "0"\n-3 + 1` would have its newline
      // silently swallowed here.
      //
      // Note: after a newline the lexer already folds `-3` into a single
      // negative-number token (newline is leading context), so we accept
      // EITHER `minus` + `number` OR a single negative `number` token after
      // the newline-skip — but the negative-number path is only valid as a
      // method arg if we actually crossed a newline (otherwise `# shift\n-3`
      // is the only ambiguity the user could intend; `# shift -3` on one line
      // arrives as `minus`+`number` because `shift` isn't leading context).
      while (true) {
        let look = this.pos;
        let crossedNewline = false;
        while (this.toks[look]?.type === "newline") { look++; crossedNewline = true; }
        const t = this.toks[look];
        if (t?.type === "minus" && this.toks[look + 1]?.type === "number") {
          this.pos = look + 2;
          const numTok = this.toks[look + 1] as { type: "number"; value: number };
          methodArgs.push({ kind: "number", value: -numTok.value });
          continue;
        }
        if (crossedNewline && t?.type === "number" && (t.value as number) < 0) {
          this.pos = look + 1;
          methodArgs.push({ kind: "number", value: t.value });
          continue;
        }
        break;
      }
      left = { kind: "method", target: left, name: methodName, args: methodArgs };
    }
    return left;
  }

  // unary := '-' unary | app           -- prefix negation
  // Note: the lexer already consumes `-<digits>` as a number literal when the
  // previous token is a leading-context one, so this only fires for cases
  // like `-sine`, `-(1+2)`, or `2 * -1` (after `*`, which is leading-context).
  private unary(): Expr {
    if (this.peek().type === "minus") {
      this.advance();
      return { kind: "unaryneg", operand: this.unary() };
    }
    return this.app();
  }

  // app := atom (atom)*       -- juxtaposition (curried application)
  private app(): Expr {
    const head = this.atom();
    const args: Expr[] = [];
    while (this.canStartAtom()) args.push(this.atom());
    if (args.length === 0) return head;
    return { kind: "curried", fn: head, args };
  }

  private canStartAtom(): boolean {
    const t = this.peek();
    return t.type === "ident" || t.type === "number" || t.type === "string" || t.type === "lparen";
  }

  private atom(): Expr {
    const t = this.peek();
    if (t.type === "ident")  { this.advance(); return { kind: "ident", name: t.value }; }
    if (t.type === "number") { this.advance(); return { kind: "number", value: t.value }; }
    if (t.type === "string") { this.advance(); return { kind: "string", value: t.value }; }
    if (t.type === "lparen") {
      this.advance();
      while (this.peek().type === "newline") this.advance();
      const inner = this.expr();
      while (this.peek().type === "newline") this.advance();
      this.expect("rparen");
      return { kind: "paren", inner };
    }
    throw new Error(`unexpected token '${t.type}' at expression start`);
  }
}

// ── Codegen ──────────────────────────────────────────────────────────────
// Top-level rule: a bare identifier statement (e.g. `hush`) is called with no args.
function genStatement(e: Expr): string {
  if (e.kind === "ident") return `${e.name}()`;
  return gen(e);
}

const BINOP_FN: Record<BinOp, string> = { "+": "__add", "-": "__sub", "*": "__mul", "/": "__div" };

function gen(e: Expr): string {
  switch (e.kind) {
    case "ident":  return e.name;
    case "number": return String(e.value);
    case "string": return JSON.stringify(e.value);
    case "paren":  return `(${gen(e.inner)})`;
    case "curried": {
      let s = gen(e.fn);
      for (const a of e.args) s = `${s}(${gen(a)})`;
      return s;
    }
    case "apply":  return `(${gen(e.fn)})(${gen(e.arg)})`;
    case "method": {
      const args = e.args.map(gen).join(", ");
      return `(${gen(e.target)}).${e.name}(${args})`;
    }
    case "binop":   return `${BINOP_FN[e.op]}(${gen(e.left)}, ${gen(e.right)})`;
    case "unaryneg": return `__neg(${gen(e.operand)})`;
  }
}

export function transpile(tidalSrc: string): string {
  const toks = tokenize(tidalSrc);
  const stmts = new Parser(toks).parse();
  return stmts.map(genStatement).join(";\n");
}
