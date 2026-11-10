/**
 * CSV import/export for browser password exports.
 *
 * Supported (auto-detected by header aliases):
 *  - Chrome / Edge  : name,url,username,password,note
 *  - Firefox        : url,username,password,httpRealm,formActionOrigin,timePasswordChanged,...
 *  - Bitwarden      : folder,favorite,type,name,notes,...,login_uri,login_username,login_password,...
 *  - LastPass       : url,username,password,extra,name,grouping,fav
 *  - 1Password      : Title,Url,Username,Password,...
 *  - Generic        : first url / username / password-looking columns
 *
 * Every parsed row carries `passwordChangedAt`. If the export has no usable
 * time column (Chrome/Edge CSV), the file's modification time is used so that
 * re-imports can still be compared against newer vault records.
 */

import {
  hostFromUrl,
  normalizeHost,
  normalizePort,
  parseHttpUrl,
  suggestBaseDomain,
} from './domain.js';

const URL_ALIASES = ['url', 'loginuri', 'uri', 'website', 'site', 'origin', 'urls', 'loginurl'];
const USERNAME_ALIASES = ['username', 'loginusername', 'user', 'login', 'account', 'email', 'loginname', 'userid'];
const PASSWORD_ALIASES = ['password', 'loginpassword', 'pass', 'pwd'];
const TITLE_ALIASES = ['name', 'title', 'accountname'];
const NOTE_ALIASES = ['note', 'notes', 'extra', 'comment', 'comments', 'memo'];

/** Ordered by relevance: password change time is the conflict-resolution key. */
const TIME_COLUMNS = [
  {
    kind: 'passwordChanged',
    aliases: [
      'timepasswordchanged',
      'passwordchanged',
      'passwordchangedat',
      'passwordlastchanged',
      'pwdchangedat',
    ],
  },
  {
    kind: 'updated',
    aliases: ['updatedat', 'updated', 'lastmodified', 'modified', 'modificationtime', 'lastupdate'],
  },
  {
    kind: 'created',
    aliases: ['timecreated', 'createdat', 'created', 'creationtime'],
  },
  {
    kind: 'lastUsed',
    aliases: ['timelastused', 'lastused', 'lastusedat'],
  },
];

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function findColumn(headers, aliases) {
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index !== -1) return index;
  }
  return -1;
}

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF and embedded newlines. */
export function parseDelimited(text, delimiter = ',') {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

function detectDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted;
      else if (char === candidate && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function detectFormat(headers) {
  if (headers.includes('loginuri') || headers.includes('loginusername')) return 'Bitwarden';
  if (headers.includes('httprealm') || headers.includes('formactionorigin')) return 'Firefox';
  if (headers.includes('extra') && headers.includes('grouping')) return 'LastPass';
  if (headers.includes('otpauth') || headers.includes('archived')) return '1Password';
  if (headers.includes('note') || headers.includes('name')) return 'Chrome / Edge';
  return '通用 CSV';
}

/**
 * Parse seconds / milliseconds / microseconds / date strings.
 * @returns {number|null} epoch milliseconds
 */
export function parseTimestamp(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : value;
  if (raw === '') return null;

  let time;
  if (typeof raw === 'number') {
    time = raw;
  } else if (/^\d{9,17}(?:\.\d+)?$/.test(String(raw))) {
    time = Number(raw);
  } else {
    const text = String(raw);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
      ? text.replace(' ', 'T')
      : text;
    time = Date.parse(normalized);
  }
  if (!Number.isFinite(time)) return null;

  // Firefox/Chromium exports have used seconds, ms and µs over time.
  if (time >= 1e14) time = Math.round(time / 1000);
  else if (time >= 1e12) time = Math.round(time);
  else if (time >= 1e9) time = Math.round(time * 1000);
  else return null;

  const min = Date.UTC(2000, 0, 1);
  const max = now + 366 * 24 * 60 * 60 * 1000;
  if (time < min || time > max) return null;
  return time;
}

function normalizeFallbackTime(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0 && number <= Date.now() + 366 * 864e5) {
    return Math.round(number);
  }
  return Date.now();
}

/**
 * Parse exported passwords into SubVault entries (without ids).
 * @param {string} text
 * @param {{fallbackTime?: number}} [options] usually File.lastModified
 */
export function csvToEntries(text, options = {}) {
  const fallbackTime = normalizeFallbackTime(options.fallbackTime);
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const warnings = [];
  if (rows.length === 0) {
    return {
      entries: [],
      format: '未知',
      total: 0,
      skipped: 0,
      warnings: ['文件为空'],
      hasTimestamps: false,
      fallbackTime,
      timeFallbacks: 0,
    };
  }

  const headers = rows[0].map(normalizeHeader);
  const format = detectFormat(headers);
  const urlIndex = findColumn(headers, URL_ALIASES);
  const usernameIndex = findColumn(headers, USERNAME_ALIASES);
  const passwordIndex = findColumn(headers, PASSWORD_ALIASES);
  const titleIndex = findColumn(headers, TITLE_ALIASES);
  const noteIndex = findColumn(headers, NOTE_ALIASES);

  if (urlIndex === -1 || passwordIndex === -1) {
    return {
      entries: [],
      format,
      total: Math.max(0, rows.length - 1),
      skipped: Math.max(0, rows.length - 1),
      warnings: ['未找到 URL 或密码列，请确认这是浏览器导出的密码 CSV 文件'],
      hasTimestamps: false,
      fallbackTime,
      timeFallbacks: 0,
    };
  }

  const timeColumns = [];
  for (const definition of TIME_COLUMNS) {
    const index = findColumn(headers, definition.aliases);
    if (index !== -1) timeColumns.push({ index, kind: definition.kind });
  }
  if (timeColumns.length === 0) {
    const stamp = new Date(fallbackTime).toISOString().slice(0, 16).replace('T', ' ');
    warnings.push(`文件没有时间列，已使用文件修改时间 ${stamp} 作为密码记录时间`);
  }

  const entries = [];
  let skipped = 0;
  let timeFallbacks = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => !cell || cell.trim() === '')) continue;
    const rawUrl = (row[urlIndex] || '').split(/\r?\n/)[0].trim();
    const password = row[passwordIndex] ?? '';
    const username = usernameIndex === -1 ? '' : (row[usernameIndex] ?? '').trim();

    if (!rawUrl || !password) {
      skipped += 1;
      continue;
    }

    const lowerUrl = rawUrl.toLowerCase();
    if (/^(chrome|edge|about|file|android|iosapp|data|javascript):/.test(lowerUrl)) {
      skipped += 1;
      continue;
    }

    const host = normalizeHost(hostFromUrl(rawUrl));
    if (!host) {
      skipped += 1;
      if (warnings.length < 6) warnings.push(`已跳过无法识别的 URL：${rawUrl.slice(0, 80)}`);
      continue;
    }

    let passwordChangedAt = null;
    for (const column of timeColumns) {
      passwordChangedAt = parseTimestamp(row[column.index]);
      if (passwordChangedAt) break;
    }
    if (!passwordChangedAt) {
      passwordChangedAt = fallbackTime;
      timeFallbacks += 1;
    }

    const title = (titleIndex === -1 ? '' : (row[titleIndex] || '').trim()) || host;
    const notes = noteIndex === -1 ? '' : (row[noteIndex] ?? '');
    entries.push({
      title: title.slice(0, 200),
      host,
      port: normalizePort(parseHttpUrl(rawUrl)?.port || ''),
      scope: 'host',
      username: username.slice(0, 320),
      password,
      notes: notes.slice(0, 5000),
      url: rawUrl.slice(0, 2000),
      source: format,
      passwordChangedAt,
    });
  }

  if (timeColumns.length > 0 && timeFallbacks > 0) {
    warnings.push(`${timeFallbacks} 条记录的时间无法解析，已使用文件修改时间`);
  }

  return {
    entries,
    format,
    total: Math.max(0, rows.length - 1),
    skipped,
    warnings,
    hasTimestamps: timeColumns.length > 0,
    fallbackTime,
    timeFallbacks,
  };
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Export in Chrome's CSV column order so the file can be re-imported by
 * Chrome, Edge, or SubVault itself. Timestamps are preserved only in the
 * encrypted backup export; CSV stays maximally compatible.
 */
export function entriesToCsv(entries) {
  const lines = ['name,url,username,password,note'];
  for (const entry of entries) {
    const url = entry.url || `https://${entry.host}/`;
    lines.push(
      [entry.title || entry.host, url, entry.username || '', entry.password || '', entry.notes || '']
        .map(escapeCsv)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Used by the import preview to explain the merge scope. */
export function describeDomainScope(host) {
  return `${suggestBaseDomain(host)} 及其所有子域名`;
}
