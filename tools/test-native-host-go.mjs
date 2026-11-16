import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('.tmp', { recursive: true });
const dir = fs.mkdtempSync(path.join('.tmp', 'subvault-go-host-'));
const bin = path.resolve(process.env.HOST_BIN || 'dist/native-host/subvault-sync-windows-amd64.exe');
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
const send = (payload) => new Promise((resolve, reject) => {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ ...payload, id }), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  pending.set(id, resolve);
  host.stdin.write(Buffer.concat([header, body]));
  setTimeout(() => reject(new Error(`timeout for ${payload.type}`)), 10000);
});

const result = {};
result.ping = (await send({ type: 'ping' })).pong === true;
const status0 = await send({ type: 'status' });
result.statusPath = status0.path;
result.emptyStatus = status0.exists === false;
const published = await send({
  type: 'publish', baseRevision: 0,
  vault: { v: 1, cipher: 'test' },
  settings: { theme: 'dark' },
  ignores: ['example.net'],
});
result.publishedResponse = published;
result.published = published.ok === true && published.revision === 1;
const pulled = await send({ type: 'pull' });
result.pulledVault = pulled.vault?.v === 1;
result.pulledIgnores = pulled.ignores?.[0] === 'example.net';
const conflict = await send({ type: 'publish', baseRevision: 0, vault: { v: 2 } });
result.conflict = conflict.ok === false && conflict.conflict === true && conflict.revision === 1;
const statePath = path.join(dir, 'state.json');
result.stateWritten = fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf8')).revision === 1;
const vaultAStatus = await send({ type: 'status', vaultId: 'vault-a' });
result.vaultAEmpty = vaultAStatus.exists === false;
const vaultAPublish = await send({ type: 'publish', vaultId: 'vault-a', baseRevision: 0, vault: { v: 9 } });
result.vaultAPublished = vaultAPublish.ok === true && vaultAPublish.revision === 1;
const vaultAPull = await send({ type: 'pull', vaultId: 'vault-a' });
result.vaultAPulled = vaultAPull.vault?.v === 9;
const defaultPull = await send({ type: 'pull' });
result.defaultUnchanged = defaultPull.vault?.v === 1;
result.vaultAFile = fs.existsSync(path.join(dir, 'vault-vault-a.json'));
result.pass = Object.values(result).every(Boolean);
console.log(JSON.stringify(result, null, 2));
host.kill();
await new Promise((resolve) => host.on('exit', resolve));
fs.rmSync(dir, { recursive: true, force: true });
if (!result.pass) process.exit(1);
