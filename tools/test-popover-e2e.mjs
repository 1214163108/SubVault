import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'popover-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const form = `
  <form id="login">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">登录</button>
  </form>`;

const pages = {
  '/normal': `<!doctype html><html><body>${form}</body></html>`,
  '/iframe': `<!doctype html><html><body><iframe id="frame" src="/normal?iframe=1" style="width:500px;height:300px"></iframe></body></html>`,
  '/shadow': `<!doctype html><html><body><div id="shadow-host"></div><script>
    const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    root.innerHTML = ${JSON.stringify(form)};
  </script></body></html>`,
  '/username': `<!doctype html><html><body><form>
    <input name="username" autocomplete="username" />
    <button type="button">下一步</button>
  </form></body></html>`,
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = pages[url.pathname] || pages['/normal'];
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

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

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'popover-password' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false },
    }),
  );
  const added = await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: '127.0.0.1',
        title: 'Popover account',
        username: 'alice',
        password: 'secret-value',
      },
    }),
  );
  if (!added?.ok) throw new Error(`add: ${added?.error}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: '127.0.0.1',
        title: 'Second account',
        username: 'bob',
        password: 'bob-secret',
      },
    }),
  );

  async function openPopover(scope) {
    const username = scope.locator('input[name="username"]');
    await username.click();
    await scope.waitForTimeout(500);
    const trigger = scope.locator('[data-subvault-trigger]');
    await trigger.waitFor({ state: 'visible', timeout: 8000 });
    await username.click();
    await scope.waitForTimeout(500);
    await trigger.waitFor({ state: 'visible', timeout: 8000 });
    await trigger.click();
    const popover = scope.locator('[data-subvault-popover]');
    await popover.waitFor({ state: 'visible', timeout: 5000 });
    return popover;
  }

  const normal = await context.newPage();
  await normal.goto(`${base}/normal`);
  await normal.waitForTimeout(600);
  const badgeText = await options.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({ url: 'http://127.0.0.1/*' }, (tabs) => {
          const tab = tabs.find((item) => item.url.includes('/normal'));
          if (!tab) return resolve('');
          chrome.action.getBadgeText({ tabId: tab.id }, resolve);
        });
      }),
  );
  if (badgeText !== '2') throw new Error(`badge mismatch: ${badgeText}`);
  await normal.locator('input[name="password"]').click();
  await normal.waitForTimeout(500);
  const passwordTrigger = normal.locator('[data-subvault-trigger]');
  if (await passwordTrigger.isVisible()) {
    throw new Error('trigger should not appear on password field');
  }
  const normalPopover = await openPopover(normal);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  await normal.screenshot({ path: path.join(root, 'docs', 'popover.png') });
  if ((await normalPopover.locator('[data-subvault-search]').count()) !== 0) {
    throw new Error('separate search input should be removed');
  }
  if ((await normalPopover.locator('[data-subvault-account]').count()) !== 2) {
    throw new Error('popover should show all accounts when input is empty');
  }
  await normal.locator('input[name="username"]').fill('ali');
  await normal.waitForTimeout(200);
  if ((await normalPopover.locator('[data-subvault-account]').count()) !== 1) {
    throw new Error('popover did not filter from the account input');
  }
  await normal.keyboard.press('Enter');
  await normal.waitForTimeout(300);
  const normalValues = await normal.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (normalValues.username !== 'alice' || normalValues.password !== 'secret-value') {
    throw new Error(`normal fill failed: ${JSON.stringify(normalValues)}`);
  }

  const usernameAnchorPage = await context.newPage();  await usernameAnchorPage.goto(`${base}/normal`);
  const usernameAnchor = usernameAnchorPage.locator('input[name="username"]');
  await usernameAnchor.click();
  await usernameAnchorPage.waitForTimeout(500);
  const usernameAnchorTrigger = usernameAnchorPage.locator('[data-subvault-trigger]');
  await usernameAnchorTrigger.waitFor({ state: 'visible', timeout: 8000 });
  const usernameBox = await usernameAnchor.boundingBox();
  const triggerBox = await usernameAnchorTrigger.boundingBox();
  if (!usernameBox || !triggerBox) throw new Error('username trigger box missing');
  if (Math.abs(triggerBox.y - usernameBox.y) > 20) {
    throw new Error(`trigger not anchored to username: ${JSON.stringify({ usernameBox, triggerBox })}`);
  }
  await usernameAnchorPage.screenshot({ path: path.join(root, 'docs', 'popover-username.png') });
  await usernameAnchorTrigger.click();
  await usernameAnchorPage.locator('[data-subvault-account]').first().click();
  await usernameAnchorPage.waitForTimeout(300);
  const usernameAnchorValues = await usernameAnchorPage.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (usernameAnchorValues.username !== 'alice' || usernameAnchorValues.password !== 'secret-value') {
    throw new Error(`username-anchor fill failed: ${JSON.stringify(usernameAnchorValues)}`);
  }

  const compactPage = await context.newPage();
  await compactPage.setViewportSize({ width: 780, height: 480 });
  await compactPage.goto(`${base}/normal`);
  await compactPage.evaluate(() => {
    const form = document.querySelector('form');
    if (form) form.style.marginTop = '380px';
  });
  const compactPopover = await openPopover(compactPage);
  await compactPage.setViewportSize({ width: 760, height: 460 });
  await compactPage.waitForTimeout(500);
  await compactPopover.locator('[data-subvault-account]').first().click();
  await compactPage.waitForTimeout(300);
  const compactValues = await compactPage.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (compactValues.username !== 'alice' || compactValues.password !== 'secret-value') {
    throw new Error(`compact-window fill failed: ${JSON.stringify(compactValues)}`);
  }

  const keyboardPage = await context.newPage();
  await keyboardPage.goto(`${base}/normal`);
  const keyboardPopover = await openPopover(keyboardPage);
  await keyboardPage.keyboard.press('ArrowDown');
  await keyboardPage.keyboard.press('Enter');
  await keyboardPage.waitForTimeout(300);
  const keyboardValues = await keyboardPage.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (keyboardValues.username !== 'bob' || keyboardValues.password !== 'bob-secret') {
    throw new Error(`keyboard fill failed: ${JSON.stringify(keyboardValues)}`);
  }

  const iframePage = await context.newPage();  await iframePage.goto(`${base}/iframe`);
  await iframePage.waitForTimeout(800);
  const frame = iframePage.frames().find((item) => item.url().includes('/normal?iframe=1'));
  if (!frame) throw new Error('iframe frame not found');
  const iframePopover = await openPopover(frame);
  await iframePopover.locator('[data-subvault-account]').first().click();
  await iframePage.waitForTimeout(300);
  const iframeValues = await frame.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (iframeValues.username !== 'alice' || iframeValues.password !== 'secret-value') {
    throw new Error(`iframe fill failed: ${JSON.stringify(iframeValues)}`);
  }

  const shadowPage = await context.newPage();
  await shadowPage.goto(`${base}/shadow`);
  const shadowPopover = await openPopover(shadowPage);
  await shadowPopover.locator('[data-subvault-account]').first().click();
  await shadowPage.waitForTimeout(300);
  const shadowValues = await shadowPage.evaluate(() => {
    const root = document.getElementById('shadow-host')?.shadowRoot;
    return {
      username: root?.querySelector('input[name="username"]')?.value,
      password: root?.querySelector('input[name="password"]')?.value,
    };
  });
  if (shadowValues.username !== 'alice' || shadowValues.password !== 'secret-value') {
    throw new Error(`shadow fill failed: ${JSON.stringify(shadowValues)}`);
  }

  const usernamePage = await context.newPage();
  await usernamePage.goto(`${base}/username`);
  const usernameInput = usernamePage.locator('input[name="username"]');
  await usernameInput.click();
  await usernamePage.waitForTimeout(400);
  const usernameTrigger = usernamePage.locator('[data-subvault-trigger]');
  await usernameTrigger.waitFor({ state: 'visible', timeout: 8000 });
  await usernameTrigger.click();
  await usernamePage.locator('[data-subvault-account]').first().click();
  await usernamePage.waitForTimeout(300);
  const usernameOnly = await usernameInput.inputValue();
  if (usernameOnly !== 'alice') {
    throw new Error(`username-only fill failed: ${usernameOnly}`);
  }

  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { autoOpenOnFocus: true },
    }),
  );
  const autoPage = await context.newPage();
  await autoPage.goto(`${base}/normal`);
  await autoPage.locator('input[name="username"]').click();
  const autoPopover = autoPage.locator('[data-subvault-popover]');
  await autoPopover.waitFor({ state: 'visible', timeout: 8000 });
  await autoPage.locator('[data-subvault-account]').first().click();
  await autoPage.waitForTimeout(300);
  const autoValues = await autoPage.evaluate(() => ({
    username: document.querySelector('input[name="username"]')?.value,
    password: document.querySelector('input[name="password"]')?.value,
  }));
  if (autoValues.username !== 'alice' || autoValues.password !== 'secret-value') {
    throw new Error(`auto-open fill failed: ${JSON.stringify(autoValues)}`);
  }

  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { autoOpenOnFocus: false, savePromptPosition: 'center', theme: 'dark' },
    }),
  );
  const appearancePage = await context.newPage();
  await appearancePage.goto(`${base}/normal`);
  const appearancePopover = await openPopover(appearancePage);
  await appearancePopover.locator('[data-subvault-account]').first().click();
  await appearancePage.waitForTimeout(300);
  const appearance = await appearancePage.evaluate(() => {
    const host = document.getElementById('subvault-ui-root');
    const toast = host?.shadowRoot?.querySelector('.sv-toast');
    const panel = host?.shadowRoot?.querySelector('.sv-panel');
    const rect = toast?.getBoundingClientRect();
    return {
      theme: host?.dataset.theme || '',
      panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
      toastClass: toast?.className || '',
      toastText: toast?.textContent || '',
      toastCenter: rect
        ? {
            x: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
            y: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2),
          }
        : null,
    };
  });
  if (
    appearance.theme !== 'dark' ||
    appearance.panelBg !== 'rgb(17, 24, 39)' ||
    !appearance.toastClass.includes('pos-center') ||
    !appearance.toastText.includes('已填入账号：alice') ||
    !appearance.toastCenter ||
    appearance.toastCenter.x > 20 ||
    appearance.toastCenter.y > 20
  ) {
    throw new Error(`appearance/toast failed: ${JSON.stringify(appearance)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        extensionId,
        badge: badgeText,
        normal: normalValues,
        usernameAnchor: usernameAnchorValues,
        compactWindow: compactValues,
        keyboard: keyboardValues,
        iframe: iframeValues,
        shadow: shadowValues,
        usernameOnly,
        appearance,
        autoOpen: autoValues,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
