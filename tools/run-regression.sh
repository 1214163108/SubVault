#!/usr/bin/env bash
# Run the E2E suites sequentially and summarise pass/fail.
cd "$(dirname "$0")/.." || exit 1
export PATH="C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"

TESTS=(
  test-keyfile-export-e2e
  test-backup-container-e2e
  test-share-e2e
  test-keyfile-e2e
  test-keyfile-ui-e2e
  test-v240-features-e2e
  test-totp-passkey-e2e
  test-hotp-steam-e2e
  test-qr-import-e2e
  test-context-menu-e2e
  test-shortcuts-e2e
  test-popover-e2e
  test-save-prompt-e2e
  test-copy-e2e
  test-import-e2e
  test-kdbx-e2e
  test-psl-e2e
  test-device-unlock-e2e
  test-hello-gate-e2e
  test-vaultkey-e2e
  test-vaults-e2e
  test-vault-sync-e2e
  test-sync-e2e
  test-sync-triggers-e2e
  test-sync-center-e2e
  test-webdav-backup-e2e
  test-webdav-auto-e2e
  test-webdav-gate-e2e
  test-appearance-e2e
  test-theme-materials-e2e
  test-settings-nav-e2e
  test-language-e2e
  test-i18n-e2e
  test-a11y-e2e
  test-toast-privacy-e2e
  test-travel-e2e
  test-alias-fill-e2e
  test-companion-e2e
  test-lock-config-e2e
  test-v141-e2e
  test-v161-e2e
  test-v2-features-e2e
  test-otp-detect-e2e
)

failures=0
for name in "${TESTS[@]}"; do
  log=".tmp-reg-${name}.log"
  timeout 300 node "tools/${name}.mjs" >"$log" 2>&1
  code=$?
  if [ "$code" -eq 0 ] && grep -qE '"pass": true|"ok": true|^PASS=true' "$log"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name  (exit $code)"
    failures=$((failures + 1))
    tail -12 "$log" | sed 's/^/      /'
  fi
done
echo "TOTAL FAILURES: $failures"
exit "$failures"
