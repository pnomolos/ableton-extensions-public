# Development workflow

This document covers the day-to-day loop for iterating on the extensions in this
repo against a running copy of Ableton Live. For first-time SDK setup, builds,
and how deployment copies bundles into your User Library, see
[BUILDING.md](BUILDING.md).

## 1. Enable Developer Mode in Live

In Live, open **Preferences → Extensions** and enable **Developer Mode**.

With Developer Mode on, Live will *not* start its own Extension Host — that lets
you run the host yourself (next step) so you can reload extensions on demand.

## 2. Run the Extension Host with `dev-launch.sh`

```bash
./dev-launch.sh
```

`dev-launch.sh` manually runs Live's **Extension Host** as a child process. On
startup it:

- **Discovers your Live install.** It scans `/Applications/Ableton Live*.app`
  for installs that contain an Extension Host (checking both known bundle
  layouts — see [Path / install notes](#path--install-notes)). If several
  match, it asks which to use; set `ABLETON_APP` to skip the prompt.
- **Discovers your User Library.** Likewise, if several
  `~/Music/Ableton*/User Library` folders exist (release/Beta/Alpha editions
  each get their own), it asks which to use; set `ABLETON_USER_LIBRARY` to
  skip the prompt.
- **Auto-discovers extensions.** It scans every subdirectory of the chosen
  User Library's `Extensions/` folder and registers any subdirectory that
  contains a `manifest.json`. Deploy a new extension and it gets picked up on
  the next (re)start of the host — no need to edit the script.
- **Prints its own PID.** You'll see a line like:

  ```
  [Arclight] PID 12345 — send 'kill -HUP 12345' to reload
  ```

  Keep that PID handy — it's how you trigger reloads.

The host runs in the foreground; leave the terminal open while you work.

## 3. The reload loop

`dev-launch.sh` traps `SIGHUP`. When it receives one, it kills the current
Extension Host child and starts a fresh one, re-discovering and re-registering
**all** deployed extensions. So you reload everything without restarting the
script:

```bash
kill -HUP <PID>   # the PID printed by dev-launch.sh
```

### A typical iteration loop

```bash
# 1. Edit source under the repo (e.g. lidal/src/...)

# 2. Build AND deploy the extension you changed
cd <ext> && pnpm run deploy        # or, from the repo root: pnpm run deploy:all

# 3. Reload the running host
kill -HUP <dev-launch-pid>
```

## ⚠️ Caveat 1 — `SIGHUP` does NOT build or deploy

The Extension Host loads the **deployed** bundle from your User Library
(`~/Music/Ableton*/User Library/Extensions/<ext>/...`), **not** the source
or `dist/` in this repo. Sending `SIGHUP` only restarts the host against
whatever is already deployed — it runs no build step.

Therefore, after editing source you must **deploy** before reloading:

```bash
cd <ext> && pnpm run deploy        # or pnpm run deploy:all from the repo root
kill -HUP <dev-launch-pid>
```

A bare `pnpm run build` is **not enough** — it only writes the repo's local
`dist/`, which the host never reads. Deploy is what copies the built bundle into
the User Library.

## ⚠️ Caveat 2 — only `SIGHUP` the `dev-launch.sh` PID

Send `SIGHUP` **only** to the PID printed by `dev-launch.sh` — that's the bash
wrapper that traps the signal and restarts its child. Confirm the target before
signalling:

```bash
ps -p <pid> -o command   # should show: bash .../dev-launch.sh
```

Do **NOT** send `SIGHUP` directly to the bare **node** Extension Host process.
Doing so tears the extensions down (HTTP servers, MIDI ports, sync sources, …)
**without re-initializing** them, leaving the host in a half-dead state. To
recover, toggle Developer Mode off/on in **Preferences → Extensions**, or
restart Live.

## Path / install notes

`dev-launch.sh` discovers everything and **asks** when there's more than one
candidate — nothing in the script needs editing:

- **Live install** — every `/Applications/Ableton Live*.app` containing an
  Extension Host is a candidate. The host has moved inside the bundle between
  releases (`Contents/App-Resources/Extensions/ExtensionHost/` up to the 12.4
  alphas, `Contents/Helpers/ExtensionHost/` from the 12.4.5 betas on); both
  layouts are checked.
- **User Library** — every `~/Music/Ableton*/User Library` is a candidate
  (each Live edition — release/Beta/Alpha — can have its own), annotated with
  how many extensions are deployed in it. Picking one without an `Extensions/`
  folder is fine — deploy creates it.
- **Node binary** — Live's **bundled** `node` next to the host module, so the
  native ABI matches what production extensions ship against; falls back to
  the `node` on your `PATH`.

Prompts are skipped when only one candidate exists, when the matching env var
is set, or when there's no TTY (the most recently modified candidate wins).
Set the env vars in your shell profile to pin a setup and never be asked:

```bash
export ABLETON_APP="/Applications/Ableton Live 12 Beta.app"
export ABLETON_USER_LIBRARY="$HOME/Music/Ableton/User Library"
```

`scripts/deploy-extension.js` honours the same `ABLETON_USER_LIBRARY`
variable (it stays non-interactive so `pnpm run deploy:all` can batch), so
deploy and dev-launch always target the same Extensions folder.

Low-level overrides that bypass discovery entirely: `ABLETON_EH_MOD` (path to
`ExtensionHostNodeModule.node`), `ABLETON_EH_NODE` (host node binary),
`ABLETON_EXTENSIONS_DIR` (Extensions folder to scan), `ABLETON_STORAGE_BASE`
(per-extension storage root).

## lidal: MIDI routing

`lidal` streams its output as MIDI through virtual ports, which require a small
amount of routing setup inside Live (one MIDI track per port). That first-run
setup is documented in [lidal/README.md](lidal/README.md).
