import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHostIsolated,
  matchesHost,
  normalizeDomainList,
  normalizePort,
  siteKeyFor,
  suggestBaseDomain,
} from '../src/lib/domain.js';

test('suggestBaseDomain handles common multi-part suffixes', () => {
  assert.equal(suggestBaseDomain('mail.example.com'), 'example.com');
  assert.equal(suggestBaseDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(suggestBaseDomain('project.github.io'), 'project.github.io');
  assert.equal(suggestBaseDomain('bucket.s3.amazonaws.com'), 'bucket.s3.amazonaws.com');
  assert.equal(suggestBaseDomain('localhost'), 'localhost');
  assert.equal(suggestBaseDomain('127.0.0.1'), '127.0.0.1');
});

test('default policy shares credentials across every subdomain', () => {
  const entry = { host: 'mail.example.com', username: 'me' };
  assert.equal(siteKeyFor('mail.example.com'), 'example.com');
  assert.equal(siteKeyFor('drive.example.com'), 'example.com');
  assert.equal(matchesHost(entry, 'example.com'), true);
  assert.equal(matchesHost(entry, 'drive.example.com'), true);
  assert.equal(matchesHost(entry, 'other.example.net'), false);
});

test('configured main domain isolates every subdomain', () => {
  const isolated = ['example.com'];
  assert.equal(siteKeyFor('mail.example.com', isolated), 'mail.example.com');
  assert.equal(siteKeyFor('drive.example.com', isolated), 'drive.example.com');
  assert.equal(isHostIsolated('a.b.example.com', isolated), true);
  assert.equal(isHostIsolated('notexample.com', isolated), false);

  const entry = { host: 'mail.example.com' };
  assert.equal(matchesHost(entry, 'mail.example.com', isolated), true);
  assert.equal(matchesHost(entry, 'a.mail.example.com', isolated), false);
  assert.equal(matchesHost(entry, 'drive.example.com', isolated), false);
  assert.equal(matchesHost(entry, 'example.com', isolated), false);
});

test('subtree isolation can be configured on a subdomain itself', () => {
  const isolated = ['mail.example.com'];
  assert.equal(isHostIsolated('mail.example.com', isolated), true);
  assert.equal(isHostIsolated('a.mail.example.com', isolated), true);
  assert.equal(isHostIsolated('drive.example.com', isolated), false);
  assert.equal(siteKeyFor('drive.example.com', isolated), 'example.com');
});

test('normalizeDomainList validates, lowercases and de-duplicates', () => {
  assert.deepEqual(
    normalizeDomainList([' Example.COM ', 'example.com', 'https://mail.example.com/x', 'bad host']),
    ['example.com', 'mail.example.com'],
  );
  assert.deepEqual(normalizeDomainList(undefined), []);
});

test('full PSL wildcard and exception rules', () => {
  assert.equal(suggestBaseDomain('a.ck'), 'a.ck');
  assert.equal(suggestBaseDomain('b.a.ck'), 'b.a.ck');
  assert.equal(suggestBaseDomain('www.ck'), 'www.ck');
  assert.equal(suggestBaseDomain('mail.example.co.uk'), 'example.co.uk');
});

test('localhost/IP ports can be isolated without affecting normal domains', () => {
  assert.equal(normalizePort('3000'), '3000');
  assert.equal(normalizePort('abc'), '');
  assert.equal(
    siteKeyFor('localhost', [], { port: '3000', portIsolation: true }),
    'localhost:3000',
  );
  assert.equal(
    siteKeyFor('127.0.0.1', [], { port: '3000', portIsolation: true }),
    '127.0.0.1:3000',
  );
  assert.equal(
    siteKeyFor('example.com', [], { port: '3000', portIsolation: true }),
    'example.com',
  );
  assert.equal(
    matchesHost({ host: 'localhost', port: '3000' }, 'localhost', [], {
      port: '3000',
      portIsolation: true,
    }),
    true,
  );
  assert.equal(
    matchesHost({ host: 'localhost', port: '3000' }, 'localhost', [], {
      port: '3001',
      portIsolation: true,
    }),
    false,
  );
});
