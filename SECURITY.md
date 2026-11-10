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
- The encrypted vault is stored in `chrome.storage.local`. The in-memory key and
  pending save sessions use `chrome.storage.session`.
- The Native Messaging host only stores the encrypted vault and settings. It
  cannot decrypt the master password and does not open a network port.
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
