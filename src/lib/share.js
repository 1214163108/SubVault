import {
  base64ToBytes,
  bytesToBase64,
  createKdfParams,
  decryptJSON,
  deriveKeyFromKdf,
  encryptJSON,
} from './crypto.js';
import { foldKeyFile, keyFileFingerprint } from './keyfile.js';

export const SHARE_FORMAT = 'subvault-share';
export const SHARE_VERSION = 2;
const SHARE_AAD_V1 = 'subvault-share-v1';
const SHARE_AAD_V2 = 'subvault-share-v2';

export async function bindKdfToExpiry(kdf, expiresAt) {  const salt = base64ToBytes(kdf.salt);
  const tag = new TextEncoder().encode(`|subvault-share|${expiresAt}`);
  const input = new Uint8Array(salt.length + tag.length);
  input.set(salt, 0);
  input.set(tag, salt.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return { ...kdf, salt: bytesToBase64(digest) };
}

export function shareAad(version, expiresAt) {
  return version >= 2 ? `${SHARE_AAD_V2}:${expiresAt}` : SHARE_AAD_V1;
}

/** Strip vault-only metadata before encrypting a share package. */
export function shareableEntry(entry) {
  return {
    host: String(entry?.host || ''),
    port: String(entry?.port || ''),
    username: String(entry?.username || ''),
    password: String(entry?.password || ''),
    url: String(entry?.url || ''),
    notes: String(entry?.notes || ''),
    totpSecret: String(entry?.totpSecret || ''),
    totpDigits: Number(entry?.totpDigits) || 6,
    totpPeriod: Number(entry?.totpPeriod) || 30,
    totpAlgorithm: String(entry?.totpAlgorithm || 'SHA1'),
    tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, 20) : [],
    folder: String(entry?.folder || ''),
  };
}

/**
 * Encrypt selected entries with a dedicated share password. The vault master
 * password is never used here, so a share file can be revoked by forgetting it.
 */
export async function createSharePackage(entries, options = {}) {
  const password = String(options.password || '');
  if (password.length < 8) throw new Error('分享密码至少需要 8 个字符');
  const keyFileBase64 = String(options.keyFileBase64 || '');
  const list = (Array.isArray(entries) ? entries : []).map(shareableEntry).filter(
    (entry) => entry.host && entry.password,
  );
  if (!list.length) throw new Error('没有可分享的账号');
  const createdAt = Date.now();
  const expiresAt = Number(options.expiresAt) || createdAt + 24 * 60 * 60 * 1000;
  if (expiresAt <= createdAt) throw new Error('分享有效期无效');
  const rawKdf = createKdfParams();
  const kdf = await bindKdfToExpiry(rawKdf, expiresAt);
  const key = await deriveKeyFromKdf(await foldKeyFile(password, keyFileBase64), kdf);
  const box = await encryptJSON(
    key,
    {
      format: SHARE_FORMAT,
      version: SHARE_VERSION,
      createdAt,
      expiresAt,
      entries: list,
    },
    shareAad(SHARE_VERSION, expiresAt),
  );
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    createdAt,
    expiresAt,
    ...(keyFileBase64
      ? { keyFile: true, keyFileFingerprint: await keyFileFingerprint(keyFileBase64) }
      : {}),
    kdf: rawKdf,
    box,
  };
}

/** Decrypt and validate a .svshare package. Throws on wrong password/expiry. */
export async function openSharePackage(pkg, password, keyFileBase64 = '') {
  const version = Number(pkg?.version);
  if (!pkg || pkg.format !== SHARE_FORMAT || (version !== 1 && version !== 2)) {
    throw new Error('不是有效的 SubVault 分享文件');
  }
  const expiresAt = Number(pkg.expiresAt) || 0;
  if (expiresAt && Date.now() > expiresAt) {
    throw new Error('分享文件已过期，无法解密');
  }
  if (pkg.keyFile && !keyFileBase64) {
    throw new Error('该分享文件需要配套的密钥文件才能解密');
  }
  if (pkg.keyFile && pkg.keyFileFingerprint) {
    const actual = await keyFileFingerprint(keyFileBase64);
    if (actual !== String(pkg.keyFileFingerprint)) {
      throw new Error('密钥文件与该分享文件不匹配');
    }
  }
  const kdf = version >= 2 ? await bindKdfToExpiry(pkg.kdf, expiresAt) : pkg.kdf;
  const key = await deriveKeyFromKdf(await foldKeyFile(String(password || ''), keyFileBase64), kdf);
  let payload;
  try {
    payload = await decryptJSON(key, pkg.box, shareAad(version, expiresAt));
  } catch {
    throw new Error('分享密码错误，或文件已损坏');
  }
  if (
    payload?.version !== version ||
    Number(payload?.expiresAt) !== expiresAt ||
    !Array.isArray(payload?.entries) ||
    !payload.entries.length
  ) {
    throw new Error('分享文件已损坏');
  }
  return { ...payload, entries: payload.entries.map(shareableEntry) };
}

export function defaultShareExpiry(days = 1) {
  return Date.now() + Math.max(1, Number(days) || 1) * 24 * 60 * 60 * 1000;
}
