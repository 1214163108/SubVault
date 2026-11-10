import test from 'node:test';
import assert from 'node:assert/strict';

const local = new Map();
const session = new Map();
let messageListener = null;

function area(map) {
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (map.has(item)) result[item] = structuredClone(map.get(item));
      }
      return result;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, structuredClone(value));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) map.delete(item);
    },
  };
}

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    getURL: (relative) => `chrome-extension://test-extension/${relative}`,
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    openOptionsPage: async () => {},
  },
  storage: {
    local: area(local),
    session: area(session),
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
  alarms: {
    async create() {},
    onAlarm: { addListener() {} },
  },
  tabs: {
    async query() {
      return [];
    },
    async sendMessage() {},
  },
  commands: {
    onCommand: { addListener() {} },
  },
};

await import('../src/background/service-worker.js');
await new Promise((resolve) => setTimeout(resolve, 80));

const EXT = { id: 'test-extension', url: 'chrome-extension://test-extension/src/popup/popup.html' };
const tab = (url) => ({ id: 'test-extension', tab: { id: 1, url }, url });

function send(message, sender = EXT) {
  return new Promise((resolve) => {
    assert.equal(typeof messageListener, 'function');
    messageListener(message, sender, resolve);
  });
}

test('backend integration: setup, domain policy, timestamp merge, lock', async () => {
  const status = await send({ type: 'SV_GET_STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.initialized, false);

  const setup = await send({ type: 'SV_SETUP', password: 'correct horse battery staple' });
  assert.equal(setup.ok, true);
  assert.equal(setup.unlocked, true);

  const added = await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: 'mail.example.com',
      title: 'Mail',
      username: 'alice',
      password: 'old-password',
    },
  });
  assert.equal(added.ok, true);
  assert.equal(added.updated, false);
  const entryId = added.id;

  // Default policy: a sibling subdomain sees the same account.
  let matches = await send({ type: 'SV_GET_MATCHES', host: 'drive.example.com' }, tab('https://drive.example.com/'));
  assert.equal(matches.ok, true);
  assert.equal(matches.locked, false);
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.isolated, false);
  assert.equal(matches.siteKey, 'example.com');

  // A pending save from one subdomain is visible on another subdomain under the
  // default shared-parent rule (covers login -> redirect flows).
  const pending = await send(
    { type: 'SV_CHECK_SAVE', username: 'bob', password: 'bob-password' },
    tab('https://mail.example.com/'),
  );
  assert.equal(pending.offer, true);
  const pendingOnSibling = await send({ type: 'SV_GET_PENDING' }, tab('https://drive.example.com/'));
  assert.equal(pendingOnSibling.pending.length, 1);
  await send(
    { type: 'SV_DISMISS_PENDING', id: pending.id },
    tab('https://drive.example.com/'),
  );

  // Configure example.com as isolated: every subdomain becomes its own bucket.
  let settings = await send({
    type: 'SV_SET_SETTINGS',
    settings: { isolatedDomains: ['example.com'] },
  });
  assert.equal(settings.ok, true);
  assert.deepEqual(settings.settings.isolatedDomains, ['example.com']);

  matches = await send({ type: 'SV_GET_MATCHES' }, tab('https://drive.example.com/'));
  assert.equal(matches.matches.length, 0);
  assert.equal(matches.isolated, true);
  matches = await send({ type: 'SV_GET_MATCHES' }, tab('https://mail.example.com/'));
  assert.equal(matches.matches.length, 1);

  // Back to the default shared rule for the timestamp merge test.
  await send({ type: 'SV_SET_SETTINGS', settings: { isolatedDomains: [] } });

  const fallbackTime = Date.now() + 5000;
  const importText =
    'name,url,username,password,note\nNew,https://drive.example.com,alice,new-password,';
  const preview = await send({
    type: 'SV_PREVIEW_CSV',
    text: importText,
    fileLastModified: fallbackTime,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.conflictCount, 1);
  assert.equal(preview.conflicts[0].result, 'update');
  const imported = await send({
    type: 'SV_IMPORT_CSV',
    text: importText,
    fileLastModified: fallbackTime,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported, 0);
  assert.equal(imported.updated, 1);
  assert.equal(imported.hasTimestamps, false);

  const fill = await send({ type: 'SV_FILL', id: entryId }, tab('https://drive.example.com/'));
  assert.equal(fill.ok, true);
  assert.equal(fill.password, 'new-password');

  // Now isolate again: a new subdomain must not overwrite the mail record.
  await send({ type: 'SV_SET_SETTINGS', settings: { isolatedDomains: ['example.com'] } });
  matches = await send({ type: 'SV_GET_MATCHES' }, tab('https://drive.example.com/'));
  assert.equal(matches.matches.length, 0);

  const isolatedImport = await send({
    type: 'SV_IMPORT_CSV',
    text: 'name,url,username,password,note\nDrive,https://drive.example.com,alice,drive-password,',
    fileLastModified: fallbackTime + 1000,
  });
  assert.equal(isolatedImport.ok, true);
  assert.equal(isolatedImport.imported, 1);

  matches = await send({ type: 'SV_GET_MATCHES' }, tab('https://drive.example.com/'));
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.matches[0].passwordChangedAt > fallbackTime, true);

  const listed = await send({ type: 'SV_LIST_ENTRIES' });
  assert.equal(listed.ok, true);
  assert.equal(listed.entries.length, 2);
  assert.equal(typeof listed.stats.weak, 'number');
  assert.equal(listed.entries.every((entry) => entry.passwordChangedAt > 0), true);
  assert.equal(listed.entries.some((entry) => entry.password), false);

  const clipboardSetting = await send({
    type: 'SV_SET_SETTINGS',
    settings: { clipboardClearSeconds: 45 },
  });
  assert.equal(clipboardSetting.ok, true);
  assert.equal(clipboardSetting.settings.clipboardClearSeconds, 45);

  await send({
    type: 'SV_SET_SETTINGS',
    settings: {
      siteExceptions: { 'mail.example.com': { disableSavePrompt: true, disableTakeover: true } },
    },
  });
  const withException = await send({ type: 'SV_GET_MATCHES' }, tab('https://mail.example.com/'));
  assert.equal(withException.policy.disableSavePrompt, true);
  const skippedSave = await send(
    { type: 'SV_CHECK_SAVE', username: 'alice', password: 'another-password' },
    tab('https://mail.example.com/'),
  );
  assert.equal(skippedSave.offer, false);
  await send({ type: 'SV_SET_SETTINGS', settings: { siteExceptions: {} } });

  const backup = await send({
    type: 'SV_EXPORT_BACKUP',
    backupPassword: 'independent-backup-passphrase',
  });
  assert.equal(backup.ok, true);
  assert.equal(backup.independent, true);
  const backupJson = JSON.parse(backup.backup);
  assert.equal(backupJson.format, 'subvault-backup');
  assert.equal(backupJson.version, 3);
  assert.equal(Array.isArray(backupJson.entries), false);
  assert.equal(Boolean(backupJson.box?.data), true);

  const restored = await send({
    type: 'SV_IMPORT_BACKUP',
    text: backup.backup,
    password: 'independent-backup-passphrase',
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.independent, true);

  const replaced = await send({
    type: 'SV_IMPORT_BACKUP',
    text: backup.backup,
    password: 'independent-backup-passphrase',
    mode: 'replace',
    restoreSettings: true,
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.total >= 1, true);

  const wrongBackup = await send({
    type: 'SV_IMPORT_BACKUP',
    text: backup.backup,
    password: 'wrong-backup-passphrase',
  });
  assert.equal(wrongBackup.ok, false);

  const csvWithoutPassword = await send({ type: 'SV_EXPORT_CSV' });
  assert.equal(csvWithoutPassword.ok, false);
  const csv = await send({ type: 'SV_EXPORT_CSV', password: 'correct horse battery staple' });
  assert.equal(csv.ok, true);
  assert.ok(csv.csv.includes('mail.example.com'));

  await send({ type: 'SV_SET_SETTINGS', settings: { isolatedDomains: [] } });
  const duplicates = await send({ type: 'SV_FIND_DUPLICATES' });
  assert.equal(duplicates.ok, true);
  assert.equal(duplicates.groups.length, 1);
  const merged = await send({ type: 'SV_MERGE_DUPLICATES', key: duplicates.groups[0].key });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, 1);

  const afterMerge = await send({ type: 'SV_LIST_ENTRIES' });
  const finalEntry = afterMerge.entries[0];
  const beforeUpdate = await send(
    { type: 'SV_FILL', id: finalEntry.id },
    tab(`https://${finalEntry.host}/`),
  );
  const previousPassword = beforeUpdate.password;
  const updated = await send({
    type: 'SV_UPDATE_ENTRY',
    entry: {
      id: finalEntry.id,
      host: finalEntry.host,
      title: finalEntry.title,
      username: finalEntry.username,
      password: 'history-new-password',
      notes: 'with history',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.passwordChanged, true);

  const history = await send({ type: 'SV_GET_HISTORY', id: finalEntry.id });
  assert.equal(history.ok, true);
  assert.equal(history.history.length, 1);

  const totp = await send({ type: 'SV_GET_TOTP_CODE', id: finalEntry.id });
  assert.equal(totp.ok, true);
  assert.equal(/^\d{6}$/.test(totp.code), true);

  const restoredHistory = await send({
    type: 'SV_RESTORE_HISTORY',
    id: finalEntry.id,
    index: 0,
  });
  assert.equal(restoredHistory.ok, true);
  const restoredFill = await send(
    { type: 'SV_FILL', id: finalEntry.id },
    tab(`https://${finalEntry.host}/`),
  );
  assert.equal(restoredFill.password, previousPassword);

  await send({ type: 'SV_SET_SETTINGS', settings: { portIsolation: true } });
  const localCreated = await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: 'localhost',
      port: '3000',
      title: 'Local',
      username: 'dev',
      password: 'local-password',
    },
  });
  assert.equal(localCreated.ok, true);
  const otherPort = await send(
    { type: 'SV_GET_MATCHES' },
    tab('http://localhost:3001/'),
  );
  assert.equal(otherPort.matches.length, 0);
  const samePort = await send(
    { type: 'SV_GET_MATCHES' },
    tab('http://localhost:3000/'),
  );
  assert.equal(samePort.matches.length, 1);
  await send({ type: 'SV_SET_SETTINGS', settings: { portIsolation: false } });
  const sharedPort = await send(
    { type: 'SV_GET_MATCHES' },
    tab('http://localhost:3001/'),
  );
  assert.equal(sharedPort.matches.length, 1);

  await send({ type: 'SV_LOCK' });
  const locked = await send({ type: 'SV_GET_MATCHES' }, tab('https://mail.example.com/'));
  assert.equal(locked.locked, true);
  assert.equal(locked.matches.length, 0);

  const wrong = await send({ type: 'SV_UNLOCK', password: 'wrong-password' });
  assert.equal(wrong.ok, false);
  const unlocked = await send({ type: 'SV_UNLOCK', password: 'correct horse battery staple' });
  assert.equal(unlocked.ok, true);
});
