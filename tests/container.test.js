import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTAINER_EXTENSION,
  CONTAINER_MAGIC,
  CONTAINER_VERSION,
  isContainerBytes,
  isLegacyJson,
  packContainer,
  unpackContainer,
} from '../src/lib/container.js';

const SAMPLE = {
  app: 'SubVault',
  format: 'subvault-backup',
  version: 4,
  box: { iv: 'AAAA', data: 'BBBB' },
  note: '这是一段会被压缩的 JSON',
};

test('container: header carries magic, version and gzip flag', async () => {
  const bytes = await packContainer(SAMPLE);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(CONTAINER_EXTENSION, 'svbak');
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), CONTAINER_MAGIC);
  assert.equal(bytes[5], CONTAINER_VERSION);
  assert.equal(bytes[6] & 1, 1, 'payload should be gzip compressed');
  assert.equal(isContainerBytes(bytes), true);
});

test('container: renaming to .txt still yields binary, never readable JSON', async () => {
  const bytes = await packContainer(SAMPLE);
  const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  assert.equal(asText.trimStart().startsWith('{'), false);
  assert.equal(asText.includes('"format"'), false);
  assert.equal(asText.includes('subvault-backup'), false);
  assert.equal(isLegacyJson(bytes), false);
});

test('container: round trip preserves the payload', async () => {
  const bytes = await packContainer(SAMPLE);
  assert.deepEqual(await unpackContainer(bytes), SAMPLE);
});

test('container: accepts ArrayBuffer and typed array views', async () => {
  const bytes = await packContainer(SAMPLE);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.deepEqual(await unpackContainer(buffer), SAMPLE);
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 4);
  const view = new Uint8Array(padded.buffer, 4, bytes.length);
  assert.deepEqual(await unpackContainer(view), SAMPLE);
});

test('container: rejects foreign files with a clear message', async () => {
  await assert.rejects(
    () => unpackContainer(new TextEncoder().encode('username,password\nfoo,bar\n')),
    /不是 SubVault 私有导出文件/,
  );
});

test('container: rejects a corrupted JSON body', async () => {
  const bytes = await packContainer('{"ok":true}');
  const broken = bytes.slice();
  broken[broken.length - 1] ^= 0xff;
  await assert.rejects(() => unpackContainer(broken));
});

test('container: rejects an unsupported container version', async () => {
  const bytes = await packContainer(SAMPLE);
  const bumped = bytes.slice();
  bumped[5] = 9;
  await assert.rejects(() => unpackContainer(bumped), /版本不受支持/);
});

test('container: still reads legacy plain-JSON backups', async () => {
  const legacy = new TextEncoder().encode(JSON.stringify(SAMPLE, null, 2));
  assert.equal(isLegacyJson(legacy), true);
  assert.deepEqual(await unpackContainer(legacy), SAMPLE);
});

test('container: legacy detection tolerates a UTF-8 BOM and leading whitespace', async () => {
  const body = new TextEncoder().encode(JSON.stringify(SAMPLE));
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(body, 3);
  assert.equal(isLegacyJson(withBom), true);
  assert.deepEqual(await unpackContainer(withBom), SAMPLE);
});

test('container: compressed payload is meaningfully smaller for repetitive data', async () => {
  const repetitive = { rows: Array.from({ length: 400 }, () => 'same-value-repeat') };
  const plain = new TextEncoder().encode(JSON.stringify(repetitive));
  const packed = await packContainer(repetitive);
  assert.ok(packed.length < plain.length / 4, `${packed.length} vs ${plain.length}`);
});
