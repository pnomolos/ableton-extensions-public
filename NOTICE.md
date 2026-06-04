# NOTICE

This repository (the "Arclight Extensions" monorepo) is licensed under
**GPL-3.0-or-later**. See [LICENSE](LICENSE).

It depends on third-party software with its own licensing terms. The most
important obligations:

| Component | Used by | License | Notes |
|-----------|---------|---------|-------|
| **Ableton Extensions SDK** (`@ableton-extensions/sdk`) | all extensions (build-time) | Proprietary (Ableton) | **Non-redistributable.** Not included in this repo — obtain it from Ableton and place it at `extensions-sdk/` (see [BUILDING.md](BUILDING.md)). You may not redistribute the SDK. |
| **Ableton Link** (bundled by `abletonlink`) | `lidal` | GPL-2.0-or-later (with a proprietary-use exception) | GPL-3.0-or-later is compatible with GPL-2.0-or-later. For **proprietary/closed-source** use of Ableton Link, contact `link-devs@ableton.com` per Ableton's Link licensing terms. |
| `easymidi`, `@julusian/midi` | `lidal` | MIT | |
| CodeMirror 6 packages (`@codemirror/*`, `@lezer/*`) | `lidal` editor | MIT | |
| `esbuild`, `typescript`, `vitest`, `tsx` | build/dev only | MIT / Apache-2.0 | Dev dependencies; not shipped in extension bundles. |

## Trademarks

*Ableton*, *Ableton Live*, *Link*, and *Max for Live* are trademarks of
Ableton AG. This project is independent and not affiliated with, endorsed by,
or supported by Ableton AG. These names are used solely to describe
interoperability.

## Release bundles

Packaged extension bundles (`releases/*.zip`) include each extension's own
GPL-3.0-or-later code and, for native-dependency extensions, the third-party
runtime dependencies above (with their license files intact under
`node_modules/`). They do **not** include the Ableton Extensions SDK.
