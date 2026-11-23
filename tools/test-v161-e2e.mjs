import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve('.');
const workDir = path.join(root, '.tmp', `v161-${Date.now()}`);
fs.mkdirSync(workDir, { recursive: true });
const context = await chromium.launchPersistentContext('', {
  headless: false,
  acceptDownloads: true,
  env: { ...process.env, SUBVAULT_SYNC_DIR: workDir },
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
await send('SV_SET_SETTINGS', {
  settings: {
    lockOnSystemLock: false,
    lockOnSystemIdle: false,
    autoLockMinutes: 0,
    privacyShieldOnBlur: false,
  },
});
await page.reload();
await page.click('[data-section="transfer"]');

const result = {};
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

// Build a KDBX3 vault with a key file in the extension page.
const built = await page.evaluate(async () => {
  const kdbx = window.kdbxweb;
  const credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString('kdbx3-key-pass'));
  const keyBytes = new TextEncoder().encode('subvault-demo-key-file');
  await credentials.setKeyFile(keyBytes);
  const db = kdbx.Kdbx.create(credentials, 'KDBX3 Test');
  db.setVersion(3);
  const group = db.createGroup(db.getDefaultGroup(), 'Legacy');
  const entry = db.createEntry(group);
  entry.fields.set('Title', 'KDBX3 Entry');
  entry.fields.set('UserName', 'legacy-user');
  entry.fields.set('Password', kdbx.ProtectedValue.fromString('legacy-secret'));
  entry.fields.set('URL', 'https://legacy.example.com/login');
  entry.fields.set('Notes', 'from kdbx3');
  entry.tags = ['legacy'];
  const bytes = new Uint8Array(await db.save());
  return { db: Array.from(bytes), key: Array.from(keyBytes) };
});
const dbFile = path.join(workDir, 'legacy.kdbx');
const keyFile = path.join(workDir, 'legacy.key');
fs.writeFileSync(dbFile, Buffer.from(built.db));
fs.writeFileSync(keyFile, Buffer.from(built.key));

// Missing key file must fail.
await page.setInputFiles('#kdbxFile', dbFile);
await page.fill('#kdbxPassword', 'kdbx3-key-pass');
await page.click('#kdbxImportBtn');
await page.waitForTimeout(1200);
result.missingKeyError = (await page.textContent('#kdbxError')) || '';
result.missingKeyRejected = /密码|损坏|密钥/i.test(result.missingKeyError);

// Wrong key file must fail.
await page.setInputFiles('#kdbxFile', dbFile);
await page.setInputFiles('#kdbxKeyFile', { name: 'wrong.key', mimeType: 'application/octet-stream', buffer: Buffer.from('wrong-key') });
await page.fill('#kdbxPassword', 'kdbx3-key-pass');
await page.click('#kdbxImportBtn');
await page.waitForTimeout(1200);
result.wrongKeyError = (await page.textContent('#kdbxError')) || '';

// Correct key file imports KDBX3.
await page.setInputFiles('#kdbxFile', dbFile);
await page.setInputFiles('#kdbxKeyFile', keyFile);
await page.fill('#kdbxPassword', 'kdbx3-key-pass');
await page.click('#kdbxImportBtn');
await page.waitForSelector('#importPreview:not([hidden])', { timeout: 30000 });
result.previewRows = await page.locator('#importPreview .preview-row').count();
result.checkedRows = await page.locator('#importPreview .preview-row-check:checked').count();
result.previewFolder = await page.textContent('#importPreview');
await page.click('#importPreview .preview-actions .btn.primary');
await page.waitForTimeout(1500);
const imported = await send('SV_LIST_ENTRIES');
result.importedHost = (imported.entries || []).map((entry) => entry.host);
result.importedFolder = (imported.entries || [])[0]?.folder || '';
result.importedTags = (imported.entries || [])[0]?.tags || [];

// Re-import: duplicate rows default unchecked and confirm disabled.
await page.setInputFiles('#kdbxFile', dbFile);
await page.setInputFiles('#kdbxKeyFile', keyFile);
await page.fill('#kdbxPassword', 'kdbx3-key-pass');
await page.click('#kdbxImportBtn');
await page.waitForSelector('#importPreview:not([hidden])', { timeout: 30000 });
result.duplicateChecked = await page.locator('#importPreview .preview-row-check:checked').count();
result.duplicateBadge = await page.textContent('#importPreview .preview-row-badge');
result.confirmDisabled = await page.locator('#importPreview [data-preview-confirm]').isDisabled();
await page.click('#importPreview .preview-row-check');
result.confirmEnabledAfterSelect = !(await page.locator('#importPreview [data-preview-confirm]').isDisabled());
await page.click('#importPreview .preview-actions .btn:not(.primary)');

// TOTP filter.
await send('SV_ADD_ENTRY', {
  entry: {
    host: 'otp.example',
    username: 'totp-user',
    password: 'totp-secret',
    title: 'OTP Example',
    url: 'https://otp.example/login',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  },
});
await page.reload();
await page.click('[data-section="vault"]');
await page.selectOption('#filterSelect', 'totp');
await page.waitForTimeout(400);
result.totpFilterText = (await page.textContent('#vaultList')) || '';
result.totpFilterCount = await page.locator('#vaultList .entry-card').count();

// Privacy shield covers the UI on blur and dismisses on click. The shield is
// off during setup so it cannot block the import clicks above; turn it on here.
await send('SV_SET_SETTINGS', { settings: { privacyShieldOnBlur: true } });
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await page.waitForSelector('#privacyShield:not([hidden])', { timeout: 3000 });
result.shieldVisible = true;
await page.click('#privacyShield');
result.shieldHidden = await page.locator('#privacyShield').isHidden();

// Copy toast mentions the auto-clear window.
await page.selectOption('#filterSelect', 'all');
await page.waitForTimeout(300);
const copyButton = page.locator('#vaultList .entry-card').first().locator('.entry-actions button.primary-mini');
await copyButton.click();
await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
result.copyToast = (await page.textContent('#toast')) || '';

result.pass =
  result.missingKeyRejected === true &&
  /密码|损坏|密钥/i.test(result.wrongKeyError) &&
  result.previewRows === 1 &&
  result.checkedRows === 1 &&
  result.importedHost.join(',') === 'legacy.example.com' &&
  result.importedFolder === 'Legacy' &&
  result.importedTags.join(',') === 'legacy' &&
  result.duplicateChecked === 0 &&
  /已存在/.test(result.duplicateBadge || '') &&
  result.confirmDisabled === true &&
  result.confirmEnabledAfterSelect === true &&
  result.totpFilterCount === 1 &&
  /otp\.example/.test(result.totpFilterText) &&
  result.shieldVisible === true &&
  result.shieldHidden === true &&
  /自动清除|clears in/i.test(result.copyToast || '') &&
  errors.length === 0;
result.pageErrors = errors;
console.log(JSON.stringify(result, null, 2));
await context.close();
if (!result.pass) process.exit(1);
