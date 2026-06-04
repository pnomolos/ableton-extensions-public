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

EH_MOD="/Applications/Ableton Live 12.4 Alpha.app/Contents/App-Resources/Extensions/ExtensionHost/ExtensionHostNodeModule.node"
# Use Live's bundled node so dev ABI matches what production extensions ship against.
# Falls back to PATH `node` if the bundled binary is missing.
EH_NODE="/Applications/Ableton Live 12.4 Alpha.app/Contents/App-Resources/Extensions/ExtensionHost/node"
[[ -x "$EH_NODE" ]] || EH_NODE="$(command -v node)"
EH_EXTENSIONS_DIR="$HOME/Music/Ableton Alpha/User Library/Extensions"
EH_STORAGE_BASE="$HOME/Library/Application Support/Ableton/Extension Data"

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
    echo "[Arclight] Update EH_MOD in this script if your Live install path differs."
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
