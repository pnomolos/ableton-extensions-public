#!/usr/bin/env bash
set -euo pipefail

# Arclight dev-launch.sh
# Enable Developer Mode in Live Preferences → Extensions, then run this script
# to manually control the Extension Host process.
#
# Send SIGHUP to reload all extensions without restarting this script:
#   kill -HUP <PID>   (PID is printed on startup)
#
# Extensions are auto-discovered: any subdirectory of the User Library Extensions folder
# that contains a manifest.json is registered automatically. Deploy a new extension and
# send SIGHUP — no need to edit this script.
#
# When several Live installs / User Libraries exist, the script asks which to
# use. Set env vars to skip the prompts (e.g. in your shell profile):
#   ABLETON_APP             Path to the Live .app bundle to use.
#   ABLETON_USER_LIBRARY    Path to the Live "User Library" folder.
#                           (Also honoured by scripts/deploy-extension.js, so
#                           deploy and dev-launch agree on the Extensions folder.)
# Low-level overrides (bypass discovery entirely):
#   ABLETON_EH_MOD          Path to ExtensionHostNodeModule.node.
#   ABLETON_EH_NODE         Node binary used to run the host (default: Live's bundled node).
#   ABLETON_EXTENSIONS_DIR  Extensions folder to scan (default: $ABLETON_USER_LIBRARY/Extensions).
#   ABLETON_STORAGE_BASE    Base dir for per-extension storage directories.

# --- Helpers ----------------------------------------------------------------

# The Extension Host has moved inside the app bundle between Live releases:
#   ≤ 12.4 alpha   : Contents/App-Resources/Extensions/ExtensionHost/
#   ≥ 12.4.5 beta  : Contents/Helpers/ExtensionHost/
EH_LAYOUTS=(
  "Contents/Helpers/ExtensionHost"
  "Contents/App-Resources/Extensions/ExtensionHost"
)

# $1 = .app path → echoes the ExtensionHost dir inside it, rc 1 if absent.
find_host_dir() {
  local app="$1" layout
  for layout in "${EH_LAYOUTS[@]}"; do
    if [[ -f "$app/$layout/ExtensionHostNodeModule.node" ]]; then
      echo "$app/$layout"
      return 0
    fi
  done
  return 1
}

# Numbered picker: choose "<title>" "<label>"...  → sets CHOICE (1-based).
# Skips the prompt when there is only one option, or no TTY to ask on
# (first option — the most recently modified — wins).
CHOICE=
choose() {
  local title="$1"; shift
  CHOICE=1
  (( $# == 1 )) && return 0
  if [[ ! -t 0 ]]; then
    echo "[Arclight] $title — no TTY, using: $1"
    return 0
  fi
  echo "[Arclight] $title"
  local i=1 label
  for label in "$@"; do
    echo "  $i) $label"
    i=$((i + 1))
  done
  local reply
  while true; do
    read -rp "  Choice [1]: " reply
    reply="${reply:-1}"
    if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= $# )); then
      CHOICE=$reply
      return 0
    fi
    echo "  Please enter a number between 1 and $#."
  done
}

# --- Locate the Extension Host ------------------------------------------------
EH_MOD="${ABLETON_EH_MOD:-}"
if [[ -z "$EH_MOD" ]]; then
  if [[ -n "${ABLETON_APP:-}" ]]; then
    HOST_DIR="$(find_host_dir "$ABLETON_APP")" || {
      echo "[Arclight] No Extension Host found inside: $ABLETON_APP"
      echo "[Arclight] (looked under: ${EH_LAYOUTS[*]})"
      exit 1
    }
  else
    APPS=()
    while IFS= read -r app; do
      if find_host_dir "$app" >/dev/null; then APPS+=("$app"); fi
    done < <(ls -dt /Applications/Ableton\ Live*.app 2>/dev/null)
    if (( ${#APPS[@]} == 0 )); then
      echo "[Arclight] No Ableton Live install with an Extension Host found in /Applications."
      echo "[Arclight] Set ABLETON_APP (path to the .app bundle) or ABLETON_EH_MOD."
      exit 1
    fi
    choose "Which Live install?" "${APPS[@]}"
    APP="${APPS[CHOICE-1]}"
    HOST_DIR="$(find_host_dir "$APP")"
    if (( ${#APPS[@]} > 1 )); then
      echo "[Arclight]   (export ABLETON_APP=\"$APP\" to skip this prompt)"
    fi
  fi
  EH_MOD="$HOST_DIR/ExtensionHostNodeModule.node"
fi
echo "[Arclight] Extension Host: $EH_MOD"

# Use Live's bundled node (next to the host module) so dev ABI matches what
# production extensions ship against. Falls back to PATH `node` if missing.
EH_NODE="${ABLETON_EH_NODE:-}"
if [[ -z "$EH_NODE" ]]; then
  EH_NODE="$(dirname "$EH_MOD")/node"
  [[ -x "$EH_NODE" ]] || EH_NODE="$(command -v node || true)"
  if [[ -z "$EH_NODE" ]]; then
    echo "[Arclight] No node binary found (no bundled node next to the host, none on PATH)."
    echo "[Arclight] Install node or set ABLETON_EH_NODE."
    exit 1
  fi
fi

# --- Locate the User Library Extensions folder --------------------------------
EH_EXTENSIONS_DIR="${ABLETON_EXTENSIONS_DIR:-}"
if [[ -z "$EH_EXTENSIONS_DIR" ]]; then
  if [[ -n "${ABLETON_USER_LIBRARY:-}" ]]; then
    EH_EXTENSIONS_DIR="$ABLETON_USER_LIBRARY/Extensions"
  else
    # Each Live edition (release/Beta/Alpha) can have its own User Library.
    LIBS=()
    LABELS=()
    # Libraries with a deployed Extensions folder first, newest first…
    while IFS= read -r dir; do
      LIBS+=("${dir%/Extensions}")
      n="$(find "$dir" -mindepth 2 -maxdepth 2 -name manifest.json 2>/dev/null | wc -l | tr -d ' ')"
      LABELS+=("${dir%/Extensions} ($n deployed)")
    done < <(ls -dt "$HOME/Music/Ableton"*"/User Library/Extensions" 2>/dev/null)
    # …then libraries without one (the folder is created on first deploy).
    for lib in "$HOME/Music/Ableton"*"/User Library"; do
      if [[ -d "$lib" && ! -d "$lib/Extensions" ]]; then
        LIBS+=("$lib")
        LABELS+=("$lib (no extensions deployed yet)")
      fi
    done
    if (( ${#LIBS[@]} == 0 )); then
      echo "[Arclight] No User Library found under ~/Music/Ableton*/."
      echo "[Arclight] Set ABLETON_USER_LIBRARY (path to the User Library folder)."
      exit 1
    fi
    choose "Which User Library?" "${LABELS[@]}"
    LIB="${LIBS[CHOICE-1]}"
    if (( ${#LIBS[@]} > 1 )); then
      echo "[Arclight]   (export ABLETON_USER_LIBRARY=\"$LIB\" to skip this prompt)"
    fi
    EH_EXTENSIONS_DIR="$LIB/Extensions"
  fi
fi
echo "[Arclight] Extensions dir: $EH_EXTENSIONS_DIR"

EH_STORAGE_BASE="${ABLETON_STORAGE_BASE:-$HOME/Library/Application Support/Ableton/Extension Data}"

NODE_PID=
RELOAD=false

_reload() {
  echo "[Arclight] Reload signal received — restarting Extension Host..."
  RELOAD=true
  [[ -n "$NODE_PID" ]] && kill "$NODE_PID" 2>/dev/null || true
}

trap _reload SIGHUP

echo "[Arclight] PID $$ — send 'kill -HUP $$' to reload"

while true; do
  RELOAD=false

  if [[ ! -f "$EH_MOD" ]]; then
    echo "[Arclight] Extension Host module not found at: $EH_MOD"
    echo "[Arclight] Set ABLETON_APP (or ABLETON_EH_MOD) to match your Live install."
    exit 1
  fi

  # Build extension list by scanning the User Library Extensions directory.
  # Any subdirectory containing a manifest.json is registered automatically.
  EXT_JSON="["
  FIRST=true
  if [[ -d "$EH_EXTENSIONS_DIR" ]]; then
    for ext_dir in "$EH_EXTENSIONS_DIR"/*/; do
      [[ -f "${ext_dir}manifest.json" ]] || continue
      ext_name="$(basename "$ext_dir")"
      ext_path="${ext_dir%/}"
      ext_storage="${EH_STORAGE_BASE}/${ext_name}"
      mkdir -p "$ext_storage" "/tmp/${ext_name}"
      $FIRST || EXT_JSON+=","
      EXT_JSON+="{ path: '${ext_path}', storageDirectory: '${ext_storage}', tempDirectory: '/tmp/${ext_name}' }"
      FIRST=false
      echo "[Arclight] Registered: ${ext_name}"
    done
  fi
  EXT_JSON+="]"

  echo "[Arclight] Starting Extension Host (node: $EH_NODE)"
  "$EH_NODE" -e "require('$EH_MOD').initialize({ extensions: ${EXT_JSON} });" &

  NODE_PID=$!
  wait "$NODE_PID" || true

  if $RELOAD; then
    sleep 0.5
    continue
  fi

  echo "[Arclight] Extension Host exited"
  break
done
