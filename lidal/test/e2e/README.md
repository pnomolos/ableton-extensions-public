# Lidal editor e2e probes

Playwright scripts that drive the Lidal editor and verify UX behaviour
end-to-end. There are two host modes:

1. **Live host** — the extension running inside Ableton via `dev-launch.sh`,
   serving the editor at `http://localhost:7654/`. Required for anything
   touching the LOM (drum auto-map, bake-to-clip).
2. **Headless host** — `npm run start:headless` boots the same `activate()`
   under the SDK's `TestHarness`, with `easymidi` and `abletonlink` aliased
   to no-op stubs. No native deps, no Live, no ALSA — runs anywhere Node 22
   does. Used by CI.

## Prerequisites

```
cd lidal
npm install                 # installs playwright + the SDK testing harness
npx playwright install chromium
```

## Running

### Against a Live host (manual / Mac-only)

```
# Make sure the extension is deployed + dev-launch is up:
npm run deploy
kill -HUP <dev-launch-pid>  # reload extensions

# Then drive the suite against http://localhost:7654/:
npm run test:e2e
```

### Against the headless host (cross-platform; same as CI)

```
# Terminal A — start the headless host (port override avoids colliding with
# a running Live instance):
LIDAL_HTTP_PORT=7655 npm run start:headless

# Terminal B — point Playwright at it:
LIDAL_E2E_URL=http://localhost:7655/ npm run test:e2e
```

The CI workflow (`.github/workflows/ci.yml`) wires both together in one
step; failures upload `test/e2e/out/` as a build artifact.

### Individual probes

For narrower iteration. These still talk to `LIDAL_E2E_URL` (or 7654 by default):

```
node test/e2e/probe.mjs               # smoke check — does the page load?
node test/e2e/inspect-tokens.mjs      # dump per-token class + colour
node test/e2e/interactive.mjs         # banner, brackets, comment toggle, autocomplete
node test/e2e/eval-manual.mjs         # eval + orbit-monitor + status-pill
node test/e2e/flash-and-hush.mjs      # eval flash + Cmd+. hush + error log
```

Each script writes screenshots to `test/e2e/out/`.

## What's tested vs what isn't

**Tested by `verify-ux.mjs`:**
- Per-orbit colour decoration in the editor (regex correctness, CSS specificity)
- `c4` inside a string is NOT decorated as an orbit
- Status pill renders coloured orbit spans
- CM6 diagnostics — gutter dot + inline range
- Help overlay (Cmd+?) — open, search filter, Escape sequence (clear → close)
- Command palette (Cmd+P) — open, filter by command name
- Snippet completion (`eve` → Enter → `every ${1:4} ${2:rev} ${3:p}`)
- Hover tooltip on combinator names
- Collapsible cheat sheet

**Not tested:**
- Anything that requires Live (MIDI routing, drum auto-map preview modal, bake to clip)
- Ableton Link discovery / peer count (`abletonlink` is a no-op stub in the headless host)
- The orbit-monitor "fade out after 3 s" animation timing
- Visual regressions (no screenshot diffing)
- Edge cases in the StreamLanguage tokenizer

## Adding new probes

Probes use a `globalThis.URL` workaround for path resolution and read the
target host from `LIDAL_E2E_URL` (default `http://localhost:7654/`). SSE keeps
the connection open indefinitely, so use `waitUntil: "load"` and explicit
selector waits rather than `networkidle`.

Use `process.platform === "darwin" ? "Meta" : "Control"` for modifier
shortcuts so the suite is portable between local-dev Macs and CI Linux.

To exit any active CM6 snippet placeholder/autocomplete state between tests,
press `Escape` before the next `${MOD}+a / Backspace / type` sequence.

## Headless host internals

`test/headless/runner.mjs` spins up the same `activate()` Lidal runs under
Live, but the SDK's `TestHarness` supplies the activation context. The
harness pre-bakes a Live Set (`tempo: 120`) and provides commands/UI mocks,
and we re-bind `initializeExtensionHost` to drop the harness's hardcoded
0.0.4 version check (lidal targets 0.0.5).

The headless extension bundle is built separately via `npm run build:headless`
and lands at `dist/extension-headless.cjs`. It uses esbuild's `alias` option
to swap `easymidi` and `abletonlink` for the no-op stubs in
`test/headless/*-stub.cjs`, so a vanilla Node install (no ALSA, no Link
prebuilds) can load it.

Override the editor port with `LIDAL_HTTP_PORT` to run alongside a Live
extension on 7654 without colliding.
