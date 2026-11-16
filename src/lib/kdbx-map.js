/**
 * Pure KeePass (KDBX) → SubVault row mapping.
 *
 * Kept free of kdbxweb imports so the mapping can be unit-tested in Node and
 * reused by the options page. Attachment bytes are never copied; only names
 * are recorded in notes. Optional TOTP fields are translated to SubVault's
 * totpSecret/totpDigits/totpPeriod/totpAlgorithm shape.
 */

import { parseHttpUrl } from './domain.js';

const STANDARD_FIELDS = new Set([
  'Title',
  'UserName',
  'Password',
  'URL',
  'Notes',
  'otp',
  'TOTP Seed',
  'TOTP Settings',
  'passkey_credential_id',
  'passkey_rp_id',
  'passkey_username',
  'passkey_note',
]);

const MAX_HISTORY = 5;
const MAX_NOTES = 5000;

/** Read a KDBX field as text (string or ProtectedValue). */
export function kdbxFieldText(entry, name) {
  const value = entry?.fields?.get?.(name);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.getText === 'function') {
    try {
      return String(value.getText());
    } catch {
      return '';
    }
  }
  return String(value);
}

function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseTotpSettings(raw) {
  const result = { digits: 6, period: 30, algorithm: 'SHA1' };
  const text = String(raw || '').trim();
  if (!text) return result;
  for (const part of text.split(/[;,\s]+/)) {
    const token = part.trim();
    if (!token) continue;
    const [key, value] = token.includes('=')
      ? token.split('=', 2).map((item) => item.trim())
      : ['', token];
    if (/^\d+$/.test(value)) {
      const number = Number(value);
      if (key.toLowerCase() === 'period' || (!key && number >= 10 && number <= 300)) {
        result.period = Math.min(300, Math.max(10, number));
      } else if (key.toLowerCase() === 'digits' || (!key && (number === 6 || number === 8))) {
        result.digits = number === 8 ? 8 : 6;
      }
      continue;
    }
    const algorithm = value.toUpperCase().replace('SHA-', 'SHA');
    if (['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) result.algorithm = algorithm;
  }
  return result;
}

/** Extract a TOTP configuration from KeePass otp / TOTP Seed fields. */
export function kdbxTotp(entry) {
  const otp = kdbxFieldText(entry, 'otp').trim();
  if (otp) {
    if (/^otpauth:\/\//i.test(otp)) {
      return { totpSecret: otp, totpDigits: 6, totpPeriod: 30, totpAlgorithm: 'SHA1' };
    }
    // Some vaults store a bare seed in the otp field.
    const settings = parseTotpSettings(kdbxFieldText(entry, 'TOTP Settings'));
    return {
      totpSecret: otp,
      totpDigits: settings.digits,
      totpPeriod: settings.period,
      totpAlgorithm: settings.algorithm,
    };
  }
  const seed = kdbxFieldText(entry, 'TOTP Seed').trim();
  if (!seed) return {};
  const settings = parseTotpSettings(kdbxFieldText(entry, 'TOTP Settings'));
  return {
    totpSecret: seed,
    totpDigits: settings.digits,
    totpPeriod: settings.period,
    totpAlgorithm: settings.algorithm,
  };
}

function customFieldLines(entry) {
  const lines = [];
  const fields = entry?.fields;
  if (!fields || typeof fields.forEach !== 'function') return lines;
  fields.forEach((value, key) => {
    if (STANDARD_FIELDS.has(key)) return;
    const text =
      typeof value === 'string'
        ? value
        : typeof value?.getText === 'function'
          ? value.getText()
          : '';
    if (!text) return;
    lines.push(`${key}: ${text}`);
  });
  return lines;
}

function attachmentNames(entry) {
  const names = [];
  const binaries = entry?.binaries;
  if (!binaries) return names;
  if (typeof binaries.keys === 'function') {
    for (const name of binaries.keys()) names.push(String(name));
  } else if (Array.isArray(binaries)) {
    for (const item of binaries) {
      const name = item?.name || item?.ref;
      if (name) names.push(String(name));
    }
  }
  return names;
}

function mapHistory(entry) {
  const history = Array.isArray(entry?.history) ? entry.history : [];
  const rows = [];
  for (const old of history) {
    const password = kdbxFieldText(old, 'Password');
    if (!password) continue;
    rows.push({
      password,
      changedAt: timeValue(old?.times?.lastModTime),
      username: kdbxFieldText(old, 'UserName'),
    });
    if (rows.length >= MAX_HISTORY) break;
  }
  return rows;
}

/**
 * Map one KDBX entry to a SubVault import row.
 *
 * @param {object} entry kdbxweb KdbxEntry-like object
 * @param {{groupPath?: string}} [options]
 * @returns {object|null} row, or null when it has no login URL / password
 */
export function mapKdbxEntry(entry, options = {}) {
  if (!entry) return null;
  const password = kdbxFieldText(entry, 'Password');
  if (!password) return null;

  const rawUrl = kdbxFieldText(entry, 'URL').trim();
  const parsed =
    parseHttpUrl(rawUrl) ||
    (!/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) && rawUrl
      ? parseHttpUrl(`https://${rawUrl}`)
      : null);
  const host = parsed?.hostname || '';
  if (!host) return null;

  const title = kdbxFieldText(entry, 'Title').trim() || host;
  const username = kdbxFieldText(entry, 'UserName').trim();
  const notes = [kdbxFieldText(entry, 'Notes').trim()];
  const custom = customFieldLines(entry);
  if (custom.length) notes.push(`自定义字段\n${custom.join('\n')}`);
  const attachments = attachmentNames(entry);
  if (attachments.length) notes.push(`附件（仅记录名称）\n${attachments.join(', ')}`);

  const row = {
    title: title.slice(0, 200),
    host,
    port: parsed.port || '',
    username: username.slice(0, 320),
    aliasEmail: kdbxFieldText(entry, 'alias_email').trim().slice(0, 320),
    aliasProvider: kdbxFieldText(entry, 'alias_provider').trim().slice(0, 80),
    password: password.slice(0, 4096),
    url: parsed.href.slice(0, 2000),
    notes: notes.filter(Boolean).join('\n\n').slice(0, MAX_NOTES),
    tags: Array.isArray(entry?.tags) ? entry.tags.map(String).filter(Boolean).slice(0, 32) : [],
    folder: String(options.groupPath || '').slice(0, 80),
    passwordChangedAt: timeValue(entry?.times?.lastModTime),
    history: mapHistory(entry),
    source: 'kdbx',
  };

  const totp = kdbxTotp(entry);
  if (totp.totpSecret) Object.assign(row, totp);

  const passkeyCredentialId = kdbxFieldText(entry, 'passkey_credential_id').trim().slice(0, 1024);
  const passkeyRpId = kdbxFieldText(entry, 'passkey_rp_id').trim().slice(0, 255);
  if (passkeyCredentialId || passkeyRpId) {
    row.passkey = {
      credentialId: passkeyCredentialId,
      rpId: passkeyRpId,
      username: kdbxFieldText(entry, 'passkey_username').trim().slice(0, 320),
      note: kdbxFieldText(entry, 'passkey_note').trim().slice(0, 500),
    };
  }

  return row;
}

/** Flatten a kdbxweb group tree into rows, preserving the group path. */
export function collectKdbxRows(group, groupPath = '', rows = [], isRoot = true) {
  if (!group) return rows;
  const name = String(group.name || '').trim();
  // The root group is the database name, not a user folder.
  const path = isRoot ? '' : groupPath ? (name ? `${groupPath}/${name}` : groupPath) : name;
  const entries = Array.isArray(group.entries) ? group.entries : [];
  for (const entry of entries) {
    const row = mapKdbxEntry(entry, { groupPath: path });
    if (row) rows.push(row);
  }
  for (const child of Array.isArray(group.groups) ? group.groups : []) {
    collectKdbxRows(child, path, rows, false);
  }
  return rows;
}
