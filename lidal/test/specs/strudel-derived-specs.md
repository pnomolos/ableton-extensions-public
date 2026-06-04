# Strudel-derived behavioral specs for Lidal

Behavioral test specifications for Lidal's mini-notation parser and pattern
combinators, distilled from the behaviors that TidalCycles/Strudel's test
suite asserts. Specs are written in Lidal's vocabulary and aim at the
implementation in `lidal/src/parser.ts`, `lidal/src/patterns.ts`,
`lidal/src/control.ts`, and `lidal/src/music.ts`.

## Conventions

- An **event** is `{ start, duration, name, velocity?, channel?, channelOffset?, offset? }`.
  `start` and `duration` are fractions of a cycle in `[0, 1)`.
- `evaluatePattern(src, cycleN)` (parser-only output) returns events with just
  `{ start, duration, name }`.
- `n(src).getEvents(cycleN)` (Pattern API) returns the same events with
  `velocity: 100` added; `s(src)` is the drum-port equivalent.
- Unless otherwise noted, specs evaluate at cycle 0 and expect a stable result
  for every cycle (i.e. no randomness).
- "Slot" means one of the equal subdivisions a sequence creates; a top-level
  sequence of N items has slot width `1/N`.
- For specs involving randomness (`?`, `degrade`, `sometimes`, `choose`,
  `wchoose`, `irand`, `|`, `rand`, `perlin`), Lidal's PRNG is **deterministic per
  cycle**: re-evaluating the same source at the same `cycleN` always yields the
  same output. Tests should assert determinism plus aggregate statistics over
  many cycles rather than exact per-cycle picks (unless the spec gives one).
- Events from `getEvents` are sorted ascending by `start`. Specs list events in
  that order.

---

## Mini-notation parser

### Single atom — produces one full-cycle event

A bare token fills the whole cycle.

**Input:** `evaluatePattern("a")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |

---

### Rest — `~` produces no event

A lone rest produces an empty event list.

**Input:** `evaluatePattern("~")`

**Expected events:** `[]`

---

### Sequence of two — splits cycle in half

**Input:** `evaluatePattern("a b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

---

### Sequence of three — splits cycle in thirds

**Input:** `evaluatePattern("a b c")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "c"  |

---

### Subdivision — nested brackets share parent slot

`[c d]` shares one slot with its siblings.

**Input:** `evaluatePattern("a [b c]")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/4      | "b"  |
| 3/4   | 1/4      | "c"  |

---

### Nested subdivision — depth halves duration each level

**Input:** `evaluatePattern("a [b [c d]]")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/4      | "b"  |
| 3/4   | 1/8      | "c"  |
| 7/8   | 1/8      | "d"  |

---

### Parallel-in-slot — comma inside `[ ]` fires simultaneously

`[a, b]` fires `a` and `b` together within the slot.

**Input:** `evaluatePattern("[a, b] c")`

**Expected events (sorted by start):**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 0     | 1/2      | "b"  |
| 1/2   | 1/2      | "c"  |

**Notes:** Implementation lifts `[a, b]` to a one-cycle polyrhythm so each
lane covers the full slot.

---

### Three-voice parallel — all share the parent slot duration

**Input:** `evaluatePattern("[a, b, c] d")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 0     | 1/2      | "b"  |
| 0     | 1/2      | "c"  |
| 1/2   | 1/2      | "d"  |

---

### Alternation — `<a b c>` picks one child per cycle (mod len)

**Input:** `evaluatePattern("<a b c>", cycleN)` for `cycleN = 0, 1, 2, 3, 4`

**Expected events per cycle:**

- Cycle 0: `[{ start: 0, duration: 1, name: "a" }]`
- Cycle 1: `[{ start: 0, duration: 1, name: "b" }]`
- Cycle 2: `[{ start: 0, duration: 1, name: "c" }]`
- Cycle 3: `[{ start: 0, duration: 1, name: "a" }]` (wraps)
- Cycle 4: `[{ start: 0, duration: 1, name: "b" }]`

---

### Alternation inside sequence — only the alternated slot rotates

`x <a b>` keeps `x` constant and rotates the alternation.

**Cycle 0:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "x"  |
| 1/2   | 1/2      | "a"  |

**Cycle 1:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "x"  |
| 1/2   | 1/2      | "b"  |

---

### Polyrhythm — `{a b, c d e}` runs each lane over one cycle

Each lane independently fills the cycle.

**Input:** `evaluatePattern("{a b, c d e}")`

**Expected events (sorted by start; lanes share the cycle):**

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 0     | 1/3      | "c"  |
| 1/3   | 1/3      | "d"  |
| 1/2   | 1/2      | "b"  |
| 2/3   | 1/3      | "e"  |

---

### Polymeter `%N` — forces every lane to N slots

`{a b, c d e}%4` makes both lanes play 4 slots per cycle, cycling through
their elements.

**Input:** `evaluatePattern("{a b, c d e}%4")`

**Expected events (sorted by start):**

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "a"  |
| 0     | 1/4      | "c"  |
| 1/4   | 1/4      | "b"  |
| 1/4   | 1/4      | "d"  |
| 1/2   | 1/4      | "a"  |
| 1/2   | 1/4      | "e"  |
| 3/4   | 1/4      | "b"  |
| 3/4   | 1/4      | "c"  |

**Notes:** Each lane's element list is cycled to length 4 (`[a,b,a,b]`,
`[c,d,e,c]`), then each lane sequences those 4 across the cycle.

---

### Polymeter on uneven lanes — `%3`

**Input:** `evaluatePattern("{a b, c d e}%3")`

**Expected events (sorted by start):**

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 0     | 1/3      | "c"  |
| 1/3   | 1/3      | "b"  |
| 1/3   | 1/3      | "d"  |
| 2/3   | 1/3      | "a"  |
| 2/3   | 1/3      | "e"  |

---

### Repeat `a*N` — N copies inside the slot

`a*3` becomes three events filling the slot.

**Input:** `evaluatePattern("a*3 b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/6      | "a"  |
| 1/6   | 1/6      | "a"  |
| 2/6   | 1/6      | "a"  |
| 1/2   | 1/2      | "b"  |

---

### Repeat is equivalent to subdivision

`evaluatePattern("a*3 b")` must produce identical events to
`evaluatePattern("[a a a] b")`.

---

### Elongate `_` — extends previous element by one slot

`a _ b` makes `a` weight 2, `b` weight 1, dividing the cycle 2:1.

**Input:** `evaluatePattern("a _ b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 2/3      | "a"  |
| 2/3   | 1/3      | "b"  |

---

### Elongate two underscores — weights stack additively

`a _ _ b` weights `a:3, b:1`.

**Input:** `evaluatePattern("a _ _ b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 3/4      | "a"  |
| 3/4   | 1/4      | "b"  |

---

### Weighted slot `@N` — `a@2 b` divides cycle 2:1

**Input:** `evaluatePattern("a@2 b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 2/3      | "a"  |
| 2/3   | 1/3      | "b"  |

---

### Weighted slot with two weights — `a@2 b@3`

Total weight = 5; `a` gets 2/5, `b` gets 3/5.

**Input:** `evaluatePattern("a@2 b@3")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 2/5      | "a"  |
| 2/5   | 3/5      | "b"  |

---

### Replicate `!` — copies the previous element once

`a ! b` becomes `a a b` (three slots, equal width).

**Input:** `evaluatePattern("a ! b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 1/3   | 1/3      | "a"  |
| 2/3   | 1/3      | "b"  |

---

### Replicate `!*N` — copies the previous element N times

`a !*3 b` becomes `a a a a b` (5 slots).

**Input:** `evaluatePattern("a !*3 b")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/5      | "a"  |
| 1/5   | 1/5      | "a"  |
| 2/5   | 1/5      | "a"  |
| 3/5   | 1/5      | "a"  |
| 4/5   | 1/5      | "b"  |

---

### Euclidean `bd(3,8)` — Bjorklund 3-in-8

3 hits across 8 equal slots, distributed as evenly as possible. Hits land at
positions 0, 3, 6.

**Input:** `evaluatePattern("bd(3,8)")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/8      | "bd" |
| 3/8   | 1/8      | "bd" |
| 6/8   | 1/8      | "bd" |

**Notes:** Non-hit slots are rests (no events emitted).

---

### Euclidean `(5,8)` — 5-in-8

Hits at positions 0, 2, 3, 5, 6.

**Input:** `evaluatePattern("bd(5,8)")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/8      | "bd" |
| 2/8   | 1/8      | "bd" |
| 3/8   | 1/8      | "bd" |
| 5/8   | 1/8      | "bd" |
| 6/8   | 1/8      | "bd" |

---

### Euclidean rotation — `bd(3,8,2)` rotates left by 2

Original hits at 0,3,6; Tidal's `_euclidOff n k s = rotL (s/k) (euclid n k)`
shifts the time axis LEFT by `r/n` cycles, which is equivalent to slicing the
slot array at index `r` and appending the prefix. For `bd(3,8,2)`:
`[T,F,F,T,F,F,T,F]` → `[F,F,T,F,F,T,F,T]` (slice(2) + slice(0,2)), with hits
at positions 1, 4, 6.

**Input:** `evaluatePattern("bd(3,8,2)")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 1/8   | 1/8      | "bd" |
| 4/8   | 1/8      | "bd" |
| 6/8   | 1/8      | "bd" |

**Notes:** Direction matches TidalCycles' canonical `euclidOff` semantics.
Lidal implements this by left-rotating the boolean slot array by `r` slots
(`children.slice(r).concat(children.slice(0, r))`).

---

### Euclidean edge case — `(n,n)` is all hits

**Input:** `evaluatePattern("x(8,8)")`

**Expected events:** Eight equal-duration `"x"` events, one per slot.

---

### Euclidean edge case — `(0,n)` produces no events

**Input:** `evaluatePattern("x(0,4)")`

**Expected events:** `[]` (all slots are rests).

---

### Euclidean Toussaint table — additional spot checks

The following inputs must produce hits at exactly these slot indices
(slot width = 1/n). Values are the canonical Bjorklund distribution
(Toussaint 2005), matching TidalCycles' `Sound.Tidal.Bjorklund`:

| Input        | hit indices            |
|--------------|------------------------|
| `x(1,2)`     | 0                      |
| `x(1,4)`     | 0                      |
| `x(2,5)`     | 0, 2                   |
| `x(3,4)`     | 0, 1, 2                |
| `x(3,5)`     | 0, 2, 4                |
| `x(3,7)`     | 0, 2, 4                |
| `x(4,7)`     | 0, 2, 4, 6             |
| `x(4,9)`     | 0, 2, 4, 6             |
| `x(4,11)`    | 0, 3, 6, 9             |
| `x(4,12)`    | 0, 3, 6, 9             |
| `x(5,7)`     | 0, 2, 3, 5, 6          |
| `x(5,9)`     | 0, 2, 4, 6, 8          |
| `x(5,11)`    | 0, 2, 4, 6, 8          |
| `x(5,16)`    | 0, 3, 6, 9, 12         |
| `x(7,8)`     | 0, 1, 2, 3, 4, 5, 6    |

**Notes:** Hit at slot 0 is always set when hits > 0. Lidal uses the
canonical Bjorklund recursive list-merge (transliterated from Tidal's
`Sound.Tidal.Bjorklund`), so these values are stable across Tidal,
Strudel, and Lidal.

---

### Numeric range `0 .. 7` — inclusive integer expansion

`0 .. 7` is sugar for `0 1 2 3 4 5 6 7`.

**Input:** `evaluatePattern("0 .. 7")`

**Expected events:** 8 equal-duration events with names `"0"` through `"7"`,
each duration `1/8`, starting at `i/8`.

---

### Numeric range descending — `5 .. 2`

**Input:** `evaluatePattern("5 .. 2")`

**Expected events:** 4 events named `"5", "4", "3", "2"`, each duration `1/4`.

---

### Degrade `?` — element disappears in roughly half of cycles

`a?` drops `a` with probability 0.5 per cycle. Determinism: identical
`cycleN` always produces the same outcome.

**Statistical spec:** Over 1000 distinct cycles `evaluatePattern("a?", c)` for
`c = 0..999`, the number of cycles producing one event should be within
99% confidence interval for binomial(1000, 0.5) — i.e. between roughly 460
and 540.

**Determinism:** `evaluatePattern("a?", k) === evaluatePattern("a?", k)`
exactly, for every `k`.

---

### Degrade with explicit probability — `a?0.8`

`a?0.8` drops `a` in roughly 80% of cycles.

**Statistical spec:** Over 1000 cycles, the count of cycles producing one
event should be `> 0` and `< 300` (well below the binomial(1000, 0.2)
upper bound).

---

### Degrade independence across siblings

In `a? b?`, the two `?` rolls must be independent — they receive different
PRNG seeds (Lidal seeds by `cycleN * 7919 + floor(slotStart * 1e6)`).

**Statistical spec:** Over many cycles, the joint distribution of
`(a-present, b-present)` should approximate uniform on
`{(T,T), (T,F), (F,T), (F,F)}` with each cell near 25%.

---

### Random pick `|` — `[a b | c d]` picks one whole sub-sequence per cycle

Each `|`-separated group is sequenced together; one group plays per cycle.

**Per-cycle determinism:** `evaluatePattern("a b | c d", k)` always returns
either the events of `"a b"` or the events of `"c d"` (never mixed),
deterministically for each `k`.

**Statistical spec:** Over 1000 cycles, roughly 50% should match `"a b"` and
50% `"c d"` (binomial(1000, 0.5)).

---

### Random pick distribution — three branches

For `"a | b | c"`, over 900 cycles each of `a`, `b`, `c` should appear
roughly 300 times (chi-squared test on the three-way distribution).

---

### Random pick — multiple independent uses

Two separate `|` expressions in the same pattern get independent seeds.

**Input:** `[a|b] [a|b]` evaluated over 1000 cycles.

**Statistical spec:** The four combined outcomes `aa, ab, ba, bb` each appear
in roughly 25% of cycles (chi-squared test on 4 equally-likely cells).

---

### Chord shorthand `c'maj` — emits chord intervals concurrently

`c'maj` expands to a polyrhythm of three concurrent voices: C4, E4, G4 (C
major triad, root MIDI 60). Each voice fills the slot.

**Input:** `evaluatePattern("c'maj")`

**Expected events (all start=0, duration=1):**

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "0"  |
| 0     | 1        | "4"  |
| 0     | 1        | "7"  |

**Notes:** Names are semitone offsets from C4 (=60). C major = `{0, 4, 7}`.

---

### Chord shorthand with explicit octave — `c5'maj`

C major rooted at C5 (MIDI 72) → semitone offsets from C4 are `12, 16, 19`.

**Expected events (all start=0, duration=1):**

names: `"12"`, `"16"`, `"19"`.

---

### Chord shorthand `f#3'min7`

F#3 = MIDI 54; min7 intervals = `{0, 3, 7, 10}`; offsets from C4 = `54-60,
57-60, 61-60, 64-60` = `-6, -3, 1, 4`.

**Expected events (all start=0, duration=1):**

names: `"-6"`, `"-3"`, `"1"`, `"4"`.

---

### Chord shorthand within a sequence — chord shares the slot

`evaluatePattern("a c'maj")` produces 1 + 3 events:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "0"  |
| 1/2   | 1/2      | "4"  |
| 1/2   | 1/2      | "7"  |

---

### Trailing suffix on group — `[a b]*2`

A suffix attaches to the preceding group node.

**Input:** `evaluatePattern("[a b]*2")`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "a"  |
| 1/4   | 1/4      | "b"  |
| 1/2   | 1/4      | "a"  |
| 3/4   | 1/4      | "b"  |

---

### Trailing suffix on alternation — `<a b>*2`

`*2` on `<a b>` advances the alternation twice within one cycle.

**Cycle 0** of `evaluatePattern("<a b>*2", 0)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

**Cycle 1** of `evaluatePattern("<a b>*2", 1)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

**Notes:** The alternation pointer advances as `(cycleN * repeat + r) % len`,
so with `repeat=2` and `len=2`, each cycle still emits `(a,b)` but a 3-element
alternation `<a b c>*2` would tour differently — see next spec.

---

### Alternation advances per-occurrence — `<a b c>*2`

`*2` makes the alternation fire twice per cycle, advancing the cursor each
occurrence.

**Cycle 0** picks `c.children[(0*2+0)%3]=a`, then `c.children[(0*2+1)%3]=b`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

**Cycle 1** picks `c.children[(1*2+0)%3]=c`, then `c.children[(1*2+1)%3]=a`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "c"  |
| 1/2   | 1/2      | "a"  |

**Cycle 2:** picks indices `4%3=1` then `5%3=2` → names `"b"`, `"c"`.

---

## Time scaling

### `fast 2` doubles density, halves duration

`fast 2` applied to a 4-step pattern produces 8 events per cycle, each at
half duration.

**Input:** `n("0 1 2 3").fast(2).getEvents(0)`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/8      | "0"  |
| 1/8   | 1/8      | "1"  |
| 2/8   | 1/8      | "2"  |
| 3/8   | 1/8      | "3"  |
| 4/8   | 1/8      | "0"  |
| 5/8   | 1/8      | "1"  |
| 6/8   | 1/8      | "2"  |
| 7/8   | 1/8      | "3"  |

**Notes:** Velocity is `100` on each event. `density 2` is an alias for
`fast 2`.

---

### `fast 1` is a no-op

`n("a b").fast(1).getEvents(0)` is exactly `n("a b").getEvents(0)`.

---

### `fast 3` triples density

`n("a").fast(3).getEvents(0)` produces 3 events:

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 1/3   | 1/3      | "a"  |
| 2/3   | 1/3      | "a"  |

---

### `slow 2` halves density, doubles duration

`slow 2` on a one-cycle pattern shows only the first half of the pattern
within one host cycle.

**Input:** `n("a b").slow(2).getEvents(0)`

**Expected events:** one event filling the full host cycle with name `"a"`.

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |

**Cycle 1** of `n("a b").slow(2).getEvents(1)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "b"  |

**Notes:** A `slow 2` pattern takes 2 host cycles to play through once.

---

### `slow 2` then `fast 2` recovers the original pattern

`n("a b c d").slow(2).fast(2).getEvents(0)` equals `n("a b c d").getEvents(0)`.

---

### `sparsity` is an alias for `slow`

`p.slow(2).getEvents(c)` and `sparsity(2)(p).getEvents(c)` produce identical
output for every `c`.

---

### `fast` with a patterned argument — Patternable<number>

`fast "<2 3>"` alternates between fast-2 and fast-3 across consecutive
cycles. The Patternable is sampled at phase 0 of each cycle.

**Cycle 0** of `n("a b").fast("<2 3>").getEvents(0)`:

Two cycles of `"a b"` crammed into one host cycle:

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "a"  |
| 1/4   | 1/4      | "b"  |
| 1/2   | 1/4      | "a"  |
| 3/4   | 1/4      | "b"  |

**Cycle 1** of `n("a b").fast("<2 3>").getEvents(1)`:

Three cycles of `"a b"` crammed into one host cycle:

| start | duration | name |
|-------|----------|------|
| 0     | 1/6      | "a"  |
| 1/6   | 1/6      | "b"  |
| 2/6   | 1/6      | "a"  |
| 3/6   | 1/6      | "b"  |
| 4/6   | 1/6      | "a"  |
| 5/6   | 1/6      | "b"  |

---

### `fast` rejects non-positive arguments

`n("a").fast(0).getEvents(0)` throws. So does `fast(-1)`.

---

## Structural transforms

### `rev` reverses event order within each cycle

Each event's start becomes `1 - (start + duration)`.

**Input:** `n("a b c").rev().getEvents(0)`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "c"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "a"  |

**Notes:** Order across cycles is not reversed — only the contents of each
cycle individually.

---

### `palindrome` alternates forward and reversed cycles

Equivalent to `cat([p, p.rev()])`.

**Cycle 0** of `n("a b c").palindrome().getEvents(0)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "c"  |

**Cycle 1** of `n("a b c").palindrome().getEvents(1)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "c"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "a"  |

---

### `linger 4` plays the first quarter of the cycle four times

Takes events whose start falls in `[0, 1/N)`, then repeats that slice `N`
times across the cycle.

**Input:** `n("0 1 2 3 4 5 6 7").linger(4).getEvents(0)`

The first quarter of the source contains events at start `0/8, 1/8`
(both `< 1/4`). The output repeats `(0, 1)` four times:

| start | duration | name |
|-------|----------|------|
| 0     | 1/8      | "0"  |
| 1/8   | 1/8      | "1"  |
| 2/8   | 1/8      | "0"  |
| 3/8   | 1/8      | "1"  |
| 4/8   | 1/8      | "0"  |
| 5/8   | 1/8      | "1"  |
| 6/8   | 1/8      | "0"  |
| 7/8   | 1/8      | "1"  |

**Notes:** `linger` requires `N >= 1` (round-clamped); fractional values are
not supported and will throw if `< 1`.

---

### `inside 2 rev` reverses within a single cycle of a doubled pattern

`p.inside(2, rev)` is `rev(p.slow(2)).fast(2)`.

**Input:** `n("a b c d").inside(2, rev).getEvents(0)`

**Expected events:** Same as `n("b a d c").getEvents(0)`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "b"  |
| 1/4   | 1/4      | "a"  |
| 2/4   | 1/4      | "d"  |
| 3/4   | 1/4      | "c"  |

---

### `outside 2 rev` reverses at a slower rate

For a pattern already slowed by 2, `outside(2, rev)` first speeds it up
(making the original cycle worth of data fit in one host cycle), reverses
it, then slows back down.

**Input:** `n("a b c d").slow(2).outside(2, rev).getEvents(0)`

**Expected events:** Same as `n("d c").getEvents(0)`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "d"  |
| 1/2   | 1/2      | "c"  |

---

### `iter 4` shifts the pattern left by 1/N each cycle

`iter 4` rotates the cycle leftward by `cycleN/4`.

**Cycle 0** of `n("0 1 2 3").iter(4).getEvents(0)`:

Unchanged:

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "0"  |
| 1/4   | 1/4      | "1"  |
| 2/4   | 1/4      | "2"  |
| 3/4   | 1/4      | "3"  |

**Cycle 1** — shift = -1/4 (left by 1/4):

The event originally at 0 wraps to start 3/4; subsequent events shift left.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "1"  |
| 1/4   | 1/4      | "2"  |
| 2/4   | 1/4      | "3"  |
| 3/4   | 1/4      | "0"  |

**Cycle 2** — shift = -2/4:

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "2"  |
| 1/4   | 1/4      | "3"  |
| 2/4   | 1/4      | "0"  |
| 3/4   | 1/4      | "1"  |

**Cycle 4** — shift = 0 again (mod 4):

Same as cycle 0.

---

### `rot N` rotates event NAMES leftward by N positions

`rot` keeps event timing but rotates the values.

**Input:** `n("a b c d").rot(1).getEvents(0)`

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "b"  |
| 1/4   | 1/4      | "c"  |
| 2/4   | 1/4      | "d"  |
| 3/4   | 1/4      | "a"  |

**Notes:** Unlike `iter`, `rot N` is constant across all cycles (it does not
depend on `cycleN`) — sampled once per host cycle from its Patternable
argument at phase 0.

---

### `chunk N fn` applies `fn` to one of N equal slices per cycle, rotating per cycle

`p.chunk(N, fn)` divides each cycle into N slices and applies `fn` to slice
`cycleN % N`. The rest of the slices pass through unchanged.

**Cycle 0** of `n("0 1 2 3").chunk(4, add(10)).getEvents(0)`:

Slice 0 (positions `[0, 1/4)`) gets `+10`; others unchanged. Source events
are at starts `0, 1/4, 2/4, 3/4`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "10" |
| 1/4   | 1/4      | "1"  |
| 2/4   | 1/4      | "2"  |
| 3/4   | 1/4      | "3"  |

**Cycle 1** — slice 1 gets `+10`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "0"  |
| 1/4   | 1/4      | "11" |
| 2/4   | 1/4      | "2"  |
| 3/4   | 1/4      | "3"  |

**Notes:** `chunk` partitions by EVENT START position (`>= lo && < hi`).
Events from `fn(p)` that fall outside the target slice are dropped; events
from `p` that fall inside it are dropped.

---

### `stutter N time` repeats each event N times with `time` spacing

Copies that extend past the cycle boundary are dropped.

**Input:** `n("a").stutter(3, 1/4).getEvents(0)`

Source has one event at start 0, duration 1. Stutter emits three copies at
`start = 0, 1/4, 2/4`. Each copy's duration is `min(1, 1 - start)`.

**Expected events:**

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |
| 1/4   | 3/4      | "a"  |
| 2/4   | 1/2      | "a"  |

**Notes:** Copies whose start ≥ 1 are dropped.

---

### `stutter` with start past cycle boundary — drops late copies

`n("a").stutter(5, 1/3).getEvents(0)` emits copies at `0, 1/3, 2/3, 1, 4/3`.
The copies at `start >= 1` are dropped. Resulting events (3 total):

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |
| 1/3   | 2/3      | "a"  |
| 2/3   | 1/3      | "a"  |

---

### `mask` keeps only events covered by a non-rest event in the mask pattern

**Input:** `n("a b").mask("x ~ x x").getEvents(0)`

Source events: `(a @ 0..1/2)`, `(b @ 1/2..1)`. Mask events: `x @ 0..1/4`,
`x @ 2/4..3/4`, `x @ 3/4..1` (rest in slot 1 produces no event).

`a` starts at 0, covered by mask `(0..1/4)` → keep.
`b` starts at 1/2, covered by mask `(2/4..3/4)` → keep.

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

---

### `mask` removes events not covered

**Input:** `n("a b").mask("~ x").getEvents(0)`

Source: `a @ 0..1/2`, `b @ 1/2..1`. Mask: `(x @ 1/2..1)` only. `a` start=0
is not in any mask event → drop. `b` start=1/2 is in mask → keep.

| start | duration | name |
|-------|----------|------|
| 1/2   | 1/2      | "b"  |

---

### `mask` accepts a string and promotes it via `n()`

`p.mask("x ~ x x")` and `p.mask(n("x ~ x x"))` produce identical events.

---

### `struct` adopts the timing of a structure pattern

`p.struct(structPat)` uses `structPat`'s event timing as the rhythm and
cycles `p`'s values through those slots.

**Input:** `n("a b").struct("1 1 1").getEvents(0)`

Source values: `["a", "b"]`. Struct slots: 3 equal events at starts
`0, 1/3, 2/3`. Output uses source values cyclically by index modulo 2:

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "a"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "a"  |

**Notes:** `struct` does NOT use note value of the structure pattern — only
its slot timing. Empty source returns `[]`.

---

## Conditional transforms

### `every N fn` applies `fn` to every Nth cycle (0-indexed: cycle 0, N, 2N, ...)

**Cycle 0** of `n("a b c").every(3, fast(2)).getEvents(0)`:

Transformed: `fast(2)` applied. Two cycles of `"a b c"` crammed in:

| start | duration | name |
|-------|----------|------|
| 0     | 1/6      | "a"  |
| 1/6   | 1/6      | "b"  |
| 2/6   | 1/6      | "c"  |
| 3/6   | 1/6      | "a"  |
| 4/6   | 1/6      | "b"  |
| 5/6   | 1/6      | "c"  |

**Cycle 1:** untransformed (3 events).

**Cycle 2:** untransformed (3 events).

**Cycle 3:** transformed (6 events) — `cycleN % 3 === 0`.

---

### `every` rejects N < 1

`every(0, fn)` throws; so does `every(-1, fn)`. Fractional N is rounded.

---

### `whenmod m n fn` applies `fn` when `cycleN % m === n`

**Cycle 0** of `n("a").whenmod(3, 1, fast(2)).getEvents(0)`: untransformed
(0 % 3 === 0, not 1).

**Cycle 1:** transformed (1 % 3 === 1).

**Cycle 2:** untransformed.

**Cycle 4:** transformed (4 % 3 === 1).

---

### `sometimes fn` is `sometimesBy 0.5 fn`

`sometimes` applies `fn` with probability 0.5 per cycle, deterministic per
`cycleN` (seed namespace 6997).

**Statistical spec:** Over 1000 cycles, count of transformed cycles is in
`[460, 540]` (99% CI for binomial(1000, 0.5)).

**Determinism spec:** Re-evaluating any single cycle always yields the same
choice.

---

### `often fn` is `sometimesBy 0.75 fn`

Over 1000 cycles, transformed count is roughly 750 (within binomial 99% CI
of about `[715, 785]`).

---

### `rarely fn` is `sometimesBy 0.25 fn`

Over 1000 cycles, transformed count is roughly 250 (within binomial 99% CI
of about `[215, 285]`).

---

### `sometimesBy 0` never applies `fn`

`p.sometimesBy(0, f).getEvents(c)` equals `p.getEvents(c)` for every `c`.

---

### `sometimesBy 1` always applies `fn`

`p.sometimesBy(1, f).getEvents(c)` equals `f(p).getEvents(c)` for every `c`.

---

### `degrade` is `degradeBy 0.5` and uses a different seed per slot

`p.degrade()` drops events with per-event probability 0.5; each event index
uses a distinct seed (`cycleN * 1009 + i`), so siblings drop independently.

**Statistical spec:** For `s("bd bd bd bd").degrade()`, over 1000 cycles the
total kept-event count should be near `1000 * 4 * 0.5 = 2000` (within
binomial 99% CI).

---

### `degradeBy 0` is a no-op

`p.degradeBy(0).getEvents(c)` equals `p.getEvents(c)` for every `c`.

---

### `degradeBy 1` drops every event

`p.degradeBy(1).getEvents(c)` equals `[]` for every `c`.

---

## Time shifting

### `early t` shifts events earlier (leftward) by `t` cycle fractions, wrapping

**Input:** `n("a b").early(0.25).getEvents(0)`

Source events at starts `0, 1/2`. Shift by `-0.25` (so `wrapShift` adds 0.75
mod 1): new starts `0.75, 0.25`. After sorting:

| start | duration | name |
|-------|----------|------|
| 1/4   | 1/2      | "b"  |
| 3/4   | 1/4      | "a"  |

Note: the `a` event would have ended at `0.75 + 0.5 = 1.25`, so `wrapShift`
splits it. Actually `wrapShift` does split: original `a` (start 0, dur 1/2)
gets newStart `0.75`, end `1.25 > 1`, so split into `(0.75, 0.25)` and
`(0, 0.25)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "a"  |
| 1/4   | 1/2      | "b"  |
| 3/4   | 1/4      | "a"  |

**Notes:** Events spanning the cycle boundary are split into two
sub-events that together cover the original duration.

---

### `late t` shifts events later (rightward) by `t`

`p.late(t)` is symmetric to `p.early(t)`. `n("a b").late(0.25).getEvents(0)`:

Source starts `0, 1/2`. Shift by `+0.25`: new starts `0.25, 0.75`. The `b`
event (start 0.75, dur 0.5) spans wrap; split into `(0.75, 0.25)` and
`(0, 0.25)`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "b"  |
| 1/4   | 1/2      | "a"  |
| 3/4   | 1/4      | "b"  |

---

### `nudge t` is an alias for `late t`

`p.nudge(t).getEvents(c)` equals `p.late(t).getEvents(c)` for all `c`.

---

### `early` / `late` with a full-cycle shift is a no-op

`p.early(1).getEvents(c)` equals `p.getEvents(c)`. (Normalization is `t % 1`.)

---

### `early` / `late` with a negative shift normalizes correctly

`p.early(-0.25).getEvents(c)` equals `p.late(0.25).getEvents(c)`.

---

### `off t fn` overlays a transformed-and-shifted copy on the original

`p.off(t, fn)` is `stack(p, fn(p).late(t))`.

**Input:** `n("a").off(0.25, fast(2)).getEvents(0)`

Original: `[{start:0, dur:1, name:"a"}]`. `fast(2)` of `p`: `[{0, 1/2,
"a"}, {1/2, 1/2, "a"}]`. Then `.late(0.25)`: starts shift to `1/4, 3/4`.
The shifted event at `3/4 .. 5/4` spans the cycle boundary and `wrapShift`
splits it into `(3/4, 1/4)` and `(0, 1/4)`. Stacked with the original:

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |
| 0     | 1/4      | "a"  |
| 1/4   | 1/2      | "a"  |
| 3/4   | 1/4      | "a"  |

**Notes:** Events sorted by `start`; the original full-cycle event sits at
start 0 alongside the wrapped split-off copy.

---

## Windowing

### `zoom a b` selects the window `[a, b]` and rescales to fill the cycle

**Input:** `n("a b c d").zoom(1/4, 3/4).getEvents(0)`

Source events: `(a, 0..1/4), (b, 1/4..2/4), (c, 2/4..3/4), (d, 3/4..1)`.
Window `[1/4, 3/4]` contains `b` and `c` fully. After rescaling to span the
whole cycle:

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "b"  |
| 1/2   | 1/2      | "c"  |

---

### `zoom` rejects invalid ranges

`zoom(0, 0)`, `zoom(0.5, 0.2)`, `zoom(-0.1, 0.5)`, `zoom(0.5, 1.5)` all throw.

---

### `compress a b` squeezes the cycle into the window `[a, b]`

The inverse of `zoom`: maps `[0, 1]` to `[a, b]`, leaving the rest empty.

**Input:** `n("a b").compress(1/4, 3/4).getEvents(0)`

Source events `(a, 0..1/2), (b, 1/2..1)`. Span = `3/4 - 1/4 = 1/2`. New
events: `(a, 1/4 + 0*1/2..1/2 * 1/2) = (a, 1/4..1/2)`, `(b, 1/4 + 1/2*1/2..
1/2 * 1/2) = (b, 1/2..3/4)`.

| start | duration | name |
|-------|----------|------|
| 1/4   | 1/4      | "a"  |
| 1/2   | 1/4      | "b"  |

---

### `trunc N` truncates the cycle to its first N fraction

**Input:** `n("a b c d").trunc(0.5).getEvents(0)`

Source events: starts at `0, 1/4, 2/4, 3/4`. Only events with `start < 0.5`
are kept; their durations are clipped to end at `0.5`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "a"  |
| 1/4   | 1/4      | "b"  |

**Notes:** `trunc` requires `0 < N <= 1`.

---

## Multi-pattern combinators

### `stack` plays all parts simultaneously

**Input:** `stack([n("a"), n("b"), n("c")]).getEvents(0)`

Each part's full-cycle event is layered:

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "a"  |
| 0     | 1        | "b"  |
| 0     | 1        | "c"  |

---

### `stack` rejects an empty array

`stack([])` throws.

---

### `stack` rejects mixed note + drum patterns

`stack([n("a"), s("bd")])` throws (cannot mix `notes` and `drums` portType).

---

### `cat` picks one part per cycle (mod-N over part count)

**Cycle 0** of `cat([n("a"), n("b")]).getEvents(0)`: `[{0, 1, "a"}]`.

**Cycle 1:** `[{0, 1, "b"}]`.

**Cycle 2:** `[{0, 1, "a"}]`.

**Notes:** Each part plays one full host cycle when picked.

---

### `fastcat` (alias `seq`) crams all parts into one cycle

**Input:** `fastcat([n("a"), n("b")]).getEvents(0)`

Two parts share the cycle, each in a 1/2 slot. Each part's full-cycle event
(start 0, dur 1) is rescaled to fit its slot.

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |
| 1/2   | 1/2      | "b"  |

**Notes:** `fastcat([n("a b"), n("c")]).getEvents(0)` produces 3 events:
`(a, 0..1/4), (b, 1/4..1/2), (c, 1/2..1)`.

---

### `seq` is exactly `fastcat`

`seq([...])` and `fastcat([...])` produce identical events for any input
that satisfies the array validation.

---

## Routing

### `.ch N` sets absolute MIDI channel 1..16 (clamped, then 0-indexed internally)

`n("a").ch(5).channel === 4` (0-indexed). Internally clamped to `[0, 15]`.

`.ch(20)` becomes channel 15. `.ch(0)` becomes channel 0. `.ch(-3)` becomes
channel 0.

---

### `jux fn` routes original on `channel` and `fn(p)` on `channel + 1`

`jux(fn)` is sugar for `juxBy(1, fn)`. The transformed copy's events are
tagged with `channelOffset: 1` so the scheduler routes them one channel up.

**Input:** `n("a").jux(rev).getEvents(0)`

Source emits: `{start:0, dur:1, name:"a", velocity:100}`. `rev(p)` emits the
same (single event), tagged with `channelOffset: 1`. Stacked output:

Two events, both name `"a"`, start 0, dur 1:
- one with no channel/channelOffset (inherits orbit channel)
- one with `channelOffset: 1`

---

### `juxBy offset fn` uses a custom channel offset

`p.juxBy(3, fn)` routes `fn(p)` on `channel + 3`.

---

### `juxTo absChannel fn` routes `fn(p)` on an absolute channel

`p.juxTo(5, fn)` tags the transformed events with `channel: 4` (0-indexed
from input 5), so they fire on that absolute channel regardless of orbit.

---

### `jux` does not duplicate explicit-channel events

If the transformed pattern has its own `.ch()`, its explicit channel wins
over `channelOffset`.

---

## Velocity, gain, and degrade

### `gain N` scales velocity by N, clamped to [0, 127]

`n("a").gain(0.5).getEvents(0)[0].velocity` equals `round(100 * 0.5)` = 50.

`n("a").gain(2).getEvents(0)[0].velocity` equals `min(127, round(100 * 2))`
= 127 (clamped).

`n("a").gain(0).getEvents(0)[0].velocity` equals 0.

`n("a").gain(-1).getEvents(0)` throws (gain must be non-negative).

---

### `velocity v` sets velocity directly

If `v <= 1`, velocity is `round(v * 127)`; if `v > 1`, velocity is `round(v)`
(treated as a 0..127 MIDI value already).

- `n("a").velocity(0.5).getEvents(0)[0].velocity` = `round(0.5 * 127)` = 64.
- `n("a").velocity(80).getEvents(0)[0].velocity` = 80.
- `n("a").velocity(200).getEvents(0)[0].velocity` = 127 (clamped).
- `n("a").velocity(-1).getEvents(0)` throws.

---

### `gain` accepts a continuous signal — per-event sampling at event start

`n("0 1 2 3").gain(sine).getEvents(0)` samples `sine` at each event's start
phase `(0, 1/4, 2/4, 3/4)`. `sine(_, ph) = (sin(2πph) + 1) / 2`, so:

- ph=0:   sine = 0.5 → velocity round(100 * 0.5) = 50
- ph=1/4: sine = 1.0 → velocity 100 (clamped via `min(127, round(100))`)
- ph=2/4: sine = 0.5 → velocity 50
- ph=3/4: sine = 0.0 → velocity 0

---

### `gain` accepts a Pattern as argument

`n("0 1 2 3").gain(n("0.5 1")).getEvents(0)` samples the gain pattern at each
event's start. Source events at `0, 1/4, 2/4, 3/4`. Gain pattern events:
`(0.5 @ 0..1/2), (1 @ 1/2..1)`. So:

- events at 0 and 1/4 multiply velocity by 0.5 → velocity 50
- events at 2/4 and 3/4 multiply velocity by 1 → velocity 100

---

## Pitch math

### `add N` adds N to each event's pitch offset

`n("0 1 2 3").add(5).getEvents(0)` — each event accumulates `offset += 5`.
The scheduler applies `offset` to the resolved MIDI note before output.

| start | duration | name | offset |
|-------|----------|------|--------|
| 0     | 1/4      | "0"  | 5      |
| 1/4   | 1/4      | "1"  | 5      |
| 2/4   | 1/4      | "2"  | 5      |
| 3/4   | 1/4      | "3"  | 5      |

---

### `sub N` subtracts from offset

`n("0").sub(3).getEvents(0)[0].offset === -3`.

---

### `mul N` multiplies existing offset by N

`n("0").add(4).mul(2).getEvents(0)[0].offset === 8`. The base offset (0) +
add(4) → 4; then mul(2) → 8.

---

### `up N` is an alias for `add N`

`n("0").up(5).getEvents(0)` and `n("0").add(5).getEvents(0)` produce
identical output (including offset).

---

### `octave N` adds N * 12 to offset

`n("0").octave(2).getEvents(0)[0].offset === 24`.

---

### `add` chains accumulate

`n("0").add(3).add(4).getEvents(0)[0].offset === 7`.

---

### `add` with a continuous signal — smooth per-event offset

`n("0 0 0 0").add(range2(-12, 12, sine2)).getEvents(0)`: `range2(-12, 12,
sine2)` is a signal that maps sine2's `[-1, 1]` to `[-12, 12]`. Sampled at
event starts `0, 1/4, 2/4, 3/4`:

- ph=0:   sine2=0   → offset 0
- ph=1/4: sine2=1   → offset 12
- ph=2/4: sine2=0   → offset 0
- ph=3/4: sine2=-1  → offset -12

---

### `range(lo, hi, sig)` scales a unipolar [0..1] source to [lo, hi]

`range(50, 100, saw)` at phase 0 = 50; at phase 0.5 = 75; at phase 1 (= 0
mod 1) = 50 again.

---

### `range2(lo, hi, sig)` scales a bipolar [-1..1] source to [lo, hi]

`range2(1000, 1100, src)` where src is a Pattern with values `(-1, -0.5, 0,
0.5)` produces values `(1000, 1025, 1050, 1075)`.

**Input:** `range2(1000, 1100, n("-1 -0.5 0 0.5")).getEvents(0)`

| start | duration | name   |
|-------|----------|--------|
| 0     | 1/4      | "1000" |
| 1/4   | 1/4      | "1025" |
| 2/4   | 1/4      | "1050" |
| 3/4   | 1/4      | "1075" |

---

## Music theory

### `scale "major"` maps integer degrees to semitones using the major intervals

Major scale intervals: `[0, 2, 4, 5, 7, 9, 11]`. Degree N → `floor(N/7) * 12
+ intervals[N mod 7]`.

`n("0 1 2 3 4 5 6").scale("major").getEvents(0)` produces names:

| degree | name (semitones) |
|--------|-----------------|
| 0      | "0"             |
| 1      | "2"             |
| 2      | "4"             |
| 3      | "5"             |
| 4      | "7"             |
| 5      | "9"             |
| 6      | "11"            |

---

### `scale "major"` wraps octave for degrees outside [0, len)

Degree 7 (major scale, 7 notes) → `1*12 + intervals[0] = 12`.

`n("7").scale("major").getEvents(0)[0].name === "12"`.

Degree 8 → `1*12 + intervals[1] = 14`. Degree -1 → `-1*12 + intervals[6] =
-12 + 11 = -1`.

---

### `scale "minor"` (natural) intervals `[0, 2, 3, 5, 7, 8, 10]`

`n("0 1 2 3 4 5 6").scale("minor").getEvents(0)` produces names `"0", "2",
"3", "5", "7", "8", "10"`.

---

### `scale "dorian"` intervals `[0, 2, 3, 5, 7, 9, 10]`

`n("0 1 2 3 4 5 6").scale("dorian").getEvents(0)` produces names `"0", "2",
"3", "5", "7", "9", "10"`.

---

### `scale "pentatonicMinor"` is 5 notes; degree 5 octave-wraps

`pentatonicMinor` intervals = `[0, 3, 5, 7, 10]`. Degree 5 → `1*12 + 0 =
12`. Degree 4 → `10`.

---

### `scale` rejects unknown names

`n("0").scale("frobnitz").getEvents(0)` throws.

---

### `scale` rejects non-integer tokens

`n("a").scale("major").getEvents(0)` throws (token must parse as integer).

---

### `chord("Cmaj")` produces three concurrent voices at C4, E4, G4

`chord(name)` returns a Pattern whose events all fire at start=0, dur=1, with
names equal to semitone offsets from C4 (=60).

`chord("Cmaj").getEvents(0)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1        | "0"  |
| 0     | 1        | "4"  |
| 0     | 1        | "7"  |

---

### `chord("C7")` produces dominant-7 — `[0, 4, 7, 10]`

`chord("C7").getEvents(0)` produces 4 concurrent events with names `"0",
"4", "7", "10"`.

**Notes:** `C7` parses as C + chord `"7"` (dominant 7), NOT as C7-octave +
default chord — because the chord-name interpretation is tried first.

---

### `chord("F#3min7")` — explicit octave on F#3 with min7

F#3 = MIDI 54. min7 intervals = `[0, 3, 7, 10]`. Offsets from C4: `54-60,
57-60, 61-60, 64-60` = `-6, -3, 1, 4`.

`chord("F#3min7").getEvents(0)` produces names `"-6", "-3", "1", "4"`.

---

### `chord("Bb9")` is C-relative offsets for Bb dominant-9

Bb4 = MIDI 70. `"9"` intervals = `[0, 4, 7, 10, 14]`. Offsets from C4 (60):
`10, 14, 17, 20, 24`.

Names: `"10", "14", "17", "20", "24"`.

---

### `chord` defaults to major when no chord suffix

`chord("C")` is equivalent to `chord("Cmaj")` — produces `0, 4, 7`.

---

### `arp "up"` arpeggiates concurrent chord notes low to high

`chord("Cmaj").arp("up").getEvents(0)` turns 3 concurrent notes into a
sequence within their shared duration.

Group's total duration = 1. With 3 notes, slot = 1/3. Sorted low→high by
parsed name: `["0", "4", "7"]`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "0"  |
| 1/3   | 1/3      | "4"  |
| 2/3   | 1/3      | "7"  |

---

### `arp "down"` arpeggiates high to low

`chord("Cmaj").arp("down").getEvents(0)`:

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "7"  |
| 1/3   | 1/3      | "4"  |
| 2/3   | 1/3      | "0"  |

---

### `arp "updown"` goes up, then back down

`chord("Cmaj").arp("updown").getEvents(0)`. Sorted = `[0, 4, 7]`. For 3+
notes, updown = `[...sorted, ...sorted.slice(1, -1).reverse()]`, so
`[0, 4, 7]` becomes `[0, 4, 7, 4]` — no repeat of the `7` peak nor the
`0` trough.

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "0"  |
| 1/4   | 1/4      | "4"  |
| 2/4   | 1/4      | "7"  |
| 3/4   | 1/4      | "4"  |

Special case for length 2: `slice(1, -1)` of a 2-element array is `[]`,
which would collapse the arp back to plain "up" and leave the bottom note
hanging at the end of the cycle. To make a 2-note arp actually move, the
low note is appended explicitly: sorted `[a, b]` becomes `[a, b, a]`
(three slots of 1/3) — see TOFIX #21.

For length 1, the result is the single note unchanged.

---

### `arp "converge"` interleaves from outside in

`chord("Cmaj").arp("converge").getEvents(0)`. With sorted `[0, 4, 7]`:
order2 = `[0, 7, 4]`.

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "0"  |
| 1/3   | 1/3      | "7"  |
| 2/3   | 1/3      | "4"  |

---

### `arp` passes through events with unique start times unchanged

`n("a b c").arp("up").getEvents(0)` produces the same events as `n("a b c")`
— `arp` only re-orders groups of concurrent events; sequential events have
unique starts and are passed through.

---

## Value constructors

### `run N` produces a sequence `0 1 ... N-1` across one cycle

**Input:** `run(4).getEvents(0)`

| start | duration | name |
|-------|----------|------|
| 0     | 1/4      | "0"  |
| 1/4   | 1/4      | "1"  |
| 2/4   | 1/4      | "2"  |
| 3/4   | 1/4      | "3"  |

---

### `silence` is a Pattern that always emits no events

`silence.getEvents(c)` returns `[]` for every `c`.

---

### `irand N` emits one event per cycle with value `floor(rand() * N)`

`irand(8).getEvents(c)` returns a single event for each cycle:
`{start: 0, dur: 1, name: floor(r*8)}` where r depends only on `c`.

**Determinism:** Same cycle always yields same value.

**Statistical:** Over 800 cycles of `irand(8)`, each of 0..7 should appear
roughly 100 times.

---

### `choose [a, b, c]` picks one entry per cycle, seeded by cycleN

`choose(["a", "b", "c"]).getEvents(c)` returns a single event per cycle
with name from the chosen entry.

**Determinism:** Per-cycle deterministic.

**Statistical:** Over 900 cycles, each value appears roughly 300 times.

---

### `wchoose [(weight, value), ...]` picks proportional to weight

`wchoose([[3, "a"], [1, "b"]]).getEvents(c)` returns "a" roughly 75% of
cycles and "b" roughly 25%.

**Statistical spec:** Over 1000 cycles, count of "a" is in 99% CI of
binomial(1000, 0.75) ~ `[715, 785]`.

---

### `wchoose` with zero total weight throws

`wchoose([[0, "a"], [0, "b"]]).getEvents(0)` throws.

---

## Continuous signals

### `sine` is unipolar in `[0, 1]`, peak at phase 0.25

- `sine(_, 0)` = 0.5
- `sine(_, 0.25)` = 1.0
- `sine(_, 0.5)` = 0.5
- `sine(_, 0.75)` = 0.0

---

### `sine2` is bipolar in `[-1, 1]`, peak at phase 0.25

- `sine2(_, 0)` = 0
- `sine2(_, 0.25)` = 1
- `sine2(_, 0.5)` = 0
- `sine2(_, 0.75)` = -1

---

### `saw` is unipolar ramp 0..1 across the cycle

`saw(_, 0)` = 0, `saw(_, 0.25)` = 0.25, `saw(_, 0.5)` = 0.5, `saw(_, 0.75)`
= 0.75.

---

### `saw2` is bipolar -1..1 across the cycle

`saw2(_, 0)` = -1, `saw2(_, 0.25)` = -0.5, `saw2(_, 0.5)` = 0, `saw2(_,
0.75)` = 0.5.

---

### `isaw` is the inverted saw — 1..0 across the cycle

`isaw(_, 0)` = 1, `isaw(_, 0.25)` = 0.75, `isaw(_, 0.5)` = 0.5, `isaw(_,
0.75)` = 0.25.

---

### `isaw2` is bipolar 1..-1 ramp

`isaw2(_, 0)` = 1, `isaw2(_, 0.25)` = 0.5, `isaw2(_, 0.5)` = 0, `isaw2(_,
0.75)` = -0.5.

---

### `tri` is triangle, unipolar 0..1..0

`tri(_, 0)` = 0, `tri(_, 0.25)` = 0.5, `tri(_, 0.5)` = 1.0, `tri(_, 0.75)`
= 0.5.

---

### `square` is a 50%-duty unipolar pulse

`square(_, 0.0)` = 0, `square(_, 0.49)` = 0, `square(_, 0.5)` = 1,
`square(_, 0.99)` = 1.

---

### `square2` is a bipolar -1/+1 pulse

`square2(_, 0.0)` = -1, `square2(_, 0.5)` = 1.

---

### `rand` produces a deterministic value in `[0, 1)` per `(cycle, phase)`

`rand(c, ph)` depends only on `c` and `floor(ph * 1e6)`. Same args ⇒ same
value. Adjacent phase queries (phase + delta where delta * 1e6 ≥ 1) return
distinct values.

---

### `perlin` is smooth value noise interpolating between cycle boundaries

`perlin(c, 0)` and `perlin(c+1, 0)` are distinct random values; `perlin(c,
ph)` between them is a smoothstep interpolation.

**Spec:** `perlin(c, 0)` equals `perlinSample(c)` (the lattice value at cycle
boundary). `perlin(c, 1)` (interpolated) equals `perlin(c+1, 0)` (the next
lattice value).

---

### `segment N sig` discretizes a continuous signal into N equal events per cycle

**Input:** `segment(4, sine).getEvents(0)`

Sampled at phases `0, 1/4, 2/4, 3/4`:

| start | duration | name   |
|-------|----------|--------|
| 0     | 1/4      | "0.5"  |
| 1/4   | 1/4      | "1"    |
| 2/4   | 1/4      | "0.5"  |
| 3/4   | 1/4      | "0"    |

**Notes:** Names are JavaScript-stringified floats. Velocity is 100. Exact
string format may vary by floating-point representation (e.g. `"0.5"` vs
`"0.49999..."`); tests should parse names back to numbers and compare with a
small tolerance.

---

## Composition (cross-cutting)

### `slow 2`, then `fast 2` round-trips to the original

For any pattern `p`, `p.slow(2).fast(2).getEvents(c)` equals
`p.getEvents(c)` for every `c` (modulo floating-point start/duration
precision).

---

### `rev` is self-inverse

`p.rev().rev().getEvents(c)` equals `p.getEvents(c)` for every `c`.

---

### `every 2 id` is a no-op

For `id = (x) => x`, `p.every(2, id).getEvents(c)` equals `p.getEvents(c)`
for every `c`.

---

### `every` with a never-firing N (effectively) — never transforms

`p.every(1_000_000, fast(2)).getEvents(c)` equals `p.getEvents(c)` for all
small `c` (transformation only fires at cycle 0 and every millionth cycle
thereafter).

---

### `iter N` returns to original at cycle N

`p.iter(N).getEvents(0)` and `p.iter(N).getEvents(N)` produce identical
events. (Because `cycleN % N === 0` at both ends, so shift = 0.)

---

### `palindrome` is `cat([p, p.rev()])`

`p.palindrome().getEvents(c)` equals `cat([p, p.rev()]).getEvents(c)` for
every `c`.

---

### Stack of cat preserves channel inheritance

`stack([n("a"), n("b")]).getEvents(0)` produces 2 events neither of which
has an explicit `channel` or `channelOffset` — both inherit the outer orbit
channel (set by `d1..d16`).

---

### Per-part `.ch()` tags only that part's events

`stack([n("a"), n("b").ch(5)]).getEvents(0)` produces 2 events:
- one with no `channel`/`channelOffset` (inherits orbit)
- one with `channel: 4` (5 - 1 = 0-indexed)

---

### Mixing notes and drums in `stack` / `cat` / `fastcat` throws

`stack([n("a"), s("bd")])`, `cat([n("a"), s("bd")])`, `fastcat([n("a"),
s("bd")])` all throw with the message indicating port type mismatch.

---

## Edge cases worth asserting

### Empty cycle index — cycle 0 is canonical

All pattern outputs at `cycleN = 0` are well-formed (no NaN, no negative
durations, no overlapping events except by intentional `stack` or `[,]`).

---

### Negative cycle index — `cat` with mod handles correctly

`cat([n("a"), n("b")]).getEvents(-1)` returns the same as `getEvents(1)`
(because `((-1 % 2) + 2) % 2 === 1`).

---

### Late by very large amount — `late(1000000)` is equivalent to `late(0)`

For any `p`, `p.late(1000000).getEvents(c)` equals `p.late(0).getEvents(c)`
(normalization is `t % 1`).

---

### Parser cache — repeated `evaluatePattern` calls are idempotent

`evaluatePattern(src, c)` called twice with the same `(src, c)` returns
equal arrays of events (the parser internally caches the parsed AST).

---

### Atomic chord at start of sequence — `c'maj b c`

`evaluatePattern("c'maj b c")` produces 3 (chord) + 1 + 1 events. The chord
fires in the first 1/3 slot (with all three voices concurrent, each
duration 1/3); `b` and `c` fire in the next two slots.

| start | duration | name |
|-------|----------|------|
| 0     | 1/3      | "0"  |
| 0     | 1/3      | "4"  |
| 0     | 1/3      | "7"  |
| 1/3   | 1/3      | "b"  |
| 2/3   | 1/3      | "c"  |

---

### Alternation containing rest — `<a ~ b>`

**Cycle 0:** one event, name `"a"`, full cycle.

**Cycle 1:** rest — no events.

**Cycle 2:** one event, name `"b"`, full cycle.

---

### Subdivision containing rest — `[a ~]`

| start | duration | name |
|-------|----------|------|
| 0     | 1/2      | "a"  |

(The rest in slot 1 produces no event; slot 1 is silent for half the cycle.)

---

### Euclidean inside parallel-in-slot — `[bd(3,8), hh*4]`

Two lanes share the slot via the comma; each lane fills the cycle (since
they are top-level here, the slot IS the cycle).

`[bd(3,8), hh*4]` becomes a polyrhythm with two lanes:
- lane 1: `bd(3,8)` — bd at slots 0, 3, 6 of 8 (start `0, 3/8, 6/8`, each
  duration `1/8`)
- lane 2: `hh*4` — 4 events of `hh` evenly spaced (start `0, 1/4, 2/4,
  3/4`, each duration `1/4`)

All events fit in one cycle. Sorted by start:

| start | duration | name |
|-------|----------|------|
| 0     | 1/8      | "bd" |
| 0     | 1/4      | "hh" |
| 1/4   | 1/4      | "hh" |
| 3/8   | 1/8      | "bd" |
| 1/2   | 1/4      | "hh" |
| 3/4   | 1/4      | "hh" |
| 3/4   | 1/8      | "bd" |

---

### Replication of group — `[a b]!2` (or `[a b] ! [a b]`)

`!` after a group replicates the previous sibling once.

**Input:** `evaluatePattern("[a b] ! c")`

Three slots, each 1/3:

| start | duration | name |
|-------|----------|------|
| 0     | 1/6      | "a"  |
| 1/6   | 1/6      | "b"  |
| 1/3   | 1/6      | "a"  |
| 3/6   | 1/6      | "b"  |
| 2/3   | 1/3      | "c"  |

---

### Degrade on a chord shorthand — `c'maj?`

The `?` attaches to the chord token. The whole chord either fires or
doesn't (it's a single AST node with `degrade` set).

**Statistical spec:** Over 1000 cycles of `c'maj?`, roughly half of cycles
produce 3 events and the other half produce 0 events.

---
