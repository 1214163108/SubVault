import { normalizeHost, normalizePort, parseHttpUrl } from './domain.js';

function asString(value) {
  return String(value ?? '').trim();
}

function hostFromUrl(value) {
  const parsed = parseHttpUrl(asString(value)) || parseHttpUrl(`https://${asString(value)}`);
  if (!parsed) return null;
  return {
    host: normalizeHost(parsed.hostname),
    port: normalizePort(parsed.port),
    url: parsed.href,
  };
}

function cleanUriList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : item?.uri || item?.url))
    .map(asString)
    .filter(Boolean);
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeEntry({ url, host, port, title, username, password, notes, totpSecret, folder, tags, passwordChangedAt }) {
  const parsed = url ? hostFromUrl(url) : null;
  const finalHost = normalizeHost(host || parsed?.host || '');
  if (!finalHost || !password) return null;
  return {
    host: finalHost,
    port: normalizePort(port || parsed?.port || ''),
    url: parsed?.url || (url ? String(url) : ''),
    title: asString(title),
    username: asString(username),
    password: String(password),
    notes: asString(notes),
    totpSecret: asString(totpSecret),
    folder: asString(folder),
    tags: Array.isArray(tags) ? [...new Set(tags.map(asString).filter(Boolean))] : [],
    passwordChangedAt: timestamp(passwordChangedAt),
  };
}

/** Bitwarden unencrypted JSON export. */
export function parseBitwardenJson(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch {
    throw new Error('Bitwarden JSON 格式无效');
  }
  if (data?.encrypted) {
    throw new Error('这是加密的 Bitwarden 导出文件；请先导出未加密 JSON');
  }
  if (!Array.isArray(data?.items)) throw new Error('没有找到 Bitwarden items');

  const folders = new Map(
    (Array.isArray(data.folders) ? data.folders : []).map((folder) => [
      folder.id,
      asString(folder.name),
    ]),
  );
  const entries = [];
  let skipped = 0;
  for (const item of data.items) {
    if (item?.type !== 1 || !item.login) {
      skipped += 1;
      continue;
    }
    const uris = cleanUriList(item.login.uris);
    const entry = makeEntry({
      url: uris[0] || item.login.uri || '',
      title: item.name,
      username: item.login.username,
      password: item.login.password,
      notes: item.notes,
      totpSecret: item.login.totp,
      folder: folders.get(item.folderId) || '',
      tags: item.collectionIds ? [] : [],
      passwordChangedAt: item.revisionDate || item.creationDate,
    });
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return {
    entries,
    skipped,
    total: Array.isArray(data.items) ? data.items.length : 0,
    format: 'Bitwarden JSON',
    warnings: entries.length ? [] : ['没有可导入的登录项'],
    hasTimestamps: entries.some((entry) => entry.passwordChangedAt > 0),
  };
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('1PUX 不是有效的 ZIP 文件');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  const inflate = async (data) => {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压 1PUX');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const jobs = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, compressed);
    } else if (method === 8) {
      jobs.push(
        inflate(compressed).then((data) => {
          entries.set(name, data);
        }),
      );
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return Promise.all(jobs).then(() => entries);
}

function parseOnePasswordItem(item, folders) {
  const overview = item?.overview || {};
  const urls = cleanUriList(overview.urls);
  const fields = Array.isArray(item?.loginFields) ? item.loginFields : [];
  const findField = (designation) =>
    fields.find((field) => String(field?.designation || '').toLowerCase() === designation)?.value;
  const extras = Array.isArray(item?.fields) ? item.fields : [];
  const totpField = extras.find((field) =>
    /one.?time|totp|otp|verification/i.test(
      `${field?.label || ''} ${field?.designation || ''} ${field?.id || ''}`,
    ),
  );
  const folder = item.__folder || folders.get(item?.vaultUuid) || '';
  return makeEntry({
    url: urls[0] || overview.url || '',
    title: overview.title || item?.title,
    username: findField('username'),
    password: findField('password'),
    notes: item?.notes,
    totpSecret: totpField?.value,
    folder,
    tags: Array.isArray(overview.tags) ? overview.tags : [],
    passwordChangedAt: item?.updatedAt || item?.createdAt,
  });
}

/** 1Password .1pux export: a ZIP containing export.data JSON. */
export async function parseOnePassword1pux(bytes) {
  const files = await readZipEntries(bytes);
  const dataEntry =
    [...files.entries()].find(([name]) => /export\.data$/i.test(name)) ||
    [...files.entries()].find(([name]) => /\.json$/i.test(name));
  if (!dataEntry) throw new Error('1PUX 中没有 export.data');
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(dataEntry[1]));
  } catch {
    throw new Error('1PUX export.data 不是有效 JSON');
  }
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const folders = new Map();
  const items = [];
  for (const account of accounts) {
    for (const vault of Array.isArray(account?.vaults) ? account.vaults : []) {
      if (vault?.name) folders.set(vault.uuid || vault.name, vault.name);
      for (const item of Array.isArray(vault?.items) ? vault.items : []) {
        items.push({ ...item, __folder: vault.name || '' });
      }
    }
  }
  const entries = [];
  let skipped = 0;
  for (const item of items) {
    const entry = parseOnePasswordItem(item, folders);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return {
    entries,
    skipped,
    total: items.length,
    format: '1Password 1PUX',
    warnings: entries.length ? [] : ['没有可导入的登录项'],
    hasTimestamps: entries.some((entry) => entry.passwordChangedAt > 0),
  };
}

export async function parseImportFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const magic = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (name.endsWith('.1pux') || magic) return parseOnePassword1pux(buffer);
  const text = new TextDecoder().decode(buffer);
  if (name.endsWith('.json') || /^\s*{/.test(text)) return parseBitwardenJson(text);
  throw new Error('请选择 CSV、Bitwarden JSON 或 1PUX 文件');
}
