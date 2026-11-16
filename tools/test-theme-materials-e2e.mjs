import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'theme-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const html = '<!doctype html><html><body><form><label>User <input name="username" autocomplete="username"></label><label>Pass <input name="password" type="password"></label></form></body></html>';
const server = http.createServer((req, res) => { res.setHeader('content-type','text/html; charset=utf-8'); res.end(html); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--no-default-browser-check', '--window-position=-32000,-32000', '--window-size=1000,900'],
});
const result = { combos: [], errors: [] };
let failure = null;
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }));
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } }));
  await options.waitForSelector('#gate', { state: 'hidden' });

  for (const theme of ['light', 'dark']) {
    for (const material of ['solid', 'glass', 'liquid']) {
      await options.evaluate((settings) => chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings }), { theme, material });
      await options.reload();
      await options.waitForSelector('#gate', { state: 'hidden' });
      await options.waitForTimeout(120);
      const snap = await options.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const card = document.querySelector('.card');
        return {
          theme: document.documentElement.dataset.theme || '',
          material: document.documentElement.dataset.material || '',
          surface: style.getPropertyValue('--surface').trim(),
          cardBg: card ? getComputedStyle(card).backgroundColor : '',
          filter: card ? getComputedStyle(card).backdropFilter : '',
        };
      });
      result.combos.push({ ...snap, requestedTheme: theme, requestedMaterial: material });
    }
  }

  const page = await context.newPage();
  page.on('pageerror', (e) => result.errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(600);
  const readHost = () => page.evaluate(() => {
    const host = document.getElementById('subvault-ui-root');
    return { theme: host?.dataset.theme || '', material: host?.dataset.material || '' };
  });
  await options.bringToFront();
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { theme: 'dark', material: 'liquid' } }));
  await page.bringToFront();
  await page.waitForTimeout(700);
  result.contentDarkLiquid = await readHost();
  await options.bringToFront();
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { theme: 'light', material: 'solid' } }));
  await page.bringToFront();
  await page.waitForTimeout(700);
  result.contentLightSolid = await readHost();

  const signatures = new Set(result.combos.map((c) => `${c.surface}|${c.cardBg}|${c.filter}`));
  result.distinctCombos = signatures.size;
  const bad = result.combos.filter((c) => c.theme !== c.requestedTheme || c.material !== c.requestedMaterial);
  result.bad = bad;
  result.pass = result.combos.length === 6 && result.distinctCombos === 6 && bad.length === 0 &&
    result.contentDarkLiquid.theme === 'dark' && result.contentDarkLiquid.material === 'liquid' &&
    result.contentLightSolid.theme === 'light' && result.contentLightSolid.material === 'solid' &&
    result.errors.length === 0;
  if (!result.pass) throw new Error(`theme combos failed: ${JSON.stringify(result)}`);
} catch (error) {
  failure = error;
  result.pass = false;
  result.error = String(error?.message || error);
} finally {
  await context.close().catch(() => {});
  await new Promise((r) => server.close(r));
  console.log(JSON.stringify(result, null, 2));
  if (failure) process.exitCode = 1;
}
