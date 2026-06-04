# Building

## Prerequisites

- **Node.js** (LTS) and **[pnpm](https://pnpm.io)** 11+.
- A build of **Ableton Live** whose Extension Host negotiates Extensions API
  `1.0.0` (e.g. the public beta with Extensions enabled).
- The **Ableton Extensions SDK** — see below.

## 1. Obtain the Extensions SDK

The SDK (`@ableton-extensions/sdk`) is **proprietary and not redistributable**,
so it is not checked into this repo (the `extensions-sdk/` directory is
git-ignored). You must obtain it from Ableton and place it here yourself.

Every package references it as `"@ableton-extensions/sdk": "file:../extensions-sdk"`,
so the SDK must live at the repo root as `extensions-sdk/`, laid out as an
installable package:

```
extensions-sdk/
├── package.json     # "name": "@ableton-extensions/sdk"
└── dist/            # index.mjs, index.d.mts, …
```

If Ableton ships the SDK as a tarball (`ableton-extensions-sdk-<version>.tgz`),
extract its inner `package/` contents into `extensions-sdk/`:

```bash
mkdir -p extensions-sdk
tar xzf /path/to/ableton-extensions-sdk-1.0.0-beta.0.tgz \
    --strip-components=1 -C extensions-sdk
```

This project was developed against SDK `1.0.0-beta.0`.

## 2. Install and build

```bash
pnpm install
pnpm run build:all      # builds arclight-core first, then every extension
```

Per-extension:

```bash
cd harmonic-lens && pnpm run build
```

`lidal` has native dependencies (`abletonlink`, `easymidi`). pnpm 11 blocks
their install scripts by default; the bundled `pnpm-workspace.yaml` allow-lists
them, but if you see `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds`.
(Extension bundles externalize native deps, so they build even if the native
binaries are not compiled — but you need them compiled to *run* `lidal`.)

`easymidi`'s backend (`@julusian/midi`) ships prebuilt binaries, but
`abletonlink` must be compiled by node-gyp at install time. If that step was
skipped (blocked install scripts, `--ignore-scripts`), `lidal`'s deploy and
pack fail with a "no compiled .node binary" error rather than shipping a
bundle with Ableton Link silently disabled — fix it with:

```bash
pnpm rebuild abletonlink
```

(`abletonlink` is N-API-based, so the compiled binary is ABI-stable across
Node versions — your local Node need not match Live's bundled one.)

## 3. Deploy to Live

Each extension has a `deploy` script that copies its built bundle into your
Ableton User Library `Extensions/` folder. Enable Developer Mode in Live →
Preferences → Extensions to load locally-built extensions.

```bash
cd harmonic-lens && pnpm run deploy
```

## Tests

```bash
pnpm test
```

Some `arclight-core` tests are corpus/integration tests that read local audio
sample files; they **skip automatically** when those files are not present, so
a clean checkout runs only the self-contained unit tests.
