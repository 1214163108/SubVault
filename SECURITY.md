# Security Policy

## Supported version

Security fixes target the latest released SubVault version. Older versions may
receive documentation-only guidance.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose vault
data or bypass authentication.

Use GitHub's private security advisory for this repository:

- https://github.com/1214163108/SubVault/security/advisories/new

Include the affected version, steps to reproduce, impact, and whether a native
host is involved. Do not include real master passwords, vault data, or export
files in the report.

## Scope and security model

- SubVault is a local-only Chromium extension. It has no server account, cloud
  sync, telemetry, or network synchronization endpoint.
- Up to 20 independently encrypted vaults are stored in `chrome.storage.local`
  under `vault` / `vault:<id>`; each has its own master password. A plaintext
  index stores only ids, names, timestamps and the key-file flag.
- Vault format v4 derives a KEK from the master password (Argon2id or
  PBKDF2-SHA512) and uses it only to wrap a random 32-byte VaultKey with
  AES-256-GCM. Entries are encrypted under the VaultKey. Changing the master
  password or key file rewraps the VaultKey; it does not re-encrypt the payload.
- Before migrating an older vault, the original encrypted blob is copied to
  `vaultBackup:<id>` locally. The new blob is verified in memory before it
  replaces the original. The settings page can roll back with the master
  password; rollback locks the vault and the next unlock migrates again. The
  migration backup is not synchronized or uploaded.
- Optional device quick unlock is Windows-only. Enabling it creates a WebAuthn
  platform-authenticator credential (Windows Hello interaction) and the sync
  host protects a local-only copy of the 32-byte VaultKey with Windows DPAPI
  (`DataProtectionScope.CurrentUser`) in `device.json` / `device-<id>.json`,
  alongside the credential id. Unlocking performs a platform-authenticator
  assertion first and then asks the host to unprotect the VaultKey. The
  extension never stores the master password, the host never writes the
  VaultKey in plaintext, and the binding is never synchronized. If the browser
  or system cannot provide a platform authenticator, device quick unlock cannot
  be enabled. Bindings created by older versions without a credential id are
  rejected and must be re-enabled; they cannot fall back to a promptless DPAPI
  unlock. The master password (plus optional key file) always remains a fallback. Removing the binding, deleting the vault,
  rolling back the format, or wiping the extension asks the host to delete the
  binding.
- The in-memory key and pending save sessions use `chrome.storage.session`.
- The Native Messaging host stores encrypted vault blobs per vault
  (`state.json` / `vault-<id>.json`) plus DPAPI-protected device bindings
  (`device.json` / `device-<id>.json`). It cannot decrypt the master password
  and does not open a listening port.
- That data lives in a fixed per-user folder (`%LOCALAPPDATA%\SubVaultSync` on
  Windows, `~/Library/Application Support/SubVaultSync` or
  `${XDG_CONFIG_HOME:-~/.config}/SubVaultSync` elsewhere), never beside the host
  binary. Reinstalling or relocating the host therefore cannot make a device
  see an empty remote and overwrite the real vault with its own copy. If an
  older build left files in `<host dir>/data`, they are copied into the fixed
  folder on first start; existing files are never overwritten. The only
  fallback to the host folder happens when the per-user folder is not
  writable. Optional WebDAV is an independent
  encrypted backup/restore target, not a real-time sync transport; the host
  performs GET/PUT/MKCOL to the user-configured server, credentials are passed
  per command, and they are not written to host storage.
- `.svshare` v2 uses a separate PBKDF2 + AES-GCM password. `expiresAt` is
  mixed into the KDF salt and the AES-GCM AAD, so altering the expiry breaks
  decryption rather than merely hiding the file in the UI. The bundled
  `companion/index.html` decrypts them locally with no network access.
- Encrypted backups can carry an optional expiry that is bound into the KDF and
  AAD (format v5). Such backups require an independent backup password, and an
  expired file cannot be decrypted with the original password.
- Private exports (encrypted backup, sync snapshot, pre-import/pre-merge/
  pre-restore snapshots and the recovery note) are written as `.svbak`, a
  binary container with an `SVBAK` magic header, a version byte, a gzip flag
  and a gzip-compressed JSON payload. Renaming the file to `.txt` does not
  reveal or allow editing the payload; the extension still accepts a renamed
  container on import, but rejects arbitrary files with a format error. The
  recovery note is viewable inside the options page, so no external tool is
  needed. Interoperable formats (plaintext CSV, KeePass `.kdbx`, `.svshare`)
  are intentionally unchanged.
- Encrypted backups and share packages can optionally be bound to an exported
  key file (`.svkey`: `SVKEY` magic, version byte, 32 random bytes). The key file
  never contains a password; its SHA-256 is folded into the KDF input next to the
  password, so the export cannot be decrypted without that exact file. The
  export header records a 16-hex fingerprint of the key file, and the importer
  rejects a missing or mismatched file before running the expensive KDF. The key
  file is optional: without it the export is password-only, exactly as before.
  The file is never stored in the vault, so losing it means losing the export.
- Passkey support stores only credential id, RP id, account and note as vault
  metadata; the extension cannot import or use a platform Passkey private key.
- TOTP secrets are stored in the encrypted vault and codes are generated
  locally; the TOTP quick view and countdown never send secrets anywhere.
- The extension deliberately receives broad host permissions to detect login
  forms. See the README permission table for details.
- There has not been an independent third-party security audit of SubVault.
  Do not describe it as audited until such an audit has been completed and its
  scope published.

## User responsibilities

- Use a strong, unique master password.
- Keep encrypted backups and recovery instructions separately.
- Verify release SHA-256 checksums before installing a downloaded package.
- Remove exported plaintext CSV files after use.
- Native sync requires the same master password on both browser profiles.

## 回收站、动态码提示与存储

- 删除的条目先进入加密密码库内的 `trash` 数组（上限 100 条），可在设置页恢复或清空；不会写入明文日志或外部存储。
- 网页动态码卡片只在当前 http/https 页面内显示，验证码由本地 TOTP 计算后经扩展消息传给内容脚本，不发起网络请求；复制仍受 30 秒剪贴板清理策略约束。
- 存储预算显示为 50 MB，并申请 `unlimitedStorage` 以避免浏览器配额过早触顶；实际占用仍由用户本机磁盘决定。
- WebDAV 首次备份会在配置的目录内自动 `MKCOL` 创建固定子目录；每次备份成功后除覆盖 `state.json` 外，还会在同一目录写入一份带时间戳的副本 `subvault-YYYYMMDD-HHmmss.json`（`If-None-Match: *`，不覆盖既有副本）。副本内容与主备份完全相同的密文，不含明文或密钥。
- 宿主不监听端口，扩展仍保持 `connect-src 'none'`。
