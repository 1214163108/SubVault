import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  createKdfParams,
  deriveKeyFromKdf,
  encryptJSON,
} from '../src/lib/crypto.js';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'vaultkey-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const password = 'SubVault-VaultKey-2026!Qm7#';
const kdf = createKdfParams();
const key = await deriveKeyFromKdf(password, kdf);
const legacyData = {
  version: 3,
  entries: [
    {
      id: 'legacy-entry',
      host: 'example.com',
      username: 'legacy@example.com',
      password: 'legacy-secret',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};
const box = await encryptJSON(key, legacyData, 'subvault:vault:v1');
const legacyBlob = {
  v: 3,
  cipher: 'AES-GCM',
  kdf,
  box,
  createdAt: 1,
  updatedAt: 1,
};

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

const result = { pass: false, errors: [] };
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];

  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await seed.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  await seed.evaluate(async (blob) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ vault: blob });
  }, legacyBlob);
  await seed.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html#security`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  await options.waitForTimeout(400);

  const unlocked = await options.evaluate((password) =>
    chrome.runtime.sendMessage({ type: 'SV_UNLOCK', password }), password);
  result.unlocked = unlocked;

  const stored = await options.evaluate(() => chrome.storage.local.get(['vault', 'vaultBackup:default']));
  result.stored = {
    version: stored.vault?.v,
    hasWrappedKey: Boolean(stored.vault?.wrappedKey?.data),
    hasBackup: Boolean(stored['vaultBackup:default']?.blob),
  };

  const status = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_GET_MIGRATION_STATUS' }));
  result.status = {
    ok: status.ok,
    currentVersion: status.currentVersion,
    exists: status.exists,
    fromVersion: status.fromVersion,
  };

  await options.reload();
  await options.waitForTimeout(700);
  await options.evaluate(() => {
    location.hash = '#security';
  });
  await options.waitForTimeout(400);
  result.card = {
    tag: (await options.locator('#migrationTag').textContent().catch(() => ''))?.trim(),
    status: (await options.locator('#migrationStatus').textContent().catch(() => ''))?.trim(),
    rollbackVisible: await options.locator('#migrationRollbackRow').isVisible().catch(() => false),
  };

  const rollback = await options.evaluate((password) =>
    chrome.runtime.sendMessage({ type: 'SV_ROLLBACK_MIGRATION', password }), password);
  result.rollback = { ok: rollback.ok, version: rollback.version };
  const afterRollback = await options.evaluate(async () => {
    const stored = await chrome.storage.local.get(['vault', 'vaultBackup:default']);
    return { version: stored.vault?.v, hasBackup: Boolean(stored['vaultBackup:default']) };
  });
  result.afterRollback = afterRollback;

  const second = await options.evaluate((password) =>
    chrome.runtime.sendMessage({ type: 'SV_UNLOCK', password }), password);
  result.remigrated = { ok: second.ok, migrated: second.migrated, format: second.format };

  result.pass = Boolean(
    unlocked.ok &&
      unlocked.migrated &&
      unlocked.format === 4 &&
      result.stored.version === 4 &&
      result.stored.hasWrappedKey &&
      result.stored.hasBackup &&
      status.ok &&
      status.currentVersion === 4 &&
      status.exists &&
      result.card.tag === 'v4' &&
      result.card.rollbackVisible &&
      result.rollback.ok &&
      result.afterRollback.version === 3 &&
      !result.afterRollback.hasBackup &&
      second.ok &&
      second.migrated &&
      second.format === 4,
  );
} catch (error) {
  result.errors.push(error?.stack || String(error));
} finally {
  console.log(JSON.stringify(result, null, 2));
  await context.close();
}
