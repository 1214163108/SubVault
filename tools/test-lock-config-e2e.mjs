import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'lock-data');
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
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'lock-password' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false },
    }),
  );

  async function lockAlarm() {
    const alarms = await page.evaluate(() => chrome.alarms.getAll());
    return alarms.find((alarm) => alarm.name === 'subvault-lock-at') || null;
  }

  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { autoLockMinutes: 1 } }),
  );
  await page.waitForTimeout(300);
  const oneMinute = await lockAlarm();
  if (!oneMinute) throw new Error('1-minute lock alarm missing');
  const oneDelta = oneMinute.scheduledTime - Date.now();
  if (oneDelta < 50_000 || oneDelta > 65_000) {
    throw new Error(`unexpected 1-minute alarm: ${oneDelta}`);
  }

  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { autoLockMinutes: 5 } }),
  );
  await page.waitForTimeout(300);
  const fiveMinutes = await lockAlarm();
  if (!fiveMinutes) throw new Error('5-minute lock alarm missing');
  const fiveDelta = fiveMinutes.scheduledTime - Date.now();
  if (fiveDelta < 290_000 || fiveDelta > 305_000) {
    throw new Error(`unexpected 5-minute alarm: ${fiveDelta}`);
  }

  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { autoLockMinutes: 0 } }),
  );
  await page.waitForTimeout(300);
  const never = await lockAlarm();
  if (never) throw new Error('lock alarm should be cleared when auto-lock is off');

  await page.waitForTimeout(65_000);
  const stillUnlocked = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_GET_STATUS' }),
  );
  if (stillUnlocked.locked) {
    throw new Error('vault locked even though auto-lock is off');
  }

  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LOCK' }));
  const locked = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_GET_STATUS' }));
  if (!locked.locked) throw new Error('manual lock did not lock');

  console.log(
    JSON.stringify(
      {
        ok: true,
        oneMinuteDelta: Math.round(oneDelta / 1000),
        fiveMinuteDelta: Math.round(fiveDelta / 1000),
        autoLockOffCleared: true,
        autoLockOffHeld65s: !stillUnlocked.locked,
        manualLocked: locked.locked,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
