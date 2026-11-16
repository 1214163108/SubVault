import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'settings-nav-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><p>ok</p></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const context = await chromium.launchPersistentContext('', {
  headless: false,
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

const result = { sections: {}, checks: {}, errors: [] };
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );
  await page.reload();
  await page.waitForTimeout(900);

  const navSections = await page.$$eval('.nav-item', (items) =>
    items.map((item) => ({ section: item.dataset.section, text: item.innerText.trim() })),
  );
  result.checks.navCount = navSections.length;
  result.checks.navSections = navSections.map((item) => item.section);
  result.checks.navLabels = navSections.map((item) => item.text);

  const expectedSections = [
    'vault',
    'general',
    'security',
    'takeover',
    'domains',
    'sync',
    'transfer',
    'share',
    'language',
    'about',
  ];
  result.checks.navOrder = JSON.stringify(result.checks.navSections) === JSON.stringify(expectedSections);

  for (const section of expectedSections.slice(1)) {
    await page.click(`[data-section="${section}"]`);
    await page.waitForTimeout(250);
    const visible = await page.$$eval('.section', (items) =>
      items.filter((item) => !item.hidden).map((item) => item.id),
    );
    result.sections[section] = {
      visible,
      title: await page.locator('#pageTitle').innerText(),
    };
  }

  result.checks.onlyOneSectionVisible = Object.values(result.sections).every(
    (entry) => entry.visible.length === 1,
  );

  await page.click('[data-section="sync"]');
  result.checks.syncCardInSync = await page.locator('#syncCard').isVisible();
  await page.click('[data-section="general"]');
  result.checks.generalCardInGeneral = await page.locator('#generalCard').isVisible();
  await page.click('[data-section="takeover"]');
  result.checks.takeoverCardInTakeover = await page.locator('#takeoverCard').isVisible();

  await page.fill('#settingsSearch', 'WebDAV');
  await page.waitForTimeout(300);
  result.checks.searchSyncVisible = await page.locator('#syncCard').isVisible();
  result.checks.searchSyncSectionVisible = await page.locator('#section-sync').isVisible();
  const searchVisibleSections = await page.$$eval('.section', (items) =>
    items.filter((item) => !item.hidden).map((item) => item.id),
  );
  result.checks.searchSections = searchVisibleSections;

  await page.fill('#settingsSearch', '找不到的设置xyz');
  await page.waitForTimeout(300);
  result.checks.emptySearchHidesAll = (await page.$$('.section:not([hidden])')).length === 0;

  await page.fill('#settingsSearch', '');
  await page.waitForTimeout(300);
  result.checks.clearSearchRestoresSection = (await page.$$('.section:not([hidden])')).length === 1;

  await page.click('[data-section="domains"]');
  await page.waitForTimeout(250);
  result.checks.pslPickerEnhanced = await page.locator('#pslFile').evaluate((input) =>
    input.classList.contains('file-native') && Boolean(input.nextElementSibling?.classList.contains('file-picker')),
  );
  result.checks.pslPickerButton = await page.locator('#pslFile + .file-picker .file-picker-btn').innerText();
  result.checks.pslPickerName = await page.locator('#pslFile + .file-picker .file-picker-name').innerText();

  await page.click('[data-section="language"]');
  await page.waitForTimeout(300);
  const before = await page.locator('#formatSample').innerText();
  result.checks.formatSampleBefore = before;
  result.checks.formatSamplePresent = before !== '—' && /\d/.test(before);
  result.checks.languageSelectVisible = await page.locator('#uiLanguageSelect').isVisible();

  await page.screenshot({ path: path.join(root, 'docs', 'settings-nav.png'), fullPage: true });

  const expected = {
    navCount: 10,
    navOrder: true,
    onlyOneSectionVisible: true,
    syncCardInSync: true,
    generalCardInGeneral: true,
    takeoverCardInTakeover: true,
    searchSyncVisible: true,
    searchSyncSectionVisible: true,
    emptySearchHidesAll: true,
    clearSearchRestoresSection: true,
    pslPickerEnhanced: true,
    pslPickerButton: '选择文件',
    pslPickerName: '未选择文件',
    formatSamplePresent: true,
    languageSelectVisible: true,
  };
  result.pass = Object.entries(expected).every(([key, value]) => result.checks[key] === value);
} catch (error) {
  result.errors.push(String(error?.stack || error));
} finally {
  await context.close();
  server.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
