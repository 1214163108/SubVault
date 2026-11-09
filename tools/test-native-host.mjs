import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync('D:\\DeepSeek\\Chrome\\.tmp-host\\host-');
const host = path.resolve(import.meta.dirname, '..', 'native-host', 'SubVaultSync.exe');
const child = spawn(host, [], {
  env: { ...process.env, SUBVAULT_SYNC_DIR: path.join(dir, 'sync') },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
const messages = [];
const waiters = [];
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  }
});

function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  child.stdin.write(Buffer.concat([header, payload]));
}

function next(timeout = 3000) {
  if (messages.length) return Promise.resolve(messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host timeout')), timeout);
    waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function request(message) {
  send(message);
  while (true) {
    const response = await next();
    if (response.type === 'change') continue;
    return response;
  }
}

try {
  const status0 = await request({ type: 'status' });
  if (!status0.ok || status0.exists) throw new Error('unexpected initial status');

  const published = await request({
    type: 'publish',
    baseRevision: 0,
    vault: { v: 1, kdf: { salt: 'x' }, box: { iv: 'i', data: 'd' } },
    settings: { isolatedDomains: [] },
    ignores: [],
  });
  if (!published.ok || published.revision !== 1) throw new Error('publish failed');

  const status1 = await request({ type: 'status' });
  if (!status1.exists || status1.revision !== 1) throw new Error('status mismatch');

  const pulled = await request({ type: 'pull' });
  if (!pulled.ok || pulled.vault?.box?.data !== 'd') throw new Error('pull mismatch');

  const conflict = await request({
    type: 'publish',
    baseRevision: 0,
    vault: { v: 1 },
  });
  if (!conflict.conflict || conflict.revision !== 1) throw new Error('conflict not detected');

  console.log(JSON.stringify({ ok: true, status1, pulledRevision: pulled.revision, conflict }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
