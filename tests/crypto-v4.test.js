import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createKdfParams,
  createVaultKey,
  decryptJSON,
  decryptPayload,
  deriveKeyFromKdf,
  encryptPayload,
  unwrapVaultKey,
  wrapVaultKey,
} from '../src/lib/crypto.js';

const password = 'SubVault-V4-Test-2026!Qm7#';
const wrongPassword = 'SubVault-V4-Wrong-2026!Qm7#';

test('v4 wraps and unwraps the VaultKey with the master-derived KEK', async () => {
  const kdf = createKdfParams();
  const kek = await deriveKeyFromKdf(password, kdf);
  const vaultKey = await createVaultKey();
  const wrapped = await wrapVaultKey(kek, vaultKey);

  assert.equal(typeof wrapped.iv, 'string');
  assert.equal(typeof wrapped.data, 'string');

  const unwrapped = await unwrapVaultKey(kek, wrapped);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped));
  assert.equal(raw.length, 32);
});

test('v4 refuses the wrong master password', async () => {
  const kdf = createKdfParams();
  const kek = await deriveKeyFromKdf(password, kdf);
  const vaultKey = await createVaultKey();
  const wrapped = await wrapVaultKey(kek, vaultKey);
  const wrongKek = await deriveKeyFromKdf(wrongPassword, kdf);

  await assert.rejects(() => unwrapVaultKey(wrongKek, wrapped), /主密码错误/);
});

test('v4 payload uses a different AAD from the legacy payload', async () => {
  const kdf = createKdfParams();
  const kek = await deriveKeyFromKdf(password, kdf);
  const vaultKey = await createVaultKey();
  const payload = { entries: [{ username: 'alice' }], updatedAt: 1 };
  const box = await encryptPayload(vaultKey, payload);
  assert.deepEqual(await decryptPayload(vaultKey, box), payload);

  await assert.rejects(
    async () => {
      const legacy = await import('../src/lib/crypto.js');
      return legacy.decryptJSON(vaultKey, box, 'subvault:vault:v1');
    },
    /主密码错误/,
  );
});
