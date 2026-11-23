import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.tmp-sync-center');
const syncDir = path.join(base, 'data');
const password = 'SubVault-Test-2026!Qm7#';
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const results = {};
const errors = [];

async function openExtension(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-32000,-32000',
      '--window-size=920,900',
    ],
    env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
    locale: 'zh-CN',
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  return { context, page, id };
}

const send = (page, type, payload = {}) =>
  page.evaluate(([kind, extra]) => chrome.runtime.sendMessage({ type: kind, ...extra }), [type, payload]);

async function noIdle(page) {
  await send(page, 'SV_SET_SETTINGS', {
    settings: {
      lockOnSystemLock: false,
      lockOnSystemIdle: false,
      autoLockMinutes: 0,
      privacyShieldOnBlur: false,
    },
  });
}

async function openSyncCard(page) {
  await page.click('[data-section="sync"]');
  await page.waitForSelector('#syncStateTag', { timeout: 10000 });
  await page.evaluate(() => {
    const shield = document.getElementById('privacyShield');
    if (shield) shield.hidden = true;
  });
}

async function cardState(page) {
  return page.evaluate(() => ({
    tag: document.getElementById('syncStateTag')?.textContent?.trim(),
    box: document.getElementById('syncStateBox')?.textContent?.trim(),
    trigger: document.getElementById('syncTriggerSelect')?.value,
    lastAt: document.getElementById('syncLastAt')?.textContent?.trim(),
    direction: document.getElementById('syncLastDirection')?.textContent?.trim(),
    revision: document.getElementById('syncRevision')?.textContent?.trim(),
    conflictHidden: document.getElementById('syncConflictBox')?.hidden,
    errorHidden: document.getElementById('syncErrorBox')?.hidden,
  }));
}

let a = null;
let b = null;
try {
  a = await openExtension(path.join(base, 'profile-a'));
  const setup = await send(a.page, 'SV_SETUP', { password });
  if (!setup?.ok) throw new Error(`A setup: ${setup?.error}`);
  await noIdle(a.page);
  await send(a.page, 'SV_SET_SETTINGS', { settings: { syncTrigger: 'manual' } });
  for (let i = 0; i < 40; i += 1) {
    const status = await send(a.page, 'SV_SYNC_STATUS');
    if (status.state === 'idle' && status.available && status.joined) break;
    if (i === 20) await send(a.page, 'SV_SYNC_NOW');
    await a.page.waitForTimeout(250);
  }
  await send(a.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', title: 'A one', username: 'alice', password: 'alice-secret' },
  });
  const pushA = await send(a.page, 'SV_SYNC_NOW');
  results.pushA = pushA;
  if (!pushA?.ok) throw new Error(`A push: ${pushA?.error}`);
  await openSyncCard(a.page);
  await a.page.waitForTimeout(500);
  results.cardAfterPush = await cardState(a.page);
  const statusA = await send(a.page, 'SV_SYNC_STATUS');
  results.statusA = statusA;
  results.manualTrigger = statusA.trigger === 'manual' && statusA.state === 'idle';
  await a.context.close();
  a = null;

  b = await openExtension(path.join(base, 'profile-b'));
  await b.page.waitForSelector('#gateImportPrompt:not([hidden])', { timeout: 10000 });
  await b.page.evaluate(() => {
    const shield = document.getElementById('privacyShield');
    if (shield) shield.hidden = true;
  });
  await b.page.click('#gateImportChoose');
  await b.page.fill('#gateImportPassword', password);
  await b.page.click('#gateImportBtn');
  await b.page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  await noIdle(b.page);
  await send(b.page, 'SV_SET_SETTINGS', { settings: { syncTrigger: 'manual' } });

  await b.page.click('[data-section="sync"]');
  await b.page.waitForSelector('#syncStateTag', { timeout: 10000 });
  results.importedCard = await cardState(b.page);
  results.importedTriggerPersisted = results.importedCard.trigger === 'manual';

  await send(b.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', title: 'B one', username: 'bob', password: 'bob-secret' },
  });

  a = await openExtension(path.join(base, 'profile-a'));
  const unlock = await send(a.page, 'SV_UNLOCK', { password });
  if (!unlock?.ok) throw new Error(`A unlock: ${unlock?.error}`);
  await noIdle(a.page);
  await send(a.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', title: 'A two', username: 'alice2', password: 'alice2-secret' },
  });
  const pushA2 = await send(a.page, 'SV_SYNC_NOW');
  results.pushA2 = pushA2;
  if (!pushA2?.ok) throw new Error(`A push2: ${pushA2?.error}`);

  const conflict = await send(b.page, 'SV_SYNC_NOW');
  results.conflictResponse = conflict;
  results.conflictDetected =
    conflict?.state === 'conflict' &&
    Boolean(conflict?.conflict?.remoteRevision) &&
    conflict?.lastErrorCode === 'conflict';

  await b.page.evaluate(() => {
    const shield = document.getElementById('privacyShield');
    if (shield) shield.hidden = true;
  });
  await b.page.waitForSelector('#syncConflictBox:not([hidden])', { timeout: 5000 });
  results.conflictCard = await cardState(b.page);
  results.conflictText = await b.page.locator('#syncConflictText').textContent();

  await b.page.click('#syncKeepRemoteBtn');
  await b.page.waitForSelector('#syncConflictBox[hidden]', { timeout: 15000 }).catch(() => {});
  await b.page.waitForTimeout(500);
  const afterRemote = await send(b.page, 'SV_LIST_ENTRIES');
  const names = (afterRemote.entries || []).map((entry) => entry.username).sort();
  results.afterRemote = names;
  results.remoteApplied = names.includes('alice2') && !names.includes('bob');
  results.cardAfterResolve = await cardState(b.page);

  await b.page.reload();
  await b.page.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  await b.page.click('[data-section="sync"]');
  await b.page.waitForSelector('#syncStateTag', { timeout: 10000 });
  results.persistedAfterReload = await cardState(b.page);
  results.persistedTrigger = results.persistedAfterReload.trigger === 'manual';

  results.errors = errors;
  results.ok =
    results.manualTrigger &&
    results.importedTriggerPersisted &&
    results.conflictDetected &&
    results.remoteApplied &&
    results.conflictCard?.conflictHidden === false &&
    results.cardAfterResolve?.conflictHidden === true &&
    results.persistedTrigger &&
    results.persistedAfterReload?.lastAt !== '从未' &&
    errors.length === 0;
} catch (error) {
  results.error = String(error?.stack || error);
  results.errors = errors;
  results.ok = false;
} finally {
  if (a) await a.context.close().catch(() => {});
  if (b) await b.context.close().catch(() => {});
}

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
