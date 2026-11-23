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

import '../vendor/hash-wasm-argon2.umd.js';

export const KDF_ALGO = 'PBKDF2-SHA512';
export const KDF_ALGO_ARGON2 = 'ARGON2ID';
export const ARGON2_MEMORY_KIB = 65536;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;
export const KDF_HASH = 'SHA-512';
export const KDF_LEGACY_HASH = 'SHA-256';
export const KDF_ITERATIONS = 310_000;
export const KDF_MIN_ITERATIONS = 100_000;
export const KDF_SALT_BYTES = 32;
export const AES_KEY_BITS = 256;
export const VAULT_VERSION = 1;
export const VAULT_FORMAT_VERSION = 4;
export const AAD_VAULT_KEY = 'subvault:vaultkey:v4';
export const AAD_PAYLOAD_V4 = 'subvault:vault:v4';

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

async function encryptBytes(key, bytes, aad = '') {
  const iv = randomBytes(12);
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = TEXT_ENCODER.encode(aad);
  const ciphertext = await crypto.subtle.encrypt(params, key, bytes);
  return { iv: b64encode(iv), data: b64encode(new Uint8Array(ciphertext)) };
}

async function decryptBytes(key, box, aad = '') {
  if (!box || typeof box.iv !== 'string' || typeof box.data !== 'string') {
    throw new Error('密码库数据格式无效');
  }
  const params = { name: 'AES-GCM', iv: b64decode(box.iv) };
  if (aad) params.additionalData = TEXT_ENCODER.encode(aad);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, b64decode(box.data)));
  } catch {
    throw new Error('主密码错误，或密码库数据已损坏');
  }
}

/** Generate the random payload key used by vault format v4. */
export async function createVaultKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap (encrypt) a VaultKey under the password-derived KEK. */
export async function wrapVaultKey(kek, vaultKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vaultKey));
  return encryptBytes(kek, raw, AAD_VAULT_KEY);
}

/** Unwrap a VaultKey with the password-derived KEK. */
export async function unwrapVaultKey(kek, box) {
  const raw = await decryptBytes(kek, box, AAD_VAULT_KEY);
  if (raw.length !== AES_KEY_BITS / 8) throw new Error('VaultKey 数据无效');
  try {
    return await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: AES_KEY_BITS },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new Error('VaultKey 数据无效');
  }
}

export async function encryptPayload(key, value) {
  return encryptJSON(key, value, AAD_PAYLOAD_V4);
}

export async function decryptPayload(key, box) {
  return decryptJSON(key, box, AAD_PAYLOAD_V4);
}

export async function exportKeyJwk(key) {
  return crypto.subtle.exportKey('jwk', key);
}

/** Export a raw AES key for host-side device binding (base64-encoded caller). */
export async function exportKeyRaw(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** Import a raw AES-GCM key returned by the device-binding host. */
export async function importKeyRaw(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length !== AES_KEY_BITS / 8) throw new Error('设备密钥长度无效');
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
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

export function createArgon2Params() {
  return {
    algo: KDF_ALGO_ARGON2,
    salt: b64encode(randomBytes(KDF_SALT_BYTES)),
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: AES_KEY_BITS / 8,
  };
}

/**
 * Derive the AES-GCM vault key from a stored KDF descriptor.
 * Supports PBKDF2-SHA512 (legacy/default) and Argon2id (bundled WASM).
 * @param {string} password
 * @param {Record<string, any>} kdf
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKeyFromKdf(password, kdf = {}) {
  if (!kdf || !kdf.salt) throw new Error('密码库加密参数缺失');
  if (kdf.algo === KDF_ALGO_ARGON2) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('主密码不能为空');
    }
    const engine = globalThis.hashwasm;
    if (!engine?.argon2id) throw new Error('Argon2 引擎未加载，请刷新页面后重试');
    let raw;
    try {
      raw = await engine.argon2id({
        password: TEXT_ENCODER.encode(password),
        salt: b64decode(kdf.salt),
        parallelism: Math.min(4, Math.max(1, Number(kdf.parallelism) || 1)),
        iterations: Math.min(10, Math.max(1, Number(kdf.iterations) || 3)),
        memorySize: Math.min(262144, Math.max(8192, Number(kdf.memorySize) || 65536)),
        hashLength: 32,
        outputType: 'binary',
      });
    } catch (error) {
      throw new Error(`Argon2 密钥派生失败：${error?.message || '未知错误'}`);
    }
    if (!(raw instanceof Uint8Array) || raw.length !== 32) {
      throw new Error('Argon2 密钥派生结果无效');
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: AES_KEY_BITS }, true, [
      'encrypt',
      'decrypt',
    ]);
  }
  return deriveKey(
    password,
    kdf.salt,
    Math.max(KDF_MIN_ITERATIONS, Number(kdf.iterations) || KDF_ITERATIONS),
    kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH,
  );
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

export async function sha256Hex(value) {
  const data =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new TextEncoder().encode(String(value ?? ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}
