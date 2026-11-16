import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'language-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const loginHtml = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>Username <input name="username" autocomplete="username" /></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">Log in</button>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(loginHtml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  locale: 'en-US',
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--lang=en-US',
    '--accept-lang=en-US',
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

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  result.checks.setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForTimeout(800);
  const popupEn = await popup.locator('body').innerText();
  result.checks.popupEnglish = popupEn.includes('Add account');

  await options.reload();
  await options.waitForTimeout(800);
  const optionsEn = await options.locator('body').innerText();
  result.checks.optionsEnglish = optionsEn.includes('Import & export');

  const switchLanguage = async (value) => {
    await options.evaluate((next) => {
      const select = document.getElementById('uiLanguageSelect');
      select.value = next;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await options.waitForTimeout(900);
  };

  await switchLanguage('zh-CN');
  const optionsZh = await options.locator('body').innerText();
  result.checks.optionsChinese = optionsZh.includes('导入与导出') && optionsZh.includes('密码库');
  result.checks.optionsChineseHasEnglish = optionsZh.includes('Import & export');
  result.checks.documentLangZh = await options.evaluate(() => document.documentElement.lang);

  await switchLanguage('en');
  const optionsEnAgain = await options.locator('body').innerText();
  result.checks.optionsEnglishAgain = optionsEnAgain.includes('Import & export');

  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: '127.0.0.1', username: 'alice', password: 'alice-secret' },
    }),
  );

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(900);
  await page.locator('input[name="username"]').click();
  await page.waitForTimeout(500);
  result.checks.contentEnglishLabel = await page
    .locator('[data-subvault-trigger]')
    .getAttribute('aria-label');

  await switchLanguage('zh-CN');
  await page.waitForTimeout(600);
  result.checks.contentChineseLabel = await page
    .locator('[data-subvault-trigger]')
    .getAttribute('aria-label');

  await switchLanguage('en');
  await page.waitForTimeout(600);
  result.checks.contentEnglishLabelAgain = await page
    .locator('[data-subvault-trigger]')
    .getAttribute('aria-label');

  await switchLanguage('zh-CN');
  await popup.reload();
  await popup.waitForTimeout(800);
  const popupZh = await popup.locator('body').innerText();
  result.checks.popupChinese = popupZh.includes('添加账号');

  await switchLanguage('en');
  await popup.reload();
  await popup.waitForTimeout(800);
  const popupEnAgain = await popup.locator('body').innerText();
  result.checks.popupEnglishAgain = popupEnAgain.includes('Add account');

  const expected = {
    popupEnglish: true,
    optionsEnglish: true,
    optionsChinese: true,
    optionsChineseHasEnglish: false,
    documentLangZh: 'zh-CN',
    optionsEnglishAgain: true,
    contentEnglishLabel: 'Fill with SubVault',
    contentChineseLabel: '用 SubVault 填充密码',
    contentEnglishLabelAgain: 'Fill with SubVault',
    popupChinese: true,
    popupEnglishAgain: true,
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
