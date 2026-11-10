import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'import-data');
const importFile = path.join(root, '.tmp', 'bitwarden-import.json');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
fs.mkdirSync(path.dirname(importFile), { recursive: true });
fs.writeFileSync(
  importFile,
  JSON.stringify({
    encrypted: false,
    folders: [{ id: 'f1', name: 'Work' }],
    items: [
      {
        type: 1,
        name: 'Imported account',
        folderId: 'f1',
        notes: 'imported note',
        login: {
          username: 'imported-user',
          password: 'imported-password',
          totp: 'otpauth://totp/Imported:imported-user?secret=JBSWY3DPEHPK3PXP',
          uris: [{ uri: 'https://imported.example.com/login' }],
        },
      },
    ],
  }),
);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'import-password' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false },
    }),
  );

  await page.locator('[data-section="transfer"]').click();
  await page.locator('#csvFile').setInputFiles(importFile);
  await page.locator('#importPreview').waitFor({ state: 'visible', timeout: 8000 });
  const previewText = await page.locator('#importPreview').textContent();
  if (!previewText.includes('Bitwarden JSON')) throw new Error(`preview: ${previewText}`);
  await page.getByRole('button', { name: '确认导入（先自动保存快照）' }).click();
  await page.waitForTimeout(1200);
  const entries = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }),
  );
  if (!entries.entries) throw new Error(`list failed: ${JSON.stringify(entries)}`);
  if (entries.entries.length !== 1 || entries.entries[0].username !== 'imported-user') {
    throw new Error(`imported entries: ${JSON.stringify(entries.entries)}`);
  }
  const entry = entries.entries[0];
  if (entry.folder !== 'Work' || !entry.hasTotp) {
    throw new Error(`imported metadata missing: ${JSON.stringify(entry)}`);
  }

  await page.locator('[data-section="vault"]').click();
  await page.locator('.entry-select').first().check();
  await page.locator('#bulkBar').waitFor({ state: 'visible' });
  await page.locator('#bulkFavoriteBtn').click();
  await page.waitForTimeout(500);
  const favorited = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }),
  );
  if (!favorited.entries?.[0]?.favorite) {
    throw new Error(`bulk favorite failed: ${JSON.stringify(favorited)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        format: 'Bitwarden JSON',
        entry: { username: entry.username, folder: entry.folder, hasTotp: entry.hasTotp },
        bulkFavorite: true,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
