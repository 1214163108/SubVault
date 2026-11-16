#!/usr/bin/env bash
# Build the SubVault sync host for the current platform.
# Requires Go 1.21+ (https://go.dev/dl/).
set -euo pipefail
cd "$(dirname "$0")/go"
os="$(go env GOOS)"; arch="$(go env GOARCH)"
out="../subvault-sync-${os}-${arch}"
[ "$os" = "windows" ] && out="${out}.exe"
go build -trimpath -ldflags "-s -w" -o "$out" .
echo "built $out"
