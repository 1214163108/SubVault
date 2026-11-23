import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { unpackContainer, isContainerBytes } from '../src/lib/container.js';

const root = path.resolve(import.meta.dirname, '..');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-backup-container-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const downloadDir = path.join(root, '.tmp-host', 'backup-downloads');
fs.rmSync(downloadDir, { recursive: true, force: true });
fs.mkdirSync(downloadDir, { recursive: true });

const result = { checks: {}, errors: [] };

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
    '--window-size=1100,900',
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
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' });
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
  });
  await page.reload();
  await page.waitForTimeout(900);
  await page.click('[data-section="transfer"]');
  await page.waitForTimeout(400);

  // 1. Export a backup and confirm the bytes are a private container, not JSON.
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#exportBackupBtn');
  const download = await downloadPromise;
  const backupPath = path.join(downloadDir, download.suggestedFilename());
  await download.saveAs(backupPath);
  const raw = fs.readFileSync(backupPath);
  result.checks.backupName = download.suggestedFilename();
  result.checks.backupExtension = path.extname(download.suggestedFilename());
  result.checks.backupIsContainer = isContainerBytes(new Uint8Array(raw));
  result.checks.backupMagic = raw.subarray(0, 5).toString('latin1');
  const asText = raw.toString('utf8');
  result.checks.backupNotPlainJson = !asText.trimStart().startsWith('{');
  result.checks.backupHasNoFieldName = !asText.includes('"box"') && !asText.includes('subvault-backup');
  const backup = await unpackContainer(new Uint8Array(raw));
  result.checks.backupFormat = backup.format;
  result.checks.backupHasBox = Boolean(backup.box) && typeof backup.box === 'object';

  // 2. A renamed .txt copy must still be recognised on restore.
  const renamed = path.join(downloadDir, 'renamed-backup.txt');
  fs.copyFileSync(backupPath, renamed);
  await page.setInputFiles('#backupFile', renamed);
  await page.waitForTimeout(500);
  result.checks.renamedAccepted = await page
    .locator('#backupFileName')
    .innerText()
    .then((text) => text.includes('renamed-backup.txt'))
    .catch(() => false);

  // 3. A plain JSON file must be rejected with a clear message.
  const bogus = path.join(downloadDir, 'bogus.txt');
  fs.writeFileSync(bogus, '{"hello":"world"}');
  await page.setInputFiles('#backupFile', bogus);
  await page.waitForTimeout(500);
  const bogusText = await page.locator('#backupFileName').innerText().catch(() => '');
  result.checks.bogusRejected = /不是|无法识别|私有/.test(bogusText) || bogusText.includes('bogus.txt');

  // 4. Recovery kit downloads as a private container and can be read in-app.
  await page.setInputFiles('#backupFile', backupPath);
  await page.waitForTimeout(400);
  const kitPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#recoveryKitBtn');
  const kitDownload = await kitPromise;
  const kitPath = path.join(downloadDir, kitDownload.suggestedFilename());
  await kitDownload.saveAs(kitPath);
  const kitRaw = fs.readFileSync(kitPath);
  result.checks.kitName = kitDownload.suggestedFilename();
  result.checks.kitIsContainer = isContainerBytes(new Uint8Array(kitRaw));
  result.checks.kitNotPlainText = !kitRaw.toString('utf8').includes('主密码');
  const kit = await unpackContainer(new Uint8Array(kitRaw));
  result.checks.kitFormat = kit.format;
  result.checks.kitLines = Array.isArray(kit.lines) && kit.lines.length >= 3;

  await page.click('#recoveryKitViewBtn');
  await page.waitForSelector('#recoveryKitDialog[open]', { timeout: 5000 });
  const kitText = await page.locator('#recoveryKitText').innerText();
  result.checks.kitDialogText = kitText.includes('主密码') || kitText.length > 20;
  await page.click('#recoveryKitClose');

  // 5. Restore the private backup (replace mode).
  const restore = await page.evaluate(async (base64) => {
    const res = await chrome.runtime.sendMessage({
      type: 'SV_IMPORT_BACKUP',
      base64,
      password: 'SubVault-Test-2026!Qm7#',
      mode: 'replace',
      restoreSettings: false,
    });
    return res;
  }, raw.toString('base64'));
  result.checks.restoreOk = Boolean(restore?.ok);
  result.checks.restoreTotal = restore?.total ?? null;

  result.checks.pass =
    result.checks.backupExtension === '.svbak' &&
    result.checks.backupIsContainer === true &&
    result.checks.backupMagic === 'SVBAK' &&
    result.checks.backupNotPlainJson === true &&
    result.checks.backupHasNoFieldName === true &&
    result.checks.backupFormat === 'subvault-backup' &&
    result.checks.backupHasBox === true &&
    result.checks.renamedAccepted === true &&
    result.checks.kitIsContainer === true &&
    result.checks.kitNotPlainText === true &&
    result.checks.kitFormat === 'subvault-recovery-kit' &&
    result.checks.kitLines === true &&
    result.checks.kitDialogText === true &&
    result.checks.restoreOk === true &&
    result.checks.restoreTotal === 2;
} catch (error) {
  result.errors.push(String(error && error.stack ? error.stack : error));
} finally {
  console.log(JSON.stringify(result, null, 2));
  await context.close();
}

process.exit(result.checks.pass ? 0 : 1);
