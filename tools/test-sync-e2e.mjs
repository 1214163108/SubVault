import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = process.env.SUBVAULT_SYNC_DIR || path.join(root, 'native-host', 'data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

async function openExtension(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-32000,-32000',
      '--window-size=900,900',
    ],
    env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  return { context, page, id };
}

const profileA = path.join(root, '.tmp-host', 'profile-a');
const profileB = path.join(root, '.tmp-host', 'profile-b');
fs.rmSync(profileA, { recursive: true, force: true });
fs.rmSync(profileB, { recursive: true, force: true });

let a;
let b;
try {
  a = await openExtension(profileA);
  const setupA = await a.page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'alpha-password' }),
  );
  if (!setupA?.ok) throw new Error(`A setup: ${setupA?.error}`);
  await a.page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.com',
        title: 'A account',
        username: 'alice',
        password: 'alpha-secret',
      },
    }),
  );
  await a.page.waitForTimeout(1200);
  const statusA = await a.page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SYNC_STATUS' }));
  await a.context.close();
  a = null;

  b = await openExtension(profileB);
  await b.page.waitForSelector('#gateImportPrompt:not([hidden])', { timeout: 10000 });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  await b.page.screenshot({ path: path.join(root, 'docs', 'sync-import-gate.png') });

  const popup = await b.context.newPage();
  await popup.setViewportSize({ width: 382, height: 600 });
  await popup.goto(`chrome-extension://${b.id}/src/popup/popup.html`);
  await popup.waitForSelector('#syncImportPrompt:not([hidden])', { timeout: 10000 });
  await popup.screenshot({ path: path.join(root, 'docs', 'popup-sync-import.png') });
  await popup.close();

  await b.page.click('#gateImportChoose');
  await b.page.fill('#gateImportPassword', 'alpha-password');
  await b.page.click('#gateImportBtn');
  await b.page.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  await b.page.waitForTimeout(300);

  const statusB = await b.page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SYNC_STATUS' }));
  if (!statusB.exists) throw new Error('B did not see the host vault');

  const before = { entries: [] };
  const after = await b.page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));

  const a2 = await openExtension(profileA);
  const unlockA = await a2.page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_UNLOCK', password: 'alpha-password' }),
  );
  if (!unlockA?.ok) throw new Error(`A unlock: ${unlockA?.error}`);
  await a2.page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.com',
        title: 'Live from A',
        username: 'bob',
        password: 'live-secret',
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const live = await b.page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));
  await a2.context.close();

  if (!live.entries?.some((entry) => entry.username === 'bob')) {
    throw new Error('B did not receive the live update from A');
  }

  const a3 = await openExtension(profileA);
  const unlockA3 = await a3.page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_UNLOCK', password: 'alpha-password' }),
  );
  if (!unlockA3?.ok) throw new Error(`A3 unlock: ${unlockA3?.error}`);
  await a3.page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.com',
        title: 'After restart',
        username: 'carol',
        password: 'restart-secret',
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await a3.context.close();

  const cdp = await b.context.newCDPSession(b.page);
  await cdp.send('ServiceWorker.enable').catch(() => {});
  await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  await b.page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SYNC_NOW' }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterRestart = await b.page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }),
  );
  if (!afterRestart.entries?.some((entry) => entry.username === 'carol')) {
    throw new Error('B did not recover the missed update after service worker restart');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        extensionId: b.id,
        hostRevisionA: statusA.revision,
        hostExistsForB: statusB.exists,
        beforeCount: before.entries?.length || 0,
        afterCount: after.entries?.length || 0,
        liveCount: live.entries?.length || 0,
        restartCount: afterRestart.entries?.length || 0,
        username: after.entries?.[0]?.username,
        liveUsername: 'bob',
        restartUsername: 'carol',
      },
      null,
      2,
    ),
  );
} finally {
  if (a) await a.context.close();
  if (b) await b.context.close();
  fs.rmSync(profileA, { recursive: true, force: true });
  fs.rmSync(profileB, { recursive: true, force: true });
}
