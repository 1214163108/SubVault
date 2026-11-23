import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

fs.mkdirSync('.tmp', { recursive: true });
const dir = fs.mkdtempSync(path.join('.tmp', 'subvault-webdav-host-'));
const bin = path.resolve(process.env.HOST_BIN || 'dist/native-host/subvault-sync-windows-amd64.exe');

const user = 'alice';
const pass = 'webdav-pass';
let exists = false;
let collection = false;
let body = Buffer.alloc(0);
let etag = '"v0"';
let counter = 0;
const archives = new Map();

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="subvault"' });
    res.end('auth required');
    return;
  }
  const archiveMatch = /^\/dav\/subvault\/([^/]+\.json)$/.exec(req.url);
  if (archiveMatch && archiveMatch[1] !== 'state.json') {
    if (req.method === 'DELETE') {
      if (!archives.delete(archiveMatch[1])) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'PUT') { res.writeHead(405); res.end('method not allowed'); return; }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.headers['if-none-match'] === '*' && archives.has(archiveMatch[1])) { res.writeHead(412); res.end('exists'); return; }
      archives.set(archiveMatch[1], Buffer.concat(chunks));
      res.writeHead(201); res.end();
    });
    return;
  }
  if (req.url === '/dav/subvault' && req.method === 'PROPFIND') {
    const items = [];
    if (exists) items.push({ name: 'state.json', size: body.length, modified: new Date(2026, 0, 1, 0, 0, 0).toUTCString() });
    for (const [name, buf] of archives) {
      items.push({ name, size: buf.length, modified: new Date(2026, 0, 2, 0, 0, 0).toUTCString() });
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${items
      .map(
        (item) =>
          `<d:response><d:href>/dav/subvault/${item.name}</d:href><d:propstat><d:prop><d:getlastmodified>${item.modified}</d:getlastmodified><d:getcontentlength>${item.size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      )
      .join('')}</d:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
    return;
  }
  if (req.url !== '/dav/subvault/state.json' && req.url !== '/dav/subvault') {
    res.writeHead(404); res.end('not found'); return;
  }
  if (req.method === 'MKCOL') {
    collection = true; res.writeHead(201); res.end(); return;
  }
  if (req.method === 'GET' && !collection) { res.writeHead(404); res.end('missing'); return; }
  if (req.method !== 'GET' && !collection) { res.writeHead(409); res.end('no collection'); return; }
  if (req.method === 'GET') {
    if (!exists) { res.writeHead(404); res.end('missing'); return; }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
    res.end(body); return;
  }
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const next = Buffer.concat(chunks);
      if (req.headers['if-none-match'] === '*' && exists) { res.writeHead(412); res.end('exists'); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412); res.end('etag mismatch'); return; }
      body = next; exists = true; counter += 1; etag = `"v${counter}"`;
      res.writeHead(201, { ETag: etag }); res.end();
    });
    return;
  }
  res.writeHead(405); res.end('method not allowed');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/dav`;

const host = spawn(bin, [], { env: { ...process.env, SUBVAULT_SYNC_DIR: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = Buffer.alloc(0);
const pending = new Map();
host.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    if (message.type === 'change') continue;
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});
let nextId = 1;
const send = (payload, timeout = 15000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const payloadBody = Buffer.from(JSON.stringify({ ...payload, id }), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32LE(payloadBody.length, 0);
  pending.set(id, resolve);
  host.stdin.write(Buffer.concat([header, payloadBody]));
  setTimeout(() => { pending.delete(id); reject(new Error(`timeout for ${payload.type}`)); }, timeout);
});

const config = { url: base, username: user, password: pass };
const result = {};
result.ping = (await send({ type: 'ping' })).pong === true;
result.emptyStatus = (await send({ type: 'webdav-status', config })).exists === false;
const first = await send({ type: 'webdav-push', config, baseRevision: 0, etag: '', backupName: 'subvault-20260101-000000.json', vault: { v: 1, cipher: 'AES-GCM' }, settings: { theme: 'dark' }, ignores: ['example.net'] });
result.firstPush = first.ok === true && first.revision === 1 && typeof first.etag === 'string' && first.etag.length > 0;
result.backupName = first.name === 'subvault-20260101-000000.json' && archives.has('subvault-20260101-000000.json') && archives.get('subvault-20260101-000000.json').length > 0;
result.noArchiveError = first.archiveError === '';
const etag1 = first.etag;
result.notModified = (await send({ type: 'webdav-status', config, etag: etag1 })).notModified === true;
const pulled = await send({ type: 'webdav-pull', config });
result.pullVault = pulled.vault?.v === 1 && pulled.revision === 1 && pulled.ignores?.[0] === 'example.net';
const full = await send({ type: 'webdav-status', config });
result.statusRevision = full.revision === 1 && typeof full.updatedAt === 'number';
result.badPassword = (await send({ type: 'webdav-status', config: { ...config, password: 'wrong' } })).error?.includes('认证失败') === true;
result.staleEtag = (await send({ type: 'webdav-push', config, baseRevision: 1, etag: '"v0"', vault: { v: 2 } })).conflict === true;
const second = await send({ type: 'webdav-push', config, baseRevision: 1, etag: etag1, vault: { v: 2, cipher: 'AES-GCM' } });
result.secondPush = second.ok === true && second.revision === 2 && second.etag !== etag1;
const pulled2 = await send({ type: 'webdav-pull', config });
result.pullSecond = pulled2.vault?.v === 2 && pulled2.revision === 2;
const history = await send({ type: 'webdav-history', config });
result.historyCount = history.ok === true && history.count === 1 && history.archives?.[0]?.name === 'subvault-20260101-000000.json';
result.historySize = Number(history.archives?.[0]?.size) > 0 && typeof history.archives?.[0]?.modified === 'number';
const noopPrune = await send({ type: 'webdav-prune', config, keep: 0, olderThanDays: 0 });
result.pruneNoop = noopPrune.ok === true && noopPrune.deleted.length === 0 && typeof noopPrune.skipped === 'string' && noopPrune.skipped.length > 0;
const keepZero = await send({ type: 'webdav-prune', config, keep: 1, olderThanDays: 0 });
result.pruneKeep = keepZero.ok === true && keepZero.deleted.length === 0 && keepZero.remaining === 1;
const pruneAll = await send({ type: 'webdav-prune', config, keep: 0, olderThanDays: 1 });
result.pruneDeleted =
  pruneAll.ok === true &&
  pruneAll.deleted.length === 1 &&
  pruneAll.remaining === 0 &&
  !archives.has('subvault-20260101-000000.json');
result.insecureRejected = (await send({ type: 'webdav-status', config: { ...config, url: 'http://example.com/dav' } })).error?.includes('HTTPS') === true;
result.pass = Object.values(result).every(Boolean);
console.log(JSON.stringify(result, null, 2));

host.kill();
await new Promise((resolve) => host.on('exit', resolve));
server.close();
fs.rmSync(dir, { recursive: true, force: true });
if (!result.pass) process.exit(1);
