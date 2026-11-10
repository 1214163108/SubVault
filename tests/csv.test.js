import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvToEntries,
  entriesToCsv,
  parseDelimited,
  parseTimestamp,
} from '../src/lib/csv.js';

const FALLBACK = Date.UTC(2024, 0, 2, 3, 4, 5);

test('Chrome CSV without timestamps uses the file modification time', () => {
  const csv = [
    'name,url,username,password,note',
    'Mail,https://mail.example.com/login,me@example.com,secret,"hello, world"',
  ].join('\r\n');
  const result = csvToEntries(csv, { fallbackTime: FALLBACK });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].host, 'mail.example.com');
  assert.equal(result.entries[0].username, 'me@example.com');
  assert.equal(result.entries[0].passwordChangedAt, FALLBACK);
  assert.equal(result.hasTimestamps, false);
  assert.equal(result.entries[0].notes, 'hello, world');
});

test('Firefox CSV timestamps (milliseconds) are parsed', () => {
  const changed = Date.UTC(2023, 5, 1, 12, 0, 0);
  const csv = [
    'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged',
    `https://example.com,user,pw,,,guid,${changed - 1000},${changed},${changed}`,
  ].join('\n');
  const result = csvToEntries(csv);
  assert.equal(result.hasTimestamps, true);
  assert.equal(result.entries[0].passwordChangedAt, changed);
});

test('seconds, milliseconds and microseconds are normalized', () => {
  assert.equal(parseTimestamp('1700000000'), 1700000000000);
  assert.equal(parseTimestamp('1700000000000'), 1700000000000);
  assert.equal(parseTimestamp('1700000000000000'), 1700000000000);
  assert.equal(parseTimestamp('2024-05-01 10:00:00'), new Date('2024-05-01T10:00:00').getTime());
  assert.equal(parseTimestamp('not-a-date'), null);
});

test('quoted fields, escaped quotes and embedded newlines survive parsing', () => {
  const csv = 'a,b\r\n"hello, ""world""","line1\nline2"\r\n';
  const rows = parseDelimited(csv);
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['hello, "world"', 'line1\nline2'],
  ]);
});

test('same host and account with different passwords are both kept for merging', () => {
  const csv = [
    'name,url,username,password,note',
    'Old,https://example.com,u,old,',
    'New,https://example.com,u,new,',
  ].join('\n');
  const result = csvToEntries(csv, { fallbackTime: FALLBACK });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.password),
    ['old', 'new'],
  );
});

test('CSV export keeps Chrome-compatible columns and escapes data', () => {
  const csv = entriesToCsv([
    {
      title: 'A, B',
      host: 'example.com',
      username: 'u"x',
      password: 'p,w',
      notes: 'line\nbreak',
    },
  ]);
  assert.ok(csv.startsWith('\uFEFFname,url,username,password,note'));
  assert.ok(csv.includes('"A, B"'));
  assert.ok(csv.includes('"u""x"'));
  assert.ok(csv.includes('"p,w"'));
  assert.ok(csv.includes('"line\nbreak"'));
});

test('unsupported URLs are skipped with a warning', () => {
  const result = csvToEntries(
    'name,url,username,password\nAndroid,android://abc,u,p\nChrome,chrome://settings,u,p\n',
    { fallbackTime: FALLBACK },
  );
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped, 2);
});
