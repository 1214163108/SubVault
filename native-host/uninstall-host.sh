#!/usr/bin/env bash
# Remove the SubVault native messaging host from macOS or Linux.
# Pass --remove-data to also delete the shared sync state.
set -euo pipefail

HOST_NAME="com.subvault.sync"
REMOVE_DATA=0
[ "${1:-}" = "--remove-data" ] && REMOVE_DATA=1
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  INSTALL_DIR="$HOME/Library/Application Support/SubVaultSync"
  TARGETS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  )
else
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/subvault-sync"
  TARGETS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  )
fi

for dir in "${TARGETS[@]}"; do
  rm -f "$dir/$HOST_NAME.json"
done
if [ "$REMOVE_DATA" = "1" ]; then
  rm -rf "$INSTALL_DIR"
else
  rm -f "$INSTALL_DIR"/subvault-sync-* "$INSTALL_DIR/$HOST_NAME.json"
fi
if [ "$REMOVE_DATA" = "1" ]; then
  echo "removed host and shared state"
else
  echo "removed host (state kept at $INSTALL_DIR)"
fi
