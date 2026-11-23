import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { unpackContainer } from '../src/lib/container.js';
import { isKeyFileBytes, parseKeyFile } from '../src/lib/keyfile.js';

const root = path.resolve(import.meta.dirname, '..');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-keyfile-export-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const downloadDir = path.join(root, '.tmp-keyfile', 'downloads');
fs.rmSync(path.join(root, '.tmp-keyfile'), { recursive: true, force: true });
fs.mkdirSync(downloadDir, { recursive: true });

const result = { checks: {}, errors: [] };
const PASSWORD = 'SubVault-KeyFile-2026!Qm7#';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=1180,900',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (error) => result.errors.push(String(error)));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(async (password) => {
    await chrome.runtime.sendMessage({ type: 'SV_SETUP', password });
    await chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: {
        lockOnSystemLock: false,
        lockOnSystemIdle: false,
        autoLockMinutes: 0,
        privacyShieldOnBlur: false,
      },
    });
    await chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: 'example.com', username: 'alice', password: 'alice-secret-1' },
    });
    await chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: 'example.org', username: 'bob', password: 'bob-secret-2' },
    });
  }, PASSWORD);
  await page.reload();
  await page.waitForTimeout(900);

  const pending = [];
  page.on('download', (download) => {
    const target = path.join(downloadDir, download.suggestedFilename());
    pending.push(
      download.saveAs(target).then(
        () => target,
        () => '',
      ),
    );
  });
  const takeDownloads = async (count) => {
    const started = Date.now();
    while (pending.length < count && Date.now() - started < 25000) {
      await page.waitForTimeout(120);
    }
    const batch = pending.splice(0, pending.length);
    return Promise.all(batch);
  };

  const saveNext = async (trigger) => {
    const promise = page.waitForEvent('download', { timeout: 25000 });
    await trigger();
    const download = await promise;
    const target = path.join(downloadDir, download.suggestedFilename());
    await download.saveAs(target);
    return target;
  };

  // --- 1. Export a backup together with a key file -------------------------
  await page.click('[data-section="transfer"]');
  await page.waitForTimeout(400);
  await page.fill('#exportBackupPassword', 'independent-backup-passphrase');
  await page.check('#exportBackupKeyFile');
  result.checks.keyFileToggleVisible = await page.isVisible('#exportBackupKeyFile');

  await page.click('#exportBackupBtn');
  const backupFiles = await takeDownloads(3);
  const backupPath = backupFiles.find((file) => file.endsWith('.svbak')) || '';
  const keyPath = backupFiles.find((file) => file.endsWith('.svkey')) || '';
  result.checks.downloadCount = backupFiles.length;
  result.checks.backupName = backupPath ? path.basename(backupPath) : '';
  result.checks.backupExt = backupPath ? path.extname(backupPath) : '';
  result.checks.keyName = keyPath ? path.basename(keyPath) : '';
  result.checks.keyExt = keyPath ? path.extname(keyPath) : '';

  const keyBytes = keyPath ? new Uint8Array(fs.readFileSync(keyPath)) : new Uint8Array();
  result.checks.keyIsKeyFile = isKeyFileBytes(keyBytes);
  result.checks.keyLength = keyBytes.length;
  const parsedKey = keyPath ? parseKeyFile(keyBytes) : null;
  result.checks.keyMagic = keyBytes.length ? Buffer.from(keyBytes.subarray(0, 5)).toString('latin1') : '';

  const backupRaw = fs.readFileSync(backupPath);
  const backupJson = await unpackContainer(new Uint8Array(backupRaw));
  result.checks.backupBoundToKey = backupJson.keyFile === true;
  result.checks.backupFingerprint = backupJson.keyFileFingerprint || '';

  // --- 2. Restore without the key file must fail --------------------------
  await page.setInputFiles('#backupFile', backupPath);
  await page.waitForTimeout(600);
  result.checks.keyRowVisible = await page.isVisible('#backupKeyFileRow');
  result.checks.fileNameShowsKey = await page
    .locator('#backupFileName')
    .innerText()
    .then((text) => /SVKEY-[0-9A-F]{8}/.test(text))
    .catch(() => false);

  await page.fill('#backupPassword', 'independent-backup-passphrase');
  await page.click('#importBackupBtn');
  await page.waitForTimeout(700);
  result.checks.missingKeyToast = await page
    .locator('#toast')
    .innerText()
    .then((text) => /密钥文件/.test(text))
    .catch(() => false);

  // --- 3. A different key file must be rejected ---------------------------
  const foreignKey = path.join(downloadDir, 'foreign.svkey');
  const foreign = Buffer.alloc(40);
  Buffer.from('SVKEY').copy(foreign, 0);
  foreign[5] = 1;
  for (let index = 8; index < 40; index += 1) foreign[index] = (index * 7) % 251;
  fs.writeFileSync(foreignKey, foreign);
  await page.setInputFiles('#backupKeyFile', foreignKey);
  await page.click('#importBackupBtn');
  await page.waitForTimeout(900);
  result.checks.mismatchedKeyToast = await page
    .locator('#toast')
    .innerText()
    .then((text) => /不匹配/.test(text))
    .catch(() => false);

  // --- 4. Correct key file restores the vault ----------------------------
  await page.setInputFiles('#backupKeyFile', keyPath);
  await page.click('#importBackupBtn');
  await page.waitForTimeout(2500);
  result.checks.restoreToast = await page
    .locator('#toast')
    .innerText()
    .then((text) => text.trim())
    .catch(() => '');
  result.checks.keyRowHiddenAfterRestore = !(await page.isVisible('#backupKeyFileRow'));
  result.checks.entryCount = await page.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' });
    return res?.entries?.length ?? -1;
  });

  // --- 5. Share export with a key file -----------------------------------
  await page.click('[data-section="share"]');
  await page.waitForTimeout(500);
  await page.fill('#sharePassword', 'share-pass-1234');
  await page.check('#shareExportKeyFile');
  await page.click('#shareSelectAllBtn');
  await page.waitForTimeout(300);
  await page.click('#shareExportBtn');
  const shareFiles = await takeDownloads(2);
  const sharePath = shareFiles.find((file) => file.endsWith('.svshare')) || '';
  const shareKeyPath = shareFiles.find((file) => file.endsWith('.svkey')) || '';
  result.checks.shareDownloadCount = shareFiles.length;
  result.checks.shareName = sharePath ? path.basename(sharePath) : '';
  result.checks.shareKeyName = shareKeyPath ? path.basename(shareKeyPath) : '';
  const shareJson = await unpackContainer(new Uint8Array(fs.readFileSync(sharePath)));
  result.checks.shareBoundToKey = shareJson.keyFile === true;

  // --- 6. Share import without the key file fails, with it succeeds ------
  await page.setInputFiles('#shareFile', sharePath);
  await page.waitForTimeout(700);
  result.checks.shareKeyRowVisible = await page.isVisible('#shareImportKeyFileRow');
  await page.fill('#shareImportPassword', 'share-pass-1234');
  await page.click('#shareImportBtn');
  await page.waitForTimeout(900);
  result.checks.shareMissingKeyError = await page
    .locator('#shareError')
    .innerText()
    .then((text) => /密钥文件/.test(text))
    .catch(() => false);

  await page.setInputFiles('#shareImportKeyFile', shareKeyPath);
  await page.click('#shareImportBtn');
  await page.waitForTimeout(2000);
  result.checks.shareImportToast = await page
    .locator('#toast')
    .innerText()
    .then((text) => text.trim())
    .catch(() => '');
  result.checks.previewVisible = await page.isVisible('#importPreview');

  result.checks.pass =
    result.checks.keyFileToggleVisible === true &&
    result.checks.backupExt === '.svbak' &&
    result.checks.keyExt === '.svkey' &&
    result.checks.keyIsKeyFile === true &&
    result.checks.keyLength === 40 &&
    result.checks.keyMagic === 'SVKEY' &&
    result.checks.backupBoundToKey === true &&
    Boolean(parsedKey) === true &&
    result.checks.backupFingerprint.length === 16 &&
    result.checks.keyRowVisible === true &&
    result.checks.fileNameShowsKey === true &&
    result.checks.missingKeyToast === true &&
    result.checks.mismatchedKeyToast === true &&
    result.checks.keyRowHiddenAfterRestore === true &&
    result.checks.entryCount === 2 &&
    result.checks.downloadCount === 3 &&
    result.checks.shareDownloadCount === 2 &&
    result.checks.shareBoundToKey === true &&
    result.checks.shareKeyRowVisible === true &&
    result.checks.shareMissingKeyError === true &&
    result.checks.previewVisible === true;
} catch (error) {
  result.errors.push(String(error && error.stack ? error.stack : error));
} finally {
  console.log(JSON.stringify(result, null, 2));
  await context.close();
}

process.exit(result.checks.pass ? 0 : 1);
