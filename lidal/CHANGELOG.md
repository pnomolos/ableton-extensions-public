# Changelog

All notable changes to **Lidal** will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 (alpha) releases may introduce breaking changes between minor versions.

## [Unreleased]

In-progress work across parallel branches. Entries describe features; specific
file layout may shift before release.

### Added

- **Editor (CodeMirror 6)** — replace the textarea with CodeMirror 6: syntax
  highlighting for Lidal DSL, snippet completions with tab-stop placeholders
  (`every` → `every ${1:4} ${2:rev} ${3:p}`), bracket matching, comment toggle
  (`Cmd+/`), hover tooltips on combinator/constructor/signal names.
- **Live feedback** — inline diagnostics (gutter dot + squiggle + hover tooltip
  for eval errors), cycle/phase ring near the status pill, **per-orbit colour
  coding** carried across the editor identifier, monitor pills, and status pill
  active-orbit list. Richer monitor pills with channel + last value + CC meter
  for control orbits; bake success toast.
- **Discoverability** — `Cmd+?` opens a searchable help overlay (categorised
  combinator/constructor/signal reference, shortcuts table, mini-notation
  cheat-sheet); `Cmd+P` opens a command palette (eval / hush / bake / sync mode
  switch / insert default buffer / toggle log panel). The static cheat sheet at
  the bottom of the editor is now collapsed by default; one-line strip expands
  on click and remembers state in `localStorage`.
- **Editor UX** — log-pane search + level + source filters, per-orbit live
  monitor panel, status pill surfacing sync mode + BPM + active orbits + Link
  peer count, first-run banner pointing at the MIDI routing setup, ARIA roles
  on interactive controls and overlays.
- **Visual polish** — consolidated CSS palette (9 named colours via custom
  properties), tightened spacing and typography across the chrome, status-pill
  cross-fade on state change, log row entrance animation.
- **Backend** — clean MIDI port deactivation on extension teardown, persistent
  sync mode + manual BPM across reloads, Link peer count and play-state surfaced
  to the editor, friendlier bake error messages (including a clear "control
  orbits are not bakeable" path), drum auto-map preview modal before apply,
  per-orbit monitor events streamed via SSE.
- **CI** — Lidal now builds and runs its offline test runner and Vitest spec
  suite in `.github/workflows/ci.yml` (with `npm ci --ignore-scripts` so the
  native deps don't try to compile on ubuntu), plus a Playwright e2e step
  against a new headless host (`test/headless/runner.mjs`) so the editor's UX
  is verified on every push. Failing runs upload `test/e2e/out/` as an
  artifact. The headless host uses the SDK's `TestHarness` for the activation
  context and bundles `easymidi` + `abletonlink` as no-op stubs, so it runs on
  a stock Linux Node install.
- **Docs** — Lidal documented in the repo-root `CLAUDE.md`; first-run MIDI
  routing setup section in `lidal/README.md`; this changelog.
- **Playwright e2e harness** — `npm run test:e2e` drives Chromium against the
  editor at `LIDAL_E2E_URL` (default `http://localhost:7654/`). Probes for
  orbit colour decorations, diagnostics, help/palette overlays, snippets,
  hover tooltips, cheat-sheet expand/collapse. Works against a real Live host
  *or* the new headless host (`npm run start:headless`). Documented in
  `test/e2e/README.md`.

### Fixed

- Editor was eating in-flight keystrokes between debounced buffer syncs. The
  status SSE payload re-broadcasts the server-side buffer on every cycle; the
  client tried to suppress that overwrite when the editor was focused, but
  checked the wrong DOM node (`view.dom` vs CodeMirror's `.cm-content`) so
  the guard never fired and partial tokens got reverted. Server-driven buffer
  pushes (auto-map snippet) use their own SSE event, so the client now only
  consumes `s.buffer` from the first status frame.
- Editor no-script `<pre>` fallback was not removed when CodeMirror mounted;
  it overlaid the live editor and intercepted clicks. Now removed on mount.
- Eval/bake line-flash opacity bumped from 0.22 to 0.55 with explicit
  per-variant keyframes so the visual confirmation actually registers.
- Per-orbit colour decoration regex no longer matches `c4` inside `"…"`
  strings (was a note name being mis-coloured as orbit `c4`). Now requires
  start-of-line + trailing `$` for the canonical `dN $ …` / `cN $ …` form.
- Per-orbit colour CSS now uses a descendant selector
  (`.lidal-feedback-orbit-XX, .lidal-feedback-orbit-XX *`) so CodeMirror's
  inner token span doesn't shadow the wrapper colour.

## [0.1.0] - unreleased

Initial alpha. Establishes the DSL, scheduler, and editor harness.

### Added

- **Mini-notation parser** — sequences, subdivisions `[ ]`, parallel `[a, b]`,
  alternation `<a b c>`, polyrhythm `{a b, c d}`, polymeter `{…}%N`, repeat
  `a*N`, rest `~`, elongation `a _`, Euclidean `bd(3,8)` (with rotation),
  degrade `a?` / `a?0.3`, weighted slot `a@2 b`, replicate `a !`, ranges
  `0 .. 7`, random pick `a | b`, chord shorthand `c'maj` / `f#3'min7`.
- **Combinators** — constructors (`n`, `s`, `silence`, `run`, `irand`,
  `choose`, `wchoose`, `chord`); multi-pattern (`stack`, `cat`, `fastcat` /
  `seq`); time-scaling (`fast`, `slow`, `density`, `sparsity`); transforms
  (`rev`, `every`, `whenmod`, `sometimes(By)`, `often`, `rarely`, `chunk`,
  `iter`, `palindrome`, `mask`, `struct`, `stutter`, `inside`, `outside`,
  `rot`); time-shift (`early`, `late`, `nudge`); windowing (`linger`, `trunc`,
  `zoom`, `compress`, `off`); routing (`ch` / `chan`, `jux`, `juxBy`, `juxTo`);
  velocity (`gain`, `velocity`, `degrade`, `degradeBy`); pitch math (`add`,
  `sub`, `mul`, `up`, `octave`, `range`, `range2`).
- **Music theory** — `scale` over 14 scales (major, modes, harmonic/melodic
  minor, pentatonics, blues, chromatic); `chord` over ~20 chord qualities
  (triads, 7ths, 9ths, 6ths, sus, dim, aug); `arp` directions.
- **Drum mapping** — `drumMap N "bd:36 sd:38 …"` per-orbit alias maps;
  `autoMap` and `autoMapAll` walking a Live track's Drum Rack to derive maps
  from Simpler sample filenames; **Lidal: Auto-map drums…** right-click action
  on MIDI clips/tracks that prepends a `drumMap` snippet into the editor
  buffer and installs the map immediately.
- **Control patterns** — `ctrl N sig` for CC output on `c1`..`c8` over the
  **Lidal Control** virtual port, with auto-scaling, `range`/`range2` shaping,
  `segment N` density override, `rest N` snap-on-clear, and full combinator
  composition (`fast`, `every`, `rev`, `jux`, `stack`, …).
- **Continuous signals** — `sine`/`sine2`, `cosine`/`cos`/`cos2`, `tri`/`tri2`,
  `saw`/`saw2`, `isaw`/`isaw2`, `square`/`square2`, `rand`, `perlin`,
  `segment(N, sig)`; usable directly as combinator args (`gain sine`, `add
  (range2 (-7) 7 sine2)`).
- **Patternable arguments** — most numeric combinator args accept a constant,
  mini-notation string, Pattern, or ContinuousSignal.
- **Scheduler** — `cycleN`-indexed event dispatch; phase-aligned ticks; panic
  table for all played notes (clean `hush`); bake-history ring buffer.
- **Sync sources** — manual BPM, LOM (Live transport), MIDI clock input
  (**Lidal Clock In**), Ableton Link. Default at activate is Link → LOM →
  manual.
- **Bake** — `Cmd+B` writes the last N cycles (default 4, max 8) of the orbits
  in the block under cursor into per-orbit MIDI clips on `lidal_d<N>` /
  `lidal_s<N>` tracks via the SDK. Patterns keep playing through bake.
- **Editor** — browser-based, served from a local HTTP server on
  `localhost:7654`. SSE pushes status + log + snippet events to the page.
  Editor buffer persists across reloads via the SDK storage directory.
- **MIDI output** — three virtual output ports (`Lidal Notes`, `Lidal Drums`,
  `Lidal Control`) created via `easymidi`. Per-orbit default channel = orbit
  number for `dN` and channel 1 for `cN`; `.ch(n)` overrides.
- **Transpiler** — Tidal-ish surface syntax (`d1 $ ...`, `#` combinator)
  rewritten to executable JavaScript before sandbox eval.
- **Determinism** — every random source seeded by `cycleN` so reload produces
  the same sequence at the same cycle position.

### Known limitations

- CC orbits are not bakeable (SDK 0.0.5 has no envelope API).
- Mini-notation `/N` slow notation and `:N` sample selector are not parsed.
- `firstOf`/`lastOf`, `slice`/`bite`, `loopFirst`/`loopBack`, `swing`/`swingBy`
  combinators are not implemented.
- Tidal `|+`, `|*`, `|+|`, `|*|` value-pattern operators are intentionally
  skipped (use method form `.add`/`.mul`).
- 14-bit (high-resolution) CCs and NRPN/RPN are not supported.
- `perlin2` (2D Perlin) is not implemented; only 1D `perlin` ships.

[Unreleased]: https://example.invalid/lidal/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/lidal/releases/tag/v0.1.0
