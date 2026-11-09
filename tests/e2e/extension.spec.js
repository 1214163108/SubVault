import { chromium, expect, test } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASTER = 'correct horse battery staple';

let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <html><head><title>SubVault fixture</title></head>
      <body>
        <form id="login">
          <label>Username <input name="username" autocomplete="username" /></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" /></label>
          <button type="submit">登录</button>
        </form>
      </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('extension can create a vault, save an account, and fill a login form', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-32000,-32000',
      '--window-size=800,600',
    ],
  });

  try {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
    const extensionId = serviceWorker.url().split('/')[2];
    expect(extensionId).toBeTruthy();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));

    await options.fill('#gateNewPassword', MASTER);
    await options.fill('#gateConfirmPassword', MASTER);
    await options.check('#gateAck');
    await options.click('#gateSetupBtn');
    await expect(options.locator('#gate')).toBeHidden({ timeout: 15_000 });

    await options.click('#headAddBtn');
    await options.fill('#entryHost', `127.0.0.1:${server.address().port}`);
    await options.fill('#entryTitle', 'Local fixture');
    await options.fill('#entryUsername', 'dev');
    await options.fill('#entryPassword', 'local-password');
    await options.click('#entrySave');
    await expect(options.locator('#entryDialog')).toBeHidden({ timeout: 10_000 });

    const login = await context.newPage();
    await login.goto(baseUrl);
    await login.waitForSelector('input[name="password"]');
    await login.waitForTimeout(1000);

    const addedId = await options.evaluate(async (port) => {
      const entries = await chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' });
      return entries.entries.find((entry) => entry.port === String(port))?.id || '';
    }, server.address().port);
    expect(addedId).toBeTruthy();

    const tabId = await options.evaluate(async (port) => {
      const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/*` });
      return tabs[0]?.id || 0;
    }, server.address().port);
    expect(tabId).toBeTruthy();

    const filled = await options.evaluate(
      ({ id, tab }) => chrome.tabs.sendMessage(tab, { type: 'SV_FILL_BY_ID', id }),
      { id: addedId, tab: tabId },
    );
    expect(filled.ok).toBe(true);

    await expect(login.locator('input[name="username"]')).toHaveValue('dev');
    await expect(login.locator('input[name="password"]')).toHaveValue('local-password');
  } finally {
    await context.close();
  }
});
