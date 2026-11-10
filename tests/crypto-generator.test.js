import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KDF_HASH,
  createKdfParams,
  decryptJSON,
  deriveKey,
  encryptJSON,
  isCommonPassword,
  passwordStrength,
} from '../src/lib/crypto.js';
import { generatePassword } from '../src/lib/generator.js';

test('new KDF parameters use SHA-512 and a 32-byte random salt', () => {
  const params = createKdfParams();
  assert.equal(params.hash, KDF_HASH);
  assert.equal(params.hash, 'SHA-512');
  assert.equal(atob(params.salt).length, 32);
  assert.equal(params.iterations >= 300_000, true);
  assert.notEqual(createKdfParams().salt, params.salt);
});

test('AES-GCM roundtrip using the derived key', async () => {
  const params = createKdfParams(100_000);
  const key = await deriveKey('a strong master password', params.salt, params.iterations, params.hash);
  const box = await encryptJSON(key, { entries: [{ username: 'alice' }] }, 'test:aad');
  const decoded = await decryptJSON(key, box, 'test:aad');
  assert.deepEqual(decoded, { entries: [{ username: 'alice' }] });
  const wrongKey = await deriveKey('wrong password', params.salt, params.iterations, params.hash);
  await assert.rejects(() => decryptJSON(wrongKey, box, 'test:aad'));
});

test('common passwords are rejected by the strength hint', () => {
  assert.equal(isCommonPassword('password'), true);
  assert.equal(isCommonPassword('PASSWORD'), true);
  assert.equal(isCommonPassword('a unique master phrase'), false);
  assert.equal(passwordStrength('password').score, 0);
});

test('generator uses the expanded symbol set and requested length', () => {
  const symbols = '~!@#$%^&*()-_=+[]{};:,.?/|';
  const password = generatePassword({
    length: 40,
    lower: false,
    upper: false,
    digits: false,
    symbols: true,
  });
  assert.equal(password.length, 40);
  assert.equal([...password].every((char) => symbols.includes(char)), true);
  assert.equal(generatePassword({ length: 8 }).length, 8);
});
