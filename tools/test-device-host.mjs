import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('.tmp', { recursive: true });
const dir = fs.mkdtempSync(path.join('.tmp', 'subvault-device-host-'));
const bin = path.resolve(process.env.HOST_BIN || 'native-host/SubVaultSync.exe');
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
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
const send = (payload) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const body = Buffer.from(JSON.stringify({ ...payload, id }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    pending.set(id, resolve);
    host.stdin.write(Buffer.concat([header, body]));
    setTimeout(() => reject(new Error(`timeout for ${payload.type}`)), 10000);
  });

const key = crypto.randomBytes(32).toString('base64');
const result = {};
result.initial = await send({ type: 'device-status', vaultId: 'device-test' });
if (process.env.EXPECT_UNSUPPORTED === '1') {
  result.unsupported = result.initial.ok === false && result.initial.supported === false && /仅支持 Windows/.test(result.initial.error || '');
  result.pass = result.unsupported;
  console.log(JSON.stringify(result, null, 2));
  host.kill();
  await new Promise((resolve) => host.on('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  if (!result.pass) process.exit(1);
  process.exit(0);
}
result.initiallyMissing = result.initial.ok === true && result.initial.exists === false && result.initial.supported === true;
result.protected = await send({ type: 'device-protect', vaultId: 'device-test', key, credentialId: 'test-credential-id' });
result.protectedOk = result.protected.ok === true && result.protected.exists === true && Boolean(result.protected.createdAt);
result.status = await send({ type: 'device-status', vaultId: 'device-test' });
result.statusExists = result.status.ok === true && result.status.exists === true;
result.credentialStored = result.status.credentialId === 'test-credential-id';
result.unlocked = await send({ type: 'device-unlock', vaultId: 'device-test' });
result.unlockKeyMatches = result.unlocked.ok === true && result.unlocked.key === key;
const other = await send({ type: 'device-status', vaultId: 'other-vault' });
result.otherIsolated = other.ok === true && other.exists === false;
result.forgot = await send({ type: 'device-forget', vaultId: 'device-test' });
result.forgotten = result.forgot.ok === true && result.forgot.exists === false;
result.afterForget = await send({ type: 'device-status', vaultId: 'device-test' });
result.afterForgetMissing = result.afterForget.ok === true && result.afterForget.exists === false;
result.unlockAfterForget = await send({ type: 'device-unlock', vaultId: 'device-test' });
result.afterForgetRejected = result.unlockAfterForget.ok === false && result.unlockAfterForget.exists === false;
result.badKey = await send({ type: 'device-protect', vaultId: 'device-test', key: 'not-base64' });
result.badKeyRejected = result.badKey.ok === false;
result.files = fs.readdirSync(dir).filter((name) => name.startsWith('device')).sort();
result.pass = Object.values(result).filter((value) => typeof value === 'boolean').every(Boolean);
console.log(JSON.stringify(result, null, 2));
host.kill();
await new Promise((resolve) => host.on('exit', resolve));
fs.rmSync(dir, { recursive: true, force: true });
if (!result.pass) process.exit(1);
