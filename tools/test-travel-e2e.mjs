import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'travel-data');
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
    '--window-size=1000,900',
  ],
});

const result = {};
let failure = null;
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );
  const secret = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'travel.example.com',
        username: 'traveller',
        password: 'travel-password',
        tags: ['trip-secret'],
      },
    }),
  );
  const visible = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: 'visible.example.com', username: 'home', password: 'home-password' },
    }),
  );
  if (!secret?.ok || !visible?.ok) throw new Error('add entries failed');

  const autoRestoreAt = Date.now() + 2500;
  const enabled = await options.evaluate(
    (at) =>
      chrome.runtime.sendMessage({
        type: 'SV_SET_TRAVEL',
        travel: { enabled: true, hiddenTags: ['trip-secret'], hiddenHosts: [], hiddenEntryIds: [] },
        autoRestoreAt: at,
      }),
    autoRestoreAt,
  );
  result.enabled = { ok: enabled?.ok, enabled: enabled?.enabled, autoRestoreAt: enabled?.autoRestoreAt };
  const hidden = await options.evaluate(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' });
    return {
      listIds: list.entries.map((entry) => entry.id),
      state: await chrome.runtime.sendMessage({ type: 'SV_GET_TRAVEL' }),
    };
  });
  result.hiddenListExcludes = !hidden.listIds.includes(secret.id);
  result.hiddenListIncludesVisible = hidden.listIds.includes(visible.id);

  await options.reload();
  await options.locator('[data-section="share"]').click();
  await options.locator('#travelCard').waitFor({ state: 'visible' });
  await options.waitForTimeout(500);
  result.ui = {
    enabledChecked: await options.locator('#travelEnabled').isChecked(),
    disableRowVisible: await options.locator('#travelDisableRow').isVisible(),
    status: (await options.locator('#travelStatus').textContent())?.trim(),
    rows: await options.locator('#travelEntryList input[data-travel-id]').count(),
    checkedRows: await options.locator('#travelEntryList input[data-travel-id]:checked').count(),
  };

  await options.waitForTimeout(2600);
  const afterAuto = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_GET_TRAVEL' }));
  result.autoRestored = afterAuto?.enabled === false;
  const afterList = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));
  result.listAfterRestoreIncludes = afterList.entries.some((entry) => entry.id === secret.id);

  const onAgain = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_TRAVEL',
      travel: { enabled: true, hiddenHosts: ['travel.example.com'], hiddenTags: [], hiddenEntryIds: [] },
    }),
  );
  result.hostEnabled = onAgain?.ok === true;
  const noPassword = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_TRAVEL', travel: { enabled: false } }),
  );
  result.disableNeedsPassword = noPassword?.ok === false;
  const disabled = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_TRAVEL',
      travel: { enabled: false },
      password: 'SubVault-Test-2026!Qm7#',
    }),
  );
  result.disabled = disabled?.ok === true && disabled?.enabled === false;

  const passed =
    result.enabled.ok === true &&
    result.enabled.enabled === true &&
    result.hiddenListExcludes === true &&
    result.hiddenListIncludesVisible === true &&
    result.ui.enabledChecked === true &&
    result.ui.disableRowVisible === true &&
    result.ui.status.includes('已启用') &&
    result.ui.rows === 2 &&
    result.ui.checkedRows === 1 &&
    result.autoRestored === true &&
    result.listAfterRestoreIncludes === true &&
    result.hostEnabled === true &&
    result.disableNeedsPassword === true &&
    result.disabled === true;
  result.pass = passed;
  if (!passed) throw new Error(`travel failed: ${JSON.stringify(result)}`);
} catch (error) {
  failure = error;
  result.pass = false;
  result.error = String(error?.message || error);
} finally {
  await context.close().catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  if (failure) process.exitCode = 1;
}
