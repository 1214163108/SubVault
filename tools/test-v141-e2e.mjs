import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'v141-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const loginHtml = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">登录</button>
  </form>
</body></html>`;

const signupHtml = `<!doctype html><html><body>
  <form id="signup" onsubmit="event.preventDefault()">
    <label>邮箱 <input name="email" type="email" autocomplete="email" /></label>
    <label>密码 <input name="password" type="password" autocomplete="new-password" /></label>
    <label>确认密码 <input name="confirm" type="password" autocomplete="new-password" /></label>
    <button type="submit">注册</button>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  const pathname = request.url.split('?')[0];
  response.end(pathname === '/signup' ? signupHtml : loginHtml);
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

  // 0. Offline strength meter in the popup setup screen (no vault yet).
  const popupEarly = await context.newPage();
  await popupEarly.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popupEarly.waitForTimeout(600);
  await popupEarly.locator('#setupPassword').fill('password1234');
  await popupEarly.waitForTimeout(700);
  const weakUi = {
    text: (await popupEarly.locator('#setupStrengthText').textContent())?.trim(),
    hint: (await popupEarly.locator('#setupStrengthHint').textContent())?.trim(),
    ackVisible: await popupEarly.locator('#setupStrengthAckLabel').isVisible(),
  };
  await popupEarly.locator('#setupPassword').fill('SubVault-Test-2026!Qm7#');
  await popupEarly.waitForTimeout(700);
  const strongUi = {
    hintHidden: await popupEarly.locator('#setupStrengthHint').isHidden(),
    ackHidden: await popupEarly.locator('#setupStrengthAckLabel').isHidden(),
  };
  result.masterStrengthUi = { weak: weakUi, strong: strongUi };
  await popupEarly.close();

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
        autoOpenOnFocus: false,
        autoLockMinutes: 0,
      },
    }),
  );
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: '127.0.0.1', username: 'alice', password: 'alice-secret' },
    }),
  );

  // 1. Unlock broadcasts to open tabs without a page refresh.
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(600);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LOCK' }));
  await page.waitForTimeout(400);
  await page.locator('input[name="username"]').focus();
  await page.waitForTimeout(300);
  const triggerWhileLocked = await page
    .locator('[data-subvault-trigger]')
    .isVisible()
    .catch(() => false);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_UNLOCK', password: 'SubVault-Test-2026!Qm7#' }),
  );
  await page.locator('[data-subvault-trigger]').waitFor({ state: 'visible', timeout: 8000 });
  result.unlockLiveSync = {
    triggerWhileLocked,
    triggerAfterUnlock: await page.locator('[data-subvault-trigger]').isVisible(),
  };

  // 2. Signup form shows the inline generator and captures the new account.
  const signup = await context.newPage();
  await signup.goto(`http://127.0.0.1:${port}/signup`);
  await signup.waitForTimeout(600);
  await signup.locator('input[name="password"]').focus();
  const chip = signup.locator('[data-subvault-generate]');
  await chip.waitFor({ state: 'visible', timeout: 8000 });
  await chip.click();
  await signup.waitForTimeout(600);
  const generated = await signup.locator('input[name="password"]').inputValue();
  const confirmed = await signup.locator('input[name="confirm"]').inputValue();
  const toast = await signup.locator('.sv-toast').textContent().catch(() => '');
  result.signupGenerator = {
    length: generated.length,
    matchesConfirm: generated.length > 0 && generated === confirmed,
    toast: (toast || '').replace(/\s+/g, ' ').trim(),
  };

  await signup.locator('input[name="email"]').fill('newbie@example.com');
  await signup.locator('button[type="submit"]').click();
  const banner = signup.locator('[data-subvault-save-banner]');
  await banner.waitFor({ state: 'visible', timeout: 8000 });
  result.signupSave = {
    kicker: (await banner.locator('.sv-banner-kicker').textContent())?.trim(),
    title: (await banner.locator('.sv-banner-title').textContent())?.trim(),
  };

  // 3. Popup standalone generator fills the add-entry dialog.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.bringToFront();
  await popup.waitForTimeout(700);
  const popupShield = popup.locator('#privacyShield');
  if (await popupShield.isVisible().catch(() => false)) await popupShield.click();
  await popup.locator('#genBtn').click();
  await popup.locator('#genDialog').waitFor({ state: 'visible', timeout: 5000 });
  const output = ((await popup.locator('#genOutput').textContent()) || '').trim();
  await popup.locator('#genUse').click();
  await popup.waitForTimeout(400);
  const entryPassword = await popup.locator('#entryPassword').inputValue();
  result.popupGenerator = {
    outputLength: output.length,
    outputMatchesEntry: output.length > 0 && output === entryPassword,
  };
  await popup.locator('#entryDialog').evaluate((el) => el.close?.());
  await popup.close();

  // 4. Weak master passwords are rejected server-side.
  const weak = await options
    .evaluate(() =>
      chrome.runtime
        .sendMessage({
          type: 'SV_CHANGE_MASTER',
          currentPassword: 'SubVault-Test-2026!Qm7#',
          newPassword: 'password1234',
        })
        .then((response) => ({ ok: response?.ok, error: response?.error }))
        .catch((error) => ({ ok: false, error: String(error?.message || error) })),
    )
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  result.weakMasterRejected = {
    ok: weak.ok === false,
    error: (weak.error || '').slice(0, 120),
  };

  // 5. A strong master password still changes successfully.
  const strong = await options
    .evaluate(() =>
      chrome.runtime
        .sendMessage({
          type: 'SV_CHANGE_MASTER',
          currentPassword: 'SubVault-Test-2026!Qm7#',
          newPassword: 'Zt7#Qm2vLp9@Rt4xWn6!',
        })
        .then((response) => ({ ok: response?.ok, error: response?.error }))
        .catch((error) => ({ ok: false, error: String(error?.message || error) })),
    )
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  result.strongMasterAccepted = strong;

  console.log(JSON.stringify(result, null, 2));
  const passed =
    result.unlockLiveSync.triggerWhileLocked === false &&
    result.unlockLiveSync.triggerAfterUnlock === true &&
    result.signupGenerator.length === 20 &&
    result.signupGenerator.matchesConfirm === true &&
    result.signupSave.kicker === '保存新账号' &&
    result.popupGenerator.outputLength === 20 &&
    result.popupGenerator.outputMatchesEntry === true &&
    result.masterStrengthUi.weak.hint.includes('强度过低') &&
    result.masterStrengthUi.weak.ackVisible === false &&
    result.masterStrengthUi.strong.hintHidden === true &&
    result.masterStrengthUi.strong.ackHidden === true &&
    result.weakMasterRejected.ok === true &&
    result.strongMasterAccepted.ok === true;
  console.log(`PASS=${passed}`);
  if (!passed) process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
