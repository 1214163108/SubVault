import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharePackage,
  defaultShareExpiry,
  openSharePackage,
  shareableEntry,
} from '../src/lib/share.js';

const entries = [
  {
    id: 'a',
    host: 'example.com',
    username: 'alice',
    password: 'alice-secret',
    notes: 'note',
    tags: ['work'],
  },
  {
    id: 'b',
    host: 'example.org',
    username: 'bob',
    password: 'bob-secret',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  },
];

test('share package roundtrip keeps selected secrets', async () => {
  const pkg = await createSharePackage(entries, {
    password: 'share-pass-123',
    expiresAt: defaultShareExpiry(1),
  });
  assert.equal(pkg.format, 'subvault-share');
  const opened = await openSharePackage(pkg, 'share-pass-123');
  assert.equal(opened.entries.length, 2);
  assert.equal(opened.entries[0].username, 'alice');
  assert.equal(opened.entries[0].password, 'alice-secret');
  assert.equal(opened.entries[1].totpSecret, 'JBSWY3DPEHPK3PXP');
});

test('wrong share password fails', async () => {
  const pkg = await createSharePackage(entries, { password: 'share-pass-123' });
  await assert.rejects(() => openSharePackage(pkg, 'wrong-pass-123'), /分享密码错误/);
});

test('expired share package fails before decryption', async () => {
  const pkg = await createSharePackage(entries, { password: 'share-pass-123' });
  pkg.expiresAt = Date.now() - 1000;
  await assert.rejects(() => openSharePackage(pkg, 'share-pass-123'), /已过期/);
});

test('changing the expiry cannot bypass the bound KDF', async () => {
  const pkg = await createSharePackage(entries, { password: 'share-pass-123' });
  pkg.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => openSharePackage(pkg, 'share-pass-123'), /密码错误/);
});

test('shareableEntry drops vault metadata and clamps tags', () => {
  const result = shareableEntry({
    id: 'secret-id',
    host: 'example.com',
    password: 'x',
    tags: Array.from({ length: 50 }, (_, index) => `t${index}`),
    updatedAt: 123,
  });
  assert.equal(result.id, undefined);
  assert.equal(result.updatedAt, undefined);
  assert.equal(result.tags.length, 20);
  assert.equal(result.totpDigits, 6);
});

test('empty or invalid share input is rejected', async () => {
  await assert.rejects(() => createSharePackage([], { password: 'share-pass-123' }));
  await assert.rejects(() => openSharePackage({ format: 'x' }, 'share-pass-123'), /不是有效/);
});
