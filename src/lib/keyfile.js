import { base64ToBytes, bytesToBase64, randomBytes, sha256Hex } from './crypto.js';

/**
 * Export key files (.svkey).
 *
 * A key file is a small opaque blob that is folded into the KDF password as an
 * optional second factor for a backup or a share package. It is generated at
 * export time and never stored inside the vault, so losing it means the export
 * cannot be decrypted - exactly like a hardware token.
 *
 * Layout: "SVKEY" (5) | version (1) | reserved (2) | 32 random bytes = 40.
 */
export const KEY_FILE_EXTENSION = 'svkey';
export const KEY_FILE_MAGIC = 'SVKEY';
export const KEY_FILE_VERSION = 1;
export const KEY_FILE_SECRET_BYTES = 32;
export const KEY_FILE_BYTES = 5 + 1 + 2 + KEY_FILE_SECRET_BYTES;

/** Fingerprint stored in the export header so a wrong key fails fast. */
export function keyFileFingerprint(keyFileBase64) {
  return sha256Hex(String(keyFileBase64 || '')).then((hex) => hex.slice(0, 16));
}

/** Fold a key file into the KDF password (same scheme as the vault key file). */
export async function foldKeyFile(password, keyFileBase64 = '') {
  const text = String(password ?? '');
  if (!keyFileBase64) return text;
  return `${text}\u0000kf:${await sha256Hex(String(keyFileBase64))}`;
}

export function isKeyFileBytes(bytes) {
  if (!bytes || bytes.length !== KEY_FILE_BYTES) return false;
  const head = Array.from(bytes.subarray(0, 5))
    .map((byte) => String.fromCharCode(byte))
    .join('');
  return head === KEY_FILE_MAGIC;
}

export function createKeyFile() {
  const bytes = new Uint8Array(KEY_FILE_BYTES);
  bytes.set(Array.from(KEY_FILE_MAGIC, (char) => char.charCodeAt(0)), 0);
  bytes[5] = KEY_FILE_VERSION;
  bytes.set(randomBytes(KEY_FILE_SECRET_BYTES), 8);
  const base64 = bytesToBase64(bytes);
  return { bytes, base64, fingerprint: null };
}

/**
 * Accepts raw bytes, an ArrayBuffer or a base64 string. Anything that is not a
 * SubVault key file is rejected so a user cannot silently upload a random file.
 */
export function parseKeyFile(input) {
  let bytes;
  if (typeof input === 'string') {
    try {
      bytes = base64ToBytes(input);
    } catch {
      throw new Error('不是有效的 SubVault 密钥文件');
    }
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new Error('不是有效的 SubVault 密钥文件');
  }
  if (!isKeyFileBytes(bytes)) throw new Error('不是有效的 SubVault 密钥文件');
  if (bytes[5] !== KEY_FILE_VERSION) {
    throw new Error(`不支持的密钥文件版本：${bytes[5]}`);
  }
  return { bytes, base64: bytesToBase64(bytes) };
}

export async function describeKeyFile(input) {
  const parsed = parseKeyFile(input);
  return { ...parsed, fingerprint: await keyFileFingerprint(parsed.base64) };
}

export function keyFileLabel(fingerprint) {
  return `SVKEY-${String(fingerprint || '').slice(0, 8).toUpperCase()}`;
}
