/** RFC 4226 HOTP / RFC 6238 TOTP / Steam Guard helpers. */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const STEAM_DIGITS = 5;

export const OTP_TYPES = ['totp', 'hotp', 'steam'];

export function normalizeTotpSecret(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/g, '');
}

/**
 * Parse an otpauth:// or steam:// URI.
 * Returns null for plain Base32/empty input.
 */
export function parseOtpAuthUri(value) {
  const raw = String(value || '').trim();
  if (/^steam:\/\//i.test(raw)) {
    const secret = normalizeTotpSecret(raw.slice('steam://'.length));
    if (!isValidTotpSecret(secret)) throw new Error('Steam 密钥必须是有效 Base32');
    return {
      type: 'steam',
      secret,
      digits: STEAM_DIGITS,
      period: 30,
      algorithm: 'SHA1',
      counter: 0,
      issuer: 'Steam',
      account: '',
    };
  }
  if (!/^otpauth:\/\//i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid otpauth URL');
  }
  const kind = url.hostname.toLowerCase();
  if (kind !== 'totp' && kind !== 'hotp') {
    throw new Error('Only otpauth://totp and otpauth://hotp are supported');
  }
  const secret = normalizeTotpSecret(url.searchParams.get('secret') || '');
  if (!isValidTotpSecret(secret)) throw new Error('otpauth secret must be valid Base32');
  const digitsParam = Number(url.searchParams.get('digits'));
  const digits = kind === 'hotp' ? (digitsParam === 8 ? 8 : 6) : digitsParam === 8 ? 8 : 6;
  const period = Math.min(300, Math.max(10, Number(url.searchParams.get('period')) || 30));
  const algorithm = String(url.searchParams.get('algorithm') || 'SHA1').toUpperCase();
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
    throw new Error('Unsupported otpauth algorithm');
  }
  const counter = kind === 'hotp'
    ? Math.max(0, Math.floor(Number(url.searchParams.get('counter')) || 0))
    : 0;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const issuer = url.searchParams.get('issuer') || label.split(':')[0] || '';
  // Steam exports as otpauth://totp/Steam:<account>?issuer=Steam without digits.
  const steam = kind === 'totp'
    && !url.searchParams.get('digits')
    && /^steam$/i.test(issuer.trim());
  return {
    type: steam ? 'steam' : kind,
    secret,
    digits: steam ? STEAM_DIGITS : digits,
    period,
    algorithm,
    counter,
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

async function hmac(secret, counter, algorithm) {
  if (!isValidTotpSecret(secret)) throw new Error('Invalid OTP secret');
  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) throw new Error('OTP secret is empty');
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: totpAlgorithmToHash(algorithm) },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)));
}

function truncate(signature) {
  const offset = signature[signature.length - 1] & 0x0f;
  return (
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff)
  );
}

/** Steam Guard codes use a custom 26-character alphabet and 5 characters. */
function steamCode(binary) {
  let value = binary;
  let code = '';
  for (let index = 0; index < STEAM_DIGITS; index += 1) {
    code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
    value = Math.floor(value / STEAM_ALPHABET.length);
  }
  return code;
}

/**
 * RFC 4226 HOTP.
 * @param {string} secret Base32
 * @param {{counter?: number, digits?: number, algorithm?: string}} [options]
 */
export async function generateHotp(secret, options = {}) {
  const counter = Math.max(0, Math.floor(Number(options.counter) || 0));
  const digits = Number(options.digits) === 8 ? 8 : 6;
  const signature = await hmac(secret, counter, options.algorithm);
  const binary = truncate(signature);
  return {
    code: String(binary % 10 ** digits).padStart(digits, '0'),
    digits,
    counter,
    type: 'hotp',
  };
}

/**
 * @param {string} secret Base32
 * @param {{period?: number, digits?: number, algorithm?: string, now?: number, type?: string}} [options]
 */
export async function generateTotp(secret, options = {}) {
  if (!isValidTotpSecret(secret)) throw new Error('Invalid TOTP secret');
  const period = Math.min(300, Math.max(10, Number(options.period) || 30));
  const now = Number(options.now) || Date.now();
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);
  const remaining = period - (seconds % period);
  const signature = await hmac(secret, counter, options.algorithm);
  const binary = truncate(signature);

  if (String(options.type || '').toLowerCase() === 'steam') {
    return {
      code: steamCode(binary),
      digits: STEAM_DIGITS,
      period,
      remaining,
      counter,
      type: 'steam',
    };
  }

  const digits = options.digits === 8 ? 8 : 6;
  return {
    code: String(binary % 10 ** digits).padStart(digits, '0'),
    digits,
    period,
    remaining,
    counter,
    type: 'totp',
  };
}

/**
 * Unified entry point used by the service worker.
 * @param {{totpSecret: string, totpType?: string, totpDigits?: number, totpPeriod?: number,
 *   totpAlgorithm?: string, totpCounter?: number}} entry
 * @param {{now?: number, counter?: number}} [options]
 */
export async function generateOtpForEntry(entry, options = {}) {
  const secret = entry?.totpSecret;
  if (!secret) throw new Error('该账号没有配置动态码');
  const type = OTP_TYPES.includes(entry.totpType) ? entry.totpType : 'totp';
  if (type === 'hotp') {
    const counter = Number.isFinite(options.counter)
      ? options.counter
      : Number(entry.totpCounter) || 0;
    const result = await generateHotp(secret, {
      counter,
      digits: entry.totpDigits,
      algorithm: entry.totpAlgorithm,
    });
    return { ...result, period: 0, remaining: 0 };
  }
  return generateTotp(secret, {
    type,
    digits: type === 'steam' ? STEAM_DIGITS : entry.totpDigits,
    period: entry.totpPeriod,
    algorithm: entry.totpAlgorithm,
    now: options.now,
  });
}

export { STEAM_ALPHABET, STEAM_DIGITS };
