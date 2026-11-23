import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_FILE_BYTES,
  KEY_FILE_EXTENSION,
  createKeyFile,
  describeKeyFile,
  foldKeyFile,
  isKeyFileBytes,
  keyFileFingerprint,
  keyFileLabel,
  parseKeyFile,
} from '../src/lib/keyfile.js';
import { createSharePackage, defaultShareExpiry, openSharePackage } from '../src/lib/share.js';

const entries = [{ host: 'example.com', username: 'alice', password: 'alice-secret' }];

test('key file is a 40-byte SVKEY container', () => {
  const keyFile = createKeyFile();
  assert.equal(keyFile.bytes.length, KEY_FILE_BYTES);
  assert.equal(keyFile.bytes.length, 40);
  assert.equal(KEY_FILE_EXTENSION, 'svkey');
  assert.equal(String.fromCharCode(...keyFile.bytes.subarray(0, 5)), 'SVKEY');
  assert.equal(keyFile.bytes[5], 1);
  assert.ok(isKeyFileBytes(keyFile.bytes));
});

test('two generated key files never share a secret', () => {
  const a = createKeyFile();
  const b = createKeyFile();
  assert.notEqual(a.base64, b.base64);
});

test('parse rejects arbitrary files and truncated blobs', () => {
  assert.throws(() => parseKeyFile('aGVsbG8='), /不是有效的 SubVault 密钥文件/);
  const keyFile = createKeyFile();
  assert.throws(() => parseKeyFile(keyFile.bytes.subarray(0, 39)), /不是有效的 SubVault 密钥文件/);
  const future = new Uint8Array(keyFile.bytes);
  future[5] = 9;
  assert.throws(() => parseKeyFile(future), /不支持的密钥文件版本/);
});

test('parse accepts bytes, ArrayBuffer and base64', () => {
  const keyFile = createKeyFile();
  assert.equal(parseKeyFile(keyFile.bytes).base64, keyFile.base64);
  assert.equal(parseKeyFile(keyFile.bytes.buffer).base64, keyFile.base64);
  assert.equal(parseKeyFile(keyFile.base64).base64, keyFile.base64);
});

test('fingerprint is stable and label is human readable', async () => {
  const keyFile = createKeyFile();
  const first = await keyFileFingerprint(keyFile.base64);
  const second = await keyFileFingerprint(keyFile.base64);
  assert.equal(first, second);
  assert.equal(first.length, 16);
  assert.match(keyFileLabel(first), /^SVKEY-[0-9A-F]{8}$/);
  const described = await describeKeyFile(keyFile.bytes);
  assert.equal(described.fingerprint, first);
});

test('folding a key file changes the derived password', async () => {
  const keyFile = createKeyFile();
  const plain = await foldKeyFile('backup-pass-123');
  const folded = await foldKeyFile('backup-pass-123', keyFile.base64);
  assert.equal(plain, 'backup-pass-123');
  assert.notEqual(folded, plain);
  assert.ok(folded.startsWith('backup-pass-123\u0000kf:'));
});

test('share package with a key file requires that exact file', async () => {
  const keyFile = createKeyFile();
  const pkg = await createSharePackage(entries, {
    password: 'share-pass-123',
    expiresAt: defaultShareExpiry(1),
    keyFileBase64: keyFile.base64,
  });
  assert.equal(pkg.keyFile, true);
  assert.equal(pkg.keyFileFingerprint, await keyFileFingerprint(keyFile.base64));

  const opened = await openSharePackage(pkg, 'share-pass-123', keyFile.base64);
  assert.equal(opened.entries.length, 1);
  assert.equal(opened.entries[0].password, 'alice-secret');

  await assert.rejects(
    () => openSharePackage(pkg, 'share-pass-123'),
    /该分享文件需要配套的密钥文件才能解密/,
  );
  const other = createKeyFile();
  await assert.rejects(
    () => openSharePackage(pkg, 'share-pass-123', other.base64),
    /密钥文件与该分享文件不匹配/,
  );
});

test('share package without a key file still opens with the password alone', async () => {
  const pkg = await createSharePackage(entries, {
    password: 'share-pass-123',
    expiresAt: defaultShareExpiry(1),
  });
  assert.equal(pkg.keyFile, undefined);
  const opened = await openSharePackage(pkg, 'share-pass-123');
  assert.equal(opened.entries[0].username, 'alice');
});
