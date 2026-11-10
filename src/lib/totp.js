/** RFC 6238 TOTP helpers (HMAC-SHA1, 6/8 digits, 30s period). */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function normalizeTotpSecret(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '');
}

export function isValidTotpSecret(value) {
  const secret = normalizeTotpSecret(value);
  if (secret.length < 8 || secret.length > 128) return false;
  return [...secret].every((char) => BASE32_ALPHABET.includes(char));
}

export function base32Decode(value) {
  const secret = normalizeTotpSecret(value);
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const char of secret) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('TOTP 密钥不是有效的 Base32');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function counterBytes(counter) {
  const bytes = new Uint8Array(8);
  let value = Math.floor(counter);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}

/**
 * @param {string} secret Base32
 * @param {{period?: number, digits?: number, now?: number}} [options]
 */
export async function generateTotp(secret, options = {}) {
  if (!isValidTotpSecret(secret)) throw new Error('TOTP 密钥格式无效');
  const period = Math.min(300, Math.max(10, Number(options.period) || 30));
  const digits = options.digits === 8 ? 8 : 6;
  const now = Number(options.now) || Date.now();
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) throw new Error('TOTP 密钥为空');

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, counterBytes(counter)),
  );
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, '0');
  return {
    code,
    digits,
    period,
    remaining: period - (seconds % period),
    counter,
  };
}
