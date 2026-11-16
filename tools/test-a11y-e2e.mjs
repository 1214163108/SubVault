import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'a11y-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const html = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">登录</button>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

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
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );
  for (const [username, password] of [
    ['alice', 'alice-secret'],
    ['bob', 'bob-secret'],
  ]) {
    await options.evaluate(
      ([u, p]) =>
        chrome.runtime.sendMessage({
          type: 'SV_ADD_ENTRY',
          entry: { host: '127.0.0.1', username: u, password: p },
        }),
      [username, password],
    );
  }

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(900);
  const username = page.locator('input[name="username"]');
  await username.click();
  await page.waitForTimeout(400);
  const trigger = page.locator('[data-subvault-trigger]');
  await trigger.click();
  await page.waitForTimeout(400);

  result.expanded = await username.getAttribute('aria-expanded');
  result.haspopup = await username.getAttribute('aria-haspopup');
  result.controls = await username.getAttribute('aria-controls');
  result.panelRole = await page.locator('#sv-list').getAttribute('role');
  result.options = await page.locator('[data-subvault-popover] .sv-item').count();
  result.firstSelected = await page.locator('[data-subvault-popover] .sv-item').first().getAttribute('aria-selected');
  result.activeDescendant = await username.getAttribute('aria-activedescendant');

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  result.afterDown = {
    activeDescendant: await username.getAttribute('aria-activedescendant'),
    selected: await page.locator('[data-subvault-popover] .sv-item[aria-selected="true"]').count(),
    tabIndexes: await page
      .locator('[data-subvault-popover] .sv-item')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('tabindex'))),
  };

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  result.afterEscape = {
    expanded: await username.getAttribute('aria-expanded'),
    activeDescendant: await username.getAttribute('aria-activedescendant'),
    panelHidden: await page.locator('[data-subvault-popover]').isHidden(),
  };

  result.pass =
    result.expanded === 'true' &&
    result.haspopup === 'listbox' &&
    result.controls === 'sv-panel' &&
    result.panelRole === 'listbox' &&
    result.options === 2 &&
    result.firstSelected === 'true' &&
    Boolean(result.activeDescendant) &&
    result.afterDown.selected === 1 &&
    result.afterEscape.expanded === 'false' &&
    result.afterEscape.panelHidden;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  server.close();
}
