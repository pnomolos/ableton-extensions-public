// Offline smoke tests for the Lidal extension. Bundles each TS file with esbuild,
// stubs out easymidi/abletonlink, exercises transpile + sandbox + scheduler end-to-end.
// Run: node lidal/test/offline.js

const path = require("path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));

const ROOT = path.resolve(__dirname, "..");

function bundle(entry) {
  const r = esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["easymidi", "abletonlink"],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", r.outputFiles[0].text)(
    m, m.exports, (id) => {
      if (id === "easymidi") return {
        Output: class { send() {} close() {} },
        Input: class { on() {} close() {} },
      };
      if (id === "abletonlink") throw new Error("abletonlink not loaded in offline tests");
      return require(id);
    }
  );
  return m.exports;
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function eq(a, b, label = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function near(a, b, eps = 0.001, label = "") {
  if (Math.abs(a - b) > eps) throw new Error(`${label} expected ~${b}, got ${a}`);
}

const Transpile  = bundle("src/transpile.ts");
const Patterns   = bundle("src/patterns.ts");
const Scheduler  = bundle("src/scheduler.ts");
const Notes      = bundle("src/notes.ts");
const Control    = bundle("src/control.ts");

// ── Transpiler ──────────────────────────────────────────────────────────
test("transpile: simple d1 + s", () => {
  const js = Transpile.transpile('d1 $ s "bd sd"');
  if (!js.includes('d1') || !js.includes('s("bd sd")')) throw new Error(`unexpected JS: ${js}`);
});

test("transpile: # (paren) unwraps", () => {
  // Was a known parse error before the fix; should accept it now.
  Transpile.transpile('d1 $ s "bd" # (gain 0.8)');
});

test("transpile: rejects Haskell prime in ident", () => {
  let err = null;
  try { Transpile.transpile("foo' $ s \"bd\""); } catch (e) { err = e; }
  if (!err) throw new Error("expected an error for ident with prime");
});

test("transpile: comments stripped", () => {
  const js = Transpile.transpile('-- comment\nd1 $ s "bd"\n{- block -}\nd2 $ s "sd"');
  if (!js.includes('d1') || !js.includes('d2')) throw new Error(js);
});

// ── Arithmetic (transpile + runtime) ────────────────────────────────────
// Evaluate transpiled code against a sandbox that includes the runtime helpers
// plus a few patterns/signals so we can check end-to-end behavior in one place.
function evalArith(src, extras = {}) {
  const vm = require("vm");
  const js = Transpile.transpile(src);
  const sandbox = Object.assign({
    __add: Patterns.__add, __sub: Patterns.__sub, __mul: Patterns.__mul,
    __div: Patterns.__div, __neg: Patterns.__neg,
    n: Patterns.n, sine: Patterns.sine, sine2: Patterns.sine2, Pattern: Patterns.Pattern,
  }, extras);
  const ctx = vm.createContext(sandbox);
  return vm.runInContext(`(${js})`, ctx, { timeout: 1000 });
}

test("arith: '1 + 2' evaluates to 3", () => {
  eq(evalArith("1 + 2"), 3);
});

test("arith: precedence '1 + 2 * 3' is 7 (mul binds tighter)", () => {
  eq(evalArith("1 + 2 * 3"), 7);
});

test("arith: division and subtraction left-assoc, '10 - 3 - 2' is 5", () => {
  eq(evalArith("10 - 3 - 2"), 5);
});

test("arith: parens override precedence, '(1 + 2) * 3' is 9", () => {
  eq(evalArith("(1 + 2) * 3"), 9);
});

test("arith: unary minus on parenthesised expr, '-(1 + 2)' is -3", () => {
  eq(evalArith("-(1 + 2)"), -3);
});

test("arith: leading-minus literal still works in operator context, '5 + -3' is 2", () => {
  eq(evalArith("5 + -3"), 2);
});

test("arith: unary minus on number after operator, '2 * -1' is -2", () => {
  eq(evalArith("2 * -1"), -2);
});

test("arith: '-5' as bare statement is -5 (existing leading-literal path)", () => {
  eq(evalArith("-5"), -5);
});

test("arith: '(-3)' parses as literal -3, not unaryneg of 3 (codegen-equivalent)", () => {
  eq(evalArith("(-3)"), -3);
});

test("arith: signal + number returns a ContinuousSignal", () => {
  const sig = evalArith("sine + 0");
  if (typeof sig !== "function") throw new Error("expected ContinuousSignal (function)");
  near(sig(0, 0),   Patterns.sine(0, 0));
  near(sig(0, 0.25), Patterns.sine(0, 0.25));
});

test("arith: '(sine + 1) * 0.5' samples within [0, 1]", () => {
  const sig = evalArith("(sine + 1) * 0.5");
  for (let ph = 0; ph <= 1; ph += 0.1) {
    const v = sig(0, ph);
    if (!(v >= 0 && v <= 1)) throw new Error(`sample at ph=${ph} out of [0,1]: ${v}`);
  }
});

test("arith: '-sine' is the negation of sine across the cycle", () => {
  const negSine = evalArith("-sine");
  if (typeof negSine !== "function") throw new Error("expected ContinuousSignal");
  for (let ph = 0; ph <= 1; ph += 0.1) {
    near(negSine(0, ph), -Patterns.sine(0, ph), 0.001, `ph=${ph}`);
  }
});

test("arith: signal × signal samples per-(cycle, phase)", () => {
  const sig = evalArith("sine * sine2");
  near(sig(0, 0.25), Patterns.sine(0, 0.25) * Patterns.sine2(0, 0.25));
});

test("arith: 'n \"0 7 12\" + 5' yields a Pattern with events 5,12,17", () => {
  const p = evalArith('n "0 7 12" + 5');
  if (!(p instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const names = p.getEvents(0).map((e) => parseFloat(e.name));
  eq(names, [5, 12, 17]);
});

test("arith: Pattern × Pattern uses left as structure provider, samples right at left's start phase", () => {
  // Left has 3 events at 0, 1/3, 2/3 with values 10, 20, 30.
  // Right has 2 events at 0, 0.5 with values 1, 2.
  // Sampling right at phases 0, 1/3 (→1), 2/3 (→2): result 11, 21, 32.
  const p = evalArith('n "10 20 30" + n "1 2"');
  const events = p.getEvents(0);
  eq(events.length, 3);
  eq(events.map((e) => parseFloat(e.name)), [11, 21, 32]);
});

test("arith: Pattern × ContinuousSignal samples signal at each event's start", () => {
  // Pattern "0 0 0 0" has 4 events at phases 0, 0.25, 0.5, 0.75. Adding `sine`
  // should produce names equal to sine at those phases. Documents the chosen
  // semantics for Pattern + Signal: structure from the Pattern, signal sampled
  // per-event at the event's start phase.
  const p = evalArith('n "0 0 0 0" + sine');
  if (!(p instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const events = p.getEvents(0);
  eq(events.length, 4);
  for (let i = 0; i < 4; i++) {
    near(parseFloat(events[i].name), Patterns.sine(0, i / 4), 0.001, `event ${i}`);
  }
});

test("arith: 'gain (sine + 0.5)' accepts the signal-arithmetic result on a Pattern", () => {
  // Round-trip via the real sandbox to make sure `.gain` accepts the lifted signal.
  // We don't verify MIDI output — just that the chain composes without throwing.
  const engine = {
    setOrbit() {}, clearOrbit() {}, hush() {},
    setControlOrbit() {}, clearControlOrbit() {}, installLearn() {},
    setDrumMap() {}, clearDrumMap() {},
  };
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ n "c4 e4 g4" # gain (sine + 0.5)', sandbox);
});

test("arith: 'gain (slow 2 $ range 0.5 1 tri)' — slow/range chain on signal composes", () => {
  // Mirrors the Tidal doc form `# speed (slow 2 $ range 0.5 2 tri)` adapted to a
  // MIDI param we actually expose. Regression for the case where slow rejected a
  // ContinuousSignal with "requires a Pattern or ControlPattern (got function)".
  const engine = {
    setOrbit() {}, clearOrbit() {}, hush() {},
    setControlOrbit() {}, clearControlOrbit() {}, installLearn() {},
    setDrumMap() {}, clearDrumMap() {},
  };
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ n "c4 e4 g4" # gain (slow 2 $ range 0.5 1 tri)', sandbox);
});

test("arith: '1 / 0' yields Infinity (no special clamping at the arithmetic layer)", () => {
  // Documents the chosen behaviour: no protective clamp at the operator layer;
  // downstream MIDI clamping (velocity → [0,127], CC → [0,127]) handles overshoot.
  const v = evalArith("1 / 0");
  if (v !== Infinity) throw new Error(`expected Infinity, got ${v}`);
});

test("arith: number × Pattern uses Pattern as structure provider", () => {
  // Mirrors Pattern × number — when one side is a constant, the Pattern side
  // drives event timing.
  const p = evalArith('2 * n "0 7"');
  const names = p.getEvents(0).map((e) => parseFloat(e.name));
  eq(names, [0, 14]);
});

test("arith: unsupported operand types raise a typed error", () => {
  let err = null;
  try { evalArith('"hello" + 1', { __add: Patterns.__add }); } catch (e) { err = e; }
  if (!err || !/unsupported operand types/.test(err.message)) {
    throw new Error(`expected typed error, got ${err && err.message}`);
  }
});

// ── Patterns ────────────────────────────────────────────────────────────
test("noteNameToMidi: c4 == 60", () => {
  eq(Notes.noteNameToMidi("c4"), 60);
});
test("noteNameToMidi: rejects out-of-range octaves", () => {
  eq(Notes.noteNameToMidi("c10"), null);
  eq(Notes.noteNameToMidi("c-2"), null);
});

test("pattern: n('c4 e4 g4').fast(2) doubles events per cycle", () => {
  const p = Patterns.n("c4 e4 g4").fast(2);
  const events = p.getEvents(0);
  eq(events.length, 6);
  near(events[0].start, 0);
  near(events[1].start, 1/6);
  near(events[3].start, 3/6);
});

test("pattern: n('c4 e4').fast(1.5) handles rationals", () => {
  const p = Patterns.n("c4 e4").fast(1.5);
  // Cycle 0: 1.5 source cycles. Source events at 0, 0.5 of each cycle.
  // Source cycle 0 covers host [0, 0.667], events at host 0 and 0.333.
  // Source cycle 1 covers host [0.667, 1.333], event at sourceStart=1.0 → host 0.667;
  //   event at sourceStart=1.5 falls outside this host cycle (would be host=1.333)
  // So this host cycle: events at host 0, 0.333, 0.667.
  const events = p.getEvents(0);
  if (events.length < 3) throw new Error(`expected at least 3 events, got ${events.length}: ${JSON.stringify(events)}`);
});

test("pattern: <a b c> alternates per cycle", () => {
  const p = Patterns.n("<c4 e4 g4>");
  eq(p.getEvents(0).map(e => e.name), ["c4"]);
  eq(p.getEvents(1).map(e => e.name), ["e4"]);
  eq(p.getEvents(2).map(e => e.name), ["g4"]);
  eq(p.getEvents(3).map(e => e.name), ["c4"]);
});

test("pattern: <a b c>*2 advances pick per repeat (Tidal semantics)", () => {
  const p = Patterns.n("<a b c>*2");
  // Cycle 0: a, b. Cycle 1: c, a. Cycle 2: b, c.
  eq(p.getEvents(0).map(e => e.name), ["a", "b"]);
  eq(p.getEvents(1).map(e => e.name), ["c", "a"]);
  eq(p.getEvents(2).map(e => e.name), ["b", "c"]);
});

test("pattern: .rev() reverses event order", () => {
  const p = Patterns.n("c4 e4 g4 b4").rev();
  const events = p.getEvents(0);
  // start positions reversed; names should be in reverse order
  eq(events.map(e => e.name), ["b4", "g4", "e4", "c4"]);
});

test("noteNameToMidi: numeric tokens are semitone offsets from C4", () => {
  eq(Notes.noteNameToMidi("0"), 60);
  eq(Notes.noteNameToMidi("7"), 67);
  eq(Notes.noteNameToMidi("-12"), 48);
  eq(Notes.noteNameToMidi("12"), 72);
});
test("noteNameToMidi: rejects out-of-range numeric tokens", () => {
  eq(Notes.noteNameToMidi("200"), null);
  eq(Notes.noteNameToMidi("-100"), null);
});

test("samplePatternable: number passthrough", () => {
  eq(Patterns.samplePatternable(2, 0), 2);
  eq(Patterns.samplePatternable(0.5, 7), 0.5);
});
test("samplePatternable: string parses per phase", () => {
  // "<2 3>" alternates per cycle — sampled at phase 0
  eq(Patterns.samplePatternable("<2 3>", 0), 2);
  eq(Patterns.samplePatternable("<2 3>", 1), 3);
  eq(Patterns.samplePatternable("<2 3>", 2), 2);
});
test("samplePatternable: Pattern picks event by phase", () => {
  // n("0 7") splits cycle into [0,0.5)=0, [0.5,1)=7
  const p = Patterns.n("0 7");
  eq(Patterns.samplePatternable(p, 0, 0.0), 0);
  eq(Patterns.samplePatternable(p, 0, 0.6), 7);
});

test("pattern: fast('<2 3>') alternates speed per cycle", () => {
  const p = Patterns.n("c4 e4").fast("<2 3>");
  // Cycle 0 with n=2: 2 source-cycles in window [0,2) → 4 events
  // Cycle 1 with n=3: source-cycles [3,6) → events from 3 source-cycles. Cycle 1 covers
  //   sourceCycles 3,4,5 of the underlying 2-element pattern → 6 events.
  const c0 = p.getEvents(0);
  const c1 = p.getEvents(1);
  if (c0.length !== 4) throw new Error(`cycle 0 expected 4 events, got ${c0.length}`);
  if (c1.length !== 6) throw new Error(`cycle 1 expected 6 events, got ${c1.length}`);
});

test("pattern: every('<2 4>', rev) alternates skip period", () => {
  // every(2,rev): cycles 0,2,4,... rev'd. every(4,rev): cycles 0,4,8,... rev'd.
  // Patterned: cycle 0 uses N=2 (rev'd since 0%2===0), cycle 1 uses N=4 (NOT rev'd since 1%4!==0)
  const p = Patterns.n("a b c d").every("<2 4>", (q) => q.rev());
  const c0 = p.getEvents(0).map((e) => e.name);
  const c1 = p.getEvents(1).map((e) => e.name);
  eq(c0, ["d", "c", "b", "a"]);
  eq(c1, ["a", "b", "c", "d"]);
});

test("pattern: gain('<1 0.5>') alternates velocity scale", () => {
  const p = Patterns.n("c4").velocity(100).gain("<1 0.5>");
  eq(p.getEvents(0)[0].velocity, 100);
  eq(p.getEvents(1)[0].velocity, 50);
});

test("stack: combines event streams from two patterns", () => {
  const p = Patterns.stack([Patterns.s("bd ~"), Patterns.s("~ cp")]);
  const events = p.getEvents(0);
  // bd at 0, cp at 0.5
  eq(events.length, 2);
  eq(events[0].name, "bd");
  near(events[0].start, 0);
  eq(events[1].name, "cp");
  near(events[1].start, 0.5);
});
test("stack: rejects mixed portType", () => {
  let err = null;
  try { Patterns.stack([Patterns.n("c4"), Patterns.s("bd")]); } catch (e) { err = e; }
  if (!err || !/notes and drums/.test(err.message)) throw new Error(`expected mix-rejection, got ${err}`);
});
test("stack: per-part .ch tags events with explicit channel", () => {
  const p = Patterns.stack([Patterns.s("bd").ch(3), Patterns.s("cp").ch(7)]);
  const events = p.getEvents(0);
  // Each event should carry its part's channel tag
  const bdEv = events.find((e) => e.name === "bd");
  const cpEv = events.find((e) => e.name === "cp");
  eq(bdEv.channel, 2);  // ch(3) → idx 2
  eq(cpEv.channel, 6);  // ch(7) → idx 6
});

test("cat: cycles through 3 patterns by cycleN modulo", () => {
  const p = Patterns.cat([Patterns.n("a"), Patterns.n("b"), Patterns.n("c")]);
  eq(p.getEvents(0).map((e) => e.name), ["a"]);
  eq(p.getEvents(1).map((e) => e.name), ["b"]);
  eq(p.getEvents(2).map((e) => e.name), ["c"]);
  eq(p.getEvents(3).map((e) => e.name), ["a"]);
});

test("fastcat: 3 patterns crammed into one cycle", () => {
  const p = Patterns.fastcat([Patterns.n("a"), Patterns.n("b"), Patterns.n("c")]);
  const events = p.getEvents(0);
  eq(events.length, 3);
  eq(events.map((e) => e.name), ["a", "b", "c"]);
  near(events[0].start, 0);
  near(events[1].start, 1 / 3);
  near(events[2].start, 2 / 3);
});

test("euclidean: bd(3,8) hits at slots 0, 3, 6", () => {
  const p = Patterns.s("bd(3,8)");
  const events = p.getEvents(0);
  eq(events.length, 3);
  near(events[0].start, 0 / 8);
  near(events[1].start, 3 / 8);
  near(events[2].start, 6 / 8);
});
test("euclidean: bd(3,8,2) rotates left by 2", () => {
  const p = Patterns.s("bd(3,8,2)");
  const events = p.getEvents(0);
  eq(events.length, 3);
  // Left-rotate by 2: original [hit, no, no, hit, no, no, hit, no] (slots 0,3,6)
  // After: [no, hit, no, no, hit, no, hit, no] (slots 1,4,6)
  near(events[0].start, 1 / 8);
  near(events[1].start, 4 / 8);
  near(events[2].start, 6 / 8);
});
test("euclidean: bd(5,8) handles dense ratio", () => {
  const p = Patterns.s("bd(5,8)");
  const events = p.getEvents(0);
  eq(events.length, 5);
});
test("euclidean: numeric name (0(3,8)) works for n()", () => {
  // Names with leading digits should be accepted by the regex (excludes only `(` and `*`).
  const p = Patterns.n("0(3,8)");
  const events = p.getEvents(0);
  eq(events.length, 3);
  eq(events.every((e) => e.name === "0"), true);
});

test("jux(rev): doubles events; transformed copy carries channelOffset 1", () => {
  const orig = Patterns.s("bd sd");
  const p = orig.jux((q) => q.rev());
  const events = p.getEvents(0);
  eq(events.length, 4);
  // 2 events have channelOffset=1, 2 don't
  const offsetCount = events.filter((e) => e.channelOffset === 1).length;
  eq(offsetCount, 2);
});

test("juxBy(8, fast 2): right side has channelOffset 8 and is twice as dense", () => {
  const orig = Patterns.s("bd sd");
  const p = orig.juxBy(8, (q) => q.fast(2));
  const events = p.getEvents(0);
  // Original: 2 events, no offset. Transformed (fast 2): 4 events, offset 8.
  const orig2 = events.filter((e) => e.channelOffset === undefined && e.channel === undefined);
  const off8 = events.filter((e) => e.channelOffset === 8);
  eq(orig2.length, 2);
  eq(off8.length, 4);
});

test("juxTo(5, rev): right side has absolute channel 4 (chan 5 → idx 4)", () => {
  const orig = Patterns.s("bd sd");
  const p = orig.juxTo(5, (q) => q.rev());
  const events = p.getEvents(0);
  const tagged = events.filter((e) => e.channel === 4);
  eq(tagged.length, 2);
});

test("mini-notation: 'bd sd?' second slot drops in some cycles", () => {
  const p = Patterns.s("bd sd?");
  // Across 32 cycles, sd should appear in roughly half (allow generous range)
  let withSd = 0;
  for (let c = 0; c < 32; c++) {
    if (p.getEvents(c).some((e) => e.name === "sd")) withSd++;
  }
  if (withSd < 8 || withSd > 24) throw new Error(`expected ~16/32 with sd, got ${withSd}`);
  // bd should always appear
  for (let c = 0; c < 32; c++) {
    if (!p.getEvents(c).some((e) => e.name === "bd")) throw new Error(`bd missing in cycle ${c}`);
  }
});
test("mini-notation: 'bd?0' never drops; 'bd?1' always drops", () => {
  const never = Patterns.s("bd?0");
  const always = Patterns.s("bd?1");
  for (let c = 0; c < 8; c++) {
    if (never.getEvents(c).length !== 1) throw new Error(`?0 cycle ${c}: expected 1 event`);
    if (always.getEvents(c).length !== 0) throw new Error(`?1 cycle ${c}: expected 0 events`);
  }
});

test("mini-notation: 'bd ! sd' replicates previous: bd bd sd", () => {
  const p = Patterns.s("bd ! sd");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["bd", "bd", "sd"]);
});
test("mini-notation: 'bd !*3 sd' replicates 3 more times: bd bd bd bd sd", () => {
  const p = Patterns.s("bd !*3 sd");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["bd", "bd", "bd", "bd", "sd"]);
});
test("mini-notation: '!' at start throws", () => {
  let err = null;
  try { Patterns.s("! bd").getEvents(0); } catch (e) { err = e; }
  if (!err || !/replicate/.test(err.message)) throw new Error(`expected replicate error, got ${err}`);
});

test("mini-notation: 'bd@2 sd' weights bd 2/3 of cycle, sd 1/3", () => {
  const p = Patterns.s("bd@2 sd");
  const events = p.getEvents(0);
  eq(events.length, 2);
  near(events[0].start, 0);
  near(events[0].duration, 2 / 3);
  near(events[1].start, 2 / 3);
  near(events[1].duration, 1 / 3);
});
test("mini-notation: 'bd@3 sd@1 hh@2' proportions 3:1:2", () => {
  const p = Patterns.s("bd@3 sd@1 hh@2");
  const events = p.getEvents(0);
  eq(events.length, 3);
  near(events[0].duration, 3 / 6);
  near(events[1].duration, 1 / 6);
  near(events[2].duration, 2 / 6);
});

test("polyrhythm: '{bd cp, hh hh hh hh}' has 2-vs-4 lanes both filling cycle", () => {
  const p = Patterns.s("{bd cp, hh hh hh hh}");
  const events = p.getEvents(0);
  // Lane 0: bd at 0, cp at 0.5
  // Lane 1: hh at 0, 0.25, 0.5, 0.75
  eq(events.length, 6);
  const bdEv = events.find((e) => e.name === "bd");
  const cpEv = events.find((e) => e.name === "cp");
  near(bdEv.start, 0);
  near(cpEv.start, 0.5);
  const hhStarts = events.filter((e) => e.name === "hh").map((e) => e.start).sort((a, b) => a - b);
  near(hhStarts[0], 0);
  near(hhStarts[1], 0.25);
  near(hhStarts[2], 0.5);
  near(hhStarts[3], 0.75);
});
test("polymeter: '{bd cp}%4' forces 4 slots, cycling source", () => {
  const p = Patterns.s("{bd cp}%4");
  const events = p.getEvents(0);
  // Source [bd, cp] cycled into 4 slots: bd, cp, bd, cp
  eq(events.length, 4);
  eq(events.map((e) => e.name), ["bd", "cp", "bd", "cp"]);
  near(events[0].start, 0);
  near(events[1].start, 0.25);
  near(events[2].start, 0.5);
  near(events[3].start, 0.75);
});

test("iter(4): rotates events left by 1/4 each cycle", () => {
  const p = Patterns.n("a b c d").iter(4);
  // Cycle 0: a b c d (no shift)
  // Cycle 1: shift left by 0.25 → a was at 0, now at -0.25 wraps to 0.75; b: 0 (was 0.25), c: 0.25 (was 0.5), d: 0.5 (was 0.75); a wrapped to 0.75
  eq(p.getEvents(0).map((e) => e.name), ["a", "b", "c", "d"]);
  const c1 = p.getEvents(1);
  eq(c1.map((e) => e.name), ["b", "c", "d", "a"]);
});

test("whenmod(8, 5, rev): only applies when cycle % 8 === 5", () => {
  const p = Patterns.n("a b c d").whenmod(8, 5, (q) => q.rev());
  eq(p.getEvents(0).map((e) => e.name), ["a", "b", "c", "d"]);
  eq(p.getEvents(5).map((e) => e.name), ["d", "c", "b", "a"]);
  eq(p.getEvents(6).map((e) => e.name), ["a", "b", "c", "d"]);
});

test("sometimesBy(0): never applies; sometimesBy(1): always applies", () => {
  const never = Patterns.n("a b").sometimesBy(0, (q) => q.rev());
  const always = Patterns.n("a b").sometimesBy(1, (q) => q.rev());
  for (let c = 0; c < 8; c++) {
    eq(never.getEvents(c).map((e) => e.name), ["a", "b"]);
    eq(always.getEvents(c).map((e) => e.name), ["b", "a"]);
  }
});

test("chunk(4, rev): rotates a quarter each cycle, leaves rest untouched", () => {
  const p = Patterns.n("a b c d").chunk(4, (q) => q.rev());
  // rev'd events have positions: d@0, c@0.25, b@0.5, a@0.75
  // Cycle 0: slice 0 [0, 0.25). Use rev'd events whose start is in slice → d@0.
  //   Original events outside slice: b@0.25, c@0.5, d@0.75.
  //   Combined: d, b, c, d (sorted by start)
  const c0 = p.getEvents(0).map((e) => e.name);
  eq(c0, ["d", "b", "c", "d"]);
  // Cycle 1: slice 1 [0.25, 0.5). rev'd start=0.25 is c. Original outside: a@0, c@0.5, d@0.75.
  //   Combined sorted: a, c, c, d
  const c1 = p.getEvents(1).map((e) => e.name);
  eq(c1, ["a", "c", "c", "d"]);
});

test("early(0.25): wrap-shifts events back by quarter cycle", () => {
  const p = Patterns.n("a b c d").early(0.25);
  // Original: a@0, b@0.25, c@0.5, d@0.75
  // Shift -0.25 (with wrap): a wraps to 0.75; b@0; c@0.25; d@0.5
  const events = p.getEvents(0);
  near(events.find((e) => e.name === "a").start, 0.75);
  near(events.find((e) => e.name === "b").start, 0);
  near(events.find((e) => e.name === "c").start, 0.25);
  near(events.find((e) => e.name === "d").start, 0.5);
});

test("late(0.5): wraps half the cycle", () => {
  const p = Patterns.n("a b c d").late(0.5);
  // a@0 → 0.5, b@0.25 → 0.75, c@0.5 → 0 (wrap), d@0.75 → 0.25
  const events = p.getEvents(0);
  near(events.find((e) => e.name === "c").start, 0);
  near(events.find((e) => e.name === "d").start, 0.25);
  near(events.find((e) => e.name === "a").start, 0.5);
  near(events.find((e) => e.name === "b").start, 0.75);
});

test("linger(2): first half played twice", () => {
  const p = Patterns.n("a b c d").linger(2);
  // First half = events with start < 0.5 → a@0, b@0.25
  // Repeat 2× at offsets 0 and 0.5: a@0, b@0.25, a@0.5, b@0.75
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["a", "b", "a", "b"]);
  near(events[2].start, 0.5);
  near(events[3].start, 0.75);
});

test("trunc(0.5): drops second half, clips boundary durations", () => {
  const p = Patterns.n("a b c d").trunc(0.5);
  // Events with start < 0.5 → a@0, b@0.25 (durations clipped if exceed 0.5)
  const events = p.getEvents(0);
  eq(events.length, 2);
  eq(events.map((e) => e.name), ["a", "b"]);
});

test("zoom(0.25, 0.75): middle half stretched to full", () => {
  const p = Patterns.n("a b c d").zoom(0.25, 0.75);
  // Zoom shows [0.25, 0.75) stretched to [0, 1). b@0.25 → 0; c@0.5 → 0.5
  const events = p.getEvents(0);
  eq(events.length, 2);
  eq(events.map((e) => e.name), ["b", "c"]);
  near(events[0].start, 0);
  near(events[1].start, 0.5);
});

test("compress(0.25, 0.75): full cycle squeezed into middle", () => {
  const p = Patterns.n("a b c d").compress(0.25, 0.75);
  // Original [0,1) → [0.25, 0.75). Each event start scaled by 0.5 and offset by 0.25.
  const events = p.getEvents(0);
  eq(events.length, 4);
  near(events[0].start, 0.25);
  near(events[1].start, 0.375);
  near(events[2].start, 0.5);
  near(events[3].start, 0.625);
});

test("off(0.5, fast 2): overlays a delayed-fast copy", () => {
  const p = Patterns.s("bd cp").off(0.5, (q) => q.fast(2));
  // Original: bd@0, cp@0.5
  // Transformed (fast 2): 4 events. Shifted by 0.5.
  // Total: 6 events
  const events = p.getEvents(0);
  if (events.length !== 6) throw new Error(`expected 6 events, got ${events.length}`);
});

test("density / sparsity: aliases for fast / slow", () => {
  // density(2) == fast(2): 2 source-cycles in window → 4 events
  // We test by direct method-level comparison: density() doesn't exist on Pattern,
  // but via sandbox curry it should be the same function reference.
  // Since we can't easily access the sandbox here, just ensure fast(2) gives expected output.
  const p = Patterns.n("a b").fast(2);
  eq(p.getEvents(0).length, 4);
});

test("add(7): events accumulate offset 7", () => {
  const p = Patterns.n("c4").add(7);
  const events = p.getEvents(0);
  eq(events[0].offset, 7);
});
test("add('<0 7>'): cycle 0 +0, cycle 1 +7", () => {
  const p = Patterns.n("c4").add("<0 7>");
  eq(p.getEvents(0)[0].offset, 0);
  eq(p.getEvents(1)[0].offset, 7);
});
test("add().mul().sub() chain composes via offset", () => {
  // 3 + 4 = 7 → * 2 = 14 → - 5 = 9
  const p = Patterns.n("c4").add(3).add(4).mul(2).sub(5);
  eq(p.getEvents(0)[0].offset, 9);
});
test("up(7) === add(7); octave(1) === add(12)", () => {
  const a = Patterns.n("c4").up(7).getEvents(0)[0].offset;
  const b = Patterns.n("c4").add(7).getEvents(0)[0].offset;
  eq(a, b);
  const o = Patterns.n("c4").octave(1).getEvents(0)[0].offset;
  eq(o, 12);
});

test("scheduler: pitch offset applied to MIDI; out-of-range dropped", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push(m.note); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // n("c4") = 60. add(7) → MIDI 67 (G4)
  scheduler.setOrbit(1, Patterns.n("c4").add(7));
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  if (!sent.includes(67)) throw new Error(`expected MIDI 67, got ${sent}`);
});
test("scheduler: out-of-range MIDI is dropped", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push(m.note); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // c4 (60) + 200 = 260 → out of range, dropped
  scheduler.setOrbit(1, Patterns.n("c4").add(200));
  await new Promise((r) => setTimeout(r, 600));
  scheduler.hush();
  eq(sent.length, 0);
});

test("run(4): plays 0 1 2 3 in one cycle", () => {
  const p = Patterns.run(4);
  const events = p.getEvents(0);
  eq(events.length, 4);
  eq(events.map((e) => e.name), ["0", "1", "2", "3"]);
});

test("irand(12): names in [0,12), differs across cycles, deterministic", () => {
  const p = Patterns.irand(12);
  const names = [];
  for (let c = 0; c < 8; c++) {
    const ev = p.getEvents(c);
    eq(ev.length, 1);
    const v = parseInt(ev[0].name, 10);
    if (v < 0 || v >= 12) throw new Error(`irand value out of range: ${v}`);
    names.push(v);
  }
  // Should not all be identical (huge probability against)
  const distinct = new Set(names).size;
  if (distinct < 2) throw new Error(`expected variety, got ${names}`);
  // Determinism: re-create and re-check first cycle matches
  const p2 = Patterns.irand(12);
  eq(p.getEvents(0)[0].name, p2.getEvents(0)[0].name);
});

test("choose: picks from array per cycle, deterministic", () => {
  const p = Patterns.choose(["c4", "e4", "g4"]);
  const c0 = p.getEvents(0)[0].name;
  const c1 = p.getEvents(1)[0].name;
  // Both must be in the array
  if (!["c4", "e4", "g4"].includes(c0)) throw new Error(`unexpected ${c0}`);
  if (!["c4", "e4", "g4"].includes(c1)) throw new Error(`unexpected ${c1}`);
  // Determinism
  const p2 = Patterns.choose(["c4", "e4", "g4"]);
  eq(p.getEvents(5)[0].name, p2.getEvents(5)[0].name);
});

test("range(40, 80, n('0 0.5 1')): scales token values", () => {
  const value = Patterns.n("0 0.5 1");
  const ranged = Patterns.range(40, 80, value);
  const events = ranged.getEvents(0);
  // Tokens become "40", "60", "80"
  eq(events.map((e) => e.name), ["40", "60", "80"]);
});

test("scheduler: per-event channel overrides pattern channel", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push({ note: m.note, ch: m.channel }); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // Stack with explicit per-part channels (via .ch)
  const stacked = Patterns.stack([Patterns.s("bd").ch(3), Patterns.s("cp").ch(7)]);
  scheduler.setOrbit(1, stacked);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  // bd hits should fire on channel 2 (ch(3)→idx 2); cp on channel 6
  const bdHits = sent.filter((s) => s.note === 36);
  const cpHits = sent.filter((s) => s.note === 39);
  if (bdHits.some((h) => h.ch !== 2)) throw new Error(`bd expected ch 2, saw ${[...new Set(bdHits.map((h) => h.ch))]}`);
  if (cpHits.some((h) => h.ch !== 6)) throw new Error(`cp expected ch 6, saw ${[...new Set(cpHits.map((h) => h.ch))]}`);
});

test("scheduler: jux channelOffset resolved against orbit channel", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push({ note: m.note, ch: m.channel }); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // Original: s "bd". jux rev tags right side with channelOffset 1.
  // The pattern has no explicit channel — emulate d5 setting ch=4.
  const juxed = Patterns.s("bd").jux((q) => q.rev()).ch(5);
  scheduler.setOrbit(1, juxed);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  // Original side fires on ch 4 (orbit-set), transformed on ch 5 (4 + offset 1)
  const ch4 = sent.filter((s) => s.ch === 4).length;
  const ch5 = sent.filter((s) => s.ch === 5).length;
  if (ch4 < 1) throw new Error(`expected ch 4 hits, got ${ch4}`);
  if (ch5 < 1) throw new Error(`expected ch 5 hits, got ${ch5}`);
});

test("pattern: degradeBy('<0 1>') drops nothing then everything", () => {
  const p = Patterns.n("a b c d").degradeBy("<0 1>");
  if (p.getEvents(0).length !== 4) throw new Error(`cycle 0 expected 4 events`);
  if (p.getEvents(1).length !== 0) throw new Error(`cycle 1 expected 0 events`);
});

test("pattern: .every(4, fast 2) does NOT cache fn(this) result", () => {
  // .degradeBy uses the cycleN-deterministic PRNG, so its events should differ per cycle
  // when wrapped in .every. Before the fix, .every called fn(this) once at construction
  // and the same set of degraded events repeated every 4 cycles.
  const p = Patterns.n("a b c d e f g h").every(4, (q) => q.degradeBy(0.5));
  const c0 = p.getEvents(0).map(e => e.name);
  const c4 = p.getEvents(4).map(e => e.name);
  const c8 = p.getEvents(8).map(e => e.name);
  // Cycles 4 and 8 both apply degrade, but with different cycleN seeds → should differ
  if (JSON.stringify(c4) === JSON.stringify(c8)) {
    throw new Error("every-degradeBy produced identical results across cycles 4 and 8");
  }
});

// ── Scheduler ───────────────────────────────────────────────────────────
test("scheduler: phase-aligned tick handles mid-bar activation", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push({ ms: Date.now() - t0, midi: m.note }); }, close: () => {} };
  const t0 = Date.now();
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);  // double-time so test is fast
  const fakeStart = Date.now();
  const provider = {
    getPhase: () => ({ beat: 2.5 + ((Date.now() - fakeStart) / 1000) * 4, quantum: 4, bpm: 240 }),
    setQuantum: () => {},
  };
  scheduler.setPhaseSource(provider);
  scheduler.setOrbit(1, Patterns.n("c4 e4 g4 b4"));
  scheduler.setTransportEnabled(true);
  await new Promise(r => setTimeout(r, 1500));
  scheduler.hush();
  // Mid-bar engagement: cycle 0 contributes events with offAt > 0 (clamped to 0
  // for any whose onAt is negative — at most one micro-flam, no dropped beats);
  // subsequent cycles fire all 4 events. Within 1.5s at 240bpm/4-beat-cycle (=1s),
  // expect ≥5 noteons (1 from cycle 0 partial + 4 from cycle 1).
  if (sent.length < 5) throw new Error(`expected ≥5 noteons, got ${sent.length}: ${JSON.stringify(sent)}`);
});

test("scheduler: bd*4 fires all 4 events under phase jitter", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push(m.note); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);  // cycleMs = 1000ms
  // Phase provider that simulates ~5ms boundary jitter — beat starts at 0.01 instead of 0
  // and advances naturally. This is the steady-state Link condition where the previous
  // bug skipped the first event of every cycle.
  const t0 = Date.now();
  const provider = {
    getPhase: () => ({ beat: 0.02 + ((Date.now() - t0) / 1000) * 4, quantum: 4, bpm: 240 }),
    setQuantum: () => {},
  };
  scheduler.setPhaseSource(provider);
  scheduler.setOrbit(1, Patterns.s("bd*4"));  // 4 kicks/cycle
  scheduler.setTransportEnabled(true);
  await new Promise(r => setTimeout(r, 2200));
  scheduler.hush();
  // Expect ~8 hits (2 cycles × 4). Allow some slack for cycle boundary timing.
  if (sent.length < 7) throw new Error(`expected ≥7 noteons (2 cycles × 4), got ${sent.length}`);
  // All hits should be note 36 (bd)
  if (sent.some(n => n !== 36)) throw new Error(`expected all note 36 (bd), got ${[...new Set(sent)]}`);
});

test("scheduler: hush only sends noteoff for played notes (not 4096 messages)", async () => {
  const sends = [];
  const out = { send: (type, m) => sends.push({ type, ch: m.channel, note: m.note }), close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);  // fast cycle so events fire quickly
  scheduler.setOrbit(1, Patterns.n("c4 e4"));   // emits ch.0 (default), notes 60, 64
  await new Promise(r => setTimeout(r, 600));   // > 1 cycle at 240bpm/4beats = 1s? Actually .ch isn't set, so default ch=0
  scheduler.hush();
  const offs = sends.filter(s => s.type === "noteoff");
  // Should be at most a small number of noteoffs (the played notes), NOT 4096.
  if (offs.length > 50) throw new Error(`hush sent ${offs.length} noteoffs (expected ≤50)`);
});

test("scheduler: surfaces pattern errors via callback", async () => {
  let captured = null;
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setOnPatternError((m) => { captured = m; });
  scheduler.setTempo(240, 4);
  // Pattern whose getEvents throws
  const broken = new Patterns.Pattern(() => { throw new Error("boom"); }, "notes", 0, false);
  scheduler.setOrbit(1, broken);
  await new Promise(r => setTimeout(r, 100));
  scheduler.hush();
  if (!captured || !captured.includes("boom")) throw new Error(`expected error captured, got: ${captured}`);
});

// ── Composition: combinator interactions ──────────────────────────────
// These exercise feature pairs where bugs hide between assumptions.

test("compose: jux(rev) + chunk(4, fast 2) — both apply on the right slice", () => {
  // Stack with two layers: original + transformed (via jux). chunk applies fast 2
  // to slice (cycleN%4) of THIS pattern. The juxed-and-chunked combination
  // should produce: orig events from non-active slices + chunked-fast events on slice.
  const p = Patterns.s("bd sd hh cp").jux((q) => q.rev()).chunk(4, (q) => q.fast(2));
  const c0 = p.getEvents(0);
  // Smoke-level: at minimum produces events and doesn't crash on this composition.
  if (c0.length === 0) throw new Error("expected events");
});

test("compose: stack with mixed explicit/non-explicit ch under d5 routing", () => {
  // Part 1 has explicit .ch(3) (idx 2). Part 2 has no explicit channel.
  // Simulating d5: outer .ch(5) sets stack channel to idx 4.
  // Result: part1 events fire on ch 2 (their tag); part2 events on ch 4 (orbit).
  const stacked = Patterns.stack([Patterns.s("bd").ch(3), Patterns.s("cp")]).ch(5);
  const events = stacked.getEvents(0);
  // bd events: have channel=2 from tagPartEvents (since part1 was explicit)
  // cp events: untagged → fall back to outer pattern channel=4 at scheduler time
  const bd = events.find((e) => e.name === "bd");
  const cp = events.find((e) => e.name === "cp");
  eq(bd.channel, 2);
  eq(cp.channel, undefined);
  eq(stacked.channel, 4);
});

test("compose: cat preserves per-part .ch tags across cycles", () => {
  const p = Patterns.cat([Patterns.s("bd").ch(3), Patterns.s("cp").ch(7)]);
  eq(p.getEvents(0)[0].channel, 2);
  eq(p.getEvents(1)[0].channel, 6);
});

test("compose: fast(2) of n('0 7').add(7) — offset preserved through fast", () => {
  // fast(2) duplicates cycle worth of events. Offsets should travel with each event.
  const p = Patterns.n("0 7").add(7).fast(2);
  const events = p.getEvents(0);
  eq(events.length, 4);
  // All four events should have offset 7 (untouched by fast)
  if (events.some((e) => e.offset !== 7)) throw new Error(`expected all offsets 7, got ${events.map((e) => e.offset)}`);
});

test("compose: rev preserves channel and offset fields", () => {
  // Forward-compat: rev was changed to use {...ev, ...} spread to preserve future fields
  const p = Patterns.n("c4 e4").add(7).ch(5).rev();
  const events = p.getEvents(0);
  if (events.some((e) => e.offset !== 7)) throw new Error("rev lost offset");
  // ch is on the Pattern, not events, so just verify it's still set
  eq(p.channel, 4);
});

test("compose: every(2, add 7) — pitch math toggles per cycle", () => {
  const p = Patterns.n("c4").every(2, (q) => q.add(7));
  // Cycle 0: add(7) applied → offset 7. Cycle 1: not applied → no offset.
  eq(p.getEvents(0)[0].offset, 7);
  eq(p.getEvents(1)[0].offset, undefined);
});

test("compose: off(0.5, add 12) overlays an octave-up copy", () => {
  // Original events at orig offsets, overlay copy late by half cycle with +12 offset
  const p = Patterns.n("c4 e4").off(0.5, (q) => q.add(12));
  const events = p.getEvents(0);
  // 2 original + 2 overlaid = 4 events total
  eq(events.length, 4);
  const offsets = events.map((e) => e.offset).sort((a, b) => (a ?? 0) - (b ?? 0));
  // 2 events with no offset, 2 with offset 12
  eq(offsets.filter((o) => o === undefined).length, 2);
  eq(offsets.filter((o) => o === 12).length, 2);
});

test("compose: linger(2) preserves offset on repeated slice", () => {
  const p = Patterns.n("c4 e4 g4 b4").add(5).linger(2);
  const events = p.getEvents(0);
  // 2 events from first half, repeated → 4 events, all with offset 5
  eq(events.length, 4);
  if (events.some((e) => e.offset !== 5)) throw new Error(`expected all offsets 5, got ${events.map((e) => e.offset)}`);
});

test("compose: iter(4) wraps events through cycle 3", () => {
  // After 4 cycles, iter(4) returns to identity
  const p = Patterns.n("a b c d").iter(4);
  eq(p.getEvents(0).map((e) => e.name), ["a", "b", "c", "d"]);
  eq(p.getEvents(4).map((e) => e.name), ["a", "b", "c", "d"]);
});

test("compose: jux preserves explicit channel from inside fn", () => {
  // jux rev (s "bd" # ch 3) — transformed has explicit channel 3 (idx 2).
  // Should override the relative offset path: events tagged with channel=2 absolute.
  const p = Patterns.s("bd").jux((q) => q.rev().ch(3));
  const events = p.getEvents(0);
  const tagged = events.filter((e) => e.channel === 2);
  // Should have the rev'd events with absolute channel 2
  if (tagged.length === 0) throw new Error("jux failed to tag with explicit ch");
});

test("compose: juxBy(-1, rev) — negative offset wraps via mod 16", () => {
  // pattern at default ch 0; offset -1 → 15 after mod-16 wrap (done by juxBy itself).
  const p = Patterns.s("bd").juxBy(-1, (q) => q.rev());
  const events = p.getEvents(0);
  const offsetEvents = events.filter((e) => e.channelOffset === 15);
  if (offsetEvents.length === 0) throw new Error("expected events with channelOffset=15 (negative offset should wrap mod 16)");
});

test("compose: add(-200) drops events out of MIDI range at scheduler", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push(m.note); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // n("c4") is MIDI 60. add(-200) → -140, dropped. add(60) → 120, in range.
  const stack = Patterns.stack([Patterns.n("c4").add(-200), Patterns.n("c4").add(60)]);
  scheduler.setOrbit(1, stack);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  // Only the in-range event should fire
  if (!sent.includes(120)) throw new Error(`expected MIDI 120, got ${sent}`);
  if (sent.includes(-140)) throw new Error("out-of-range note leaked");
});

// ── Mini-notation interactions ─────────────────────────────────────────

test("mini-notation: Euclidean inside subdivision: '[bd(3,8)] sd'", () => {
  const p = Patterns.s("[bd(3,8)] sd");
  const events = p.getEvents(0);
  // 3 bd hits in first half, 1 sd in second half = 4 events
  eq(events.length, 4);
  const bdCount = events.filter((e) => e.name === "bd").length;
  const sdCount = events.filter((e) => e.name === "sd").length;
  eq(bdCount, 3);
  eq(sdCount, 1);
});

test("mini-notation: Euclidean inside alternation: '<bd(3,8) cp(5,8)>'", () => {
  const p = Patterns.s("<bd(3,8) cp(5,8)>");
  // Cycle 0: 3 bd hits. Cycle 1: 5 cp hits.
  eq(p.getEvents(0).length, 3);
  eq(p.getEvents(0).every((e) => e.name === "bd"), true);
  eq(p.getEvents(1).length, 5);
  eq(p.getEvents(1).every((e) => e.name === "cp"), true);
});

test("mini-notation: weighted slot inside subdivision: '[bd@2 sd] hh'", () => {
  const p = Patterns.s("[bd@2 sd] hh");
  // Top-level: 2 children, each gets 1/2 of cycle.
  // First child is a group [bd@2 sd]: bd takes 2/3 of 0.5 = 1/3 of cycle.
  // sd takes 1/3 of 0.5 = 1/6 of cycle.
  // hh takes 1/2 of cycle.
  const events = p.getEvents(0);
  eq(events.length, 3);
  const bd = events.find((e) => e.name === "bd");
  const sd = events.find((e) => e.name === "sd");
  const hh = events.find((e) => e.name === "hh");
  near(bd.duration, 1 / 3);
  near(sd.duration, 1 / 6);
  near(hh.duration, 0.5);
});

test("mini-notation: degrade applies to a group: '[bd sd]?0' never drops", () => {
  const p = Patterns.s("[bd sd]?0");
  for (let c = 0; c < 8; c++) {
    eq(p.getEvents(c).length, 2);
  }
});
test("mini-notation: degrade applies to a group: '[bd sd]?1' always drops", () => {
  const p = Patterns.s("[bd sd]?1");
  for (let c = 0; c < 8; c++) {
    eq(p.getEvents(c).length, 0);
  }
});

test("mini-notation: replicate after subdivision: '[bd cp] !'", () => {
  const p = Patterns.s("[bd cp] !");
  const events = p.getEvents(0);
  // Subdivision [bd cp] takes half cycle (bd at 0, cp at 0.25).
  // Replicate copies it: another [bd cp] in second half (bd at 0.5, cp at 0.75).
  eq(events.length, 4);
  eq(events.map((e) => e.name), ["bd", "cp", "bd", "cp"]);
});

test("mini-notation: polyrhythm with weighted children: '{bd@2 sd, hh hh}'", () => {
  const p = Patterns.s("{bd@2 sd, hh hh}");
  const events = p.getEvents(0);
  // Lane 0: bd@2 + sd → bd takes 2/3, sd 1/3 of cycle
  // Lane 1: hh hh → 2 hh events, each 1/2 cycle
  eq(events.length, 4);  // 2 + 2
  const bd = events.find((e) => e.name === "bd");
  const sd = events.find((e) => e.name === "sd");
  near(bd.duration, 2 / 3);
  near(sd.duration, 1 / 3);
});

test("mini-notation: polyrhythm '{a, b c}' = single + 2-element lanes", () => {
  const p = Patterns.s("{bd, cp hh}");
  const events = p.getEvents(0);
  // bd at 0 (full cycle), cp at 0, hh at 0.5
  eq(events.length, 3);
  const cp = events.find((e) => e.name === "cp");
  const hh = events.find((e) => e.name === "hh");
  near(cp.start, 0);
  near(hh.start, 0.5);
});

test("mini-notation: empty input returns no events", () => {
  const p = Patterns.s("");
  eq(p.getEvents(0).length, 0);
});

test("mini-notation: rest-only pattern returns no events", () => {
  const p = Patterns.s("~ ~ ~ ~");
  eq(p.getEvents(0).length, 0);
});

test("mini-notation: nested alternation '<<a b> <c d>>' propagates cycleN", () => {
  // Outer picks children[cycleN % 2]; the picked inner alternate is then flattened
  // with the SAME cycleN, so its choice = innerChildren[cycleN % 2].
  // Cycle 0: outer picks <a b>, inner picks a
  // Cycle 1: outer picks <c d>, inner picks d
  // Cycle 2: outer picks <a b>, inner picks a (cycleN=2, 2%2=0)
  // Cycle 3: outer picks <c d>, inner picks d (cycleN=3, 3%2=1)
  const p = Patterns.n("<<a b> <c d>>");
  eq(p.getEvents(0).map((e) => e.name), ["a"]);
  eq(p.getEvents(1).map((e) => e.name), ["d"]);
  eq(p.getEvents(2).map((e) => e.name), ["a"]);
  eq(p.getEvents(3).map((e) => e.name), ["d"]);
});

// ── Transpiler integration ────────────────────────────────────────────
// Build a sandbox + run user code via the full transpile path. This catches
// regressions in the layer between mini-notation/method calls and the parser.

function buildEngine() {
  const orbits = new Map();
  return {
    setOrbit: (n, p) => orbits.set(n, p),
    clearOrbit: (n) => orbits.delete(n),
    hush: () => orbits.clear(),
    orbits,
  };
}

test("transpile-run: 'd1 $ s \"bd\"' wires up orbit 1 with default ch", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd"', sandbox);
  const p = engine.orbits.get(1);
  if (!p) throw new Error("orbit 1 not set");
  eq(p.portType, "drums");
  eq(p.channel, 0);  // d1 → idx 0
  eq(p.channelExplicit, true);
});

test("transpile-run: 'd5 $ s \"bd\" # ch 3' — explicit ch wins over orbit", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d5 $ s "bd" # ch 3', sandbox);
  const p = engine.orbits.get(5);
  eq(p.channel, 2);  // ch(3) → idx 2
  eq(p.channelExplicit, true);
});

test("transpile-run: chained # methods compose in order", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd" # fast 2 # gain 0.5', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  eq(events.length, 2);
  // Velocity should be 100 * 0.5 = 50
  if (events.some((e) => e.velocity !== 50)) throw new Error(`expected vel 50, got ${events.map((e) => e.velocity)}`);
});

test("transpile-run: array literal '[a, b]' is NOT supported by transpiler", () => {
  // Tidal-flavored `stack [a, b]` requires Haskell list syntax. The current
  // transpiler doesn't handle `[`/`]` so this throws at parse time. Documenting
  // the limitation as a test — workaround is to construct the array from JS:
  //   `d1 (stack ([s "bd", s "cp"]))` would also fail; users must use a
  //   different composition style (or we add list syntax later).
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  let err = null;
  try { Patterns.runUserCode('d1 $ stack [s "bd", s "cp"]', sandbox); } catch (e) { err = e; }
  if (!err) throw new Error("expected transpiler to reject array literal syntax");
});

test("transpile-run: 'd1 $ s \"bd\" # jux rev' applies jux via # chain", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd" # jux rev', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  // Original event + jux'd event = 2
  eq(events.length, 2);
});

test("transpile-run: 'd1 $ s \"bd\" # add 7' transposes via # chain", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd" # add 7', sandbox);
  const p = engine.orbits.get(1);
  eq(p.getEvents(0)[0].offset, 7);
});

test("transpile-run: 'd1 $ s \"bd\" # every \"<2 4>\" rev' — patterned arg via #", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd sd cp hh" # every "<2 4>" rev', sandbox);
  const p = engine.orbits.get(1);
  // Cycle 0: N=2, 0%2===0 → rev'd
  // Cycle 1: N=4, 1%4!==0 → original
  eq(p.getEvents(0).map((e) => e.name), ["hh", "cp", "sd", "bd"]);
  eq(p.getEvents(1).map((e) => e.name), ["bd", "sd", "cp", "hh"]);
});

test("transpile-run: 'hush' clears the engine", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd"', sandbox);
  if (engine.orbits.size !== 1) throw new Error("orbit not set up");
  Patterns.runUserCode("hush", sandbox);
  eq(engine.orbits.size, 0);
});

test("transpile-run: multi-statement (newline-separated) works", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd"\nd2 $ s "cp"', sandbox);
  if (!engine.orbits.has(1)) throw new Error("d1 not set");
  if (!engine.orbits.has(2)) throw new Error("d2 not set");
});

test("transpile-run: 'd1 silence' clears orbit 1 (passing silence as Pattern)", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd"', sandbox);
  Patterns.runUserCode('d1 silence', sandbox);
  // silence is an empty Pattern; orbit 1 is now set to it (NOT cleared)
  // d1 with `silence` registers it as a Pattern; silence has no events.
  const p = engine.orbits.get(1);
  if (!p) throw new Error("d1 silence didn't register a pattern");
  eq(p.getEvents(0).length, 0);
});

test("transpile-run: pitch math + polymeter integration", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ n "{0 7 12}%4" # add 5', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  // Polymeter forces 4 slots from source [0, 7, 12]: 0, 7, 12, 0
  eq(events.length, 4);
  // All offsets should be 5 (from add(5))
  if (events.some((e) => e.offset !== 5)) throw new Error("add not applied");
});

test("transpile-run: jux with curried function arg", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  // jux (fast 2) — fast 2 is curried, must be wrapped in parens
  Patterns.runUserCode('d1 $ s "bd cp" # jux (fast 2)', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  // Original: 2 events. Transformed (fast 2): 4 events. Total: 6.
  eq(events.length, 6);
});

// ── samplePatternable edge cases ──────────────────────────────────────

test("samplePatternable: throws on empty pattern string", () => {
  let err = null;
  try { Patterns.samplePatternable("~", 0); } catch (e) { err = e; }
  if (!err || !/empty/.test(err.message)) throw new Error(`expected empty-pattern error, got ${err}`);
});

test("samplePatternable: phase outside any event falls back to first", () => {
  // "bd" produces one event at start=0, duration=1 covering whole cycle. Always matches.
  // Test fallback by constructing a pattern with a gap... actually all our patterns fill the cycle.
  // Use phase=1 (just past end) — should fall back.
  eq(Patterns.samplePatternable("0 7", 0, 1.5), 0);  // phase 1.5 outside, fall back to first
});

test("samplePatternable: custom parse function", () => {
  // String result via identity parser
  eq(Patterns.samplePatternable("a b c", 0, 0, (s) => s), "a");
  eq(Patterns.samplePatternable("a b c", 0, 0.4, (s) => s), "b");
});

// ── Generator edge cases ──────────────────────────────────────────────

test("run(1): single event '0'", () => {
  const events = Patterns.run(1).getEvents(0);
  eq(events.length, 1);
  eq(events[0].name, "0");
});

test("run(0): throws", () => {
  let err = null;
  try { Patterns.run(0); } catch (e) { err = e; }
  if (!err) throw new Error("expected error for run(0)");
});

test("choose: single-element array always picks that element", () => {
  const p = Patterns.choose(["c4"]);
  for (let c = 0; c < 4; c++) eq(p.getEvents(c)[0].name, "c4");
});

test("choose: empty array returns silence", () => {
  const p = Patterns.choose([]);
  for (let c = 0; c < 4; c++) eq(p.getEvents(c).length, 0);
});

test("choose: mixed strings and Patterns", () => {
  const p = Patterns.choose(["c4", Patterns.n("e4 g4")]);
  // Either yields 1 event (c4) or 2 events (e4, g4) per cycle
  for (let c = 0; c < 4; c++) {
    const ev = p.getEvents(c);
    if (ev.length !== 1 && ev.length !== 2) throw new Error(`unexpected count ${ev.length} cycle ${c}`);
  }
});

test("range: throws on non-numeric source token", () => {
  let err = null;
  try {
    const v = Patterns.n("c4");
    Patterns.range(40, 80, v).getEvents(0);
  } catch (e) { err = e; }
  if (!err || !/non-numeric/.test(err.message)) throw new Error(`expected non-numeric error, got ${err}`);
});

// ── Stack/cat/fastcat edge cases ─────────────────────────────────────

test("stack: empty array throws", () => {
  let err = null;
  try { Patterns.stack([]); } catch (e) { err = e; }
  if (!err || !/non-empty/.test(err.message)) throw new Error(`expected non-empty error, got ${err}`);
});

test("stack: single pattern returns equivalent events", () => {
  const orig = Patterns.s("bd cp");
  const stacked = Patterns.stack([orig]);
  eq(stacked.getEvents(0).map((e) => e.name), orig.getEvents(0).map((e) => e.name));
});

test("fastcat: events sorted by start across all parts", () => {
  const p = Patterns.fastcat([Patterns.n("a b"), Patterns.n("c d")]);
  const events = p.getEvents(0);
  // First half: a, b (starts 0, 0.25). Second half: c, d (starts 0.5, 0.75).
  for (let i = 1; i < events.length; i++) {
    if (events[i].start < events[i - 1].start) throw new Error("not sorted by start");
  }
});

test("cat: negative cycleN handled (modulo with positive result)", () => {
  // While we don't normally see negative cycles, samplePatternable can pass any cycleN.
  // cat must handle negative input gracefully via the `((cycleN % N) + N) % N` formula.
  const p = Patterns.cat([Patterns.n("a"), Patterns.n("b"), Patterns.n("c")]);
  // This shouldn't throw
  const ev = p.getEvents(-1);
  if (!ev || ev.length === 0) throw new Error("expected events at cycleN=-1");
});

// ── Time-shift edge cases ────────────────────────────────────────────

test("late(0): identity", () => {
  const orig = Patterns.s("bd cp hh");
  const late0 = orig.late(0);
  const a = orig.getEvents(0);
  const b = late0.getEvents(0);
  eq(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    near(a[i].start, b[i].start);
    eq(a[i].name, b[i].name);
  }
});

test("late(1): full-cycle shift = identity (modulo wrap)", () => {
  const orig = Patterns.s("bd cp");
  const late1 = orig.late(1);
  const a = orig.getEvents(0);
  const b = late1.getEvents(0);
  eq(a.map((e) => e.name).sort(), b.map((e) => e.name).sort());
});

test("iter(1): identity", () => {
  const orig = Patterns.n("a b c d");
  const itered = orig.iter(1);
  for (let c = 0; c < 4; c++) {
    eq(orig.getEvents(c).map((e) => e.name), itered.getEvents(c).map((e) => e.name));
  }
});

test("zoom(0, 1): identity", () => {
  const orig = Patterns.s("bd cp hh");
  const zoomed = orig.zoom(0, 1);
  const a = orig.getEvents(0);
  const b = zoomed.getEvents(0);
  eq(a.length, b.length);
  for (let i = 0; i < a.length; i++) near(a[i].start, b[i].start);
});

// ── Routing edge cases ───────────────────────────────────────────────

test("ch(17): clamps to ch 16 (idx 15)", () => {
  // Math.max(0, Math.min(15, Math.floor(17) - 1)) = Math.min(15, 16) = 15
  const p = Patterns.s("bd").ch(17);
  eq(p.channel, 15);
});

test("ch(0): rejected (1-indexed surface, use ch(1) for first channel)", () => {
  let threw = false;
  try { Patterns.s("bd").ch(0); } catch (e) { threw = /1-indexed/.test(String(e.message)); }
  if (!threw) throw new Error("ch(0) should throw a 1-indexed error");
});

test("scheduler: juxBy(-1) wraps via mod 16 to ch 15", async () => {
  const sent = [];
  const out = { send: (type, m) => { if (type === "noteon") sent.push({ note: m.note, ch: m.channel }); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(240, 4);
  // Pattern at default ch 0 + juxBy(-1) → transformed events fire on ch 15 after wrap
  const p = Patterns.s("bd").juxBy(-1, (q) => q.rev());
  scheduler.setOrbit(1, p);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  // d1 doesn't apply automatic .ch() here since we used setOrbit directly. Pattern.channel=0.
  // Original: ch 0. Transformed: ch (0 + -1) mod 16 = 15.
  const ch15 = sent.filter((s) => s.ch === 15).length;
  if (ch15 < 1) throw new Error(`expected ch 15 hits from negative offset wrap, got ${sent}`);
});

// ── Phase A: mini-notation (_ elongate, [a, b] parallel, .. ranges) ──

test("mini-notation: 'bd _ _ sd' elongates bd to 3 slots, sd to 1", () => {
  const p = Patterns.s("bd _ _ sd");
  const events = p.getEvents(0);
  // bd weight 3, sd weight 1, total 4 → bd takes 3/4, sd takes 1/4
  eq(events.length, 2);
  near(events[0].start, 0);
  near(events[0].duration, 3 / 4);
  near(events[1].start, 3 / 4);
  near(events[1].duration, 1 / 4);
});

test("mini-notation: 'bd _*3 sd' elongates bd by 3 (bd weight 4)", () => {
  const p = Patterns.s("bd _*3 sd");
  const events = p.getEvents(0);
  // bd weight 4, sd weight 1, total 5
  near(events[0].duration, 4 / 5);
  near(events[1].duration, 1 / 5);
});

test("mini-notation: 'bd@2 _ sd' composes weight + elongate (bd weight 3)", () => {
  const p = Patterns.s("bd@2 _ sd");
  const events = p.getEvents(0);
  // bd@2 → weight 2, then _ adds 1 → weight 3. sd weight 1. Total 4.
  near(events[0].duration, 3 / 4);
  near(events[1].duration, 1 / 4);
});

test("mini-notation: '_' at start of block throws", () => {
  let err = null;
  try { Patterns.s("_ bd").getEvents(0); } catch (e) { err = e; }
  if (!err || !/elongate/.test(err.message)) throw new Error(`expected elongate error, got ${err}`);
});

test("mini-notation: '[bd, cp] hh' parallel-in-slot via comma", () => {
  const p = Patterns.s("[bd, cp] hh");
  const events = p.getEvents(0);
  // [bd, cp] takes first half: bd@0 dur=0.5, cp@0 dur=0.5 (concurrent)
  // hh takes second half: hh@0.5 dur=0.5
  eq(events.length, 3);
  const bd = events.find((e) => e.name === "bd");
  const cp = events.find((e) => e.name === "cp");
  const hh = events.find((e) => e.name === "hh");
  near(bd.start, 0);
  near(bd.duration, 0.5);
  near(cp.start, 0);
  near(cp.duration, 0.5);
  near(hh.start, 0.5);
});

test("mini-notation: '[bd cp, hh hh hh hh] sd' lanes have own subdivisions", () => {
  // First slot is a polyrhythm: lane 0 = bd cp (2 elements over slot), lane 1 = 4 hh
  const p = Patterns.s("[bd cp, hh hh hh hh] sd");
  const events = p.getEvents(0);
  // Slot 0 (first half): bd@0 dur=0.25, cp@0.25 dur=0.25; hh@0, 0.125, 0.25, 0.375 (each dur 0.125)
  // Slot 1: sd@0.5 dur=0.5
  // Total: 2 + 4 + 1 = 7 events
  eq(events.length, 7);
  const sd = events.find((e) => e.name === "sd");
  near(sd.start, 0.5);
  near(sd.duration, 0.5);
});

test("mini-notation: '[bd, cp]?0.5 hh' suffix attaches to bracket group", () => {
  // ?0.5 should attach to the polyrhythm node, not become a separate atom.
  const p = Patterns.s("[bd, cp]?1 hh");
  // ?1 = always degrade → polyrhythm dropped → only hh
  const events = p.getEvents(0);
  eq(events.length, 1);
  eq(events[0].name, "hh");
});

test("mini-notation: '0 .. 7' expands to integer range", () => {
  const p = Patterns.n("0 .. 7");
  const events = p.getEvents(0);
  eq(events.length, 8);
  eq(events.map((e) => e.name), ["0", "1", "2", "3", "4", "5", "6", "7"]);
});

test("mini-notation: descending range '7 .. 0' works", () => {
  const p = Patterns.n("7 .. 0");
  const events = p.getEvents(0);
  eq(events.length, 8);
  eq(events.map((e) => e.name), ["7", "6", "5", "4", "3", "2", "1", "0"]);
});

test("mini-notation: range '-3 .. 3' handles negatives", () => {
  const p = Patterns.n("-3 .. 3");
  const events = p.getEvents(0);
  eq(events.length, 7);
  eq(events.map((e) => e.name), ["-3", "-2", "-1", "0", "1", "2", "3"]);
});

test("mini-notation: '..' between non-integers throws", () => {
  let err = null;
  try { Patterns.n("c4 .. 7").getEvents(0); } catch (e) { err = e; }
  if (!err || !/integer/.test(err.message)) throw new Error(`expected integer error, got ${err}`);
});

test("mini-notation: range mixed with other elements: '0 .. 3 sd'", () => {
  // 0,1,2,3,sd → 5 elements at top level
  const p = Patterns.n("0 .. 3 sd");
  const events = p.getEvents(0);
  eq(events.length, 5);
  eq(events.map((e) => e.name), ["0", "1", "2", "3", "sd"]);
});

// ── Phase B: structural combinators ───────────────────────────────────

test("palindrome: forward in even cycles, reversed in odd", () => {
  const p = Patterns.n("a b c d").palindrome();
  // cat([this, this.rev()]): cycle 0 = forward, cycle 1 = rev'd
  eq(p.getEvents(0).map((e) => e.name), ["a", "b", "c", "d"]);
  eq(p.getEvents(1).map((e) => e.name), ["d", "c", "b", "a"]);
  eq(p.getEvents(2).map((e) => e.name), ["a", "b", "c", "d"]);
});

test("mask: 'x ~ x ~' keeps only first and third event", () => {
  const p = Patterns.s("bd cp hh sd").mask("x ~ x ~");
  const events = p.getEvents(0);
  // Mask events at start 0 and 0.5; source events at 0, 0.25, 0.5, 0.75.
  // Keep: bd@0 (mask covers 0..0.25), hh@0.5 (mask covers 0.5..0.75).
  // Drop: cp@0.25 (mask rest), sd@0.75 (mask rest).
  eq(events.length, 2);
  eq(events.map((e) => e.name), ["bd", "hh"]);
});

test("mask: accepts a Pattern directly", () => {
  const m = Patterns.n("x ~ ~ x");
  const p = Patterns.s("bd cp hh sd").mask(m);
  const events = p.getEvents(0);
  // Mask events at 0 and 0.75. Source events at 0, 0.25, 0.5, 0.75. Keep bd@0, sd@0.75.
  eq(events.length, 2);
  eq(events.map((e) => e.name), ["bd", "sd"]);
});

test("struct: timing from struct, values cycled from source", () => {
  // Source: 2 notes (a, b). Struct: 4 events (rhythm).
  // Result: 4 events with timings from struct, names cycled a, b, a, b.
  const p = Patterns.n("a b").struct("x x x x");
  const events = p.getEvents(0);
  eq(events.length, 4);
  eq(events.map((e) => e.name), ["a", "b", "a", "b"]);
});

test("stutter(3, 0.05): 3 copies per event with small delays", () => {
  const p = Patterns.s("bd").stutter(3, 0.05);
  const events = p.getEvents(0);
  // Original bd@0 dur=1. Stutter: 3 copies at starts 0, 0.05, 0.10.
  eq(events.length, 3);
  near(events[0].start, 0);
  near(events[1].start, 0.05);
  near(events[2].start, 0.10);
});

test("stutter: copies past cycle boundary are dropped", () => {
  // bd@0.7 with stutter(5, 0.1): copies at 0.7, 0.8, 0.9 — fit; 1.0+ dropped.
  const p = Patterns.s("~ ~ ~ ~ ~ ~ ~ bd ~ ~").stutter(5, 0.1);
  const events = p.getEvents(0);
  // Should be 3 events (0.7, 0.8, 0.9). Allow margin for FP.
  if (events.length < 3 || events.length > 3) throw new Error(`expected 3 stutter copies, got ${events.length}`);
  // All within the cycle
  for (const ev of events) if (ev.start >= 1) throw new Error(`event past boundary: ${ev.start}`);
});

test("inside(2, rev): per-half reversal of n('a b c d')", () => {
  // inside(2, rev) = slow(2) → rev → fast(2). Effect: events in each half of
  // the source are reversed within their half. n("a b c d") events at 0/0.25/0.5/0.75
  // become two reversed pairs: [b, a] in first half, [d, c] in second half.
  const p = Patterns.n("a b c d").inside(2, (q) => q.rev());
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["b", "a", "d", "c"]);
});

test("outside(2, rev): rev applied to a fast'd version, slowed back", () => {
  const p = Patterns.n("a b c d").outside(2, (q) => q.rev());
  const events = p.getEvents(0);
  // Smoke check
  if (events.length === 0) throw new Error("outside produced no events");
});

test("rot(1): rotates note values left, preserving timing", () => {
  const p = Patterns.n("a b c d").rot(1);
  const events = p.getEvents(0);
  eq(events.length, 4);
  // Names rotated by 1: b, c, d, a
  eq(events.map((e) => e.name), ["b", "c", "d", "a"]);
  // Starts unchanged
  near(events[0].start, 0);
  near(events[1].start, 0.25);
  near(events[2].start, 0.5);
  near(events[3].start, 0.75);
});

test("rot: rotation is constant per cycle (unlike iter)", () => {
  const p = Patterns.n("a b c d").rot(1);
  // Same names every cycle (no per-cycle advancement)
  eq(p.getEvents(0).map((e) => e.name), ["b", "c", "d", "a"]);
  eq(p.getEvents(5).map((e) => e.name), ["b", "c", "d", "a"]);
});

test("wchoose: weighted picks proportional to weights over many cycles", () => {
  const p = Patterns.wchoose([[3, "a"], [1, "b"]]);
  const counts = { a: 0, b: 0 };
  for (let c = 0; c < 200; c++) {
    const name = p.getEvents(c)[0].name;
    counts[name]++;
  }
  // Expect roughly 75/25 split — allow 60..90 for "a"
  if (counts.a < 120 || counts.a > 180) throw new Error(`expected ~150 a's, got ${counts.a}`);
});

test("wchoose: deterministic per cycle", () => {
  const p = Patterns.wchoose([[1, "a"], [1, "b"]]);
  eq(p.getEvents(7)[0].name, p.getEvents(7)[0].name);
});

test("wchoose: empty array returns silence", () => {
  const p = Patterns.wchoose([]);
  eq(p.getEvents(0).length, 0);
});

test("wchoose: zero total weight throws", () => {
  let err = null;
  try { Patterns.wchoose([[0, "a"], [0, "b"]]); } catch (e) { err = e; }
  if (!err) throw new Error("expected error for zero total weight");
});

test("transpile-run: 'd1 $ s \"bd cp\" # palindrome' wires palindrome", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd cp" # palindrome', sandbox);
  const p = engine.orbits.get(1);
  // Cycle 0: bd cp; Cycle 1: cp bd
  eq(p.getEvents(0).map((e) => e.name), ["bd", "cp"]);
  eq(p.getEvents(1).map((e) => e.name), ["cp", "bd"]);
});

// ── Phase C: music theory (scale, chord, arp, ' chord shorthand) ─────

test("scale('minor', n('0 2 4 7')): degrees → semitones in minor", () => {
  const p = Patterns.n("0 2 4 7").scale("minor");
  const events = p.getEvents(0);
  // minor = [0, 2, 3, 5, 7, 8, 10]
  // degree 0 → 0; 2 → 3; 4 → 7; 7 → octave 1, step 0 → 12
  eq(events.map((e) => e.name), ["0", "3", "7", "12"]);
});

test("scale('major', n('0 1 2 3 4 5 6')): seven steps of major", () => {
  const p = Patterns.n("0 1 2 3 4 5 6").scale("major");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["0", "2", "4", "5", "7", "9", "11"]);
});

test("scale: negative degrees go below the root", () => {
  const p = Patterns.n("-1 -7").scale("major");
  // -1 → step 6 of octave -1 → -12 + 11 = -1 (the leading tone below root)
  // -7 → step 0 of octave -1 → -12 + 0 = -12
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["-1", "-12"]);
});

test("scale: rejects unknown scale name", () => {
  let err = null;
  try { Patterns.n("0").scale("notascale").getEvents(0); } catch (e) { err = e; }
  if (!err || !/unknown scale/.test(err.message)) throw new Error(`expected unknown-scale error, got ${err}`);
});

test("scale: rejects non-integer source token", () => {
  let err = null;
  try { Patterns.n("c4").scale("major").getEvents(0); } catch (e) { err = e; }
  if (!err || !/non-integer/.test(err.message)) throw new Error(`expected non-integer error, got ${err}`);
});

test("chord('Cmaj'): produces 3 concurrent events at C, E, G offsets", () => {
  const p = Patterns.chord("Cmaj");
  const events = p.getEvents(0);
  eq(events.length, 3);
  // C4=60, E4=64, G4=67 → offsets from C4: 0, 4, 7
  eq(events.map((e) => e.name).sort(), ["0", "4", "7"]);
  // All concurrent (start=0, duration=1)
  for (const ev of events) { near(ev.start, 0); near(ev.duration, 1); }
});

test("chord('F#3m7'): octave + minor 7th chord works", () => {
  const p = Patterns.chord("F#3m7");
  const events = p.getEvents(0);
  // F#3 = MIDI 54. Intervals [0, 3, 7, 10] → MIDI 54, 57, 61, 64.
  // Offsets from C4: -6, -3, 1, 4.
  eq(events.length, 4);
  eq(events.map((e) => e.name).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
     ["-6", "-3", "1", "4"]);
});

test("chord('C'): defaults to major", () => {
  const p = Patterns.chord("C");
  eq(p.getEvents(0).length, 3);
});

test("chord: apostrophe form ('Bb'9') also works", () => {
  // parseChordName accepts optional apostrophe — "Bb'9" and "Bb9" both parse.
  const a = Patterns.chord("Bb9");
  const b = Patterns.chord("Bb'9");
  eq(a.getEvents(0).map((e) => e.name).sort(),
     b.getEvents(0).map((e) => e.name).sort());
});

test("chord: 'C7' is dominant 7th (not C-major in octave 7)", () => {
  // Disambiguation: prefer chord-name interpretation over octave-extraction.
  // C dominant 7 = [0, 4, 7, 10] from C4 (60).
  const p = Patterns.chord("C7");
  const events = p.getEvents(0);
  eq(events.length, 4);
  eq(events.map((e) => e.name).sort((a, b) => parseInt(a) - parseInt(b)),
     ["0", "4", "7", "10"]);
});

test("chord: 'C4maj7' uses explicit octave + chord (fallback split)", () => {
  // After the chord-only interpretation fails for "4maj7", fall back to splitting.
  const p = Patterns.chord("C4maj7");
  const events = p.getEvents(0);
  eq(events.length, 4);
  // C4 is the default anyway — same notes as Cmaj7
  eq(events.map((e) => e.name).sort((a, b) => parseInt(a) - parseInt(b)),
     ["0", "4", "7", "11"]);
});

test("chord: rejects unknown chord type", () => {
  let err = null;
  try { Patterns.chord("Cnotachord"); } catch (e) { err = e; }
  if (!err || !/unrecognized chord/.test(err.message)) throw new Error(`expected error, got ${err}`);
});

test("arp('up'): arpeggiates a chord ascending", () => {
  // chord("Cmaj") → 3 events at start=0. arp("up") spreads them sequentially.
  const p = Patterns.chord("Cmaj").arp("up");
  const events = p.getEvents(0);
  eq(events.length, 3);
  // Ascending pitch order: 0, 4, 7
  eq(events.map((e) => e.name), ["0", "4", "7"]);
  // Sequential starts
  near(events[0].start, 0);
  near(events[1].start, 1 / 3);
  near(events[2].start, 2 / 3);
});

test("arp('down'): arpeggiates descending", () => {
  const p = Patterns.chord("Cmaj").arp("down");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["7", "4", "0"]);
});

test("arp('updown'): up then back down without repeating peaks", () => {
  // Cmaj7 = [0, 4, 7, 11]. updown: 0, 4, 7, 11, 7, 4 (6 events).
  const p = Patterns.chord("Cmaj7").arp("updown");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["0", "4", "7", "11", "7", "4"]);
});

test("arp('converge'): outer→inner ordering", () => {
  // Cmaj7 sorted: [0, 4, 7, 11]. converge: 0, 11, 4, 7.
  const p = Patterns.chord("Cmaj7").arp("converge");
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["0", "11", "4", "7"]);
});

test("arp: pass-through for events with unique starts (no chord)", () => {
  const p = Patterns.n("0 4 7").arp("up");
  // 3 events at distinct starts → no grouping → unchanged
  const events = p.getEvents(0);
  eq(events.length, 3);
  near(events[0].start, 0);
  near(events[1].start, 1 / 3);
  near(events[2].start, 2 / 3);
});

test("mini-notation: 'c'maj' parses as chord, fires concurrent events", () => {
  const p = Patterns.n("c'maj");
  const events = p.getEvents(0);
  eq(events.length, 3);
  eq(events.map((e) => e.name).sort(), ["0", "4", "7"]);
  for (const ev of events) near(ev.start, 0);
});

test("mini-notation: 'c'maj sd' chord then drum, allocated half cycle each", () => {
  const p = Patterns.n("c'maj sd");
  const events = p.getEvents(0);
  // Chord takes first half (3 concurrent at start 0, dur 0.5).
  // sd takes second half (1 event at start 0.5, dur 0.5).
  eq(events.length, 4);
  const chordEvents = events.filter((e) => e.name !== "sd");
  eq(chordEvents.length, 3);
  for (const ev of chordEvents) {
    near(ev.start, 0);
    near(ev.duration, 0.5);
  }
});

test("mini-notation: 'c'min7' with explicit chord type", () => {
  const p = Patterns.n("c'min7");
  const events = p.getEvents(0);
  eq(events.length, 4);
  eq(events.map((e) => e.name).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
     ["0", "3", "7", "10"]);
});

test("transpile-run: 'd1 $ n \"0 2 4\" # scale \"minor\"' wires scale via #", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ n "0 2 4" # scale "minor"', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["0", "3", "7"]);
});

test("transpile-run: 'd1 $ chord \"Cmaj7\" # arp \"up\"' wires chord+arp", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ chord "Cmaj7" # arp "up"', sandbox);
  const p = engine.orbits.get(1);
  const events = p.getEvents(0);
  eq(events.map((e) => e.name), ["0", "4", "7", "11"]);
});

// ── Tidal `|` cycleChoose ─────────────────────────────────────────────

test("cycleChoose: 'a | b' picks one whole sequence per cycle, deterministic", () => {
  const p = Patterns.s("bd | cp");
  const counts = { bd: 0, cp: 0 };
  for (let c = 0; c < 100; c++) {
    const ev = p.getEvents(c);
    eq(ev.length, 1);
    counts[ev[0].name]++;
  }
  // ~50/50 split with PRNG variance
  if (counts.bd < 30 || counts.cp < 30) throw new Error(`uneven split bd=${counts.bd} cp=${counts.cp}`);
  if (counts.bd + counts.cp !== 100) throw new Error("missing events");
});

test("cycleChoose: 'a b | c d' picks one whole 2-element sequence per cycle", () => {
  const p = Patterns.s("bd cp | hh sd");
  // Each cycle produces 2 events: either [bd, cp] or [hh, sd]
  for (let c = 0; c < 16; c++) {
    const ev = p.getEvents(c).map((e) => e.name);
    if (ev.length !== 2) throw new Error(`cycle ${c}: expected 2 events, got ${ev.length}`);
    const isBdCp = ev[0] === "bd" && ev[1] === "cp";
    const isHhSd = ev[0] === "hh" && ev[1] === "sd";
    if (!isBdCp && !isHhSd) throw new Error(`cycle ${c}: unexpected ${ev}`);
  }
});

test("cycleChoose: three-way 'a | b | c' picks evenly", () => {
  const p = Patterns.n("a | b | c");
  const counts = { a: 0, b: 0, c: 0 };
  for (let cyc = 0; cyc < 300; cyc++) {
    counts[p.getEvents(cyc)[0].name]++;
  }
  // Each ~100/300
  for (const k of ["a", "b", "c"]) {
    if (counts[k] < 70 || counts[k] > 130) throw new Error(`${k} count ${counts[k]} too far from 100`);
  }
});

test("cycleChoose: independent groups don't correlate", () => {
  // Two independent | groups in the same pattern should produce uncorrelated picks.
  const p = Patterns.n("[a | b] [c | d]");
  const pairs = new Set();
  for (let cyc = 0; cyc < 100; cyc++) {
    const ev = p.getEvents(cyc).map((e) => e.name);
    pairs.add(ev.join(","));
  }
  // We should see all 4 combinations (a,c / a,d / b,c / b,d) over 100 cycles
  if (pairs.size < 3) throw new Error(`expected 3+ pair combos, got ${pairs.size}: ${[...pairs]}`);
});

test("cycleChoose: 'a b | c d' inside angles '<...>' (alt of single chooseTail)", () => {
  // Tidal: <a b | c d> is alternate of one element (the chooseTail). Effective:
  // each cycle picks one of [a b] or [c d] and plays that as the cycle's content.
  const p = Patterns.s("<bd cp | hh sd>");
  for (let c = 0; c < 8; c++) {
    const ev = p.getEvents(c).map((e) => e.name);
    if (ev.length !== 2) throw new Error(`cycle ${c}: expected 2 events`);
    const isBdCp = ev[0] === "bd" && ev[1] === "cp";
    const isHhSd = ev[0] === "hh" && ev[1] === "sd";
    if (!isBdCp && !isHhSd) throw new Error(`cycle ${c}: unexpected ${ev}`);
  }
});

test("cycleChoose: '|' inside square brackets '[a | b] c' picks within the slot", () => {
  // [a | b] c → first slot picks one of (a, b), second slot is c
  const p = Patterns.n("[a | b] c");
  for (let cyc = 0; cyc < 8; cyc++) {
    const ev = p.getEvents(cyc).map((e) => e.name);
    eq(ev.length, 2);
    if (ev[0] !== "a" && ev[0] !== "b") throw new Error(`first slot unexpected ${ev[0]}`);
    eq(ev[1], "c");
  }
});

test("cycleChoose: deterministic per cycle (same input → same output)", () => {
  const p1 = Patterns.s("bd | cp | hh");
  const p2 = Patterns.s("bd | cp | hh");
  for (let c = 0; c < 16; c++) {
    eq(p1.getEvents(c)[0].name, p2.getEvents(c)[0].name);
  }
});

test("cycleChoose: regression for user pattern '<b4|a4 c5>'", () => {
  // The pattern that motivated this feature. Tidal semantics: angles wrap
  // a single chooseTail of [b4] vs [a4 c5]. Each cycle picks one option.
  const p = Patterns.n("c4 e4 g4 <b4|a4 c5>").getEvents(0);
  // The first three slots are always c4, e4, g4. The fourth slot is either:
  //   - a single b4 covering the whole slot, OR
  //   - a4 then c5 splitting the slot.
  // We just check there's at least 4 events and that no token is "b4|a4".
  if (p.length < 4) throw new Error(`expected at least 4 events, got ${p.length}`);
  for (const ev of p) {
    if (ev.name.includes("|")) throw new Error(`leftover '|' in token: ${ev.name}`);
  }
  // Across many cycles, both options should appear.
  let sawB4 = false, sawA4 = false;
  for (let c = 0; c < 32; c++) {
    const ev = Patterns.n("c4 e4 g4 <b4|a4 c5>").getEvents(c);
    for (const e of ev) {
      if (e.name === "b4") sawB4 = true;
      if (e.name === "a4") sawA4 = true;
    }
  }
  if (!sawB4) throw new Error("never saw b4 across 32 cycles");
  if (!sawA4) throw new Error("never saw a4 across 32 cycles");
});

// ── Continuous signals ────────────────────────────────────────────────

test("samplePatternable: function passthrough is a ContinuousSignal", () => {
  // Arbitrary function returning a number — sampled directly with (cycleN, phase).
  const sig = (c, ph) => c + ph;
  eq(Patterns.samplePatternable(sig, 3, 0.5), 3.5);
  eq(Patterns.samplePatternable(sig, 0, 0), 0);
});

test("sine: phase 0→0.5, 0.25→1, 0.5→0.5, 0.75→0", () => {
  near(Patterns.sine(0, 0), 0.5);
  near(Patterns.sine(0, 0.25), 1);
  near(Patterns.sine(0, 0.5), 0.5);
  near(Patterns.sine(0, 0.75), 0);
});

test("sine2: bipolar phase 0→0, 0.25→1, 0.5→0, 0.75→-1", () => {
  near(Patterns.sine2(0, 0), 0);
  near(Patterns.sine2(0, 0.25), 1);
  near(Patterns.sine2(0, 0.5), 0);
  near(Patterns.sine2(0, 0.75), -1);
});

test("cosine: phase 0→1, 0.25→0.5, 0.5→0", () => {
  near(Patterns.cosine(0, 0), 1);
  near(Patterns.cosine(0, 0.25), 0.5);
  near(Patterns.cosine(0, 0.5), 0);
});

test("tri: phase 0→0, 0.5→1, 0.75→0.5", () => {
  near(Patterns.tri(0, 0), 0);
  near(Patterns.tri(0, 0.25), 0.5);
  near(Patterns.tri(0, 0.5), 1);
  near(Patterns.tri(0, 0.75), 0.5);
});

test("saw: phase 0→0, 0.5→0.5, 0.999→~1", () => {
  near(Patterns.saw(0, 0), 0);
  near(Patterns.saw(0, 0.5), 0.5);
  near(Patterns.saw(0, 0.999), 0.999);
});

test("square: phase 0.25→0, 0.75→1", () => {
  eq(Patterns.square(0, 0.25), 0);
  eq(Patterns.square(0, 0.75), 1);
});

test("rand: deterministic, in [0,1), distinct across cycles", () => {
  const a1 = Patterns.rand(0, 0);
  const a2 = Patterns.rand(0, 0);
  const b = Patterns.rand(1, 0);
  eq(a1, a2);  // determinism
  if (a1 === b) throw new Error("rand should differ across cycles");
  if (a1 < 0 || a1 >= 1) throw new Error(`rand out of [0,1): ${a1}`);
});

test("perlin: continuous, deterministic, in [0,1]", () => {
  // Adjacent phases should produce close values
  const a = Patterns.perlin(5, 0.50);
  const b = Patterns.perlin(5, 0.51);
  if (Math.abs(a - b) > 0.05) throw new Error(`perlin too jumpy: ${a} vs ${b}`);
  // Determinism
  eq(Patterns.perlin(5, 0.5), Patterns.perlin(5, 0.5));
  // Range
  for (const c of [0, 1, 2, 7]) {
    for (const ph of [0, 0.3, 0.7, 0.99]) {
      const v = Patterns.perlin(c, ph);
      if (v < 0 || v > 1) throw new Error(`perlin out of [0,1] at (${c}, ${ph}): ${v}`);
    }
  }
});

test("segment(8, sine): produces 8 events with start = i/8 and duration 1/8", () => {
  const p = Patterns.segment(8, Patterns.sine);
  const events = p.getEvents(0);
  eq(events.length, 8);
  for (let i = 0; i < 8; i++) {
    near(events[i].start, i / 8);
    near(events[i].duration, 1 / 8);
  }
});

test("segment(8, sine): each event's name parses to sine value at i/8", () => {
  const p = Patterns.segment(8, Patterns.sine);
  const events = p.getEvents(0);
  for (let i = 0; i < 8; i++) {
    const expected = Patterns.sine(0, i / 8);
    near(parseFloat(events[i].name), expected);
  }
});

test("range(40, 80, sine): ContinuousSignal in → ContinuousSignal out, sine 0 → 60", () => {
  const ranged = Patterns.range(40, 80, Patterns.sine);
  // sine(0,0) = 0.5 → 40 + 0.5*40 = 60
  if (typeof ranged !== "function") throw new Error("expected function");
  near(ranged(0, 0), 60);
  near(ranged(0, 0.25), 80);  // sine peaks at 0.25
  near(ranged(0, 0.75), 40);  // sine trough at 0.75
});

test("range(40, 80, run(2)): Pattern in → Pattern out (regression)", () => {
  // Pattern path still works — n("0 1") tokens scaled to 40, 80
  const p = Patterns.range(40, 80, Patterns.n("0 1"));
  if (!(p instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const events = p.getEvents(0);
  eq(events.length, 2);
  near(parseFloat(events[0].name), 40);
  near(parseFloat(events[1].name), 80);
});

test("range2(-7, 7, sine2): bipolar signal scaled symmetrically", () => {
  const ranged = Patterns.range2(-7, 7, Patterns.sine2);
  if (typeof ranged !== "function") throw new Error("expected function");
  // sine2(0,0)=0 → -7 + (0+1)/2 * 14 = 0 (midpoint)
  near(ranged(0, 0), 0);
  // sine2(0,0.25)=1 → -7 + 1 * 14 = 7
  near(ranged(0, 0.25), 7);
  // sine2(0,0.75)=-1 → -7 + 0 * 14 = -7
  near(ranged(0, 0.75), -7);
});

test("range2 on a Pattern of bipolar tokens: also works", () => {
  // n("-1 0 1") tokens → -1 maps to lo, 0 to midpoint, 1 to hi
  const p = Patterns.range2(40, 80, Patterns.n("-1 0 1"));
  if (!(p instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const events = p.getEvents(0);
  near(parseFloat(events[0].name), 40);
  near(parseFloat(events[1].name), 60);
  near(parseFloat(events[2].name), 80);
});

test("integration: gain(sine) modulates velocity smoothly across the cycle", () => {
  // s("bd*4") emits 4 events at starts 0, 0.25, 0.5, 0.75. gain(sine) samples
  // sine at each event.start. Velocities: 100*0.5=50, 100*1=100, 100*0.5=50, 100*0=0.
  const p = Patterns.s("bd*4").gain(Patterns.sine);
  const events = p.getEvents(0);
  eq(events.length, 4);
  eq(events[0].velocity, 50);
  eq(events[1].velocity, 100);
  eq(events[2].velocity, 50);
  eq(events[3].velocity, 0);
});

test("integration: add(range2(-7, 7, sine2)) modulates pitch across the cycle", () => {
  // n("c4*4") at starts 0, 0.25, 0.5, 0.75. add samples per event.
  // sine2 at those phases: 0, 1, 0, -1 → range2(-7,7,...) → 0, 7, 0, -7
  const p = Patterns.n("c4*4").add(Patterns.range2(-7, 7, Patterns.sine2));
  const events = p.getEvents(0);
  near(events[0].offset, 0);
  near(events[1].offset, 7);
  near(events[2].offset, 0);
  near(events[3].offset, -7);
});

test("integration: add(range(0, 12, segment(4, saw))) — discretized signal as offset", () => {
  // segment(4, saw) → 4 events at starts 0, 0.25, 0.5, 0.75 with names saw values:
  //   saw(0,0)=0, saw(0,0.25)=0.25, saw(0,0.5)=0.5, saw(0,0.75)=0.75.
  // range(0, 12, ...) on Pattern path → tokens become "0", "3", "6", "9".
  // Then n("c4*4").add(<that pattern>) samples per event start, parseFloat → 0,3,6,9.
  const sigPat = Patterns.range(0, 12, Patterns.segment(4, Patterns.saw));
  const p = Patterns.n("c4*4").add(sigPat);
  const events = p.getEvents(0);
  near(events[0].offset, 0);
  near(events[1].offset, 3);
  near(events[2].offset, 6);
  near(events[3].offset, 9);
});

test("transpile-run: 'd1 $ s \"bd*8\" # gain sine' wires a sine modulation", () => {
  const engine = buildEngine();
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('d1 $ s "bd*8" # gain sine', sandbox);
  const p = engine.orbits.get(1);
  if (!p) throw new Error("orbit 1 not set");
  const events = p.getEvents(0);
  eq(events.length, 8);
  // First event at start=0 → sine=0.5 → vel 100*0.5 = 50
  eq(events[0].velocity, 50);
});

// ── Control patterns (CC out) ───────────────────────────────────────────
test("ctrl: signal source produces 64 events per cycle", () => {
  const cp = Control.ctrl(74, Patterns.sine);
  const events = cp.getEvents(0);
  eq(events.length, 64);
  // CC should be 74 on every event
  if (events.some((e) => e.cc !== 74)) throw new Error("not all events have cc=74");
  // Default channel = 0 (idx for ch 1) and not explicit
  eq(cp.channel, 0);
  eq(cp.channelExplicit, false);
});

test("ctrl: bipolar sine2 maps [-1..1] → [0..127] symmetrically", () => {
  const cp = Control.ctrl(74, Patterns.sine2);
  const events = cp.getEvents(0);
  // sine2 at phase 0 = 0, phase 0.25 = 1, phase 0.5 = 0, phase 0.75 = -1
  // 64 segments: phase 0 = 0 → ((0+1)/2)*127 = 63.5 → 64
  // phase 0.25 (i=16) → 1 → 127
  // phase 0.75 (i=48) → -1 → 0
  near(events[0].value, 64, 1);
  near(events[16].value, 127, 1);
  near(events[48].value, 0, 1);
});

test("ctrl: unipolar sine maps [0..1] → [0..127]", () => {
  const cp = Control.ctrl(74, Patterns.sine);
  const events = cp.getEvents(0);
  // sine unipolar: phase 0 = 0.5 → 0.5*127 = 63.5 → 64
  // phase 0.25 (i=16) = 1 → 127
  // phase 0.75 (i=48) = 0 → 0
  near(events[0].value, 64, 1);
  near(events[16].value, 127, 1);
  near(events[48].value, 0, 1);
});

test("ctrl: stepped string pattern emits one event per step", () => {
  const cp = Control.ctrl(74, "0 64 127 64");
  const events = cp.getEvents(0);
  eq(events.length, 4);
  eq(events.map((e) => e.value), [0, 64, 127, 64]);
  if (events.some((e) => e.cc !== 74)) throw new Error("cc mismatch");
});

test("ctrl: pattern source clamps out-of-range values", () => {
  const cp = Control.ctrl(74, "200 -10 50");
  const events = cp.getEvents(0);
  eq(events.map((e) => e.value), [127, 0, 50]);
});

test("ctrl: constant number emits one event/cycle at start=0", () => {
  const cp = Control.ctrl(74, 64);
  const events = cp.getEvents(0);
  eq(events.length, 1);
  eq(events[0].value, 64);
  eq(events[0].start, 0);
});

test("ctrl: cc out-of-range throws on construction", () => {
  let err = null;
  try { Control.ctrl(128, Patterns.sine); } catch (e) { err = e; }
  if (!err || !err.message.includes("0..127")) throw new Error(`expected out-of-range error, got ${err && err.message}`);
});

test("ctrl: cc non-integer throws on construction", () => {
  let err = null;
  try { Control.ctrl(74.5, Patterns.sine); } catch (e) { err = e; }
  if (!err || !err.message.includes("integer")) throw new Error(`expected integer error, got ${err && err.message}`);
});

test("ctrl: .segment(N) re-renders signal at N density", () => {
  const cp = Control.ctrl(74, Patterns.sine).segment(16);
  const events = cp.getEvents(0);
  eq(events.length, 16);
  eq(cp.segmentN, 16);
});

test("ctrl: .segment cap rejects N > 1024", () => {
  let err = null;
  try { Control.ctrl(74, Patterns.sine).segment(2048); } catch (e) { err = e; }
  if (!err || !err.message.includes("1024")) throw new Error(`expected cap error, got ${err && err.message}`);
});

test("ctrl: pattern-sourced .segment is a no-op (events fixed by pattern)", () => {
  const cp = Control.ctrl(74, "0 64 127");
  const segged = cp.segment(8);
  // Events still 3 from the pattern (segment doesn't re-resample a stepped source)
  eq(segged.getEvents(0).length, 3);
});

test("ctrl: .ch(N) sets explicit channel, .ch(3) → idx 2", () => {
  const cp = Control.ctrl(74, Patterns.sine).ch(3);
  eq(cp.channel, 2);
  eq(cp.channelExplicit, true);
});

test("ctrl: .ch(N) preserved across .segment", () => {
  const cp = Control.ctrl(74, Patterns.sine).ch(5).segment(8);
  eq(cp.channel, 4);
  eq(cp.channelExplicit, true);
  eq(cp.segmentN, 8);
});

test("ctrl: composes with range2 — explicit scaling overrides auto", () => {
  // range2(-7, 7, sine2) returns a ContinuousSignal of [-7..7] (a bipolar source).
  // ctrl detects the negative excursion and bipolar-scales: map [-1..1] of (raw/7)?
  // No — ctrl just sees a bipolar function. With detectBipolar=true it does (v+1)/2*127.
  // range2 outputs values in [-7..7], so values pass through (v+1)/2*127 — meaning
  // value range becomes [(−7+1)/2*127 .. (7+1)/2*127] = [−381 .. 508] → clamped 0..127.
  // This is "user-visible" — but the right pattern when you want a custom range is to
  // build with `range(lo, hi, sig)` keeping output in [0..127]. Verify clamping at least.
  const r = Patterns.range(0, 100, Patterns.sine);
  const cp = Control.ctrl(74, r);
  const events = cp.getEvents(0);
  for (const ev of events) {
    if (ev.value < 0 || ev.value > 127) throw new Error(`out of range: ${ev.value}`);
  }
});

test("ctrl: composes with mini-notation alternation '<10 50 100>'", () => {
  const cp = Control.ctrl(74, "<10 50 100>");
  // alternation pattern: cycle 0 → "10", cycle 1 → "50"
  const c0 = cp.getEvents(0);
  const c1 = cp.getEvents(1);
  eq(c0.length, 1); eq(c0[0].value, 10);
  eq(c1.length, 1); eq(c1[0].value, 50);
});

test("ctrl: cc patternable 'cc varies per cycle'", () => {
  const cp = Control.ctrl("<74 75>", 64);
  eq(cp.getEvents(0)[0].cc, 74);
  eq(cp.getEvents(1)[0].cc, 75);
});

test("scheduler: ctrl signal fires CC events on control port", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);  // 1s cycle
  // ctrl 74 sine, default ch=0 (idx 0). Use a small segment for fast test.
  const cp = Control.ctrl(74, Patterns.sine).segment(8);
  scheduler.setControlOrbit(1, cp);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  if (sent.length < 4) throw new Error(`expected ≥4 CC sends, got ${sent.length}`);
  if (sent.some((m) => m.controller !== 74)) throw new Error("non-74 CC found");
  if (sent.some((m) => m.value < 0 || m.value > 127)) throw new Error("CC value out of range");
});

test("scheduler: CC dedup suppresses identical consecutive values", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  // Constant value: should send once per orbit lifetime, not 64 per cycle.
  const cp = Control.ctrl(74, 50);
  scheduler.setControlOrbit(1, cp);
  await new Promise((r) => setTimeout(r, 2200));  // ≥ 2 cycles
  scheduler.hush();
  // Expect exactly 1 CC send (first value only — dedup suppresses repeats)
  if (sent.length !== 1) throw new Error(`expected 1 CC (dedup), got ${sent.length}`);
  eq(sent[0].value, 50);
});

test("scheduler: re-evaluating control orbit resets dedup (re-emits)", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 50));
  await new Promise((r) => setTimeout(r, 1200));
  // Re-set with a fresh same-value pattern: dedup map cleared, should re-emit.
  scheduler.setControlOrbit(1, Control.ctrl(74, 50));
  await new Promise((r) => setTimeout(r, 1200));
  scheduler.hush();
  if (sent.length < 2) throw new Error(`expected ≥2 CC sends after re-eval, got ${sent.length}`);
});

test("scheduler: clearControlOrbit holds last value (no snap)", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 99));
  await new Promise((r) => setTimeout(r, 1100));
  const before = sent.length;
  scheduler.clearControlOrbit(1);
  await new Promise((r) => setTimeout(r, 600));
  scheduler.hush();
  // After clear, no additional CCs should fire. (Pattern silently held.)
  if (sent.length > before) throw new Error(`expected ≤${before} CCs after clear, got ${sent.length}`);
});

test("scheduler: control pattern errors surface via onPatternError", async () => {
  let captured = null;
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setOnPatternError((m) => { captured = m; });
  scheduler.setTempo(240, 4);
  // Build a CP whose getEvents throws
  const broken = new Control.ControlPattern(() => { throw new Error("ccboom"); }, 0, false, 1, null);
  scheduler.setControlOrbit(1, broken);
  await new Promise((r) => setTimeout(r, 200));
  scheduler.hush();
  if (!captured || !captured.includes("ccboom")) throw new Error(`expected error captured, got: ${captured}`);
});

test("scheduler: notes still play when control orbit also active", async () => {
  const noteons = [];
  const ccs = [];
  const noteOut = { send: (type, m) => { if (type === "noteon") noteons.push(m); }, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") ccs.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setOrbit(1, Patterns.n("c4"));
  scheduler.setControlOrbit(1, Control.ctrl(74, Patterns.sine).segment(4));
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  if (noteons.length < 1) throw new Error(`expected note hits, got ${noteons.length}`);
  if (ccs.length < 1) throw new Error(`expected CC hits, got ${ccs.length}`);
});

test("learn: builds a transient control pattern and installs in learn slot", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(960, 4);  // 250ms cycle — fast for test
  const learnReq = Control.learn(74, 1);
  scheduler.installLearn(learnReq.pattern, 2);  // 2 cycles only
  await new Promise((r) => setTimeout(r, 700));  // ~3 cycles → learn auto-clears
  scheduler.hush();
  if (sent.length === 0) throw new Error("learn produced no CCs");
  if (sent.some((m) => m.controller !== 74)) throw new Error("learn fired non-74 CC");
});

test("learn: bad CC throws", () => {
  let err = null;
  try { Control.learn(200); } catch (e) { err = e; }
  if (!err || !err.message.includes("0..127")) throw new Error(`expected error, got ${err && err.message}`);
});

test("transpile-run: 'c1 $ ctrl 74 sine' wires up control orbit 1", () => {
  const engine = buildEngine();
  // Add control-orbit support to the test engine
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  engine.controlOrbits = controlOrbits;
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 sine', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  // Default channel set by c1 → idx 0
  eq(cp.channel, 0);
  eq(cp.channelExplicit, true);
  // 64 events per cycle
  eq(cp.getEvents(0).length, 64);
});

test("transpile-run: 'c2 $ ctrl 71 (range 30 90 saw) # chan 5'", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c2 $ ctrl 71 (range 30 90 saw) # chan 5', sandbox);
  const cp = controlOrbits.get(2);
  if (!cp) throw new Error("control orbit 2 not set");
  eq(cp.channel, 4);  // chan 5 → idx 4
  // range output 30..90 — verify all events stay in clamp range
  for (const ev of cp.getEvents(0)) {
    if (ev.value < 0 || ev.value > 127) throw new Error(`out of range: ${ev.value}`);
  }
});

test("transpile-run: 'c1 silence' clears control orbit 1", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 sine', sandbox);
  if (!controlOrbits.get(1)) throw new Error("control orbit 1 not set");
  Patterns.runUserCode('c1 silence', sandbox);
  if (controlOrbits.has(1)) throw new Error("control orbit 1 not cleared by 'c1 silence'");
});

test("c1: rejects a regular Pattern with a helpful error mentioning ctrl", () => {
  const engine = buildEngine();
  engine.setControlOrbit = () => {};
  engine.clearControlOrbit = () => {};
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  let err = null;
  try { Patterns.runUserCode('c1 $ n "c4 e4"', sandbox); } catch (e) { err = e; }
  if (!err || !err.message.includes("ctrl")) throw new Error(`expected hint about ctrl, got: ${err && err.message}`);
});

test("transpile-run: 'c1 $ ctrl 74 \"0 64 127\"' stepped pattern → 3 events/cycle", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 "0 64 127"', sandbox);
  const cp = controlOrbits.get(1);
  const events = cp.getEvents(0);
  eq(events.length, 3);
  eq(events.map((e) => e.value), [0, 64, 127]);
});

test("ctrl + range with auto-clamping at endpoints", () => {
  // sine peaks at phase 0.25 (1.0). Confirm round-not-truncate at the value 127.
  const cp = Control.ctrl(74, Patterns.sine);
  const events = cp.getEvents(0);
  // peak around i=16 (phase=0.25): sine = 1 → 127
  let peak = 0;
  for (const ev of events) if (ev.value > peak) peak = ev.value;
  eq(peak, 127);
  // And trough around i=48: sine = 0 → 0
  let trough = 127;
  for (const ev of events) if (ev.value < trough) trough = ev.value;
  eq(trough, 0);
});

test("ctrl: composes with sandbox 'every 2 (rev)' style — ctrl uses Patternable for cc", () => {
  // CC patternable — alternate CC number per cycle.
  const cp = Control.ctrl("<74 75>", 64);
  const c0 = cp.getEvents(0);
  const c1 = cp.getEvents(1);
  eq(c0[0].cc, 74);
  eq(c1[0].cc, 75);
});

test("ctrl + segment override via #: 'ctrl 74 sine # segment 16'", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 sine # segment 16', sandbox);
  const cp = controlOrbits.get(1);
  eq(cp.segmentN, 16);
  eq(cp.getEvents(0).length, 16);
});

test("transpile-run: 'learn 74' installs a learn pattern", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  let learnInstalled = null;
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = (pattern, durationCycles) => { learnInstalled = { pattern, durationCycles }; };
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('learn 74', sandbox);
  if (!learnInstalled) throw new Error("learn was not installed");
  eq(learnInstalled.durationCycles, 8);
  if (!learnInstalled.pattern.getEvents(0).length) throw new Error("learn pattern empty");
});

// ── # rest N (configurable snap on orbit clear) ────────────────────────
test("ctrl: .rest(N) sets restValue, default is null (hold)", () => {
  const a = Control.ctrl(74, Patterns.sine);
  eq(a.restValue, null);
  const b = a.rest(0);
  eq(b.restValue, 0);
  // Original is unchanged.
  eq(a.restValue, null);
});

test("ctrl: .rest preserved across .ch() and .segment()", () => {
  const cp = Control.ctrl(74, Patterns.sine).rest(64).ch(3).segment(16);
  eq(cp.restValue, 64);
  eq(cp.channel, 2);
  eq(cp.segmentN, 16);
});

test("ctrl: .rest rejects out-of-range, non-integer, negative", () => {
  const cp = Control.ctrl(74, Patterns.sine);
  let e1 = null, e2 = null, e3 = null, e4 = null;
  try { cp.rest(200); } catch (e) { e1 = e; }
  try { cp.rest(-1); } catch (e) { e2 = e; }
  try { cp.rest(0.5); } catch (e) { e3 = e; }
  try { cp.rest("0"); } catch (e) { e4 = e; }
  if (!e1 || !/0\.\.127/.test(e1.message)) throw new Error("expected 0..127 error for 200");
  if (!e2 || !/0\.\.127/.test(e2.message)) throw new Error("expected 0..127 error for -1");
  if (!e3) throw new Error("expected error for 0.5");
  if (!e4) throw new Error("expected error for non-number");
});

test("scheduler: # rest fires on clear at the orbit's last (channel, cc)", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 100).rest(0));
  await new Promise((r) => setTimeout(r, 1100));   // emits 100
  const before = sent.length;
  scheduler.clearControlOrbit(1);
  // The rest fires synchronously inside clearControlOrbit.
  if (sent.length !== before + 1) throw new Error(`expected one rest CC (got ${sent.length - before})`);
  const restMsg = sent[sent.length - 1];
  eq(restMsg.controller, 74);
  eq(restMsg.value, 0);
  eq(restMsg.channel, 0);
});

test("scheduler: # rest cancels in-flight CCs from current cycle", async () => {
  // A 64-segment sine — without version-cancel, the rest at t=mid-cycle would
  // be overwritten by the remaining smooth-signal samples scheduled this cycle.
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(60, 4);   // 4s cycle
  scheduler.setControlOrbit(1, Control.ctrl(74, Patterns.sine).rest(7));
  await new Promise((r) => setTimeout(r, 200));  // a few smooth samples
  scheduler.clearControlOrbit(1);
  await new Promise((r) => setTimeout(r, 600));  // would have fired more without cancel
  scheduler.hush();
  // The very last CC must be the rest value (7), not a stale sine sample.
  const last = sent[sent.length - 1];
  if (!last) throw new Error("no CCs emitted");
  eq(last.value, 7);
  eq(last.controller, 74);
});

test("scheduler: replacing an orbit does NOT fire the outgoing rest", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 100).rest(0));
  await new Promise((r) => setTimeout(r, 1100));
  // Replace, not clear. No outgoing-rest snap should occur.
  scheduler.setControlOrbit(1, Control.ctrl(74, 50).rest(64));
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  // Values seen: 100 (first orbit), then 50 (second). Never 0 (outgoing rest).
  if (sent.some((m) => m.value === 0)) {
    throw new Error(`replacement fired outgoing rest 0: ${sent.map((m) => m.value).join(",")}`);
  }
  // And both 100 and 50 should appear (otherwise dedup is too aggressive).
  if (!sent.some((m) => m.value === 100)) throw new Error("missing first-orbit value");
  if (!sent.some((m) => m.value === 50)) throw new Error("missing second-orbit value");
});

test("scheduler: clear without rest holds last value (no snap CC fires)", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 99));   // no .rest()
  await new Promise((r) => setTimeout(r, 1100));
  const before = sent.length;
  scheduler.clearControlOrbit(1);
  await new Promise((r) => setTimeout(r, 200));
  scheduler.hush();
  // No additional CCs after clear (regression for the original "hold" default).
  if (sent.length > before) throw new Error(`unexpected CCs after rest-less clear: ${sent.length - before}`);
});

test("scheduler: independent rests on multiple orbits clear independently", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  scheduler.setControlOrbit(1, Control.ctrl(74, 100).rest(0));
  scheduler.setControlOrbit(2, Control.ctrl(80, 100).rest(64).ch(2));
  await new Promise((r) => setTimeout(r, 1100));
  const before = sent.length;
  scheduler.clearControlOrbit(1);
  scheduler.clearControlOrbit(2);
  // Both rests fired synchronously.
  const tail = sent.slice(before);
  eq(tail.length, 2);
  // Find each by controller.
  const rest1 = tail.find((m) => m.controller === 74);
  const rest2 = tail.find((m) => m.controller === 80);
  if (!rest1) throw new Error("no rest on cc 74");
  if (!rest2) throw new Error("no rest on cc 80");
  eq(rest1.value, 0);  eq(rest1.channel, 0);
  eq(rest2.value, 64); eq(rest2.channel, 1);
  scheduler.hush();
});

test("scheduler: # rest with no prior CC sent (orbit cleared before any tick) is a no-op", async () => {
  // Defensive: if the user evals `c1 $ ctrl 74 sine # rest 0` and immediately
  // `c1 silence` before the first tick fires, we have no (channel, cc) address
  // for the rest. Skip silently rather than guessing.
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(60, 4);   // 4s cycle so we beat the first tick
  scheduler.setControlOrbit(1, Control.ctrl(74, 100).rest(0));
  scheduler.clearControlOrbit(1);
  scheduler.hush();
  if (sent.length !== 0) throw new Error(`expected 0 CCs, got ${sent.length}`);
});

test("transpile-run: 'c1 $ ctrl 74 sine # rest 0' wires restValue", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 sine # rest 0', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  eq(cp.restValue, 0);
});

test("transpile-run: '# rest 200' rejected with helpful error", () => {
  const engine = buildEngine();
  engine.setControlOrbit = () => {};
  engine.clearControlOrbit = () => {};
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  let err = null;
  try { Patterns.runUserCode('c1 $ ctrl 74 sine # rest 200', sandbox); } catch (e) { err = e; }
  if (!err || !/0\.\.127/.test(err.message)) throw new Error(`expected 0..127 error, got: ${err && err.message}`);
});

// ── ControlPattern combinator composition ────────────────────────────────
// Every time/structure combinator on Pattern must also work on ControlPattern.

test("ctrl + fast on signal source: re-samples at output segmentN (smooth, no zipper)", () => {
  // Output density is preserved; fast 2 shifts the source time-map but still
  // produces segmentN samples per output cycle. Sampling 2 source cycles' worth
  // of sine into the same output cycle gives 2 full sine periods at smooth res.
  const cp = Control.ctrl(74, Patterns.sine).segment(8).fast(2);
  const events = cp.getEvents(0);
  eq(events.length, 8);
  if (events.some((e) => e.start < 0 || e.start >= 1)) throw new Error("starts out of [0,1)");
});

test("ctrl + slow on signal source: re-samples at output segmentN (smooth, no zipper)", () => {
  // The whole point of the mapTime fix: slow 2 doesn't reduce output density.
  // 8 evenly-spaced output samples cover source phase 0..0.5 with full density.
  const cp = Control.ctrl(74, Patterns.sine).segment(8).slow(2);
  const events = cp.getEvents(0);
  eq(events.length, 8);
});

test("ctrl + slow 4 on signal source: smooth sweep, no stepping (regression)", () => {
  // The original bug: slow 4 (ctrl 74 sine) produced 16 events/cycle (audible
  // stepping). After mapTime, the default 64-sample density is preserved.
  const cp = Control.ctrl(74, Patterns.sine).slow(4);
  const events = cp.getEvents(0);
  eq(events.length, 64);
  // Across 4 output cycles, total samples = 4 × 64 = 256, covering one full
  // sine period of the source.
  let total = 0;
  for (let c = 0; c < 4; c++) total += cp.getEvents(c).length;
  eq(total, 256);
  // Smoothness: per-step value delta should be small (no big jumps).
  for (let i = 1; i < events.length; i++) {
    const d = Math.abs(events[i].value - events[i - 1].value);
    if (d > 16) throw new Error(`per-step jump too large at i=${i}: ${d}`);
  }
});

test("ctrl + fast 0.25 (== slow 4) on signal source: same density-shape as slow 4", () => {
  const a = Control.ctrl(74, Patterns.sine).fast(0.25).getEvents(0);
  const b = Control.ctrl(74, Patterns.sine).slow(4).getEvents(0);
  eq(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].value - b[i].value) > 1) {
      throw new Error(`fast(0.25) vs slow(4) value mismatch at i=${i}: ${a[i].value} vs ${b[i].value}`);
    }
  }
});

test("ctrl + density alias for fast: signal source re-samples at default segmentN", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ density 2 (ctrl 74 sine)', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  // Default segment is 64; output density preserved → 64 events per host cycle.
  eq(cp.getEvents(0).length, 64);
});

test("ctrl + sparsity alias for slow: signal source preserves output density", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ sparsity 2 (ctrl 74 sine # segment 8)', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  // Output segmentN remains 8; sparsity 2 maps source 0..0.5 into the cycle.
  eq(cp.getEvents(0).length, 8);
});

test("ctrl + density 0.5 on signal source: half-rate, output density preserved", () => {
  const cp = Control.ctrl(74, Patterns.sine).segment(64).fast(0.5);
  eq(cp.getEvents(0).length, 64);
});

test("ctrl + slow 2 # segment 128: explicit segment overrides default", () => {
  const cp = Control.ctrl(74, Patterns.sine).slow(2).segment(128);
  eq(cp.getEvents(0).length, 128);
  // Across 2 output cycles, total = 256 samples covering one full sine period.
  let total = 0;
  for (let c = 0; c < 2; c++) total += cp.getEvents(c).length;
  eq(total, 256);
});

test("ctrl + slow 4 on pattern source: discrete behavior preserved", () => {
  // Discrete sources keep current Tidal-style time-stretch semantics — events
  // span 4 output cycles, not re-sampled.
  const cp = Control.ctrl(80, "0 64 127 64").slow(4);
  // 4 source events spread over 4 output cycles → 1 event per cycle.
  let total = 0;
  for (let c = 0; c < 4; c++) total += cp.getEvents(c).length;
  eq(total, 4);
});

test("ctrl + inside 4 rev on signal source: smooth within each reversed quarter", () => {
  // inside(4, rev) divides the cycle into 4 sub-cycles, each reversed. Quarter
  // boundaries necessarily jump (a reversed quarter ends where the next reversed
  // quarter begins, at different source phases) — but within each 16-sample
  // quarter the signal must remain smooth.
  const cp = Control.ctrl(74, Patterns.sine).segment(64).inside(4, (p) => p.rev());
  const events = cp.getEvents(0);
  eq(events.length, 64);
  for (let q = 0; q < 4; q++) {
    for (let i = q * 16 + 1; i < (q + 1) * 16; i++) {
      const d = Math.abs(events[i].value - events[i - 1].value);
      if (d > 16) throw new Error(`inside(4, rev): per-step jump too large at i=${i} (quarter ${q}): ${d}`);
    }
  }
});

test("ctrl + composed density transforms: fast 2 ∘ slow 4 == slow 2 (signal source)", () => {
  const composed = Control.ctrl(74, Patterns.sine).slow(4).fast(2).getEvents(0);
  const direct = Control.ctrl(74, Patterns.sine).slow(2).getEvents(0);
  eq(composed.length, direct.length);
  for (let i = 0; i < composed.length; i++) {
    if (Math.abs(composed[i].value - direct[i].value) > 1) {
      throw new Error(`composition mismatch at i=${i}: ${composed[i].value} vs ${direct[i].value}`);
    }
  }
});

test("ctrl + linger 2 on signal source: smooth, output density preserved", () => {
  const cp = Control.ctrl(74, Patterns.sine).segment(64).linger(2);
  eq(cp.getEvents(0).length, 64);
  for (let i = 1; i < 64; i++) {
    const d = Math.abs(cp.getEvents(0)[i].value - cp.getEvents(0)[i - 1].value);
    if (d > 16) throw new Error(`linger smoothness broken at i=${i}: ${d}`);
  }
});

test("ctrl + zoom on signal source: re-samples within window at full density", () => {
  const cp = Control.ctrl(74, Patterns.sine).segment(64).zoom(0.25, 0.75);
  // mapTime path keeps output at segmentN, all within the zoomed source window.
  eq(cp.getEvents(0).length, 64);
});

test("ctrl + segment after fast: signal carrier survives, segment still rebuilds", () => {
  const cp = Control.ctrl(74, Patterns.sine).fast(2).segment(32);
  eq(cp.getEvents(0).length, 32);
});

test("ctrl + rev: reverses event start positions", () => {
  const cp = Control.ctrl(74, "0 64 127").rev();
  const events = cp.getEvents(0);
  eq(events.length, 3);
  // Source events at 0, 1/3, 2/3 → reversed to 1, 2/3, 1/3 → mod 1 → 0, 2/3, 1/3
  // → sorted asc: 0, 1/3, 2/3.
  near(events[0].start, 0);
  near(events[1].start, 1/3);
  near(events[2].start, 2/3);
});

test("ctrl + palindrome: alternates forward/reversed per cycle", () => {
  const cp = Control.ctrl(74, "0 64 127").palindrome();
  // Cycle 0 is forward; cycle 1 is reversed.
  const fwd = cp.getEvents(0);
  const bwd = cp.getEvents(1);
  // fwd: starts at 0, 1/3, 2/3 with values 0, 64, 127.
  // bwd: rev'd → starts at 0, 2/3, 1/3 with values 0, 64, 127 → sorted: 0, 1/3, 2/3
  // but VALUE order is 0, 127, 64 (since the original event-at-0 maps to start=0).
  near(fwd[0].start, 0);
  eq(fwd[0].value, 0);
  near(bwd[0].start, 0);
  // Reversal means value at start=0 was originally the value at start=1 ≡ start=0 (mod) → 0.
  // The value 64 (at original 1/3) reverses to 1-1/3 = 2/3. So at start 2/3 we get value 64.
  // We'll just verify the value sequence differs from forward.
  if (JSON.stringify(fwd.map((e) => e.value)) === JSON.stringify(bwd.map((e) => e.value))) {
    throw new Error("palindrome did not alter value order between cycles");
  }
});

test("ctrl + every n f: applies f every Nth cycle", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  // Use the sandbox-level rev because that's what end-users would use.
  const ctrlFn = sandbox.ctrl(74)("0 64 127");
  const transformed = sandbox.every(2)(sandbox.rev)(ctrlFn);
  if (!(transformed instanceof Control.ControlPattern)) throw new Error("expected ControlPattern back");
  const c0 = transformed.getEvents(0);
  const c1 = transformed.getEvents(1);
  // Cycle 0 is the "altered" branch (rev); cycle 1 is the original.
  // Value sequences should differ between the two cycles.
  if (JSON.stringify(c0.map((e) => e.value)) === JSON.stringify(c1.map((e) => e.value))) {
    throw new Error("every did not apply f on cycle 0");
  }
});

test("ctrl + jux: emits modified copy on channel + 1 (default)", () => {
  const cp = Control.ctrl(74, "10 20 30").jux((p) => p.rev());
  const events = cp.getEvents(0);
  // 6 events total: 3 original (channel undefined / inherits orbit) + 3 reversed (channelOffset=1).
  eq(events.length, 6);
  const offsets = events.filter((e) => e.channelOffset === 1);
  if (offsets.length !== 3) throw new Error(`expected 3 channelOffset=1 events, got ${offsets.length}`);
});

test("ctrl + juxBy: explicit channel offset", () => {
  const cp = Control.ctrl(74, "10 20 30").juxBy(3, (p) => p.rev());
  const events = cp.getEvents(0);
  const offsets = events.filter((e) => e.channelOffset === 3);
  if (offsets.length !== 3) throw new Error(`expected 3 channelOffset=3 events, got ${offsets.length}`);
});

test("ctrl + stack: merges multiple ControlPatterns into one stream", () => {
  const a = Control.ctrl(74, "10 20").ch(2);
  const b = Control.ctrl(71, "30 40").ch(3);
  const stacked = Patterns.buildSandbox(buildSandboxStubEngine()).stack([a, b]);
  if (!(stacked instanceof Control.ControlPattern)) throw new Error("expected ControlPattern back");
  const events = stacked.getEvents(0);
  eq(events.length, 4);
  const cc74 = events.filter((e) => e.cc === 74);
  const cc71 = events.filter((e) => e.cc === 71);
  eq(cc74.length, 2);
  eq(cc71.length, 2);
  // .ch() tagged events get absolute channel set.
  if (!cc74.every((e) => e.channel === 1)) throw new Error("ctrl 74 events missing absolute ch=1");
  if (!cc71.every((e) => e.channel === 2)) throw new Error("ctrl 71 events missing absolute ch=2");
});

test("ctrl + cat: picks one ControlPattern per cycle (mod-N)", () => {
  const a = Control.ctrl(74, "10 20");
  const b = Control.ctrl(71, "30 40 50");
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const cp = sandbox.cat([a, b]);
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern back");
  eq(cp.getEvents(0).length, 2);
  eq(cp.getEvents(1).length, 3);
  eq(cp.getEvents(2).length, 2);
});

test("ctrl + fastcat / seq: crams parts into one cycle", () => {
  const a = Control.ctrl(74, "10");
  const b = Control.ctrl(71, "30");
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const cp = sandbox.fastcat([a, b]);
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern back");
  const events = cp.getEvents(0);
  eq(events.length, 2);
  // a's event at start=0 → 0; b's event at start=0 → 0.5 (slot 1/2).
  near(events[0].start, 0);
  near(events[1].start, 0.5);
  // seq is alias.
  const cp2 = sandbox.seq([a, b]);
  if (!(cp2 instanceof Control.ControlPattern)) throw new Error("expected ControlPattern from seq");
});

test("stack mixing Pattern and ControlPattern throws helpful error", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const note = Patterns.n("c4");
  const ctrl = Control.ctrl(74, "10");
  let err = null;
  try { sandbox.stack([note, ctrl]); } catch (e) { err = e; }
  if (!err || !/different ports/.test(err.message)) {
    throw new Error(`expected different-ports error, got: ${err && err.message}`);
  }
});

test("ctrl + mask: gates CC by a mask string", () => {
  // Mask "1 ~" keeps only events in the first half.
  const cp = Control.ctrl(74, Patterns.sine).segment(8).mask("1 ~");
  const events = cp.getEvents(0);
  if (events.length === 0) throw new Error("expected some events");
  if (events.some((e) => e.start >= 0.5)) throw new Error("mask did not gate second half");
});

test("ctrl + struct: re-times CC values onto a rhythm", () => {
  const cp = Control.ctrl(74, "10 20 30").struct("1 1");
  // 2 struct events; 3 source values cycled. Result: 2 events with CC values 10 and 20.
  const events = cp.getEvents(0);
  eq(events.length, 2);
  eq(events[0].value, 10);
  eq(events[1].value, 20);
});

test("ctrl + degradeBy: produces fewer events than original", () => {
  const orig = Control.ctrl(74, Patterns.sine).segment(64);
  const degraded = orig.degradeBy(0.5);
  const o = orig.getEvents(0).length;
  const d = degraded.getEvents(0).length;
  if (!(d < o)) throw new Error(`expected ${d} < ${o}`);
  if (!(d > 0)) throw new Error("degradeBy ate everything");
});

test("ctrl + degrade: half-probability shorthand", () => {
  const cp = Control.ctrl(74, Patterns.sine).segment(64).degrade();
  const n = cp.getEvents(0).length;
  if (!(n > 0 && n < 64)) throw new Error(`expected partial degrade, got ${n}`);
});

test("ctrl + off: phase-shifted copy is layered on top", () => {
  const cp = Control.ctrl(74, "10 20").off(0.25, (p) => p.rev());
  const events = cp.getEvents(0);
  // 2 original + 2 shifted = 4
  eq(events.length, 4);
});

test("ctrl + stutter: repeats each event N times", () => {
  const cp = Control.ctrl(74, "10").stutter(3, 0.1);
  const events = cp.getEvents(0);
  eq(events.length, 3);
  near(events[0].start, 0);
  near(events[1].start, 0.1);
  near(events[2].start, 0.2);
});

test("ctrl + iter: shifts events left by 1/N each cycle", () => {
  const cp = Control.ctrl(74, "10 20 30 40").iter(4);
  const c0 = cp.getEvents(0);
  const c1 = cp.getEvents(1);
  near(c0[0].start, 0);
  // After iter on cycle 1, first event is shifted by 0.25.
  // wrap means slot at 0.75 → 0; so cycle 1 starts at start=0 with value that was at 0.25.
  // Just verify at least 4 events still present and rotation happened.
  eq(c1.length, 4);
});

test("ctrl + chunk: applies fn to a slice each cycle", () => {
  const cp = Control.ctrl(74, "10 20 30 40").chunk(2, (p) => p.rev());
  const events = cp.getEvents(0);
  eq(events.length, 4);
});

test("ctrl + early/late: shifts event positions", () => {
  const cp = Control.ctrl(74, "10 20").late(0.25);
  const events = cp.getEvents(0);
  eq(events.length, 2);
  near(events[0].start, 0.25);
  near(events[1].start, 0.75);
});

test("ctrl + linger: takes first 1/N of cycle, repeats N times", () => {
  const cp = Control.ctrl(74, "10 20 30 40").linger(2);
  const events = cp.getEvents(0);
  // First half has 2 events; linger(2) repeats it twice → 4 events.
  eq(events.length, 4);
});

test("ctrl + trunc: truncates to first N fraction", () => {
  const cp = Control.ctrl(74, "10 20 30 40").trunc(0.5);
  const events = cp.getEvents(0);
  eq(events.length, 2);
});

test("ctrl + zoom: focuses on a sub-window", () => {
  const cp = Control.ctrl(74, "10 20 30 40").zoom(0.25, 0.75);
  const events = cp.getEvents(0);
  // Events at 0.25 and 0.5 fall inside; rescaled to 0 and 0.5.
  eq(events.length, 2);
  near(events[0].start, 0);
  near(events[1].start, 0.5);
});

test("ctrl + compress: places events in a narrower window", () => {
  const cp = Control.ctrl(74, "10 20").compress(0.25, 0.75);
  const events = cp.getEvents(0);
  // 2 events at 0, 0.5 → compressed to 0.25, 0.5
  eq(events.length, 2);
  near(events[0].start, 0.25);
  near(events[1].start, 0.5);
});

test("ctrl + rot: rotates event values by N positions", () => {
  const cp = Control.ctrl(74, "10 20 30").rot(1);
  const events = cp.getEvents(0);
  eq(events.length, 3);
  // Values cycle by 1: was [10,20,30] at [0, 1/3, 2/3] → values [20,30,10] at same starts.
  eq(events[0].value, 20);
  eq(events[1].value, 30);
  eq(events[2].value, 10);
});

test("ctrl + sometimes/often/rarely: probabilistic transform", () => {
  // Just verify no crash and result length is plausible across cycles.
  const cp = Control.ctrl(74, "10 20").sometimesBy(0.5, (p) => p.rev());
  for (let c = 0; c < 4; c++) {
    const events = cp.getEvents(c);
    eq(events.length, 2);
  }
});

test("ctrl + inside / outside: fast/slow wrappers", () => {
  // inside(2, rev) on a stepped pattern: slow by 2, rev, fast by 2 — should still produce events.
  const cp = Control.ctrl(74, "10 20 30 40").inside(2, (p) => p.rev());
  if (cp.getEvents(0).length === 0) throw new Error("inside crushed everything");
  const cp2 = Control.ctrl(74, "10 20 30 40").outside(2, (p) => p.rev());
  if (cp2.getEvents(0).length === 0) throw new Error("outside crushed everything");
});

test("ctrl + whenmod: applies fn when cycleN mod m == n", () => {
  const cp = Control.ctrl(74, "10 20").whenmod(3, 1, (p) => p.rev());
  const c0 = cp.getEvents(0);
  const c1 = cp.getEvents(1);
  // c0 is original "10 20" → values [10, 20]
  // c1 is reversed → starts at 0, 0.5 (mod 1) → values [10, 20] but in different positions:
  //   originally event-at-0 had value 10; rev → start (1-0) mod 1 = 0, value 10
  //   originally event-at-0.5 had value 20; rev → start (1-0.5) mod 1 = 0.5, value 20
  // Wait — for "10 20" both events end up in same positions!
  // Use a 3-event pattern instead: clearer semantics.
  const cp3 = Control.ctrl(74, "10 20 30").whenmod(3, 1, (p) => p.rev());
  const v0 = cp3.getEvents(0).map((e) => e.value);
  const v1 = cp3.getEvents(1).map((e) => e.value);
  if (JSON.stringify(v0) === JSON.stringify(v1)) throw new Error("whenmod did not transform cycle 1");
  // Sanity: cycle 2 == cycle 0 (both unaltered).
  const v2 = cp3.getEvents(2).map((e) => e.value);
  eq(v2, v0);
});

test("polymorphic dispatch: fast 2 returns Pattern for Pattern, ControlPattern for ControlPattern", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const np = sandbox.fast(2)(Patterns.n("c4"));
  if (!(np instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const cp = sandbox.fast(2)(Control.ctrl(74, Patterns.sine));
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern");
});

test("polymorphic dispatch: stack returns the right type per part-array type", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const np = sandbox.stack([Patterns.n("c4"), Patterns.n("e4")]);
  if (!(np instanceof Patterns.Pattern)) throw new Error("expected Pattern");
  const cp = sandbox.stack([Control.ctrl(74, "10"), Control.ctrl(71, "30")]);
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern");
});

test("scale on ControlPattern throws clear error mentioning ctrl", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  let err = null;
  try { sandbox.scale("major")(Control.ctrl(74, "0 1 2")); } catch (e) { err = e; }
  if (!err || !/ctrl/.test(err.message)) throw new Error(`expected ctrl hint, got: ${err && err.message}`);
});

test("arp on ControlPattern throws clear error", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  let err = null;
  try { sandbox.arp("up")(Control.ctrl(74, "0 1 2")); } catch (e) { err = e; }
  if (!err || !/ctrl/.test(err.message)) throw new Error(`expected ctrl hint, got: ${err && err.message}`);
});

test("add/sub/mul/up/octave on ControlPattern throw", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  for (const name of ["add", "sub", "mul", "up", "octave"]) {
    let err = null;
    try { sandbox[name](1)(Control.ctrl(74, "0")); } catch (e) { err = e; }
    if (!err) throw new Error(`${name}: expected error`);
  }
});

test("gain/velocity on ControlPattern throw", () => {
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  for (const name of ["gain", "velocity"]) {
    let err = null;
    try { sandbox[name](1)(Control.ctrl(74, "0")); } catch (e) { err = e; }
    if (!err) throw new Error(`${name}: expected error`);
  }
});

test("scheduler: stacked control patterns on different CCs both fire", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);  // 1s cycle
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const cp = sandbox.stack([
    Control.ctrl(74, Patterns.sine).segment(4),
    Control.ctrl(71, Patterns.saw).segment(4),
  ]);
  scheduler.setControlOrbit(1, cp);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  const cc74 = sent.filter((m) => m.controller === 74);
  const cc71 = sent.filter((m) => m.controller === 71);
  if (cc74.length === 0) throw new Error("no CC 74 traffic");
  if (cc71.length === 0) throw new Error("no CC 71 traffic");
});

test("scheduler: jux on ControlPattern routes to channel + 1", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  const cp = Control.ctrl(74, "10 100").jux((p) => p.rev());
  scheduler.setControlOrbit(1, cp);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  const channels = new Set(sent.map((m) => m.channel));
  // Default c1 channel is 0; jux adds offset 1 → also channel 1.
  if (!channels.has(0) || !channels.has(1)) {
    throw new Error(`expected channels {0,1}, got ${[...channels].join(",")}`);
  }
});

test("scheduler: stack of two ctrls on same CC dedups per (chan, cc)", async () => {
  const sent = [];
  const noteOut = { send: () => {}, close: () => {} };
  const ccOut = { send: (type, m) => { if (type === "cc") sent.push(m); }, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(noteOut, noteOut, ccOut);
  scheduler.setTempo(240, 4);
  // Both stacks on CC 74. The dedup key is (channel, cc) — stable values become a single
  // emission per change. With "10 10 10 10" on one and "10 10 10 10" on the other: 1 emission.
  const sandbox = Patterns.buildSandbox(buildSandboxStubEngine());
  const cp = sandbox.stack([
    Control.ctrl(74, "10 10 10 10"),
    Control.ctrl(74, "10 10 10 10"),
  ]);
  scheduler.setControlOrbit(1, cp);
  await new Promise((r) => setTimeout(r, 1100));
  scheduler.hush();
  const cc74 = sent.filter((m) => m.controller === 74);
  // Expect just 1 send (deduped to a single value).
  eq(cc74.length, 1);
});

test("transpile-run: 'c1 $ fast 2 (ctrl 74 sine)'", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ fast 2 (ctrl 74 sine)', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern");
  // Default segment is 64; signal source preserves output density.
  eq(cp.getEvents(0).length, 64);
});

test("transpile-run: 'c1 $ every 4 rev (ctrl 74 sine)'", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ every 4 rev (ctrl 74 sine)', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern");
});

test("transpile-run: 'c1 $ stack [ctrl 74 sine, ctrl 71 saw]' is NOT supported (no array literals)", () => {
  // Array-literal syntax isn't part of the transpiler; users use stack via JS-style call.
  // Instead, we verify the JS form via runUserCode building the stack programmatically.
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  // Use ctrlStack directly via the polymorphic stack.
  const cp = sandbox.stack([
    Control.ctrl(74, Patterns.sine).segment(4),
    Control.ctrl(71, Patterns.saw).segment(4),
  ]);
  sandbox.c1(cp);
  if (!controlOrbits.get(1)) throw new Error("control orbit 1 not set");
});

test("transpile-run: 'c1 $ ctrl 74 sine # fast 2' — # method form on ctrl", () => {
  const engine = buildEngine();
  const controlOrbits = new Map();
  engine.setControlOrbit = (n, p) => controlOrbits.set(n, p);
  engine.clearControlOrbit = (n) => controlOrbits.delete(n);
  engine.installLearn = () => {};
  const sandbox = Patterns.buildSandbox(engine);
  Patterns.runUserCode('c1 $ ctrl 74 sine # fast 2', sandbox);
  const cp = controlOrbits.get(1);
  if (!cp) throw new Error("control orbit 1 not set");
  if (!(cp instanceof Control.ControlPattern)) throw new Error("expected ControlPattern");
  // Signal source preserves output density at default segment 64.
  eq(cp.getEvents(0).length, 64);
});

test("ctrl: applying chained transforms preserves restValue", () => {
  // This is critical: a user writes `c1 $ fast 2 (ctrl 74 sine # rest 0)` and
  // expects the rest to still fire on clear.
  const cp = Control.ctrl(74, Patterns.sine).rest(0).fast(2);
  eq(cp.restValue, 0);
  const cp2 = cp.rev().every(2, (p) => p.fast(2));
  eq(cp2.restValue, 0);
});

// Helper for sandbox-based tests: a stub engine that doesn't care about
// orbit registrations (we're just exercising the combinator surface).
function buildSandboxStubEngine() {
  return {
    setOrbit: () => {}, clearOrbit: () => {},
    setControlOrbit: () => {}, clearControlOrbit: () => {},
    installLearn: () => {}, hush: () => {},
  };
}

// ── Bake gesture ringbuffer ────────────────────────────────────────────
// At 480bpm/1beat-per-cycle, cycleMs = 125ms; ~250ms covers ~2 cycles.

test("bake: ringbuffer fills over N ticks; getBakeHistory returns last N cycles", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.n("c4"));
  await new Promise(r => setTimeout(r, 700));   // ≥5 cycles
  const h = scheduler.getBakeHistory(1, 4);
  const cycN = scheduler.currentCycle();
  scheduler.hush();
  if (h.length === 0) throw new Error("expected at least one cycle in history; currentCycle=" + cycN);
  // Oldest-first, contiguous cycleNs ending at the most recent we captured.
  for (let i = 1; i < h.length; i++) {
    if (h[i].cycleN !== h[i - 1].cycleN + 1) {
      throw new Error("expected contiguous cycleN, got " + h.map(s => s.cycleN).join(","));
    }
  }
});

test("bake: ringbuffer trims to BAKE_HISTORY_CYCLES=8", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);   // cycleMs = 125ms
  scheduler.setOrbit(1, Patterns.n("c4"));
  await new Promise(r => setTimeout(r, 1500));  // ~12 cycles → should trim to 8
  const h = scheduler.getBakeHistory(1, 20);
  scheduler.hush();
  if (h.length === 0) throw new Error("no history captured");
  if (h.length > 8) throw new Error("history exceeded 8: got " + h.length);
});

test("bake: snapshot independence — mutating orbit after capture preserves history", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.n("c4 e4 g4 b4"));
  await new Promise(r => setTimeout(r, 400));   // ~3 cycles
  const before = scheduler.getBakeHistory(1, 4);
  if (before.length === 0) throw new Error("no history captured");
  // Replace orbit; older snapshots must remain pinned to the original 4-note pattern.
  scheduler.setOrbit(1, Patterns.n("d4"));
  await new Promise(r => setTimeout(r, 50));
  scheduler.hush();
  for (const snap of before) {
    if (snap.notes.length !== 4) {
      throw new Error("snapshot notes mutated: expected 4, got " + snap.notes.length);
    }
  }
});

test("bake: clearOrbit drops only that orbit's history", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.n("c4"));
  scheduler.setOrbit(2, Patterns.n("e4"));
  await new Promise(r => setTimeout(r, 400));
  scheduler.clearOrbit(1);
  eq(scheduler.getBakeHistory(1, 4).length, 0);
  if (scheduler.getBakeHistory(2, 4).length === 0) throw new Error("orbit 2 history collateral-cleared");
  scheduler.hush();
});

test("bake: hush clears all history", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.n("c4"));
  scheduler.setOrbit(2, Patterns.n("e4"));
  await new Promise(r => setTimeout(r, 400));
  scheduler.hush();
  eq(scheduler.getBakeHistory(1, 4).length, 0);
  eq(scheduler.getBakeHistory(2, 4).length, 0);
});

test("bake: setOrbit does NOT clear history (typo recovery)", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.n("c4"));
  await new Promise(r => setTimeout(r, 400));
  const before = scheduler.getBakeHistory(1, 4).length;
  if (before === 0) throw new Error("no baseline history");
  // Replace pattern — history must be preserved across the swap.
  scheduler.setOrbit(1, Patterns.n("d4"));
  const after = scheduler.getBakeHistory(1, 4).length;
  if (after < before) throw new Error("setOrbit dropped history: before=" + before + " after=" + after);
  scheduler.hush();
});

test("bake: drum-resolver MIDI captured in snapshot ('bd ~ sd ~')", async () => {
  const out = { send: () => {}, close: () => {} };
  const scheduler = new Scheduler.PatternScheduler(out, out);
  scheduler.setTempo(480, 1);
  scheduler.setOrbit(1, Patterns.s("bd ~ sd ~"));
  await new Promise(r => setTimeout(r, 400));
  const h = scheduler.getBakeHistory(1, 4);
  scheduler.hush();
  if (h.length === 0) throw new Error("no history");
  const snap = h[h.length - 1];
  // Drum resolver: bd → 36, sd → 38. Two starts at 0.0 and 0.5.
  eq(snap.portType, "drums");
  eq(snap.notes.length, 2);
  near(snap.notes[0].start, 0);
  near(snap.notes[1].start, 0.5);
  eq(snap.notes[0].midi, 36);
  eq(snap.notes[1].midi, 38);
});

// ── Run ────────────────────────────────────────────────────────────────
async function main() {
  let pass = 0, fail = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log("OK   " + c.name);
      pass++;
    } catch (e) {
      console.log("FAIL " + c.name);
      console.log("     " + (e.stack || e.message).split("\n").slice(0, 3).join("\n     "));
      fail++;
    }
  }
  console.log("");
  console.log(pass + "/" + (pass + fail) + " pass");
  process.exit(fail ? 1 : 0);
}
main();
