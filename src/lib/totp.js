/** RFC 6238 TOTP helpers (SHA-1/256/512, 6/8 digits, configurable period). */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function normalizeTotpSecret(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '');
}

/**
 * Parse an otpauth://totp/... URI. Returns null for plain Base32/empty input.
 */
export function parseOtpAuthUri(value) {
  const raw = String(value || '').trim();
  if (!/^otpauth:\/\//i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid otpauth URL');
  }
  if (url.hostname.toLowerCase() !== 'totp') {
    throw new Error('Only otpauth://totp is supported');
  }
  const secret = normalizeTotpSecret(url.searchParams.get('secret') || '');
  if (!isValidTotpSecret(secret)) throw new Error('otpauth secret must be valid Base32');
  const digits = Number(url.searchParams.get('digits')) === 8 ? 8 : 6;
  const period = Math.min(300, Math.max(10, Number(url.searchParams.get('period')) || 30));
  const algorithm = String(url.searchParams.get('algorithm') || 'SHA1').toUpperCase();
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
    throw new Error('Unsupported otpauth algorithm');
  }
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const issuer = url.searchParams.get('issuer') || label.split(':')[0] || '';
  return {
    secret,
    digits,
    period,
    algorithm,
    issuer,
    account: label.includes(':') ? label.slice(label.indexOf(':') + 1) : label,
  };
}

export function totpAlgorithmToHash(algorithm) {
  const value = String(algorithm || 'SHA1').toUpperCase();
  if (value === 'SHA256') return 'SHA-256';
  if (value === 'SHA512') return 'SHA-512';
  return 'SHA-1';
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
    if (index === -1) throw new Error('TOTP secret is not valid Base32');
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
 * @param {{period?: number, digits?: number, algorithm?: string, now?: number}} [options]
 */
export async function generateTotp(secret, options = {}) {
  if (!isValidTotpSecret(secret)) throw new Error('Invalid TOTP secret');
  const period = Math.min(300, Math.max(10, Number(options.period) || 30));
  const digits = options.digits === 8 ? 8 : 6;
  const hash = totpAlgorithmToHash(options.algorithm);
  const now = Number(options.now) || Date.now();
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) throw new Error('TOTP secret is empty');

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash },
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
