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

test('legacy SHA-256 vault unlocks and upgrades to SHA-512', async () => {
  const result = await send({ type: 'SV_UNLOCK', password });
  assert.equal(result.ok, true);
  assert.equal(result.upgradedKdf, true);

  const blob = local.get('vault');
  assert.equal(blob.kdf.hash, 'SHA-512');
  assert.equal(atob(blob.kdf.salt).length, 32);
  assert.notEqual(blob.kdf.salt, legacySalt);

  await send({ type: 'SV_LOCK' });
  const second = await send({ type: 'SV_UNLOCK', password });
  assert.equal(second.ok, true);
  assert.equal(second.upgradedKdf, false);
});
