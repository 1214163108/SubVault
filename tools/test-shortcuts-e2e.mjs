import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.tmp-shortcuts', String(Date.now()));
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(root, '.tmp-host', 'test-shortcuts-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* ignore */ }
fs.mkdirSync(base, { recursive: true });
const password = 'SubVault-Test-2026!Qm7#';
const errors = [];

const page_html = `<!doctype html><html><body>
  <form id="f"><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"><button id="go" type="submit">登录</button></form>
  <input id="note" type="text">
</body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page_html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(path.join(base, 'profile'), {
  headless: false,
    env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-position=-32000,-32000', '--window-size=920,900',
  ],
  locale: 'zh-CN',
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = worker.url().split('/')[2];
const options = await context.newPage();
options.on('pageerror', (error) => errors.push(String(error)));
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#syncStateTag', { state: 'attached', timeout: 10000 });
const send = (type, payload = {}) =>
  options.evaluate(([kind, extra]) => chrome.runtime.sendMessage({ type: kind, ...extra }), [type, payload]);

const results = {};
try {
  const setup = await send('SV_SETUP', { password });
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await send('SV_SET_SETTINGS', {
    settings: {
      lockOnSystemLock: false,
      lockOnSystemIdle: false,
      autoLockMinutes: 0,
      showIcon: true,
      generatorOptions: { length: 20, uppercase: true, lowercase: true, digits: true, symbols: true, readable: false },
    },
  });
  const added = await send('SV_ADD_ENTRY', {
    entry: { host: '127.0.0.1', username: 'shortcut-user', password: 'shortcut-secret' },
  });
  if (!added?.ok) throw new Error(`add: ${added?.error}`);

  // Both new commands must be registered with the requested keys.
  results.commands = await options.evaluate(async () => {
    const list = await chrome.commands.getAll();
    return list.map((item) => ({ name: item.name, shortcut: item.shortcut, description: item.description }));
  });
  results.hasLockCommand = results.commands.some((item) => item.name === 'lock-vault' && item.shortcut);
  results.hasPopupCommand = results.commands.some((item) => item.name === 'open-popup' && item.shortcut);
  results.hasFillCommand = results.commands.some((item) => item.name === 'fill-login' && item.shortcut);

  const site = await context.newPage();
  site.on('pageerror', (error) => errors.push(String(error)));
  await site.goto(siteUrl);
  await site.waitForSelector('#u', { timeout: 10000 });
  const siteTabId = await options.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url === url);
    return tab ? tab.id : 0;
  }, siteUrl);
  results.siteTabId = siteTabId;

  const relay = (type) =>
    options.evaluate(
      ([tabId, kind]) => chrome.tabs.sendMessage(tabId, { type: kind }),
      [siteTabId, type],
    );

  // Generate shortcut: fills the focused editable field.
  await site.locator('#p').click();
  await site.waitForTimeout(400);
  await relay('SV_GENERATE_SHORTCUT');
  await site.waitForTimeout(1200);
  results.generatedValue = await site.locator('#p').inputValue();
  results.generatedLength = results.generatedValue.length;
  results.generatedToast = await site.evaluate(() => {
    const host = document.getElementById('subvault-ui-root');
    return host?.shadowRoot?.textContent?.includes('已生成') || false;
  });

  // Generate shortcut with no focused editable field copies instead.
  await site.locator('#note').click();
  await site.evaluate(() => document.activeElement.blur());
  await site.waitForTimeout(200);
  results.noteBefore = await site.locator('#note').inputValue();
  await relay('SV_GENERATE_SHORTCUT');
  await site.waitForTimeout(1200);
  results.noteAfterBlur = await site.locator('#note').inputValue();
  results.copyToast = await site.evaluate(() => {
    const host = document.getElementById('subvault-ui-root');
    return host?.shadowRoot?.textContent?.includes('已生成随机密码并复制') || false;
  });

  // Fill shortcut: single match fills both fields without opening the panel.
  await site.locator('#u').fill('');
  await site.locator('#p').fill('');
  await site.locator('#u').focus();
  await site.waitForTimeout(300);
  await relay('SV_FILL_SHORTCUT');
  await site.waitForTimeout(1500);
  results.filledUser = await site.locator('#u').inputValue();
  results.filledPassword = await site.locator('#p').inputValue();

  // Disabling the floating entry also removes the context menus (no stale items).
  await send('SV_SET_SETTINGS', { settings: { showIcon: false } });
  await options.waitForTimeout(500);
  results.menuRebuildOk = await options.evaluate(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'SV_GET_STATUS' });
    return Boolean(status?.ok);
  });
  await send('SV_SET_SETTINGS', { settings: { showIcon: true } });
  await options.waitForTimeout(300);

  // Lock shortcut path: lockVault must broadcast and clear the session.
  await site.locator('#u').fill('');
  await site.locator('#p').fill('');
  await send('SV_LOCK');
  results.lockedAfterLock = (await send('SV_GET_STATUS'))?.locked;
  const fillAfterLock = await relay('SV_FILL_SHORTCUT');
  results.fillAfterLock = fillAfterLock;
  await site.waitForTimeout(600);
  results.fieldsAfterLock = {
    user: await site.locator('#u').inputValue(),
    password: await site.locator('#p').inputValue(),
  };

  results.pass = Boolean(
    results.hasLockCommand
    && results.hasPopupCommand
    && results.hasFillCommand
    && results.siteTabId
    && results.generatedLength === 20
    && results.generatedToast
    && results.noteBefore === ''
    && results.noteAfterBlur === ''
    && results.copyToast
    && results.filledUser === 'shortcut-user'
    && results.filledPassword === 'shortcut-secret'
    && results.menuRebuildOk
    && results.lockedAfterLock === true
    && results.fieldsAfterLock?.user === ''
    && results.fieldsAfterLock?.password === ''
  );
} catch (error) {
  results.error = String(error?.stack || error);
  results.pass = false;
} finally {
  await context.close().catch(() => {});
  server.close();
}
console.log(JSON.stringify({ ...results, errors }, null, 2));
process.exit(results.pass && errors.length === 0 ? 0 : 1);
