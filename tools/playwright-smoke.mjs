import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'smoke-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const MASTER = 'correct horse battery staple';
const PORT = 8766;

const html = `<!doctype html><html><head><title>SubVault fixture</title></head>
<body>
  <form>
    <label>Username <input name="username" autocomplete="username" /></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">登录</button>
  </form>
</body></html>`;

const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
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
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  if (!extensionId) throw new Error('no extension id');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));

  const setup = await options.evaluate(
    (password) => chrome.runtime.sendMessage({ type: 'SV_SETUP', password }),
    MASTER,
  );
  if (!setup?.ok) throw new Error(`setup failed: ${setup?.error || 'unknown'}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false },
    }),
  );

  const added = await options.evaluate(
    ({ port }) =>
      chrome.runtime.sendMessage({
        type: 'SV_ADD_ENTRY',
        entry: {
          host: '127.0.0.1',
          port: String(port),
          title: 'Local fixture',
          username: 'dev',
          password: 'local-password',
          url: `http://127.0.0.1:${port}/`,
        },
      }),
    { port: PORT },
  );
  if (!added?.ok) throw new Error(`add failed: ${added?.error || 'unknown'}`);

  const login = await context.newPage();
  await login.goto(`http://127.0.0.1:${PORT}/`);
  await login.waitForSelector('input[name="password"]');
  await login.waitForTimeout(1000);

  const tabId = await options.evaluate(
    async (port) => {
      const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/*` });
      return tabs[0]?.id || 0;
    },
    PORT,
  );
  if (!tabId) throw new Error('fixture tab not found');

  const result = await options.evaluate(
    ({ id, tab }) =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(tab, { type: 'SV_FILL_BY_ID', id }, (response) => {
          resolve(response || { error: chrome.runtime.lastError?.message || 'no response' });
        });
      }),
    { id: added.id, tab: tabId },
  );
  if (!result?.ok) throw new Error(`fill failed: ${JSON.stringify(result)}`);

  await login.waitForTimeout(200);
  const values = await login.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value || '',
    password: document.querySelector('input[name="password"]')?.value || '',
  }));
  if (values.username !== 'dev' || values.password !== 'local-password') {
    throw new Error(`unexpected values: ${JSON.stringify(values)}`);
  }

  console.log(JSON.stringify({ ok: true, extensionId, values }, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
