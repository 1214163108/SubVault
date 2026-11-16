import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'alias-fill-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const pageHtml = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button id="seq-flag" type="button" onclick="window.__seqClicked = true">sequence flag</button>
    <button type="submit">登录</button>
  </form>
</body></html>`;

const signupHtml = `<!doctype html><html><body>
  <form id="signup" onsubmit="event.preventDefault()">
    <label>邮箱 <input name="email" type="email" autocomplete="email" /></label>
    <label>密码 <input name="new-password" type="password" autocomplete="new-password" /></label>
    <label>确认密码 <input name="confirm-password" type="password" autocomplete="new-password" /></label>
    <button type="submit">注册</button>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(request.url === '/signup' ? signupHtml : pageHtml);
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
let failure = null;
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));

  const setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: {
        lockOnSystemLock: false,
        lockOnSystemIdle: false,
        autoLockMinutes: 0,
        autoOpenOnFocus: false,
      },
    }),
  );

  const added = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: '127.0.0.1',
        username: 'bob',
        password: 'bob-secret-123',
        aliasEmail: 'alias@simplelogin.example',
        aliasProvider: 'SimpleLogin',
        fillSequence: [{ type: 'username' }, { type: 'wait', ms: 120 }, { type: 'password' }, { type: 'click', selector: '#seq-flag' }],
      },
    }),
  );
  if (!added?.ok) throw new Error(`add: ${added?.error}`);

  const matches = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_GET_MATCHES', host: '127.0.0.1' }),
  );
  result.aliasInMatches = matches?.matches?.[0]?.aliasEmail || null;
  result.allowSequenceSubmitDefault = await options.evaluate(async () => {
    const settings = await chrome.runtime.sendMessage({ type: 'SV_GET_SETTINGS' });
    return settings?.settings?.allowSequenceSubmit;
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(600);
  await page.locator('input[name="username"]').focus();
  await page.waitForTimeout(300);
  await page.locator('[data-subvault-trigger]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-subvault-account]').filter({ hasText: 'bob' }).first().click();
  await page.waitForTimeout(600);

  result.filled = await page.evaluate(() => ({
    username: document.querySelector('input[name="username"]').value,
    password: document.querySelector('input[name="password"]').value,
    seqClicked: window.__seqClicked === true,
    toast: document.getElementById('subvault-ui-root')?.shadowRoot?.querySelector('.sv-toast')?.textContent || '',
  }));

  const signup = await context.newPage();
  await signup.goto(`http://127.0.0.1:${port}/signup`);
  await signup.waitForTimeout(500);
  await signup.locator('input[name="new-password"]').focus();
  await signup.waitForTimeout(300);
  const aliasButton = signup.locator('[data-subvault-alias]');
  result.signupAliasChip = await aliasButton.isVisible();
  await aliasButton.click();
  await signup.waitForTimeout(300);
  result.aliasRows = await signup.locator('.sv-alias-item').count();
  result.aliasPanelText = await signup.locator('.sv-alias-panel').innerText();
  await signup.locator('.sv-alias-item').first().click();
  await signup.waitForTimeout(300);
  result.aliasToast = await signup.evaluate(
    () => document.getElementById('subvault-ui-root')?.shadowRoot?.querySelector('.sv-toast')?.textContent || '',
  );

  await options.bringToFront();
  await options.reload();
  await options.locator('.entry-card').first().waitFor({ state: 'visible', timeout: 10000 });
  await options.waitForTimeout(300);
  const cardText = await options.locator('.entry-card').first().textContent();
  result.cardHasAlias = Boolean(cardText && cardText.includes('别名 alias@simplelogin.example'));
  await options.locator('.entry-card .entry-actions button', { hasText: '编辑' }).first().click();
  await options.waitForTimeout(300);
  result.dialog = {
    aliasEmail: await options.locator('#entryAliasEmail').inputValue(),
    aliasProvider: await options.locator('#entryAliasProvider').inputValue(),
    steps: await options.locator('#entryFillSteps').inputValue(),
  };
  await options.locator('#entryClose').click();

  const passed =
    result.aliasInMatches === 'alias@simplelogin.example' &&
    result.allowSequenceSubmitDefault === false &&
    result.filled.username === 'bob' &&
    result.filled.password === 'bob-secret-123' &&
    result.filled.seqClicked === true &&
    result.filled.toast.includes('已按填充序列执行') &&
    result.cardHasAlias === true &&
    result.dialog.aliasEmail === 'alias@simplelogin.example' &&
    result.dialog.aliasProvider === 'SimpleLogin' &&
    result.signupAliasChip === true &&
    result.aliasRows === 1 &&
    result.aliasPanelText.includes('alias@simplelogin.example') &&
    result.aliasToast.includes('已复制别名邮箱') &&
    result.dialog.steps.includes('wait 120') &&
    result.dialog.steps.includes('click #seq-flag');

  result.pass = passed;
  if (!passed) throw new Error(`alias/fill failed: ${JSON.stringify(result)}`);
} catch (error) {
  failure = error;
  result.pass = false;
  result.error = String(error?.message || error);
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify(result, null, 2));
  if (failure) process.exitCode = 1;
}
