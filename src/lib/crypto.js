/**
 * SubVault crypto primitives.
 *
 * Vault layout (stored in chrome.storage.local):
 *   {
 *     v: 1,
 *     kdf: { algo: "PBKDF2-SHA512", hash: "SHA-512", salt: b64, iterations: 310000 },
 *     box: { iv: b64, data: b64 },
 *     createdAt, updatedAt
 *   }
 *
 * The AES-GCM key is derived from the master password and never persisted to
 * disk. While unlocked, the exported JWK lives in chrome.storage.session, which
 * is memory-only and cleared when the browser (or the extension) restarts.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const KDF_ALGO = 'PBKDF2-SHA512';
export const KDF_HASH = 'SHA-512';
export const KDF_LEGACY_HASH = 'SHA-256';
export const KDF_ITERATIONS = 310_000;
export const KDF_MIN_ITERATIONS = 100_000;
export const KDF_SALT_BYTES = 32;
export const AES_KEY_BITS = 256;
export const VAULT_VERSION = 1;

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'letmein',
  'admin123',
  'welcome',
  'welcome1',
  'abc12345',
  'iloveyou',
  'monkey123',
  'dragon123',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'master123',
  'login123',
  'passw0rd',
  'p@ssw0rd',
  '11111111',
  '00000000',
]);

export function isCommonPassword(password) {
  return COMMON_PASSWORDS.has(String(password || '').toLowerCase());
}

function b64encode(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...randomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes) {
  return b64encode(bytes);
}

export function base64ToBytes(value) {
  return b64decode(value);
}

/**
 * Derive an AES-GCM key from a master password.
 * PBKDF2 is the native WebCrypto KDF; SHA-512 and a 32-byte random salt are
 * used for new vaults. `hash` is persisted so older SHA-256 vaults still open.
 * @param {string} password
 * @param {string} saltB64
 * @param {number} iterations
 * @param {'SHA-256'|'SHA-512'} hash
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(
  password,
  saltB64,
  iterations = KDF_ITERATIONS,
  hash = KDF_HASH,
) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('主密码不能为空');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64decode(saltB64),
      iterations,
      hash,
    },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * @param {CryptoKey} key
 * @param {unknown} value
 * @param {string} [aad]
 * @returns {Promise<{iv: string, data: string}>}
 */
export async function encryptJSON(key, value, aad = '') {
  const iv = randomBytes(12);
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(value));
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = TEXT_ENCODER.encode(aad);
  const ciphertext = await crypto.subtle.encrypt(params, key, plaintext);
  return { iv: b64encode(iv), data: b64encode(new Uint8Array(ciphertext)) };
}

/**
 * @param {CryptoKey} key
 * @param {{iv: string, data: string}} box
 * @param {string} [aad]
 * @returns {Promise<any>}
 */
export async function decryptJSON(key, box, aad = '') {
  if (!box || typeof box.iv !== 'string' || typeof box.data !== 'string') {
    throw new Error('密码库数据格式无效');
  }
  const params = { name: 'AES-GCM', iv: b64decode(box.iv) };
  if (aad) params.additionalData = TEXT_ENCODER.encode(aad);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(params, key, b64decode(box.data));
  } catch {
    throw new Error('主密码错误，或密码库数据已损坏');
  }
  try {
    return JSON.parse(TEXT_DECODER.decode(plaintext));
  } catch {
    throw new Error('密码库内容无法解析');
  }
}

export async function exportKeyJwk(key) {
  return crypto.subtle.exportKey('jwk', key);
}

export async function importKeyJwk(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

export function createKdfParams(iterations = KDF_ITERATIONS) {
  return {
    algo: KDF_ALGO,
    hash: KDF_HASH,
    salt: b64encode(randomBytes(KDF_SALT_BYTES)),
    iterations,
  };
}

/**
 * Basic strength estimate used only for UI hints.
 * @param {string} password
 */
export function passwordStrength(password) {
  const value = String(password || '');
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return { score: 0, label: '太常见' };
  }
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;
  const pool = [26, 26, 10, 33][Math.max(0, classes - 1)] || 0;
  const bits = value.length * Math.log2(pool || 1);
  if (value.length < 8) return { score: 0, label: '太短' };
  if (bits < 45) return { score: 1, label: '偏弱' };
  if (bits < 70) return { score: 2, label: '一般' };
  if (bits < 100) return { score: 3, label: '较强' };
  return { score: 4, label: '很强' };
}
