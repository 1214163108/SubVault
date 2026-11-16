import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve('.');
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subvault-kdbx-'));
const context = await chromium.launchPersistentContext('', {
  headless: false,
  acceptDownloads: true,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extensionId = worker.url().split('/')[2];
const page = await context.newPage();
await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
const send = (type, payload = {}) =>
  page.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, ...payload }), [type, payload]);

const password = 'SubVault-Test-2026!Qm7#';
await send('SV_SETUP', { password });
await send('SV_SET_SETTINGS', { settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } });
await send('SV_ADD_ENTRY', {
  entry: { host: 'example.com', username: 'alice', password: 'alice-secret-1', title: 'Example Alice', url: 'https://example.com/login' },
});
await send('SV_ADD_ENTRY', {
  entry: { host: 'example.org', username: 'bob', password: 'bob-secret-2', title: 'Example Bob', url: 'https://example.org/login' },
});
await page.reload();
await page.click('[data-section="transfer"]');

const result = {};
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.fill('#kdbxExportPassword', 'kdbx-export-pass-123');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('#kdbxExportBtn'),
]);
const file = path.join(syncDir, 'roundtrip.kdbx');
await download.saveAs(file);
result.exported = fs.existsSync(file) && fs.statSync(file).size > 0;
result.exportName = download.suggestedFilename();

// Remove entries, then import the exported file back.
const before = await send('SV_LIST_ENTRIES');
for (const entry of before.entries || []) await send('SV_DELETE_ENTRY', { id: entry.id });
await page.reload();
await page.click('[data-section="transfer"]');
result.emptied = (await send('SV_LIST_ENTRIES')).entries?.length === 0;

await page.setInputFiles('#kdbxFile', file);
await page.fill('#kdbxPassword', 'kdbx-export-pass-123');
await page.click('#kdbxImportBtn');
await page.waitForSelector('#importPreview:not([hidden])', { timeout: 30000 });
result.previewText = (await page.textContent('#importPreview'))?.slice(0, 120) || '';
await page.click('#importPreview .preview-actions .btn.primary');
await page.waitForTimeout(1500);
const after = await send('SV_LIST_ENTRIES');
result.importedCount = after.entries?.length || 0;
result.importedUsers = (after.entries || []).map((e) => `${e.host}:${e.username}`).sort();
result.importedPasswords = [];
for (const entry of after.entries || []) {
  const secret = await send('SV_GET_SECRET', { id: entry.id });
  result.importedPasswords.push(secret.password);
}
result.importedPasswords.sort();

// Wrong password should be rejected.
await page.setInputFiles('#kdbxFile', file);
await page.fill('#kdbxPassword', 'wrong-password');
await page.click('#kdbxImportBtn');
await page.waitForTimeout(1200);
result.wrongPasswordError = (await page.textContent('#kdbxError')) || '';
result.pass =
  result.exported === true &&
  result.emptied === true &&
  result.importedCount === 2 &&
  result.importedUsers.join(',') === 'example.com:alice,example.org:bob' &&
  result.importedPasswords.join(',') === 'alice-secret-1,bob-secret-2' &&
  /密码|损坏/i.test(result.wrongPasswordError) &&
  errors.length === 0;
result.pageErrors = errors;
console.log(JSON.stringify(result, null, 2));
await context.close();
if (!result.pass) process.exit(1);
