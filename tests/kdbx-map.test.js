import test from 'node:test';
import assert from 'node:assert/strict';
import { collectKdbxRows, kdbxFieldText, mapKdbxEntry } from '../src/lib/kdbx-map.js';

function fakeEntry({ fields = {}, tags = [], history = [], binaries = new Map(), lastModTime = 0 } = {}) {
  return {
    fields: new Map(Object.entries(fields)),
    tags,
    history,
    binaries,
    times: { lastModTime },
  };
}

test('kdbxFieldText reads plain strings and protected values', () => {
  const entry = fakeEntry({ fields: { Title: 'Example', Password: { getText: () => 's3cret' } } });
  assert.equal(kdbxFieldText(entry, 'Title'), 'Example');
  assert.equal(kdbxFieldText(entry, 'Password'), 's3cret');
  assert.equal(kdbxFieldText(entry, 'Missing'), '');
});

test('mapKdbxEntry keeps folder, tags, custom fields and attachment names', () => {
  const entry = fakeEntry({
    fields: {
      Title: 'Mail',
      UserName: 'alice@example.com',
      Password: 'mail-secret',
      URL: 'https://mail.example.com/login',
      Notes: 'Primary mailbox',
      'Account ID': 'A-42',
    },
    tags: ['work', 'mail'],
    binaries: new Map([['recovery-codes.txt', { ref: 'abc' }]]),
    lastModTime: 1700000000000,
  });
  const row = mapKdbxEntry(entry, { groupPath: 'Work/Email' });
  assert.equal(row.host, 'mail.example.com');
  assert.equal(row.username, 'alice@example.com');
  assert.equal(row.password, 'mail-secret');
  assert.equal(row.folder, 'Work/Email');
  assert.deepEqual(row.tags, ['work', 'mail']);
  assert.equal(row.passwordChangedAt, 1700000000000);
  assert.match(row.notes, /Primary mailbox/);
  assert.match(row.notes, /Account ID: A-42/);
  assert.match(row.notes, /recovery-codes\.txt/);
});

test('mapKdbxEntry maps passkey metadata without exposing it in notes', () => {
  const row = mapKdbxEntry(
    fakeEntry({
      fields: {
        Password: 'x',
        URL: 'https://example.com',
        passkey_credential_id: 'cred-1',
        passkey_rp_id: 'example.com',
        passkey_username: 'alice',
        passkey_note: 'Security key',
      },
    }),
  );
  assert.deepEqual(row.passkey, {
    credentialId: 'cred-1',
    rpId: 'example.com',
    username: 'alice',
    note: 'Security key',
  });
  assert.doesNotMatch(row.notes, /cred-1/);
});

test('mapKdbxEntry drops entries without URL or password', () => {
  assert.equal(mapKdbxEntry(fakeEntry({ fields: { Password: 'x' } })), null);
  assert.equal(mapKdbxEntry(fakeEntry({ fields: { URL: 'https://example.com' } })), null);
});

test('mapKdbxEntry accepts bare host URLs and keeps port/url', () => {
  const row = mapKdbxEntry(
    fakeEntry({ fields: { Password: 'x', URL: 'example.org:8443/login' } }),
  );
  assert.equal(row.host, 'example.org');
  assert.equal(row.port, '8443');
  assert.match(row.url, /^https:\/\/example\.org:8443\//);
});

test('mapKdbxEntry maps TOTP Seed settings and otpauth URI', () => {
  const seeded = mapKdbxEntry(
    fakeEntry({
      fields: {
        Password: 'x',
        URL: 'https://example.com',
        'TOTP Seed': 'JBSWY3DPEHPK3PXP',
        'TOTP Settings': '60;8;SHA256',
      },
    }),
  );
  assert.equal(seeded.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(seeded.totpDigits, 8);
  assert.equal(seeded.totpPeriod, 60);
  assert.equal(seeded.totpAlgorithm, 'SHA256');

  const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&digits=6&period=30';
  const fromUri = mapKdbxEntry(
    fakeEntry({ fields: { Password: 'x', URL: 'https://example.com', otp: uri } }),
  );
  assert.equal(fromUri.totpSecret, uri);
});

test('mapKdbxEntry turns password history into rows capped at five', () => {
  const history = Array.from({ length: 7 }, (_, index) => ({
    fields: new Map([
      ['Password', `old-${index}`],
      ['UserName', 'alice'],
    ]),
    times: { lastModTime: 1000 + index },
  }));
  const row = mapKdbxEntry(
    fakeEntry({
      fields: { Password: 'current', URL: 'https://example.com', UserName: 'alice' },
      history,
    }),
  );
  assert.equal(row.history.length, 5);
  assert.equal(row.history[0].password, 'old-0');
  assert.equal(row.history[0].changedAt, 1000);
});

test('collectKdbxRows recurses groups and joins folder paths', () => {
  const root = {
    name: 'Root',
    entries: [fakeEntry({ fields: { Password: 'root', URL: 'https://root.example' } })],
    groups: [
      {
        name: 'Work',
        entries: [],
        groups: [
          {
            name: 'Mail',
            entries: [
              fakeEntry({ fields: { Password: 'mail', URL: 'https://mail.example' } }),
            ],
            groups: [],
          },
        ],
      },
    ],
  };
  const rows = collectKdbxRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].folder, 'Work/Mail');
  assert.equal(rows[0].folder, '');
});
