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
  sha256Hex,
} from '../src/lib/crypto.js';
import { generatePassword, generatePin } from '../src/lib/generator.js';
import { isWeakPasswordHash } from '../src/vendor/weak-passwords.js';

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

test('readable mode excludes ambiguous characters, full mode keeps them', () => {
  const readable = generatePassword({
    length: 200,
    lower: true,
    upper: true,
    digits: true,
    symbols: false,
    readable: true,
  });
  assert.equal(/[IlO01]/.test(readable), false);

  const full = generatePassword({
    length: 400,
    lower: true,
    upper: true,
    digits: true,
    symbols: false,
    readable: false,
  });
  assert.equal(/[IlO01]/.test(full), true);
});

test('PIN generation is numeric and uses the requested length', () => {
  const pin = generatePin(12);
  assert.equal(pin.length, 12);
  assert.equal(/^[0-9]+$/.test(pin), true);
  assert.equal(generatePin(4).length, 4);
});

test('offline common-password digest list matches known weak passwords', async () => {
  assert.equal(isWeakPasswordHash(await sha256Hex('password')), true);
  assert.equal(isWeakPasswordHash(await sha256Hex('123456')), true);
  assert.equal(isWeakPasswordHash(await sha256Hex('SubVault-Test-2026!Qm7#')), false);
});
