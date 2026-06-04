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

- **Auto-discovers extensions.** It scans every subdirectory of your User
  Library Extensions folder
  (`~/Music/Ableton Alpha/User Library/Extensions` by default) and registers
  any subdirectory that contains a `manifest.json`. Deploy a new extension and
  it gets picked up on the next (re)start of the host — no need to edit the
  script.
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
(`~/Music/Ableton Alpha/User Library/Extensions/<ext>/...`), **not** the source
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

`dev-launch.sh` hardcodes paths near the top that you may need to edit for your
setup:

- `EH_MOD` — path to `ExtensionHostNodeModule.node` inside your `Live.app`.
- `EH_NODE` — path to Live's **bundled** `node` binary. The script uses Live's
  bundled node so the native ABI matches what production extensions ship
  against. It falls back to the `node` on your `PATH` if the bundled binary is
  missing.
- `EH_EXTENSIONS_DIR` — the User Library Extensions folder it scans
  (`~/Music/Ableton Alpha/User Library/Extensions`).

These default to an **Ableton Alpha** install of a specific Live version
(`Ableton Live 12.4 Alpha.app`). If you're on a different Live version or
edition, edit `EH_MOD`, `EH_NODE`, and `EH_EXTENSIONS_DIR` to match your install
before running the script.

## lidal: MIDI routing

`lidal` streams its output as MIDI through virtual ports, which require a small
amount of routing setup inside Live (one MIDI track per port). That first-run
setup is documented in [lidal/README.md](lidal/README.md).
