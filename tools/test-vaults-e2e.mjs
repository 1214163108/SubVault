import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-vaults-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const PROFILE = path.join(ROOT, '.tmp-vaults', String(Date.now()));
const MASTER = 'SubVault-Test-2026!Qm7#';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
  ],
});
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#gate');

const errors = [];
options.on('pageerror', (error) => errors.push(String(error)));
options.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(MASTER);
  else await dialog.accept();
});

const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const result = {};

await send({ type: 'SV_SETUP', password: MASTER });
await send({ type: 'SV_SET_SETTINGS', settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } });
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden' });
await options.click('[data-section="general"]');
await options.waitForSelector('.vault-manage-row');
result.initialRows = await options.locator('.vault-manage-row').count();

await options.fill('#newVaultName', '工作库');
await options.fill('#newVaultPassword', MASTER);
await options.click('#newVaultCreateBtn');
await options.waitForSelector('#gateVaultSelect option:nth-child(2)', { state: 'attached' });
result.gateVisibleAfterCreate = await options.locator('#gate').isVisible();
result.vaultOptions = await options.locator('#gateVaultSelect option').count();
await options.selectOption('#gateVaultSelect', { label: '工作库' });
await options.fill('#gatePassword', MASTER);
await options.click('#gateUnlockBtn');
await options.waitForSelector('#gate', { state: 'hidden' });
result.unlockedWork = await options.locator('#lockState').textContent();

await send({ type: 'SV_ADD_ENTRY', entry: { host: 'example.com', username: 'work-user', password: 'work-secret-1' } });
const afterAdd = await send({ type: 'SV_GET_STATUS' });
result.workActiveDiffers = afterAdd.activeVaultId !== 'default';
result.workCount = afterAdd.vaults?.length;

await options.click('[data-section="general"]');
await options.waitForSelector('.vault-manage-row');
result.rowsAfterCreate = await options.locator('.vault-manage-row').count();
await options.locator('.vault-manage-row[data-vault-id="default"] button', { hasText: '切换' }).click();
await options.waitForSelector('#gateVaultSelect', { state: 'visible' });
await options.selectOption('#gateVaultSelect', 'default');
await options.fill('#gatePassword', MASTER);
await options.click('#gateUnlockBtn');
await options.waitForSelector('#gate', { state: 'hidden' });
const defaultState = await send({ type: 'SV_GET_STATUS' });
result.defaultActive = defaultState.activeVaultId === 'default';
result.defaultMatches = defaultState.matches?.length || 0;

await options.click('[data-section="general"]');
await options.waitForSelector('.vault-manage-row');
const workRow = options.locator('.vault-manage-row').filter({ hasText: '工作库' });
await workRow.locator('button', { hasText: '删除' }).click();
await options.waitForTimeout(1200);
const afterDelete = await send({ type: 'SV_GET_STATUS' });
result.afterDeleteVaults = afterDelete.vaults?.length;
result.defaultStillActive = afterDelete.activeVaultId === 'default';
result.errors = errors;
result.pass = result.initialRows === 1
  && result.gateVisibleAfterCreate
  && result.vaultOptions === 2
  && result.unlockedWork.includes('已解锁')
  && result.workActiveDiffers
  && result.rowsAfterCreate === 2
  && result.defaultActive
  && result.defaultMatches === 0
  && result.afterDeleteVaults === 1
  && result.defaultStillActive
  && errors.length === 0;
console.log(JSON.stringify(result, null, 2));
await context.close();
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!result.pass) process.exit(1);
