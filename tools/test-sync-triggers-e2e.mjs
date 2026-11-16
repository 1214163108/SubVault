import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'sync-trigger-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

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

const result = { checks: {}, errors: [] };
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
  await page.click('[data-section="sync"]');
  await page.waitForTimeout(400);

  await page.selectOption('#syncTriggerSelect', 'interval');
  await page.waitForTimeout(300);
  result.checks.intervalRowVisible = await page.locator('#syncIntervalRow').isVisible();
  result.checks.scheduleRowHidden = await page.locator('#syncScheduleRow').isHidden();
  await page.fill('#syncIntervalMinutes', '7');
  await page.dispatchEvent('#syncIntervalMinutes', 'change');
  await page.waitForTimeout(500);

  result.checks.intervalSetting = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'SV_GET_SETTINGS' });
    return response.settings?.syncIntervalMinutes;
  });

  await page.selectOption('#syncTriggerSelect', 'scheduled');
  await page.waitForTimeout(300);
  result.checks.scheduleRowVisible = await page.locator('#syncScheduleRow').isVisible();
  result.checks.intervalRowHidden = await page.locator('#syncIntervalRow').isHidden();
  await page.fill('#syncScheduleTime', '08:30');
  await page.dispatchEvent('#syncScheduleTime', 'change');
  await page.waitForTimeout(500);

  const setting = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'SV_GET_SETTINGS' });
    return response.settings;
  });
  result.checks.scheduledSetting = setting?.syncTrigger;
  result.checks.scheduleTime = setting?.syncScheduleTime;

  await page.reload();
  await page.waitForTimeout(900);
  await page.click('[data-section="sync"]');
  await page.waitForTimeout(500);
  result.checks.persistedTrigger = await page.locator('#syncTriggerSelect').inputValue();
  result.checks.persistedTime = await page.locator('#syncScheduleTime').inputValue();
  result.checks.persistedInterval = await page.locator('#syncIntervalMinutes').inputValue();

  await page.screenshot({ path: path.join(root, 'docs', 'sync-triggers.png'), fullPage: true });

  const expected = {
    intervalRowVisible: true,
    scheduleRowHidden: true,
    intervalSetting: 7,
    scheduleRowVisible: true,
    intervalRowHidden: true,
    scheduledSetting: 'scheduled',
    scheduleTime: '08:30',
    persistedTrigger: 'scheduled',
    persistedTime: '08:30',
    persistedInterval: '7',
  };
  result.pass = Object.entries(expected).every(([key, value]) => result.checks[key] === value);
} catch (error) {
  result.errors.push(String(error?.stack || error));
} finally {
  await context.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
