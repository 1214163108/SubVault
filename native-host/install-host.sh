#!/usr/bin/env bash
# Install the SubVault native messaging host on macOS or Linux.
set -euo pipefail

EXTENSION_ID="domeipmeogohlofgahadfifjecafipeb"
HOST_NAME="com.subvault.sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *) echo "this script supports macOS and Linux; use install-host.ps1 on Windows" >&2; exit 1 ;;
esac

BINARY="subvault-sync-${PLATFORM}-${ARCH}"
[ -f "$SCRIPT_DIR/$BINARY" ] || { echo "missing $BINARY next to this script" >&2; exit 1; }

if [ "$PLATFORM" = "darwin" ]; then
  INSTALL_DIR="$HOME/Library/Application Support/SubVaultSync"
else
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/subvault-sync"
fi
mkdir -p "$INSTALL_DIR"
install -m 755 "$SCRIPT_DIR/$BINARY" "$INSTALL_DIR/$BINARY"

MANIFEST="$INSTALL_DIR/$HOST_NAME.json"
cat > "$MANIFEST" <<JSON
{
  "name": "$HOST_NAME",
  "description": "SubVault local encrypted vault sync host",
  "path": "$INSTALL_DIR/$BINARY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON

if [ "$PLATFORM" = "darwin" ]; then
  TARGETS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  )
else
  TARGETS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  )
fi
for dir in "${TARGETS[@]}"; do
  mkdir -p "$dir"
  ln -sf "$MANIFEST" "$dir/$HOST_NAME.json"
done

echo "installed $HOST_NAME"
echo "  binary:   $INSTALL_DIR/$BINARY"
echo "  manifest: $MANIFEST"
echo "Restart the browser, then reload the SubVault extension."
