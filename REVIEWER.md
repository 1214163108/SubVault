# SubVault — Reviewer Guide

SubVault is a **local-only** Manifest V3 password manager. This document gives
Chrome Web Store reviewers (and anyone auditing the source) the facts needed to
verify that the extension does what it says and nothing else.

- Repository: <https://github.com/1214163108/SubVault>
- Version: see `manifest.json`
- License: GPL-3.0
- Fixed extension ID: `domeipmeogohlofgahadfifjecafipeb` (declared `key` in
  `manifest.json`; required so the optional local Native Messaging host can
  allow-list a stable ID)

## 1. No network, no telemetry

- No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
  remote fonts, remote images, analytics or crash reporting anywhere in `src/`.
- The extension-page CSP in `manifest.json` sets `connect-src 'none'`, so a
  network request from any extension page would be blocked by the browser even
  if one were added accidentally.
- No remote code. All scripts are packaged in the zip. Third-party code:
  - `src/vendor/zxcvbn.js` (zxcvbn 4.4.2, MIT), offline master-password
    strength estimation;
  - `src/vendor/hash-wasm-argon2.umd.js` (hash-wasm 4.12.0, MIT), Argon2id
    key derivation; the WASM binary is embedded as base64 in that file, so
    nothing is fetched or compiled from a remote URL. `manifest.json` only
    adds `'wasm-unsafe-eval'` to `script-src` for this purpose; `connect-src`
    remains `'none'`;
  - `src/vendor/weak-passwords.js` (SHA-256 digests of the SecLists
    10k-most-common list, MIT), offline weak-password detection. It contains
    no plaintext passwords;
  - `src/vendor/kdbxweb.min.js` + `src/vendor/kdbxweb-shim.js` (kdbxweb 2.x,
    MIT), local KeePass `.kdbx` parsing/writing (KDBX 3/4, optional key file, groups/tags/custom fields/history). Argon2 is provided by the
    already-bundled hash-wasm module; no file leaves the device;
  - `src/vendor/jsqr.min.js` (jsQR 1.4.0, Apache-2.0, license text in
    `src/vendor/jsqr.LICENSE.txt`), offline QR decoding for the TOTP
    "import from image" button. It only runs on a local `canvas` created
    from a user-selected image file, contains no `eval`, and performs no
    network access; Chrome's built-in `BarcodeDetector` is used when it
    exists.
- The optional Native Messaging host is a separate local executable; it opens
  no sockets and only talks to the extension over stdin/stdout. Users who do
  not need same-machine cross-browser sync never install it.

## 2. Data storage

| Location | Content | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | AES-256-GCM encrypted vaults (accounts, profiles, alias emails, fill sequences, settings, domain rules), ciphertext only; up to 20 vaults under `vault` / `vault:<id>` keys; plus a ciphertext-only pre-pull WebDAV snapshot | until uninstall / wipe |
| `chrome.storage.local` (migration backup) | the previous ciphertext blob under `vaultBackup:<vaultId>`, written before a v3→v4 migration and deleted after rollback | until uninstall / wipe / rollback |
| `chrome.storage.local` (vault index) | vault ids, display names, created time, key-file flag; no credentials | until uninstall / wipe |
| `chrome.storage.local` (plaintext metadata) | active section, sync trigger/interval/schedule, last sync time/direction/revision/error, travel-mode alarm time; no credentials or account data | until uninstall / wipe |
| `chrome.storage.session` | derived AES key (JWK) and pending-save candidates | cleared when the browser closes or the vault locks |
| Downloads (user action) | plaintext CSV export, `.svbak` private container holding an encrypted backup / sync snapshot / recovery note, encrypted `.svshare` package with its own password, and an optional 40-byte `.svkey` second factor (no secrets, KDF input only) | user-managed |

The master password is never stored. The content script never receives the
vault: it asks the background for matches for the current host and gets at most
a handful of account records.

- One-time share packages (`.svshare`) v2 bind `expiresAt` into both the KDF
  salt and the AES-GCM AAD, so changing the expiry breaks decryption. Encrypted
  backups optionally bind an expiry the same way (format v5) and require an
  independent backup password.
- One-time share packages are encrypted with PBKDF2-HMAC-SHA256
  (310,000 iterations) + AES-256-GCM under a separate share password. The
  expiry timestamp is inside the ciphertext and is enforced by both sides; a
  downloaded file cannot be remotely revoked.
- Encrypted backups, sync snapshots and the recovery note are packaged in the
  `.svbak` binary container (`SVBAK` magic + version + gzip flag + gzipped
  JSON). The container only wraps already-encrypted data or non-secret
  recovery instructions; it is not an obfuscation layer for plaintext
  credentials. Interoperable formats (CSV, `.kdbx`) stay unchanged.
- Passkey support stores credential id, RP id, account and note as encrypted
  vault metadata; no Passkey private key is imported or used.
- The bundled Companion (`companion/index.html`) is a static local page with inline script only: no network calls, no analytics, no storage. It decrypts `.svshare` packages with the share password in memory.
- Email aliases and fill sequences are ordinary encrypted account fields. A
  fill sequence can only focus fields, press Tab/Enter, wait, or click a CSS
  selector supplied by the user; it cannot execute arbitrary script. Enter
  submission is disabled unless the user enables it in Settings.
- Travel mode only filters which accounts are visible; it never deletes data.
  Registration pages show a “use alias” chip next to the password generator; it only copies a saved alias after an explicit click, never fills automatically.
  The auto-restore time is a local `chrome.alarms` entry, and disabling travel
  mode early requires the master password.

## 3. Key derivation

- Default: Argon2id, 64 MiB memory, 3 iterations, parallelism 1, 32-byte salt,
  32-byte output. Users can switch to PBKDF2-HMAC-SHA512 (310,000 iterations)
  in Settings. Existing PBKDF2/SHA-256 vaults are upgraded transparently on
  unlock with the current preference.
- Vault format v4 adds a key layer: the KDF output is a **KEK** used only to
  wrap a random 32-byte **VaultKey** with AES-256-GCM (`wrappedKey`). The
  payload (`box`) is encrypted under the VaultKey with AES-256-GCM. Changing the
  master password or key file rewraps the VaultKey and leaves the payload box
  unchanged, so the whole vault is not re-encrypted.
- Older v3/legacy blobs are migrated on the first successful unlock. The
  original encrypted blob is first copied to `vaultBackup:<vaultId>` in
  `chrome.storage.local`; the new blob is unwrapped and decrypted in memory
  before it replaces the original. Migration failure leaves the original
  untouched. Settings shows the current format and backup time and can roll
  back with the master password; rollback restores the old ciphertext, deletes
  the backup, and locks the vault. The next unlock migrates again.
- The derived KEK/VaultKey exists only in memory and `chrome.storage.session`
  while unlocked and is never written to disk or sent anywhere.
- Optional key file (two-factor unlock): the KDF input becomes
  `masterPassword + "\0kf:" + SHA-256(keyFile)`. The key file bytes are never
  stored; only a boolean `keyFile` flag is kept in the encrypted vault header so
  the UI knows to ask for the file. Imported/exported backups keep the flag but
  not the file.
- Optional device quick unlock is Windows-only. On explicit enable while
  unlocked, the extension creates a WebAuthn platform-authenticator credential
  (Windows Hello interaction) and exports the 32-byte VaultKey to the native
  host, which protects it with Windows DPAPI
  (`DataProtectionScope.CurrentUser`). The host stores only the protected blob
  and credential id in `device.json` / `device-<id>.json`; the extension does
  not store the master password and the binding is never synced. Unlocking
  performs a platform-authenticator assertion and then asks the host to
  unprotect the VaultKey; without a platform authenticator device quick unlock
  cannot be enabled, and older bindings without a credential id are rejected
  instead of falling back to a promptless DPAPI unlock. The master password
  (and optional key file) remains a fallback. Removing the binding, deleting the
  vault, rolling back the format, or wiping the extension requests deletion of
  the host-side binding.

## 4. Permissions and why each is needed

| Permission | Justification |
| --- | --- |
| `storage` | Persist the encrypted vault and settings. |
| `unlimitedStorage` | Avoid browser quota errors for large vaults/attachments; UI still shows a 50 MB budget. |
| `alarms` | Schedule the precise auto-lock wake-up. |
| `idle` | Optional: lock on system lock / system idle (off by default). |
| `activeTab` | Know which tab the popup is acting on. |
| `privacy` | Optional: turn off Chrome's own "save password" prompt after explicit user opt-in. |
| `nativeMessaging` | Optional: local sync host, no network. |
| `clipboardWrite` | Copy password / TOTP code on user action. |
| `contextMenus` | Optional right-click entries: fill this page, generate a password, open the panel. |
| `favicon` | Show the site icon next to each saved account in the list. |
| `clipboardRead` (optional) | User-granted: verify clipboard content before auto-clearing it. |
| `http://*/*`, `https://*/*` | Show the fill button next to login fields on the current page. |

The content script reads only form fields and their nearby labels; it does not
read page text, cookies, storage or network traffic.

## 5. Password-manager takeover

Chrome exposes no API to delete or replace its built-in password dropdown.
SubVault therefore does the maximum the platform allows: it marks fields with
`autocomplete` values and can disable Chrome's save prompt through the
`privacy` API **only when the user enables that setting**. Documented in
`README.md` §6.

## 6. Native Messaging host

- Windows source: `native-host/SubVaultSync.cs`; manifests are installed per
  browser by `native-host/install-host.ps1` under
  `HKCU\Software\...\NativeMessagingHosts`.
- macOS/Linux source: `native-host/go/main.go` (single static Go binary, no
  runtime). `native-host/install-host.sh` installs it under the user config
  directory and links the manifest into each browser's `NativeMessagingHosts`.
  The protocol and state format are identical to the Windows host.
- Allowed origin is restricted to `chrome-extension://domeipmeogohlofgahadfifjecafipeb/`.
- It stores only the encrypted vault blob and a revision counter in
  `state.json` for the default vault and `vault-<id>.json` for each additional vault, in a fixed per-user folder (`%LOCALAPPDATA%\SubVaultSync` on Windows; `~/Library/Application Support/SubVaultSync` or `${XDG_CONFIG_HOME:-~/.config}/SubVaultSync` elsewhere). Older builds kept them in a `data` folder beside the executable; those files are copied into the fixed folder on first start, and the exe-adjacent location is only used when the per-user folder is not writable. Optional DPAPI device bindings are stored beside them as `device.json` / `device-<id>.json`; they contain a `ProtectedData` blob, not a plaintext VaultKey.
- Optional WebDAV is an independent encrypted backup/restore target, not a
  real-time sync transport. The host performs `GET`/`PUT`/`MKCOL` against
  `<base>/subvault/state.json` for the default vault and
  `<base>/subvault/<id>/state.json` for other vaults. The extension still makes
  no network requests (`connect-src 'none'`), and the host opens no listening
  port. HTTPS is required except loopback test addresses. Credentials are
  passed per command, never written to disk, and stored by the extension only
  inside the encrypted vault. Restoring overwrites the current vault and
  requires the master password and re-unlock.
- Multiple vaults: each vault has its own master password and ciphertext; switching or deleting requires the target vault password. Merging decrypts the source vault in memory only, merges by site/account, and never modifies the source.
- Sync triggers (`realtime`, `interval`, `scheduled`, `unlock`, `manual`) are
  stored in `chrome.storage.local`; status metadata (last sync time, direction,
  revision, error code, conflict, retry time) is local-only and never sent over
  the network. Failed attempts back off exponentially, capped at 30 minutes.
- Before a remote vault is applied, the current encrypted blob is kept as a
  local snapshot in `chrome.storage.local`; the user can restore it from the
  sync card. A one-shot guard prevents the unlock-time reconcile from
  immediately re-applying the remote version after a restore.
- A host `change` notification only triggers a timestamp comparison; it never
  applies the remote payload directly, so a stale notification cannot overwrite
  a newer local edit.
- Two-sided edits are never overwritten silently. A revision mismatch enters a
  conflict state that requires an unlocked user choice in Options: keep the
  remote version or keep the local version (explicit confirmation).

## 7. Reproducible build

The packaged archive is deterministic: fixed entry timestamps
(1980-01-01), fixed permissions, sorted paths and fixed compression level.

```bash
python tools/package.py            # dist/subvault-<version>.zip + .sha256
python tools/package.py            # run again: identical SHA-256
```

Or with Docker (no host Python required):

```bash
docker build -t subvault-build .
docker run --rm -v "$PWD/dist:/out" subvault-build
```

Build twice locally (or in Docker) and compare the two hashes. Compare the published `dist/subvault-<version>.zip.sha256`
with a local build to confirm the store upload matches this source.

## 8. How to smoke-test

1. Load the unpacked folder (or the zip) in `chrome://extensions`.
2. Create a master password (≥ 10 characters; the UI shows an offline zxcvbn
   estimate and requires ≥ 60 bits, or an explicit confirmation for 50–59 bits).
3. Open any login page, focus the **username** field: a SubVault button appears.
4. Add an account in the popup, then select it from the button: username and
   password are filled, no automatic submit.
5. Click the site's login button: a "save/update" prompt appears.

Automated checks used by the project: 58 Node unit/backend tests plus Playwright
Chromium E2E scripts under `tools/` (`test-v141-e2e.mjs`, `test-popover-e2e.mjs`,
`test-save-prompt-e2e.mjs`, `test-sync-e2e.mjs`, ...).

## 回收站与动态码

- 删除条目先写入加密 vault 的 `trash`（最多 100 条），可恢复或清空；不写外部日志。
- 动态码提示由本地 TOTP 计算，经扩展消息传给内容脚本，无网络请求。
- `unlimitedStorage` 仅用于大密码库；UI 预算显示 50 MB。
- WebDAV 首次备份自动 `MKCOL` 固定子目录，修复 `409 AncestorsNotFound`。
