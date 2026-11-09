import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeEntries } from '../src/lib/merge.js';

function existing(overrides = {}) {
  return {
    id: 'existing-1',
    title: 'Mail',
    host: 'mail.example.com',
    username: 'me@example.com',
    password: 'old-password',
    passwordChangedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function incoming(overrides = {}) {
  return {
    title: 'Drive',
    host: 'drive.example.com',
    username: 'me@example.com',
    password: 'new-password',
    passwordChangedAt: 2000,
    url: 'https://drive.example.com/',
    ...overrides,
  };
}

test('default parent-domain rule keeps one newest password across subdomains', () => {
  const result = mergeEntries([existing()], [incoming()], { now: 3000 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].password, 'new-password');
  assert.equal(result.entries[0].passwordChangedAt, 2000);
  assert.equal(result.entries[0].host, 'mail.example.com');
  assert.equal(result.updated, 1);
  assert.equal(result.imported, 0);
});

test('isolated main domain keeps each subdomain separate', () => {
  const result = mergeEntries([existing()], [incoming()], {
    now: 3000,
    isolatedDomains: ['example.com'],
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.imported, 1);
  assert.equal(result.updated, 0);
  const drive = result.entries.find((entry) => entry.host === 'drive.example.com');
  assert.equal(drive.password, 'new-password');
  const mail = result.entries.find((entry) => entry.host === 'mail.example.com');
  assert.equal(mail.password, 'old-password');
});

test('an older import never overwrites a newer vault record', () => {
  const current = existing({ passwordChangedAt: 5000, password: 'newer' });
  const result = mergeEntries([current], [incoming({ passwordChangedAt: 2000 })], {
    now: 6000,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].password, 'newer');
  assert.equal(result.updated, 0);
});

test('imported subdomains collapse to one record under the default rule', () => {
  const result = mergeEntries(
    [],
    [
      incoming({ host: 'mail.example.com', password: 'older', passwordChangedAt: 1000 }),
      incoming({ host: 'drive.example.com', password: 'newest', passwordChangedAt: 3000 }),
    ],
    { now: 4000 },
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].password, 'newest');
  assert.equal(result.entries[0].host, 'drive.example.com');
  assert.equal(result.imported, 1);
  assert.equal(result.merged, 1);
});

test('password-only records are not merged across different hosts', () => {
  const result = mergeEntries(
    [],
    [
      incoming({ host: 'mail.example.com', username: '', password: 'p1', passwordChangedAt: 1000 }),
      incoming({ host: 'drive.example.com', username: '', password: 'p2', passwordChangedAt: 2000 }),
    ],
    { now: 3000 },
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.imported, 2);
});

test('new imported host under a shared domain adopts the existing newest password', () => {
  const current = existing({ passwordChangedAt: 6000, password: 'vault-newest' });
  const result = mergeEntries([current], [incoming({ passwordChangedAt: 2000 })], {
    now: 7000,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].password, 'vault-newest');
});

test('identical timestamps use the later row in the file', () => {
  const result = mergeEntries(
    [],
    [
      incoming({ host: 'example.com', password: 'first', passwordChangedAt: 1000 }),
      incoming({ host: 'example.com', password: 'second', passwordChangedAt: 1000 }),
    ],
    { now: 2000 },
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].password, 'second');
});
