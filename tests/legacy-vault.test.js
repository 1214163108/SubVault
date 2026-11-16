import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesToBase64,
  createKdfParams,
  deriveKey,
  encryptJSON,
  randomBytes,
} from '../src/lib/crypto.js';

const AAD = 'subvault:vault:v1';
const password = 'legacy master password';
const local = new Map();
const session = new Map();
let messageListener = null;

// Build a vault exactly like the earlier SHA-256 build did.
const legacySalt = bytesToBase64(randomBytes(16));
const legacyKey = await deriveKey(password, legacySalt, 120_000, 'SHA-256');
const legacyData = { version: 1, entries: [], createdAt: 1, updatedAt: 1 };
const legacyBox = await encryptJSON(legacyKey, legacyData, AAD);
local.set('vault', {
  v: 1,
  kdf: { algo: 'PBKDF2-SHA256', salt: legacySalt, iterations: 120_000 },
  box: legacyBox,
  createdAt: 1,
  updatedAt: 1,
});
local.set('settings', { autoLockMinutes: 15 });

function area(map) {
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (map.has(item)) result[item] = structuredClone(map.get(item));
      }
      return result;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, structuredClone(value));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) map.delete(item);
    },
  };
}

globalThis.chrome = {
  runtime: {
    id: 'legacy-test',
    lastError: undefined,
    getURL: (relative) => `chrome-extension://legacy-test/${relative}`,
    onMessage: { addListener(listener) { messageListener = listener; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    openOptionsPage: async () => {},
  },
  storage: { local: area(local), session: area(session) },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  alarms: { async create() {}, onAlarm: { addListener() {} } },
  tabs: { async query() { return []; }, async sendMessage() {} },
  commands: { onCommand: { addListener() {} } },
};

await import('../src/background/service-worker.js');
await new Promise((resolve) => setTimeout(resolve, 50));

function send(message) {
  return new Promise((resolve) => {
    messageListener(
      message,
      {
        id: 'legacy-test',
        url: 'chrome-extension://legacy-test/src/popup/popup.html',
      },
      resolve,
    );
  });
}

test('legacy SHA-256 vault unlocks and upgrades to v4 with Argon2id VaultKey', async () => {
  const result = await send({ type: 'SV_UNLOCK', password });
  assert.equal(result.ok, true);
  assert.equal(result.upgradedKdf, true);
  assert.equal(result.migrated, true);
  assert.equal(result.format, 4);

  const blob = local.get('vault');
  assert.equal(blob.v, 4);
  assert.equal(blob.cipher, 'AES-GCM');
  assert.ok(blob.wrappedKey?.iv);
  assert.ok(blob.wrappedKey?.data);
  assert.equal(blob.kdf.algo, 'ARGON2ID');
  assert.equal(blob.kdf.memorySize, 65536);
  assert.equal(blob.kdf.iterations, 3);
  assert.equal(atob(blob.kdf.salt).length, 32);
  assert.notEqual(blob.kdf.salt, legacySalt);

  await send({ type: 'SV_LOCK' });
  const second = await send({ type: 'SV_UNLOCK', password });
  assert.equal(second.ok, true);
  assert.equal(second.upgradedKdf, false);
  assert.equal(second.migrated, false);
  assert.equal(second.format, 4);

  const status = await send({ type: 'SV_GET_MIGRATION_STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.currentVersion, 4);
  assert.equal(status.exists, true);
  assert.equal(status.fromVersion, 1);

  const rollback = await send({ type: 'SV_ROLLBACK_MIGRATION', password });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.version, 1);
  assert.equal(local.get('vault').v, 1);
  assert.equal(local.has('vaultBackup:default'), false);

  const remigrate = await send({ type: 'SV_UNLOCK', password });
  assert.equal(remigrate.ok, true);
  assert.equal(remigrate.migrated, true);
  assert.equal(local.get('vault').v, 4);

  const boxBefore = structuredClone(local.get('vault').box);
  const wrappedBefore = local.get('vault').wrappedKey;
  const nextPassword = 'New-Vault-Key-2026!Qm7#';
  const changed = await send({
    type: 'SV_CHANGE_MASTER',
    currentPassword: password,
    newPassword: nextPassword,
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.rewrapped, true);
  const afterRewrap = local.get('vault');
  assert.equal(afterRewrap.v, 4);
  assert.deepEqual(afterRewrap.box, boxBefore);
  assert.notDeepEqual(afterRewrap.wrappedKey, wrappedBefore);

  await send({ type: 'SV_LOCK' });
  const oldRejected = await send({ type: 'SV_UNLOCK', password });
  assert.equal(oldRejected.ok, false);
  const newAccepted = await send({ type: 'SV_UNLOCK', password: nextPassword });
  assert.equal(newAccepted.ok, true);
  assert.equal(newAccepted.migrated, false);
});
