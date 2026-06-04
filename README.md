# Arclight Extensions

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A monorepo of community-built extensions for **Ableton Live**, targeting the
Extensions SDK (API `1.0.0`).

These extensions add MIDI and audio tooling to Live — chord/key analysis,
groove extraction, transient detection, generative MIDI transforms, and a
TidalCycles-flavored live-coding environment. Each extension is an independent,
deployable bundle; several share the dependency-free `arclight-core` library for
their music-theory and signal-analysis logic.

> **Disclaimer:** *Ableton* and *Ableton Live* are trademarks of Ableton AG.
> These are independent, community-created extensions and are **not affiliated
> with, endorsed by, or supported by Ableton AG.** "Ableton Live" is used here
> only to describe what the software interoperates with.

## Extensions

| Extension | What it does |
|-----------|--------------|
| **harmonic-lens** | MIDI chord/key detection and next-chord suggestions on a clip. |
| **groove-transplant** | Extract groove feel from MIDI/audio and apply it; build drum racks from loops. |
| **beat-detective** | Audio transient detection with a waveform preview. *Analyze-only on SDK 1.0.0 — programmatic warp-marker writing is not yet exposed by the SDK.* |
| **lidal** | A TidalCycles-flavored live-coding DSL that streams patterns out as MIDI via virtual ports, with a browser-based editor. *Fully supported on macOS only — see [Platform support](#platform-support).* |
| **conway-clips** | Cellular-automata transformations of MIDI clip content. |
| **petri** | Evolutionary / generative MIDI experiments. |

## Repository layout

```
ableton-extensions/
├── arclight-core/       Shared, dependency-free TypeScript library
│                        (music theory, transient/groove/drum analysis, WAV I/O)
├── harmonic-lens/       Chord/key detection extension
├── groove-transplant/   Groove extract/apply + drum-rack builder extension
├── beat-detective/      Audio transient detection extension (analyze-only on 1.0.0)
├── lidal/               Live-coding DSL → MIDI extension + browser editor
├── conway-clips/        Cellular-automata MIDI transforms extension
├── petri/               Generative MIDI experiments extension
├── extensions-sdk/      Local placeholder for the proprietary Ableton SDK (you provide it)
├── scripts/             Shared build / deploy / pack helpers (esbuild-based)
├── dev-launch.sh        Manual Extension Host launcher for development (see DEVELOPMENT.md)
├── BUILDING.md          SDK setup, per-extension builds, deployment
├── DEVELOPMENT.md       Dev workflow, the reload loop, and dev-launch.sh caveats
└── NOTICE.md            Dependency-license chain
```

`arclight-core` is a shared, dependency-free TypeScript library (music theory,
transient/groove/drum analysis, WAV I/O) used by several of the extensions.
`scripts/` holds the shared `build-extension.js`, `deploy-extension.js`, and
`pack-extension.js` helpers that each extension's own build scripts call.

### Per-extension documentation

- [arclight-core/README.md](arclight-core/README.md)
- [harmonic-lens/README.md](harmonic-lens/README.md)
- [groove-transplant/README.md](groove-transplant/README.md)
- [beat-detective/README.md](beat-detective/README.md)
- [lidal/README.md](lidal/README.md) — includes the per-port MIDI routing setup for Live
- [conway-clips/README.md](conway-clips/README.md)
- [petri/README.md](petri/README.md)

## Requirements

- A build of **Ableton Live** whose Extension Host negotiates Extensions API
  `1.0.0` (e.g. the public beta with Extensions enabled), with **Developer
  Mode** turned on (Live → Preferences → Extensions) to load locally-built
  extensions.
- **Node.js** (LTS) and **[pnpm](https://pnpm.io)** 11+.
- The **Ableton Extensions SDK** (`@ableton-extensions/sdk`), which is
  proprietary and **not redistributable** — you must obtain it from Ableton and
  place it in this repo yourself. This project was developed against SDK
  `1.0.0-beta.0`. See **[BUILDING.md](BUILDING.md)**.

### Platform support

| Extension | macOS | Windows |
|-----------|:-----:|:-------:|
| harmonic-lens, groove-transplant, beat-detective, conway-clips, petri | ✅ | ✅ |
| lidal | ✅ | ⚠️ unsupported |

Five of the six extensions are pure JavaScript bundles and run anywhere the
Extension Host does.

**lidal is fully supported on macOS only.** It relies on native modules
(`easymidi`/RtMidi and `abletonlink`) to create its three **virtual MIDI
ports**, and the Windows MIDI API does not support creating virtual ports — so
lidal's core MIDI output path doesn't work there. Packaged builds are
accordingly produced for macOS only (`darwin-arm64` and `darwin-x64`). On
Windows you can build lidal, but running it usefully would require a
third-party virtual-MIDI driver (e.g. loopMIDI) and code changes to open
existing ports instead of creating them; this is untested and unsupported.

The development workflow (`dev-launch.sh`, see
[DEVELOPMENT.md](DEVELOPMENT.md)) is also written for macOS — it points at the
Live application bundle under `/Applications`. Building and deploying the
pure-JS extensions on Windows works with the standard `pnpm` scripts.

## Build

```bash
pnpm install
pnpm run build:all
```

See **[BUILDING.md](BUILDING.md)** for SDK setup, per-extension builds, and
deployment to your Live User Library.

## Development

See **[DEVELOPMENT.md](DEVELOPMENT.md)** for the day-to-day workflow: enabling
Developer Mode, running `dev-launch.sh`, and the deploy-then-reload loop (with
its important caveats around `SIGHUP`).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and **[NOTICE.md](NOTICE.md)** for the
full dependency-license chain (notably the Ableton Link / `abletonlink`
GPL-2.0+ terms that apply to `lidal`).
