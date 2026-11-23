import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression test for:
 *   Unchecked runtime.lastError: Cannot create item with duplicate id subvault-fill
 *   ... subvault-generate / subvault-open
 *
 * Root cause: the worker booted through three independent entry points (the
 * top-level `void safeInitialize()`, `chrome.runtime.onInstalled` and
 * `chrome.runtime.onStartup`) and each ran initialize() → buildContextMenus().
 * `contextMenus.removeAll()` is asynchronous while `contextMenus.create()` is
 * synchronous, so two overlapping rebuilds interleave as
 * removeAll, removeAll, create×3, create×3 — and the second batch collides
 * with the first. Chrome reports that collision through `runtime.lastError`
 * ("Cannot create item with duplicate id …") instead of throwing.
 *
 * Why this test does not watch console output: `runtime.lastError` raised
 * inside a service worker is neither forwarded to Playwright's
 * `worker.on('console')` stream nor recorded in chrome://extensions
 * `developerPrivate.getExtensionsInfo().runtimeErrors` — both were verified
 * empty even while the buggy implementation was installed. The duplicate is
 * therefore observed by replacing `chrome.contextMenus` with a recorder inside
 * the worker: any `create` whose id is still present is a duplicate, which is
 * exactly the condition Chrome complains about.
 *
 * The fix serializes rebuilds behind a promise chain (`contextMenuChain`) and
 * de-duplicates `initialize()` behind `initializePromise`, so concurrent
 * rebuild requests must produce zero duplicates.
 */

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-context-menu-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-context-menu');
fs.rmSync(profile, { recursive: true, force: true });

const MENU_IDS = ['subvault-fill', 'subvault-generate', 'subvault-open'];
const checks = {};
const errors = [];
let context = null;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
    ],
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = worker.url().split('/')[2];

  const options = await context.newPage();
  options.on('pageerror', (error) => errors.push(`options: ${error}`));
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'Menu-Pass-2026!x9Kq7vT' });
    await chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: {
        lockOnSystemLock: false,
        lockOnSystemIdle: false,
        autoLockMinutes: 0,
        showIcon: true,
      },
    });
  });
  await options.waitForTimeout(1200);

  // Install a recorder over the contextMenus API. `create` is synchronous and
  // `removeAll` resolves on a later task, mirroring the real API's asymmetry
  // that makes overlapping rebuilds collide.
  checks.recorderInstalled = await worker.evaluate(() => {
    const state = { present: new Set(), duplicates: [], creates: 0, removes: 0 };
    globalThis.__menuRecorder = state;
    try {
      chrome.contextMenus.create = (details, callback) => {
        state.creates += 1;
        if (state.present.has(details.id)) state.duplicates.push(details.id);
        state.present.add(details.id);
        if (typeof callback === 'function') setTimeout(callback, 0);
      };
      chrome.contextMenus.removeAll = (callback) => {
        state.removes += 1;
        state.present.clear();
        if (typeof callback === 'function') setTimeout(callback, 0);
      };
      return true;
    } catch {
      return false;
    }
  });

  // Every settings update calls buildContextMenus(). All ten keep showIcon
  // enabled, so every rebuild reaches the create phase — unserialized they
  // interleave as removeAll×10 then create×3×10, and the 2nd..10th batches
  // duplicate ids 1..3.
  await options.evaluate(async () => {
    const calls = [];
    for (let i = 0; i < 10; i += 1) {
      calls.push(
        chrome.runtime.sendMessage({
          type: 'SV_SET_SETTINGS',
          settings: { showIcon: true },
        }),
      );
    }
    await Promise.all(calls);
  });
  await options.waitForTimeout(1500);

  const burst = await worker.evaluate(() => {
    const state = globalThis.__menuRecorder;
    return {
      duplicates: state.duplicates,
      creates: state.creates,
      removes: state.removes,
      present: [...state.present],
    };
  });
  checks.burst = burst;

  // After the storm settles, exactly the three ids must be registered — a
  // duplicate-id failure can otherwise leave a generation half-applied.
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { showIcon: true } }),
  );
  await options.waitForTimeout(900);
  checks.settled = await worker.evaluate(() => {
    const state = globalThis.__menuRecorder;
    return [...state.present].sort();
  });

  // Turning the floating trigger off must clear all three ids.
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { showIcon: false } }),
  );
  await options.waitForTimeout(900);
  checks.afterDisable = await worker.evaluate(() => [...globalThis.__menuRecorder.present]);

  checks.pass =
    checks.recorderInstalled === true
    && burst.duplicates.length === 0
    && burst.creates >= MENU_IDS.length * 2
    && checks.settled.length === MENU_IDS.length
    && MENU_IDS.every((menuId) => checks.settled.includes(menuId))
    && checks.afterDisable.length === 0
    && errors.length === 0;
} catch (error) {
  checks.error = String(error?.stack || error);
  checks.pass = false;
} finally {
  if (context) await context.close().catch(() => {});
}

console.log(JSON.stringify({ ...checks, errors }, null, 2));
process.exit(checks.pass && errors.length === 0 ? 0 : 1);
