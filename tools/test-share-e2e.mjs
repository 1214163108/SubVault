import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'share-data');
const downloadDir = path.join(root, '.tmp-host', 'share-downloads');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.rmSync(downloadDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  headless: false,
  acceptDownloads: true,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=1100,900',
  ],
});

const result = { checks: {}, errors: [] };
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (error) => result.errors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: 'example.com', username: 'alice', password: 'alice-secret-1' },
    });
    await chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.org',
        username: 'bob',
        password: 'bob-secret-2',
        tags: ['work'],
      },
    });
  });
  await page.reload();
  await page.waitForTimeout(900);

  await page.click('[data-section="share"]');
  await page.waitForSelector('#shareEntryList input[data-share-id]');
  result.checks.rows = await page.locator('#shareEntryList input[data-share-id]').count();
  result.checks.selected = await page.locator('#shareEntryList input[data-share-id]:checked').count();
  result.checks.exportLabel = await page.locator('#shareExportBtn').innerText();
  result.checks.exportDisabled = await page.locator('#shareExportBtn').isDisabled();

  await page.fill('#shareSearch', 'work');
  await page.waitForTimeout(200);
  result.checks.filteredRows = await page.locator('#shareEntryList input[data-share-id]').count();
  await page.click('#shareSelectAllBtn');
  result.checks.selectedAfterFilter = await page.locator('#shareEntryList input[data-share-id]:checked').count();
  result.checks.exportLabelAfterFilter = await page.locator('#shareExportBtn').innerText();
  result.checks.pickerPresent = (await page.locator('.file-picker').count()) > 0;

  // Too-short password must fail before encryption.
  await page.fill('#sharePassword', 'short');
  await page.click('#shareExportBtn');
  await page.waitForTimeout(300);
  result.checks.firstPasswordError = await page.locator('#shareError').innerText();

  await page.fill('#sharePassword', 'share-pass-123');
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#shareExportBtn');
  const download = await downloadPromise;
  const filePath = path.join(downloadDir, download.suggestedFilename());
  await download.saveAs(filePath);
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  result.checks.fileName = download.suggestedFilename();
  result.checks.format = pkg.format;
  result.checks.entryCount = pkg.box ? pkg.entryCount ?? null : null;

  await page.fill('#shareSearch', '');
  await page.waitForTimeout(200);
  result.checks.rowsAfterClear = await page.locator('#shareEntryList input[data-share-id]').count();

  // Import the produced file; duplicates default to unchecked.
  await page.setInputFiles('#shareFile', filePath);
  await page.fill('#shareImportPassword', 'wrong-pass-1');
  await page.click('#shareImportBtn');
  await page.waitForTimeout(300);
  result.checks.importPasswordError = await page.locator('#shareError').innerText();

  await page.setInputFiles('#shareFile', filePath);
  await page.fill('#shareImportPassword', 'share-pass-123');
  await page.click('#shareImportBtn');
  await page.waitForSelector('#importPreview', { timeout: 15000 });
  result.checks.previewVisible = await page.locator('#importPreview').isVisible();
  result.checks.previewRows = await page.locator('#importPreview .preview-row').count();
  result.checks.checkedRows = await page.locator('#importPreview .preview-row input:checked').count();
  result.checks.confirmDisabled = await page.locator('[data-preview-confirm]').isDisabled();
  result.checks.previewText = (await page.locator('#importPreview').innerText()).slice(0, 160);

  result.checks.pass =
    result.checks.rows === 2 &&
    result.checks.selected === 0 &&
    result.checks.exportDisabled === true &&
    result.checks.filteredRows === 1 &&
    result.checks.selectedAfterFilter === 1 &&
    result.checks.exportLabelAfterFilter === '导出 1 个账号' &&
    result.checks.pickerPresent === true &&
    result.checks.rowsAfterClear === 2 &&
    result.checks.format === 'subvault-share' &&
    result.checks.previewVisible === true &&
    result.checks.previewRows === 1 &&
    result.checks.checkedRows === 0 &&
    result.checks.confirmDisabled === true &&
    result.errors.length === 0;
} catch (error) {
  result.errors.push(String(error?.stack || error));
  result.checks.pass = false;
} finally {
  console.log(JSON.stringify(result, null, 2));
  await context.close();
}
