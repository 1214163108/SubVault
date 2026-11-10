import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBitwardenJson, parseOnePassword1pux } from '../src/lib/importers.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const cent = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cent.set(nameBytes, 46);
    central.push(cent);
    offset += local.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    all.set(chunk, cursor);
    cursor += chunk.length;
  }
  return all;
}

test('Bitwarden JSON imports login, folder and TOTP', () => {
  const result = parseBitwardenJson(
    JSON.stringify({
      encrypted: false,
      folders: [{ id: 'f1', name: 'Work' }],
      items: [
        {
          type: 1,
          name: 'Example',
          folderId: 'f1',
          notes: 'hello',
          login: {
            username: 'alice',
            password: 'secret',
            totp: 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP',
            uris: [{ uri: 'https://example.com/login' }],
          },
        },
        { type: 2, name: 'Note' },
      ],
    }),
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.entries[0].host, 'example.com');
  assert.equal(result.entries[0].folder, 'Work');
  assert.equal(result.entries[0].username, 'alice');
});

test('1PUX ZIP imports account, folder and tags', async () => {
  const exportData = {
    accounts: [
      {
        vaults: [
          {
            uuid: 'v1',
            name: 'Personal',
            items: [
              {
                overview: {
                  title: 'Example',
                  urls: [{ url: 'https://example.com' }],
                  tags: ['work'],
                },
                loginFields: [
                  { designation: 'username', value: 'bob' },
                  { designation: 'password', value: 'pw' },
                ],
                notes: 'note',
              },
            ],
          },
        ],
      },
    ],
  };
  const bytes = makeZip({ 'export.data': JSON.stringify(exportData) });
  const result = await parseOnePassword1pux(bytes);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].host, 'example.com');
  assert.equal(result.entries[0].username, 'bob');
  assert.equal(result.entries[0].folder, 'Personal');
  assert.deepEqual(result.entries[0].tags, ['work']);
});
